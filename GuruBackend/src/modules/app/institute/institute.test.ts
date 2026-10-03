import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../../app.js'
import { env } from '../../../config/env.js'
import { db, pool } from '../../../db/index.js'
import { gstinChecksumValid, isValidGstin, maskGstin, normaliseGstin } from '../../../lib/gstin.js'
import { haversineKm } from '../../../lib/geo.js'
import { slugify } from '../../../lib/slug.js'
import { APP, bearer, createParent, createTeacher, loadMasters, purgeUsersByPhone, randomPhone, registrationToken } from '../../../test/appHelpers.js'
import type { Masters, TestParent } from '../../../test/appHelpers.js'
import * as repo from './institute.repository.js'
import { sendDraftReminders } from './institute.service.js'

const app = createApp()
const phones: string[] = []
let m: Masters
let parent: TestParent

const GOOD_GSTIN = '29AAGCA4321M1ZJ' // Karnataka
const DAY = 86_400_000
const HOUR = 3_600_000
const BENGALURU = { lat: 12.935214, lng: 77.624481 } // Koramangala, ~4 km from the city centre

const instituteBody = (over: Record<string, unknown> = {}) => ({
  name: 'Apex JEE Academy',
  instituteType: 'coaching_centre',
  email: 'contact@apexjee.in',
  gstin: null,
  addressLine: '3rd Floor, 80 Feet Road, 6th Block',
  cityId: m.city.id,
  areaId: m.areas.find((a) => a.name === 'Koramangala')!.id,
  pincode: '560034',
  latitude: BENGALURU.lat,
  longitude: BENGALURU.lng,
  ...over,
})
const ownerBody = (over: { institute?: Record<string, unknown>; owner?: Record<string, unknown>; [k: string]: unknown } = {}) => {
  const { institute, owner, ...rest } = over
  return { mode: 'owner', institute: instituteBody(institute), owner: { fullName: 'Suresh Menon', mobile: '+919845012345', ...owner }, consents: { terms: true, privacy: true, documentVersion: '2026-09' }, referralCode: null, ...rest }
}

type Reg = { phone: string; token: string; jti: string }
function newReg(): Reg {
  const phone = randomPhone()
  phones.push(phone)
  const { token, jti } = registrationToken(phone)
  return { phone, token, jti }
}
const register = (reg: Reg, body: object, opts: { key?: string | null; install?: string } = {}) => {
  const r = request(app).post(`${APP}/registration/institute`).set('Authorization', `Bearer ${reg.token}`).set('X-Install-Id', opts.install ?? randomUUID())
  return (opts.key === null ? r : r.set('Idempotency-Key', opts.key ?? randomUUID())).send(body)
}
async function registerOk(over: Parameters<typeof ownerBody>[0] = {}) {
  const reg = newReg()
  const res = await register(reg, ownerBody(over))
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return { reg, res, data: res.body.data, token: res.body.data.session.accessToken as string, instituteId: res.body.data.institute.id as string, userId: res.body.data.user.id as string }
}

const patch = (token: string, body: object, version?: string) => {
  const r = request(app).patch(`${APP}/institute/registration/basics`).set('Authorization', `Bearer ${token}`)
  return (version ? r.set('If-Match', version) : r).send(body)
}
const versionOf = async (instituteId: string) => (await db.selectFrom('institutes').select('updated_at').where('id', '=', instituteId).executeTakeFirstOrThrow()).updated_at.toISOString()
const setInstitute = (id: string, values: Record<string, unknown>) => db.updateTable('institutes').set(values as never).where('id', '=', id).execute()

// An institute with a primary manager and a pending counsellor invite, created straight in the database.
async function seedInstitute(over: { status?: string; accountStatus?: string; invitePhone?: string; invitedAgoMs?: number; inviteRole?: 'manager' | 'counsellor' } = {}) {
  const ownerPhone = randomPhone()
  phones.push(ownerPhone)
  const owner = await db.insertInto('app_users').values({ user_type: 'institute_staff', phone: ownerPhone, full_name: 'Owner Person', signup_source: 'organic' }).returning('id').executeTakeFirstOrThrow()
  const institute = await db
    .insertInto('institutes')
    .values({ name: 'Seed Institute', slug: `seed-${randomUUID().slice(0, 8)}`, institute_type: 'coaching_centre', phone: ownerPhone, address_line: '12 Test Road', city_id: m.city.id, area_id: m.areas[0]!.id, pincode: '560034', verification_status: (over.status ?? 'approved') as 'approved', account_status: (over.accountStatus ?? 'active') as 'active' })
    .returning('id')
    .executeTakeFirstOrThrow()
  const primary = await db.insertInto('institute_managers').values({ institute_id: institute.id, user_id: owner.id, full_name: 'Owner Person', phone: ownerPhone, staff_role: 'manager', is_primary: true, status: 'active', accepted_at: new Date() }).returning('id').executeTakeFirstOrThrow()
  const invitePhone = over.invitePhone ?? randomPhone()
  phones.push(invitePhone)
  const invite = await db
    .insertInto('institute_managers')
    .values({ institute_id: institute.id, full_name: 'Kavita (invited)', phone: invitePhone, staff_role: over.inviteRole ?? 'counsellor', status: 'invited', invited_at: new Date(Date.now() - (over.invitedAgoMs ?? 2 * HOUR)) })
    .returning('id')
    .executeTakeFirstOrThrow()
  return { instituteId: institute.id, ownerUserId: owner.id, primaryId: primary.id, inviteId: invite.id, invitePhone }
}
const regFor = (phone: string): Reg => {
  const { token, jti } = registrationToken(phone)
  return { phone, token, jti }
}

beforeAll(async () => {
  m = await loadMasters()
  parent = await createParent(m)
  phones.push(parent.phone)
})
afterAll(async () => {
  await purgeUsersByPhone(phones)
  await pool.end()
})

describe('GSTIN helpers (BR-21.4)', () => {
  it('validates the documented examples', () => {
    expect(gstinChecksumValid('29AAGCA4321M1ZJ')).toBe(true)
    expect(gstinChecksumValid('29AAGCA4321M1ZK')).toBe(false)
    expect(isValidGstin('29AAGCA4321M1ZJ', 'KA')).toEqual({ ok: true })
    expect(isValidGstin('29AAGCA4321M1ZK', 'KA')).toEqual({ ok: false, reason: 'checksum' })
    expect(isValidGstin('27AAPFU0939F1ZV', 'KA')).toEqual({ ok: false, reason: 'state' })
    expect(isValidGstin('27AAPFU0939F1ZV', 'MH')).toEqual({ ok: true })
    expect(isValidGstin('NOTAGSTIN', 'KA')).toEqual({ ok: false, reason: 'format' })
    expect(isValidGstin('29aagca4321m1zj', 'KA')).toEqual({ ok: false, reason: 'format' }) // normalise first
  })
  it('normalises and masks', () => {
    expect(normaliseGstin(' 29aagca 4321m1zj ')).toBe('29AAGCA4321M1ZJ')
    expect(normaliseGstin('   ')).toBeNull()
    expect(normaliseGstin(null)).toBeNull()
    expect(maskGstin('29AAGCA4321M1ZJ')).toBe('XXXXXXXXXXXM1ZJ')
    expect(maskGstin(null)).toBeNull()
  })
  it('knows the state of every seeded state code', async () => {
    const codes = (await db.selectFrom('states').select('code').execute()).map((s) => s.code)
    const { GST_STATE_CODES } = await import('../../../lib/gstin.js')
    for (const code of codes) expect(GST_STATE_CODES[code], code).toMatch(/^\d{2}$/)
  })
})

describe('small helpers', () => {
  it('slugifies like the spec example and respects the 80 character cap', () => {
    expect(slugify('Apex JEE Academy', 'Koramangala')).toBe('apex-jee-academy-koramangala')
    expect(slugify('Apex JEE & NEET Academy', 'Koramangala')).toBe('apex-jee-neet-academy-koramangala')
    expect(slugify('Café  Tütors!!', null)).toBe('cafe-tutors')
    expect(slugify('x'.repeat(200))).toHaveLength(80)
    expect(slugify('!!!')).toBe('institute')
  })
  it('measures distance', () => {
    expect(haversineKm({ lat: 12.9716, lng: 77.5946 }, { lat: 12.9716, lng: 77.5946 })).toBe(0)
    const d = haversineKm({ lat: 12.9716, lng: 77.5946 }, { lat: 12.9352, lng: 77.6245 })
    expect(d).toBeGreaterThan(4)
    expect(d).toBeLessThan(6)
  })
})

describe('POST /registration/institute (owner)', () => {
  it('creates the account, draft institute and primary manager in one go (T21.1)', async () => {
    const { reg, data, instituteId, userId, token } = await registerOk({ owner: { mobile: '+919000011111' } }) // body mobile is ignored in favour of the token's phone
    expect(data).toMatchObject({
      user: { role: 'institute_staff', fullName: 'Suresh Menon' },
      institute: { publicCode: expect.stringMatching(/^GC-I/), slug: 'apex-jee-academy-koramangala', name: 'Apex JEE Academy', verificationStatus: 'draft', staffRole: 'manager', isPrimary: true },
      nextStep: 'institute_documents',
    })
    expect(data.session).toMatchObject({ accessToken: expect.any(String), expiresIn: expect.any(Number), refreshToken: expect.any(String), sessionId: expect.any(String) })

    const user = await db.selectFrom('app_users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow()
    expect(user).toMatchObject({ user_type: 'institute_staff', phone: reg.phone, full_name: 'Suresh Menon', account_status: 'active', preferred_language: 'en', signup_source: 'organic' })
    expect(user.phone_verified_at).not.toBeNull()
    expect(user.email).toBeNull()
    const institute = await db.selectFrom('institutes').selectAll().where('id', '=', instituteId).executeTakeFirstOrThrow()
    expect(institute).toMatchObject({ verification_status: 'draft', account_status: 'active', phone: reg.phone, email: 'contact@apexjee.in', gstin: null, pincode: '560034', institute_type: 'coaching_centre' })
    expect(Number(institute.latitude)).toBeCloseTo(BENGALURU.lat, 6)
    const managers = await db.selectFrom('institute_managers').selectAll().where('institute_id', '=', instituteId).execute()
    expect(managers).toHaveLength(1)
    expect(managers[0]).toMatchObject({ user_id: userId, staff_role: 'manager', is_primary: true, status: 'active', designation: 'Owner', phone: reg.phone, invited_at: null })
    expect(managers[0]!.accepted_at).not.toBeNull()
    expect(data.user.profileId).toBe(managers[0]!.id)

    const consents = await db.selectFrom('user_consents').select(['consent_type', 'document_version', 'granted', 'method']).where('user_id', '=', userId).orderBy('consent_type').execute()
    expect(consents).toEqual([
      { consent_type: 'privacy_policy', document_version: '2026-09', granted: true, method: 'checkbox' },
      { consent_type: 'terms', document_version: '2026-09', granted: true, method: 'checkbox' },
    ])
    expect(await db.selectFrom('user_auth_identities').select('provider').where('user_id', '=', userId).execute()).toEqual([{ provider: 'phone' }])
    const audit = await db.selectFrom('audit_logs').select(['module', 'new_values']).where('actor_id', '=', userId).where('action', '=', 'app.institute_registered').executeTakeFirstOrThrow()
    expect(audit.module).toBe('app.institute_registration')
    expect(audit.new_values).toMatchObject({ instituteId, hasGstin: false, instituteType: 'coaching_centre', signupSource: 'organic' })

    // the session works: /me reports the institute and the next registration step
    const me = await request(app).get(`${APP}/me`).set(bearer({ token }))
    expect(me.status).toBe(200)
    expect(me.body.data).toMatchObject({ role: 'institute_staff', profileId: managers[0]!.id, institute: { id: instituteId, name: 'Apex JEE Academy', staffRole: 'manager', isPrimary: true, verificationStatus: 'draft' }, registration: { complete: false, nextStep: 'institute_documents' } })
  })

  it('returns the original 201 for the same Idempotency-Key and rejects the used token otherwise (T21.2, T21.10)', async () => {
    const reg = newReg()
    const key = randomUUID()
    const install = randomUUID()
    const a = await register(reg, ownerBody(), { key, install })
    const b = await register(reg, ownerBody(), { key, install })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect(b.body.data).toEqual(a.body.data)
    expect(await db.selectFrom('institutes').select('id').where('phone', '=', reg.phone).execute()).toHaveLength(1)
    expect(await db.selectFrom('app_users').select('id').where('phone', '=', reg.phone).execute()).toHaveLength(1)

    const other = await register(reg, ownerBody(), { key: randomUUID(), install })
    expect(other.status).toBe(401)
    expect(other.body.error).toMatchObject({ code: 'AUTH_REQUIRED', details: { reason: 'registration_token_expired' } })
  })

  it('needs a registration token, an Idempotency-Key and a matching role', async () => {
    const reg = newReg()
    expect((await request(app).post(`${APP}/registration/institute`).set('Idempotency-Key', randomUUID()).send(ownerBody())).status).toBe(401)
    expect((await request(app).post(`${APP}/registration/institute`).set('Authorization', 'Bearer nope').set('Idempotency-Key', randomUUID()).send(ownerBody())).status).toBe(401)
    const noKey = await register(reg, ownerBody(), { key: null })
    expect(noKey.status).toBe(422)
    const wrong = jwt.sign({ sub: randomPhone(), contactType: 'phone', role: 'teacher', jti: randomUUID() }, env.APP_JWT_SECRET, { algorithm: 'HS256', audience: 'gc-register', expiresIn: 600 })
    const res = await register({ phone: '', token: wrong, jti: '' }, ownerBody())
    expect(res.status).toBe(403)
    // an access token is not a registration token
    expect((await register({ phone: '', token: parent.token, jti: '' }, ownerBody())).status).toBe(401)
  })

  it('needs a verified phone: email and Google tokens are asked to verify a mobile first (BR-21.2)', async () => {
    const { token, jti } = registrationToken('someone@example.com', 'email')
    const res = await register({ phone: '', token, jti }, ownerBody())
    expect(res.status).toBe(422)
    expect(res.body.error.details[0]).toMatchObject({ path: 'owner.mobile' })
    expect(await db.selectFrom('institutes').select('id').where('email', '=', 'contact@apexjee.in').where('name', '=', 'Apex JEE Academy').where('phone', '=', 'someone@example.com').execute()).toHaveLength(0)
  })

  it('answers phone_in_use when the number already has an account', async () => {
    const { token, jti } = registrationToken(parent.phone)
    const res = await register({ phone: parent.phone, token, jti }, ownerBody())
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', message: 'This number already has a GuruConnect account. Sign in instead.', details: { reason: 'phone_in_use', path: 'owner.mobile' } })
  })

  it('accepts a valid GSTIN for the city\'s state, and normalises its case and spaces (T21.3)', async () => {
    await db.deleteFrom('institutes').where('gstin', '=', GOOD_GSTIN).execute()
    const { instituteId } = await registerOk({ institute: { gstin: ' 29aagca4321m1zj ' } })
    expect((await db.selectFrom('institutes').select('gstin').where('id', '=', instituteId).executeTakeFirstOrThrow()).gstin).toBe(GOOD_GSTIN)
    await db.deleteFrom('institutes').where('id', '=', instituteId).execute() // free the GSTIN for later tests
  })

  it('rejects a bad GSTIN with the specific reason and jumps back to step 1 (T21.3)', async () => {
    const cases: [string, string][] = [
      ['29AAGCA4321M1ZK', "This GSTIN doesn't look right. Check the last character."],
      ['27AAPFU0939F1ZV', 'This GSTIN is registered in another state.'],
      ['1234', 'Enter a valid 15-character GSTIN.'],
    ]
    for (const [gstin, message] of cases) {
      const res = await register(newReg(), ownerBody({ institute: { gstin } }))
      expect(res.status, gstin).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
      expect(res.body.error.message).toBe('Please check the highlighted fields.')
      expect(res.body.error.details).toEqual([{ path: 'institute.gstin', message }])
    }
  })

  it('stores a missing or blank GSTIN as NULL (T21.5)', async () => {
    for (const gstin of [undefined, null, '', '   ']) {
      const { instituteId } = await registerOk({ institute: { gstin } })
      expect((await db.selectFrom('institutes').select('gstin').where('id', '=', instituteId).executeTakeFirstOrThrow()).gstin).toBeNull()
    }
  })

  it('refuses a GSTIN used by another live institute without naming it, but not a rejected one (T21.4)', async () => {
    await db.deleteFrom('institutes').where('gstin', '=', GOOD_GSTIN).execute()
    const first = await registerOk({ institute: { gstin: GOOD_GSTIN } })
    await setInstitute(first.instituteId, { verification_status: 'approved' })
    const dup = await register(newReg(), ownerBody({ institute: { name: 'Totally Different Name', gstin: GOOD_GSTIN } }))
    expect(dup.status).toBe(409)
    expect(dup.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', details: { reason: 'gstin_in_use', path: 'institute.gstin' } })
    expect(JSON.stringify(dup.body)).not.toContain('Apex')
    expect(await db.selectFrom('app_users').select('id').where('full_name', '=', 'Suresh Menon').where('phone', '=', newReg().phone).execute()).toHaveLength(0)

    await setInstitute(first.instituteId, { verification_status: 'rejected' })
    expect((await register(newReg(), ownerBody({ institute: { gstin: GOOD_GSTIN } }))).status).toBe(201)
    await db.deleteFrom('institutes').where('gstin', '=', GOOD_GSTIN).execute()
  })

  it('keeps slugs unique with -2, -3 suffixes (BR-21.7)', async () => {
    const a = await registerOk({ institute: { name: 'Slug Test Academy' } })
    const b = await registerOk({ institute: { name: 'Slug Test Academy' } })
    const c = await registerOk({ institute: { name: 'Slug Test Academy' } })
    expect([a, b, c].map((r) => r.data.institute.slug)).toEqual(['slug-test-academy-koramangala', 'slug-test-academy-koramangala-2', 'slug-test-academy-koramangala-3'])
  })

  it('validates the location: PIN format, area in city, pin distance, serviceable cities (T21.6, T21.7)', async () => {
    const koramangala = m.areas.find((a) => a.name === 'Koramangala')!.id
    // a PIN from another locality is only a soft warning in the app: the server saves it
    expect((await register(newReg(), ownerBody({ institute: { areaId: koramangala, pincode: '560001' } }))).status).toBe(201)
    for (const pincode of ['56003', '060034', '5600345', 'abcdef']) expect((await register(newReg(), ownerBody({ institute: { pincode } }))).status, pincode).toBe(422)

    const far = await register(newReg(), ownerBody({ institute: { latitude: 13.43, longitude: 77.62 } })) // ~55 km north
    expect(far.status).toBe(422)
    expect(far.body.error.details).toEqual([{ path: 'institute.latitude', message: 'The pin is too far from Bengaluru. Move it to your institute.' }])
    expect((await register(newReg(), ownerBody({ institute: { latitude: 13.02, longitude: 77.62 } }))).status).toBe(201) // ~9 km, inside

    const otherCityArea = await db.selectFrom('areas').select('id').where('city_id', '=', m.otherCity.id).where('is_active', '=', true).executeTakeFirst()
    if (otherCityArea) {
      const wrong = await register(newReg(), ownerBody({ institute: { areaId: otherCityArea.id } }))
      expect(wrong.status).toBe(422)
      expect(wrong.body.error.details.map((d: { path: string }) => d.path)).toContain('institute.areaId')
    }
    const unknownCity = await register(newReg(), ownerBody({ institute: { cityId: randomUUID() } }))
    expect(unknownCity.status).toBe(422)
    expect(unknownCity.body.error.details[0]).toEqual({ path: 'institute.cityId', message: 'Choose your city.' })
  })

  it('accepts a city that is not serviceable yet (BR-21.5)', async () => {
    const city = await db.selectFrom('cities').select(['id']).where('id', '=', m.city.id).executeTakeFirstOrThrow()
    await db.updateTable('cities').set({ is_serviceable: false }).where('id', '=', city.id).execute()
    try {
      expect((await register(newReg(), ownerBody())).status).toBe(201)
    } finally {
      await db.updateTable('cities').set({ is_serviceable: true }).where('id', '=', city.id).execute()
    }
  })

  it('validates the remaining fields', async () => {
    const bad: [string, object][] = [
      ['name too short', ownerBody({ institute: { name: 'ab' } })],
      ['name digits only', ownerBody({ institute: { name: '123456' } })],
      ['name bad characters', ownerBody({ institute: { name: 'Apex <script>' } })],
      ['name too long', ownerBody({ institute: { name: 'a'.repeat(121) } })],
      ['bad type', ownerBody({ institute: { instituteType: 'gym' } })],
      ['bad email', ownerBody({ institute: { email: 'not-an-email' } })],
      ['short address', ownerBody({ institute: { addressLine: 'abc' } })],
      ['no latitude', ownerBody({ institute: { latitude: undefined } })],
      ['no longitude', ownerBody({ institute: { longitude: undefined } })],
      ['latitude out of range', ownerBody({ institute: { latitude: 95 } })],
      ['owner name 1 char', ownerBody({ owner: { fullName: 'S' } })],
      ['owner name digits', ownerBody({ owner: { fullName: 'Suresh 123' } })],
      ['bad mobile', ownerBody({ owner: { mobile: '12345' } })],
      ['terms not accepted', ownerBody({ consents: { terms: false, privacy: true, documentVersion: '2026-09' } })],
      ['privacy not accepted', ownerBody({ consents: { terms: true, privacy: false, documentVersion: '2026-09' } })],
      ['no document version', ownerBody({ consents: { terms: true, privacy: true, documentVersion: '' } })],
      ['bad referral code', ownerBody({ referralCode: 'x' })],
      ['unknown mode', { ...ownerBody(), mode: 'visitor' }],
    ]
    for (const [name, body] of bad) {
      const res = await register(newReg(), body)
      expect(res.status, name).toBe(422)
      expect(res.body.error.code, name).toBe('VALIDATION_FAILED')
    }
  })

  it('applies the institute referral only when that program is on (BR-21.3, BR-21.6 step 8)', async () => {
    const owner = await createParent(m)
    phones.push(owner.phone)
    const code = `IR${Date.now().toString().slice(-8)}`
    const rc = await db.insertInto('referral_codes').values({ user_id: owner.userId, code, program_code: 'INSTITUTE_REFERRAL' }).returning('id').executeTakeFirstOrThrow()
    try {
      const off = await registerOk({ referralCode: code }) // the program is off at launch
      expect(await db.selectFrom('referrals').select('id').where('referee_user_id', '=', off.userId).execute()).toHaveLength(0)
      expect((await db.selectFrom('app_users').select('signup_source').where('id', '=', off.userId).executeTakeFirstOrThrow()).signup_source).toBe('organic')

      await db.updateTable('referral_settings').set({ is_enabled: true }).where('program_code', '=', 'INSTITUTE_REFERRAL').where('status', '=', 'active').execute()
      const on = await registerOk({ referralCode: code })
      const ref = await db.selectFrom('referrals').select(['referral_code_id', 'status']).where('referee_user_id', '=', on.userId).executeTakeFirstOrThrow()
      expect(ref).toEqual({ referral_code_id: rc.id, status: 'pending' })
      expect((await db.selectFrom('app_users').select('signup_source').where('id', '=', on.userId).executeTakeFirstOrThrow()).signup_source).toBe('referral')
    } finally {
      await db.updateTable('referral_settings').set({ is_enabled: false }).where('program_code', '=', 'INSTITUTE_REFERRAL').where('status', '=', 'active').execute()
      await db.deleteFrom('referrals').where('referral_code_id', '=', rc.id).execute()
      await db.deleteFrom('referral_codes').where('id', '=', rc.id).execute()
    }
  })

  it('leaves nothing behind when a later step fails (T21.12)', async () => {
    const reg = newReg()
    const spy = vi.spyOn(repo, 'insertOwnerManagerTx').mockRejectedValueOnce(new Error('boom'))
    try {
      const res = await register(reg, ownerBody({ institute: { name: 'Rollback Academy' } }))
      expect(res.status).toBe(500)
    } finally {
      spy.mockRestore()
    }
    expect(await db.selectFrom('app_users').select('id').where('phone', '=', reg.phone).execute()).toHaveLength(0)
    expect(await db.selectFrom('institutes').select('id').where('phone', '=', reg.phone).execute()).toHaveLength(0)
    expect(await db.selectFrom('institutes').select('id').where('name', '=', 'Rollback Academy').execute()).toHaveLength(0)
    // the same token can try again, since nothing was consumed
    const retry = await register(reg, ownerBody({ institute: { name: 'Rollback Academy' } }))
    expect(retry.status).toBe(201)
  })

  it('limits attempts per install: 5 an hour, 2 successful registrations in 30 days (BR-21.11)', async () => {
    const install = randomUUID()
    for (let i = 0; i < 2; i++) expect((await register(newReg(), ownerBody(), { install })).status).toBe(201)
    const third = await register(newReg(), ownerBody(), { install })
    expect(third.status).toBe(429)
    expect(third.body.error).toMatchObject({ code: 'LIMIT_REACHED', details: { reason: 'install_registrations', limit: 2 } })

    const hourly = randomUUID()
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await register(newReg(), ownerBody({ institute: { gstin: '29AAGCA4321M1ZK' } }), { install: hourly })).status)
    expect(statuses).toEqual([422, 422, 422, 422, 422, 429])
  })

  it('reads the preferred language from Accept-Language', async () => {
    const reg = newReg()
    const res = await request(app).post(`${APP}/registration/institute`).set('Authorization', `Bearer ${reg.token}`).set('Idempotency-Key', randomUUID()).set('X-Install-Id', randomUUID()).set('Accept-Language', 'hi-IN,en;q=0.8').send(ownerBody())
    expect(res.status).toBe(201)
    expect((await db.selectFrom('app_users').select('preferred_language').where('id', '=', res.body.data.user.id).executeTakeFirstOrThrow()).preferred_language).toBe('hi')
  })
})

describe('GET /registration/context (BR-21.8)', () => {
  it('lists pending invites for the verified phone and the referral programs', async () => {
    const seed = await seedInstitute({ invitedAgoMs: 2 * HOUR })
    const old = await seedInstitute({ invitePhone: seed.invitePhone, invitedAgoMs: 80 * HOUR })
    const reg = regFor(seed.invitePhone)
    const res = await request(app).get(`${APP}/registration/context`).set('Authorization', `Bearer ${reg.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.referralPrograms).toEqual({ learner: expect.any(Boolean), teacher: expect.any(Boolean), institute: false })
    const invites = res.body.data.invites as { inviteId: string; instituteName: string; staffRole: string; expired: boolean }[]
    expect(invites).toHaveLength(2)
    expect(invites.find((i) => i.inviteId === seed.inviteId)).toMatchObject({ instituteName: 'Seed Institute', staffRole: 'counsellor', expired: false })
    expect(invites.find((i) => i.inviteId === old.inviteId)!.expired).toBe(true)

    const nobody = await request(app).get(`${APP}/registration/context`).set('Authorization', `Bearer ${newReg().token}`)
    expect(nobody.body.data.invites).toEqual([])
  })
})

describe('POST /registration/institute (join)', () => {
  const joinBody = (inviteId: string, over: object = {}) => ({ mode: 'join', inviteId, fullName: 'Kavita Rao', consents: { terms: true, privacy: true, documentVersion: '2026-09' }, ...over })

  it('accepts a pending invite and tells the primary manager (T21.11)', async () => {
    const seed = await seedInstitute({ status: 'approved' })
    const reg = regFor(seed.invitePhone)
    const res = await register(reg, joinBody(seed.inviteId))
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data).toMatchObject({
      user: { role: 'institute_staff', profileId: seed.inviteId, fullName: 'Kavita Rao' },
      institute: { id: seed.instituteId, name: 'Seed Institute', verificationStatus: 'approved', staffRole: 'counsellor', isPrimary: false },
      nextStep: null,
    })
    const row = await db.selectFrom('institute_managers').select(['user_id', 'status', 'full_name', 'accepted_at']).where('id', '=', seed.inviteId).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ user_id: res.body.data.user.id, status: 'active', full_name: 'Kavita Rao' })
    expect(row.accepted_at).not.toBeNull()
    const user = await db.selectFrom('app_users').select(['user_type', 'phone']).where('id', '=', res.body.data.user.id).executeTakeFirstOrThrow()
    expect(user).toEqual({ user_type: 'institute_staff', phone: seed.invitePhone })
    const audit = await db.selectFrom('audit_logs').select('new_values').where('actor_id', '=', res.body.data.user.id).where('action', '=', 'app.institute_staff_joined').executeTakeFirstOrThrow()
    expect(audit.new_values).toEqual({ instituteId: seed.instituteId, staffId: seed.inviteId, staffRole: 'counsellor' })
    const note = await db.selectFrom('user_notifications').select(['title', 'body', 'deep_link', 'category']).where('user_id', '=', seed.ownerUserId).executeTakeFirstOrThrow()
    expect(note).toEqual({ title: 'Kavita Rao joined your team', body: 'They can now answer enquiries as Counsellor.', deep_link: '/institute/staff', category: 'account' })
    const me = await request(app).get(`${APP}/me`).set(bearer({ token: res.body.data.session.accessToken }))
    expect(me.body.data).toMatchObject({ role: 'institute_staff', institute: { id: seed.instituteId, staffRole: 'counsellor', isPrimary: false }, registration: { complete: true, nextStep: null } })
    // the invite cannot be used a second time
    const again = await register(regFor(seed.invitePhone), joinBody(seed.inviteId))
    expect(again.status).toBe(409) // the phone now has an account
  })

  it('rejects an invite older than 72 hours with invite_expired', async () => {
    const seed = await seedInstitute({ invitedAgoMs: 80 * HOUR })
    const res = await register(regFor(seed.invitePhone), joinBody(seed.inviteId))
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', details: { reason: 'invite_expired' } })
    expect((await db.selectFrom('institute_managers').select('status').where('id', '=', seed.inviteId).executeTakeFirstOrThrow()).status).toBe('invited')
  })

  it('treats a stranger\'s, unknown, used or disabled invite the same way', async () => {
    const seed = await seedInstitute()
    const strangerPhone = randomPhone()
    phones.push(strangerPhone)
    const wrongPhone = await register(regFor(strangerPhone), joinBody(seed.inviteId))
    expect(wrongPhone.status).toBe(422)
    expect(wrongPhone.body.error.details).toEqual([{ path: 'inviteId', message: 'This invite is no longer valid.' }])
    const unknown = await register(regFor(seed.invitePhone), joinBody(randomUUID()))
    expect(unknown.status).toBe(422)
    expect((await register(regFor(seed.invitePhone), joinBody('nope'))).status).toBe(422)

    await db.updateTable('institute_managers').set({ status: 'disabled' }).where('id', '=', seed.inviteId).execute()
    expect((await register(regFor(seed.invitePhone), joinBody(seed.inviteId))).status).toBe(422)

    const suspended = await seedInstitute({ accountStatus: 'suspended' })
    expect((await register(regFor(suspended.invitePhone), joinBody(suspended.inviteId))).status).toBe(422)
    const primary = await register(regFor(strangerPhone), joinBody(seed.primaryId)) // an existing active manager row is not an invite
    expect(primary.status).toBe(422)
  })

  it('validates the join body', async () => {
    const seed = await seedInstitute()
    for (const over of [{ fullName: 'K' }, { fullName: 'Kavita 9' }, { consents: { terms: false, privacy: true, documentVersion: '2026-09' } }, { inviteId: undefined }]) {
      expect((await register(regFor(seed.invitePhone), joinBody(seed.inviteId, over))).status, JSON.stringify(over)).toBe(422)
    }
  })
})

describe('PATCH /institute/registration/basics (BR-21.9)', () => {
  it('edits the basics while docs are requested, regenerating the slug and auditing masked changes (T21.13)', async () => {
    await db.deleteFrom('institutes').where('gstin', '=', GOOD_GSTIN).execute()
    const r = await registerOk({ institute: { gstin: GOOD_GSTIN } })
    await setInstitute(r.instituteId, { verification_status: 'docs_requested' })
    const res = await patch(r.token, { name: 'Apex JEE & NEET Academy', gstin: null, pincode: '560095' }, await versionOf(r.instituteId))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ id: r.instituteId, name: 'Apex JEE & NEET Academy', slug: 'apex-jee-neet-academy-koramangala', gstin: null, pincode: '560095', verificationStatus: 'docs_requested' })
    expect(res.body.data.updatedAt).toBeTruthy()
    const audit = await db.selectFrom('audit_logs').select('new_values').where('actor_id', '=', r.userId).where('action', '=', 'app.institute_basics_updated').executeTakeFirstOrThrow()
    const changes = (audit.new_values as { changes: Record<string, { old: unknown; new: unknown }> }).changes
    expect(changes.name).toEqual({ old: 'Apex JEE Academy', new: 'Apex JEE & NEET Academy' })
    expect(changes.gstin).toEqual({ old: 'XXXXXXXXXXXM1ZJ', new: null }) // only the last four characters are kept
    expect(JSON.stringify(audit.new_values)).not.toContain(GOOD_GSTIN)
    await db.deleteFrom('institutes').where('id', '=', r.instituteId).execute()
  })

  it('works in draft and keeps the slug when the name is unchanged', async () => {
    const r = await registerOk()
    const res = await patch(r.token, { addressLine: '4th Floor, New Road', email: null, instituteType: 'tuition_centre' }, await versionOf(r.instituteId))
    expect(res.status).toBe(200)
    expect(res.body.data.slug).toBe(r.data.institute.slug)
    const row = await db.selectFrom('institutes').select(['address_line', 'email', 'institute_type']).where('id', '=', r.instituteId).executeTakeFirstOrThrow()
    expect(row).toEqual({ address_line: '4th Floor, New Road', email: null, institute_type: 'tuition_centre' })
  })

  it('updates the owner name on the account and the primary manager row', async () => {
    const r = await registerOk()
    expect((await patch(r.token, { ownerName: 'Suresh K. Menon' }, await versionOf(r.instituteId))).status).toBe(200)
    expect((await db.selectFrom('app_users').select('full_name').where('id', '=', r.userId).executeTakeFirstOrThrow()).full_name).toBe('Suresh K. Menon')
    expect((await db.selectFrom('institute_managers').select('full_name').where('institute_id', '=', r.instituteId).executeTakeFirstOrThrow()).full_name).toBe('Suresh K. Menon')
  })

  it('is read-only once in review or approved (T21.13)', async () => {
    const r = await registerOk()
    for (const [status, reason] of [['pending', 'in_review'], ['under_review', 'in_review'], ['visit_scheduled', 'in_review'], ['evaluation_done', 'in_review'], ['approved', 'approved_use_profile']] as const) {
      await setInstitute(r.instituteId, { verification_status: status })
      const res = await patch(r.token, { name: 'Changed Name' }, await versionOf(r.instituteId))
      expect(res.status, status).toBe(409)
      expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', details: { reason } })
    }
  })

  it('forbids counsellors, other roles and missing auth', async () => {
    const seed = await seedInstitute({ status: 'draft' })
    const joined = await register(regFor(seed.invitePhone), { mode: 'join', inviteId: seed.inviteId, fullName: 'Kavita Rao', consents: { terms: true, privacy: true, documentVersion: '2026-09' } })
    const forbidden = await patch(joined.body.data.session.accessToken, { name: 'Hacked Name' }, await versionOf(seed.instituteId))
    expect(forbidden.status).toBe(403)
    expect(forbidden.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Only a manager can change these details.' })
    expect((await patch(parent.token, { name: 'Hacked Name' }, new Date().toISOString())).status).toBe(403)
    const t = await createTeacher(m)
    phones.push(t.phone)
    expect((await patch(t.token, { name: 'Hacked Name' }, new Date().toISOString())).status).toBe(403)
    expect((await request(app).patch(`${APP}/institute/registration/basics`).send({ name: 'x' })).status).toBe(401)
  })

  it('needs If-Match and rejects a stale one', async () => {
    const r = await registerOk()
    const v = await versionOf(r.instituteId)
    expect((await patch(r.token, { pincode: '560095' })).status).toBe(422)
    expect((await patch(r.token, { pincode: '560095' }, v)).status).toBe(200)
    const stale = await patch(r.token, { pincode: '560034' }, v)
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('VERSION_CONFLICT')
  })

  it('needs a new area and pin when the city changes, and re-checks the GSTIN state', async () => {
    await db.deleteFrom('institutes').where('gstin', 'in', [GOOD_GSTIN, '27AAPFU0939F1ZV']).execute()
    const r = await registerOk({ institute: { gstin: GOOD_GSTIN } })
    const mumbai = await db.selectFrom('cities').select(['id', 'name', 'latitude', 'longitude']).where('name', '=', 'Mumbai').executeTakeFirstOrThrow()
    const area = await db.insertInto('areas').values({ id: randomUUID(), city_id: mumbai.id, name: `Test Area ${randomUUID().slice(0, 6)}`, slug: `test-${randomUUID().slice(0, 8)}` }).returning('id').executeTakeFirstOrThrow()
    const noAreaOrPin = await patch(r.token, { cityId: mumbai.id }, await versionOf(r.instituteId))
    expect(noAreaOrPin.status).toBe(422)
    expect(noAreaOrPin.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['areaId', 'latitude'])

    // area and pin given, but the existing Karnataka GSTIN no longer matches the state
    const stateMismatch = await patch(r.token, { cityId: mumbai.id, areaId: area.id, latitude: Number(mumbai.latitude), longitude: Number(mumbai.longitude) }, await versionOf(r.instituteId))
    expect(stateMismatch.status).toBe(422)
    expect(stateMismatch.body.error.details).toEqual([{ path: 'gstin', message: 'This GSTIN is registered in another state.' }])

    const moved = await patch(r.token, { cityId: mumbai.id, areaId: area.id, latitude: Number(mumbai.latitude), longitude: Number(mumbai.longitude), gstin: '27AAPFU0939F1ZV' }, await versionOf(r.instituteId))
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    const row = await db.selectFrom('institutes').select(['city_id', 'area_id', 'gstin']).where('id', '=', r.instituteId).executeTakeFirstOrThrow()
    expect(row).toEqual({ city_id: mumbai.id, area_id: area.id, gstin: '27AAPFU0939F1ZV' })
    await db.deleteFrom('institutes').where('id', 'in', [r.instituteId]).execute()
    await db.deleteFrom('areas').where('id', '=', area.id).execute()
  })

  it('validates the patched fields, the pin distance and GSTIN uniqueness', async () => {
    await db.deleteFrom('institutes').where('gstin', '=', GOOD_GSTIN).execute()
    const taken = await registerOk({ institute: { gstin: GOOD_GSTIN } })
    await setInstitute(taken.instituteId, { verification_status: 'approved' })
    const r = await registerOk()
    for (const body of [{ name: 'ab' }, { pincode: '12' }, { latitude: 13.43 }, { latitude: 12.9, longitude: 777 }, { gstin: '29AAGCA4321M1ZK' }, { instituteType: 'gym' }, { unknown: 1 }, {}, { areaId: randomUUID() }]) {
      const res = await patch(r.token, body, await versionOf(r.instituteId))
      expect(res.status, JSON.stringify(body)).toBe(422)
    }
    const far = await patch(r.token, { latitude: 13.43, longitude: 77.62 }, await versionOf(r.instituteId))
    expect(far.body.error.details).toEqual([{ path: 'latitude', message: 'The pin is too far from Bengaluru. Move it to your institute.' }])
    const dup = await patch(r.token, { gstin: GOOD_GSTIN }, await versionOf(r.instituteId))
    expect(dup.status).toBe(409)
    expect(dup.body.error.details).toEqual({ reason: 'gstin_in_use', path: 'gstin' })
    await db.deleteFrom('institutes').where('id', '=', taken.instituteId).execute()
  })

  it('lets a rejected institute re-apply after 30 days, moving it back to draft (T21.14)', async () => {
    const r = await registerOk()
    await setInstitute(r.instituteId, { verification_status: 'rejected', rejected_at: new Date(Date.now() - 10 * DAY), rejection_reason_code: 'ADDRESS_NOT_FOUND', rejection_note: 'We could not find the address.' })
    const early = await patch(r.token, { addressLine: '5 New Road, Koramangala' }, await versionOf(r.instituteId))
    expect(early.status).toBe(409)
    expect(early.body.error.code).toBe('CONFLICT_STATE')
    expect(early.body.error.details.canReapplyAt).toBeTruthy()

    await setInstitute(r.instituteId, { rejected_at: new Date(Date.now() - 31 * DAY) })
    const res = await patch(r.token, { addressLine: '5 New Road, Koramangala' }, await versionOf(r.instituteId))
    expect(res.status).toBe(200)
    expect(res.body.data.verificationStatus).toBe('draft')
    const row = await db.selectFrom('institutes').select(['verification_status', 'rejection_reason_code', 'rejection_note']).where('id', '=', r.instituteId).executeTakeFirstOrThrow()
    expect(row).toEqual({ verification_status: 'draft', rejection_reason_code: null, rejection_note: null })
    const audit = await db.selectFrom('audit_logs').select('new_values').where('actor_id', '=', r.userId).where('action', '=', 'app.institute_reapplied').executeTakeFirstOrThrow()
    expect(audit.new_values).toEqual({ previousRejectionReasonCode: 'ADDRESS_NOT_FOUND' })
  })
})

describe('draft reminders (section 16)', () => {
  it('nudges the primary manager of an unsubmitted draft at 24 h, 72 h and 7 days, once each', async () => {
    const r = await registerOk()
    const created = (await db.selectFrom('institutes').select('created_at').where('id', '=', r.instituteId).executeTakeFirstOrThrow()).created_at
    const at = (ms: number) => new Date(created.getTime() + ms)
    const inbox = () => db.selectFrom('user_notifications').select(['title', 'body', 'deep_link', 'category', 'dedupe_key']).where('user_id', '=', r.userId).where('event_type', '=', 'institute.draft_reminder').orderBy('dedupe_key').execute()

    expect(await sendDraftReminders(at(5 * HOUR))).toBeGreaterThanOrEqual(0)
    expect(await inbox()).toEqual([])
    await sendDraftReminders(at(25 * HOUR))
    await sendDraftReminders(at(26 * HOUR)) // same milestone: nothing new
    await sendDraftReminders(at(73 * HOUR))
    await sendDraftReminders(at(8 * DAY))
    await sendDraftReminders(at(9 * DAY))
    const rows = await inbox()
    expect(rows.map((x) => x.dedupe_key)).toEqual([`institute_draft_reminder_24h:${r.instituteId}`, `institute_draft_reminder_72h:${r.instituteId}`, `institute_draft_reminder_7d:${r.instituteId}`])
    expect(rows[0]).toMatchObject({ title: 'Finish verifying Apex JEE Academy', body: 'Upload your documents so parents can find you.', deep_link: '/institute/documents', category: 'verification' })

    // stops as soon as the institute leaves draft
    const s = await registerOk()
    await setInstitute(s.instituteId, { verification_status: 'pending' })
    await sendDraftReminders(new Date(Date.now() + 2 * DAY))
    expect(await db.selectFrom('user_notifications').select('id').where('user_id', '=', s.userId).execute()).toEqual([])
  })
})
