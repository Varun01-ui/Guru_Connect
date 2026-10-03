import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../app.js'
import { db, pool } from '../../../db/index.js'
import { signRegistrationToken } from '../../../lib/appJwt.js'

const app = createApp()
const phone = '+919911122233'

afterAll(async () => {
  await pool.end()
})

describe('registration module (M05 + M06)', () => {
  let regToken: string
  let stateId: string
  let cityId: string
  let wrongCityAreaId: string

  beforeAll(async () => {
    const { token } = signRegistrationToken({ sub: phone, contactType: 'phone' })
    regToken = token

    const city = await db.selectFrom('cities').select(['id', 'state_id']).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirstOrThrow()
    stateId = city.state_id
    cityId = city.id

    const areaInOtherCity = await db
      .selectFrom('areas')
      .select('id')
      .where('city_id', '!=', cityId)
      .where('is_active', '=', true)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    wrongCityAreaId = areaInOtherCity?.id ?? randomUUID()
  })

  afterAll(async () => {
    await db.deleteFrom('app_sessions').where('user_id', 'in', db.selectFrom('app_users').select('id').where('phone', '=', phone)).execute()
    await db.deleteFrom('user_consents').where('user_id', 'in', db.selectFrom('app_users').select('id').where('phone', '=', phone)).execute()
    await db.deleteFrom('user_auth_identities').where('provider_subject', '=', phone).execute()
    await db.deleteFrom('parents').where('phone', '=', phone).execute()
    await db.deleteFrom('app_users').where('phone', '=', phone).execute()
  })

  it('GET /registration/context returns the verified contact and legal versions', async () => {
    const res = await request(app).get('/api/v1/app/registration/context').set('Authorization', `Bearer ${regToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.verifiedValue).toBe(phone)
    expect(res.body.data.contactType).toBe('phone')
    expect(res.body.data.legal.termsUrl).toBe('https://guruconnect.in/terms')
  })

  it('POST /registration/parent requires an Idempotency-Key header', async () => {
    const res = await request(app)
      .post('/api/v1/app/registration/parent')
      .set('Authorization', `Bearer ${regToken}`)
      .send({ fullName: 'No Key', mobile: phone, stateId, cityId, marketingOptIn: false })
    expect(res.status).toBe(422)
  })

  it('rejects an areaId that belongs to a different city with 422 VALIDATION_FAILED', async () => {
    const res = await request(app)
      .post('/api/v1/app/registration/parent')
      .set('Authorization', `Bearer ${regToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ fullName: 'Lakshmi Venkatesh', mobile: phone, stateId, cityId, areaId: wrongCityAreaId, marketingOptIn: false })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('creates the parent account, identity, consents, and session in one transaction', async () => {
    const res = await request(app)
      .post('/api/v1/app/registration/parent')
      .set('Authorization', `Bearer ${regToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ fullName: 'Lakshmi Venkatesh', mobile: phone, stateId, cityId, marketingOptIn: true })

    expect(res.status).toBe(201)
    expect(res.body.data.user.role).toBe('parent')
    expect(res.body.data.user.registration.nextStep).toBe('child_setup')
    expect(res.body.data.accessToken).toBeDefined()

    const parentRow = await db.selectFrom('parents').selectAll().where('phone', '=', phone).executeTakeFirstOrThrow()
    expect(parentRow.full_name).toBe('Lakshmi Venkatesh')

    const consents = await db.selectFrom('user_consents').select('consent_type').where('user_id', '=', parentRow.user_id).execute()
    expect(consents.map((c) => c.consent_type).sort()).toEqual(['marketing', 'privacy_policy', 'terms'])
  })

  it('a second submit for the same phone is rejected as CONFLICT_DUPLICATE, not a duplicate row', async () => {
    const res = await request(app)
      .post('/api/v1/app/registration/parent')
      .set('Authorization', `Bearer ${regToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ fullName: 'Lakshmi Venkatesh Again', mobile: phone, stateId, cityId, marketingOptIn: false })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT_DUPLICATE')

    const rows = await db.selectFrom('parents').select('id').where('phone', '=', phone).execute()
    expect(rows).toHaveLength(1)
  })

  it('two concurrent submits for a brand-new phone: exactly one succeeds, the DB unique index catches the race', async () => {
    const racePhone = '+919911155566'
    const { token } = signRegistrationToken({ sub: racePhone, contactType: 'phone' })

    const [a, b] = await Promise.all([
      request(app)
        .post('/api/v1/app/registration/parent')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ fullName: 'Racer One', mobile: racePhone, stateId, cityId, marketingOptIn: false }),
      request(app)
        .post('/api/v1/app/registration/parent')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ fullName: 'Racer Two', mobile: racePhone, stateId, cityId, marketingOptIn: false }),
    ])

    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([201, 409])

    const rows = await db.selectFrom('parents').select('id').where('phone', '=', racePhone).execute()
    expect(rows).toHaveLength(1)

    await db.deleteFrom('app_sessions').where('user_id', 'in', db.selectFrom('app_users').select('id').where('phone', '=', racePhone)).execute()
    await db.deleteFrom('user_consents').where('user_id', 'in', db.selectFrom('app_users').select('id').where('phone', '=', racePhone)).execute()
    await db.deleteFrom('user_auth_identities').where('provider_subject', '=', racePhone).execute()
    await db.deleteFrom('parents').where('phone', '=', racePhone).execute()
    await db.deleteFrom('app_users').where('phone', '=', racePhone).execute()
  })
})

describe('POST /registration/referral/validate', () => {
  it('reports an unknown code as invalid', async () => {
    const { token } = signRegistrationToken({ sub: '+919911100000', contactType: 'phone' })
    const res = await request(app)
      .post('/api/v1/app/registration/referral/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'NOTAREALCODE99' })
    expect(res.status).toBe(200)
    expect(res.body.data.valid).toBe(false)
  })
})
