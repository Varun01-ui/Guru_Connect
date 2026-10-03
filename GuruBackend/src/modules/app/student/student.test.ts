import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../app.js'
import { db, pool } from '../../../db/index.js'
import { kvDel, kvGet } from '../../../lib/kv.js'
import { hitRateLimit } from '../../../lib/rateLimit.js'
import { smsOutbox } from '../../../lib/providers/sms.js'
import { APP, bearer, createParent, deleteParent, lastSmsCode, loadMasters, purgeUsersByPhone, randomPhone, registrationToken } from '../../../test/appHelpers.js'
import type { Masters, TestParent } from '../../../test/appHelpers.js'
import { assertParentalConsentAllows, coldStartKey } from './student.service.js'

const app = createApp()
const phones: string[] = []
let m: Masters
let parent: TestParent

const reg = (phone: string, body: Record<string, unknown>, token = registrationToken(phone).token) =>
  request(app).post(`${APP}/registration/student`).set('Authorization', `Bearer ${token}`).send(body)

const base = (over: Record<string, unknown> = {}) => ({
  fullName: 'Aarav Kumar',
  classId: m.classes.five,
  cityId: m.city.id,
  parentName: 'Lakshmi Venkatesh',
  parentPhone: randomPhone(),
  subjectIds: [m.subjects.maths],
  consents: { terms: true, privacyPolicy: true, marketing: false },
  ...over,
})

async function newMinor(over: Record<string, unknown> = {}) {
  const phone = randomPhone()
  phones.push(phone)
  const body = base(over)
  const res = await reg(phone, body)
  expect(res.status).toBe(201)
  return { phone, body, res, token: res.body.data.accessToken as string, studentId: res.body.data.studentId as string, parentPhone: body.parentPhone as string }
}

beforeAll(async () => {
  m = await loadMasters()
  parent = await createParent(m)
})

afterAll(async () => {
  await purgeUsersByPhone(phones)
  await deleteParent(parent)
  await pool.end()
})

describe('POST /registration/student', () => {
  it('creates a minor with pending consent, sends the parent an SMS and signs them in (T11.1)', async () => {
    const { res, phone, parentPhone, studentId } = await newMinor()
    expect(res.body.data).toMatchObject({ role: 'student', parentalConsent: 'pending', nextStep: 'parent_consent' })
    expect(res.body.data.parentPhoneMasked).toMatch(/XXXXX$/)
    expect(res.body.data.publicCode).toMatch(/^GC-S/)
    expect(res.body.data.refreshToken).toBeTruthy()

    expect(lastSmsCode(parentPhone)).toMatch(/^\d{6}$/)
    const user = await db.selectFrom('app_users').selectAll().where('phone', '=', phone).executeTakeFirstOrThrow()
    expect(user.user_type).toBe('student')
    const consents = await db.selectFrom('user_consents').select('consent_type').where('user_id', '=', user.id).execute()
    expect(consents.map((c) => c.consent_type).sort()).toEqual(['privacy_policy', 'terms']) // never parental/minor consent at submission
    const challenge = await db.selectFrom('otp_challenges').selectAll().where('user_id', '=', user.id).executeTakeFirstOrThrow()
    expect(challenge.purpose).toBe('parent_consent')
    expect(challenge.destination).toBe(parentPhone)
    expect(challenge.code_hash).not.toContain(lastSmsCode(parentPhone))
    const audit = await db.selectFrom('audit_logs').select('module').where('actor_id', '=', user.id).where('action', '=', 'app.student_registered').executeTakeFirst()
    expect(audit?.module).toBe('app.student_registration')

    const me = await request(app).get(`${APP}/me`).set('Authorization', `Bearer ${res.body.data.accessToken}`)
    expect(me.body.data.student).toEqual({ parentalConsent: 'pending' })
    expect(me.body.data.profileId).toBe(studentId)
  })

  it('needs no consent from Class 11 (T11.2)', async () => {
    const phone = randomPhone()
    phones.push(phone)
    const res = await reg(phone, base({ classId: m.classes.eleven, parentName: undefined, parentPhone: undefined }))
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ parentalConsent: 'not_required', parentPhoneMasked: null, nextStep: null })
    const n = await db.selectFrom('otp_challenges').select('id').where('destination', '=', phone).execute()
    expect(n).toHaveLength(0)
  })

  it('treats Class 9 as the first class that needs no consent', async () => {
    const phone = randomPhone()
    phones.push(phone)
    const res = await reg(phone, base({ classId: m.classes.nine, parentName: undefined, parentPhone: undefined }))
    expect(res.body.data.parentalConsent).toBe('not_required')
  })

  it('links a matching parent account as pending (T11.6)', async () => {
    const { phone } = await newMinor({ parentPhone: parent.phone })
    const s = await db.selectFrom('students').select(['parent_id', 'parent_link_status']).where('phone', '=', phone).executeTakeFirstOrThrow()
    expect(s).toEqual({ parent_id: parent.parentId, parent_link_status: 'pending' })
  })

  it('leaves the link unset when no parent account matches', async () => {
    const { phone } = await newMinor()
    const s = await db.selectFrom('students').select(['parent_id', 'parent_link_status']).where('phone', '=', phone).executeTakeFirstOrThrow()
    expect(s).toEqual({ parent_id: null, parent_link_status: 'none' })
  })

  it('stores the optional marketing consent and the cold-start subjects (T11.11)', async () => {
    const { phone } = await newMinor({ consents: { terms: true, privacyPolicy: true, marketing: true }, subjectIds: [m.subjects.maths, m.subjects.english] })
    const user = await db.selectFrom('app_users').select('id').where('phone', '=', phone).executeTakeFirstOrThrow()
    const types = (await db.selectFrom('user_consents').select('consent_type').where('user_id', '=', user.id).execute()).map((c) => c.consent_type)
    expect(types).toContain('marketing')
    expect(JSON.parse((await kvGet(coldStartKey(user.id)))!)).toEqual([m.subjects.maths, m.subjects.english])
  })

  it('rejects a second submit with the same registration token as AUTH_REQUIRED', async () => {
    const phone = randomPhone()
    phones.push(phone)
    const { token } = registrationToken(phone)
    expect((await reg(phone, base(), token)).status).toBe(201)
    const again = await reg(phone, base(), token)
    expect(again.status).toBe(401)
    expect(again.body.error.code).toBe('AUTH_REQUIRED')
  })

  it('rejects a missing or invalid registration token', async () => {
    expect((await request(app).post(`${APP}/registration/student`).send(base())).status).toBe(401)
    expect((await reg(randomPhone(), base(), 'garbage')).status).toBe(401)
  })

  it('requires a verified phone contact', async () => {
    const res = await reg('a@b.com', base(), registrationToken('a@b.com', 'email').token)
    expect(res.status).toBe(422)
  })

  it('requires parent name and phone when the class needs consent', async () => {
    const noPhone = await reg(randomPhone(), base({ parentPhone: undefined }))
    expect(noPhone.status).toBe(422)
    expect(noPhone.body.error.code).toBe('VALIDATION_FAILED')
    expect(noPhone.body.error.details[0].path).toBe('parentPhone')
    const noName = await reg(randomPhone(), base({ parentName: undefined }))
    expect(noName.body.error.details[0].path).toBe('parentName')
  })

  it("rejects the student's own number as the parent's", async () => {
    const phone = randomPhone()
    const res = await reg(phone, base({ parentPhone: phone }))
    expect(res.status).toBe(422)
    expect(res.body.error.details[0]).toEqual({ path: 'parentPhone', message: "This can't be your own number." })
  })

  it('validates the other fields', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ fullName: 'A' }, 'fullName'],
      [{ fullName: 'Aarav 123' }, 'fullName'],
      [{ classId: '00000000-0000-4000-8000-000000000000' }, 'classId'],
      [{ boardId: '00000000-0000-4000-8000-000000000000' }, 'boardId'],
      [{ subjectIds: Array.from({ length: 7 }, () => m.subjects.maths) }, 'subjectIds'],
      [{ subjectIds: [m.subjects.maths, m.subjects.maths] }, 'subjectIds'],
      [{ cityId: '00000000-0000-4000-8000-000000000000' }, 'cityId'],
      [{ areaId: '00000000-0000-4000-8000-000000000000' }, 'areaId'],
      [{ parentPhone: '12345' }, 'parentPhone'],
      [{ schoolName: 'x'.repeat(121) }, 'schoolName'],
      [{ consents: { terms: false, privacyPolicy: true } }, 'consents.terms'],
      [{ consents: { terms: true, privacyPolicy: false } }, 'consents.privacyPolicy'],
    ]
    for (const [over, path] of cases) {
      const res = await reg(randomPhone(), base(over))
      expect(res.status, path).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
      expect(JSON.stringify(res.body.error.details)).toContain(path)
    }
  })

  it('rejects a phone that already has an account', async () => {
    const res = await reg(parent.phone, base())
    expect(res.status).toBe(401)
  })
})

describe('parent consent request / verify', () => {
  it('confirms consent with the right code (T11.1)', async () => {
    const s = await newMinor()
    const code = lastSmsCode(s.parentPhone)
    const res = await request(app).post(`${APP}/student/parent-consent/verify`).set(bearer({ token: s.token })).send({ code })
    expect(res.status).toBe(200)
    expect(res.body.data.parentalConsent).toBe('confirmed')
    expect(res.body.data.parentalConsentAt).toBeTruthy()

    const row = await db.selectFrom('students').select(['parental_consent', 'parental_consent_at']).where('id', '=', s.studentId).executeTakeFirstOrThrow()
    expect(row.parental_consent).toBe('confirmed')
    const user = await db.selectFrom('students').select('user_id').where('id', '=', s.studentId).executeTakeFirstOrThrow()
    const consents = await db.selectFrom('user_consents').select(['consent_type', 'method', 'guardian_phone', 'granted']).where('user_id', '=', user.user_id).where('method', '=', 'otp').execute()
    expect(consents.map((c) => c.consent_type).sort()).toEqual(['data_processing_minor', 'parental_consent'])
    expect(consents.every((c) => c.granted && c.guardian_phone === s.parentPhone)).toBe(true)
    const note = await db.selectFrom('user_notifications').select('event_type').where('user_id', '=', user.user_id).executeTakeFirst()
    expect(note?.event_type).toBe('student.parental_consent_confirmed')
    const audit = await db.selectFrom('audit_logs').select('new_values').where('actor_id', '=', user.user_id).where('action', '=', 'app.parental_consent_confirmed').executeTakeFirstOrThrow()
    expect(JSON.stringify(audit.new_values ?? {})).not.toContain(code)

    const again = await request(app).post(`${APP}/student/parent-consent/verify`).set(bearer({ token: s.token })).send({ code })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('CONFLICT_STATE')
  })

  it('reports attempts left on a wrong code, then locks after 5 and unlocks later (T11.4)', async () => {
    const s = await newMinor()
    const code = lastSmsCode(s.parentPhone)
    const wrong = code === '000000' ? '111111' : '000000'
    const verify = (c: string) => request(app).post(`${APP}/student/parent-consent/verify`).set(bearer({ token: s.token })).send({ code: c })

    const first = await verify(wrong)
    expect(first.status).toBe(422)
    expect(first.body.error).toMatchObject({ code: 'OTP_INVALID', details: { attemptsLeft: 4 } })
    for (let i = 0; i < 3; i++) await verify(wrong)
    const fifth = await verify(wrong)
    expect(fifth.status).toBe(429)
    expect(fifth.body.error.code).toBe('OTP_LOCKED')

    const duringLock = await verify(code)
    expect(duringLock.status).toBe(429)
    expect(duringLock.body.error.code).toBe('OTP_LOCKED')

    await kvDel(`consent:lock:${s.studentId}`) // the 15 minutes pass
    expect((await verify(code)).status).toBe(200)
  })

  it('rejects a malformed code', async () => {
    const s = await newMinor()
    const res = await request(app).post(`${APP}/student/parent-consent/verify`).set(bearer({ token: s.token })).send({ code: '12ab' })
    expect(res.status).toBe(422)
  })

  it('returns OTP_EXPIRED once the code is older than 24 hours', async () => {
    const s = await newMinor()
    const code = lastSmsCode(s.parentPhone)
    await db.updateTable('otp_challenges').set({ expires_at: new Date(Date.now() - 1000) }).where('destination', '=', s.parentPhone).execute()
    const res = await request(app).post(`${APP}/student/parent-consent/verify`).set(bearer({ token: s.token })).send({ code })
    expect(res.status).toBe(410)
    expect(res.body.error.code).toBe('OTP_EXPIRED')
  })

  it('resend: second call within the cooldown is RATE_LIMITED and the new code replaces the old (T11.5)', async () => {
    const s = await newMinor()
    const oldCode = lastSmsCode(s.parentPhone)
    const r1 = await request(app).post(`${APP}/student/parent-consent/request`).set(bearer({ token: s.token }))
    expect(r1.status).toBe(200)
    const r2 = await request(app).post(`${APP}/student/parent-consent/request`).set(bearer({ token: s.token }))
    expect(r2.status).toBe(429)
    expect(r2.body.error.code).toBe('RATE_LIMITED')

    const newCode = lastSmsCode(s.parentPhone)
    if (newCode !== oldCode) {
      const stale = await request(app).post(`${APP}/student/parent-consent/verify`).set(bearer({ token: s.token })).send({ code: oldCode })
      expect(stale.body.error.code).toBe('OTP_INVALID')
    }
    const ok = await request(app).post(`${APP}/student/parent-consent/verify`).set(bearer({ token: s.token })).send({ code: newCode })
    expect(ok.status).toBe(200)
    const resends = await db.selectFrom('audit_logs').select('id').where('action', '=', 'app.parental_consent_requested').where('entity_id', '=', s.studentId).execute()
    expect(resends).toHaveLength(1)
  })

  it('caps codes per hour', async () => {
    const s = await newMinor()
    for (let i = 0; i < 5; i++) await hitRateLimit(`consent-otp-hour:${s.studentId}`, 5, 60 * 60 * 1000)
    const res = await request(app).post(`${APP}/student/parent-consent/request`).set(bearer({ token: s.token }))
    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('OTP_LOCKED')
  })

  it('request on an account that needs no consent is CONFLICT_STATE', async () => {
    const phone = randomPhone()
    phones.push(phone)
    const reg11 = await reg(phone, base({ classId: m.classes.eleven, parentName: undefined, parentPhone: undefined }))
    const token = reg11.body.data.accessToken
    const res = await request(app).post(`${APP}/student/parent-consent/request`).set(bearer({ token }))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT_STATE')
  })

  it('is student-only', async () => {
    for (const path of ['request', 'verify']) {
      const res = await request(app).post(`${APP}/student/parent-consent/${path}`).set(bearer(parent)).send({ code: '123456' })
      expect(res.status).toBe(403)
    }
    expect((await request(app).post(`${APP}/student/parent-consent/request`)).status).toBe(401)
  })

  it('gates contact actions on the consent status (hook for M37/M38, T11.3)', async () => {
    const s = await newMinor()
    await expect(assertParentalConsentAllows(s.studentId)).rejects.toMatchObject({ status: 403, details: { reason: 'parental_consent_pending' } })
    await db.updateTable('students').set({ parental_consent: 'declined' }).where('id', '=', s.studentId).execute()
    await expect(assertParentalConsentAllows(s.studentId)).rejects.toMatchObject({ details: { reason: 'parental_consent_declined' } })
    await db.updateTable('students').set({ parental_consent: 'confirmed' }).where('id', '=', s.studentId).execute()
    await expect(assertParentalConsentAllows(s.studentId)).resolves.toBeUndefined()
    expect(smsOutbox.length).toBeGreaterThan(0)
  })
})
