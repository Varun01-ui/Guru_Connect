import { randomInt, randomUUID } from 'node:crypto'
import type { Express } from 'express'
import request from 'supertest'
import { db } from '../db/index.js'
import { signAppAccessToken } from '../lib/appJwt.js'

export const APP = '/api/v1/app'

// Seed data the mobile tests lean on (sql/seed/*.sql): classes 1-12, subjects with class ranges, boards, cities.
export type Masters = Awaited<ReturnType<typeof loadMasters>>

export async function loadMasters() {
  const id = async (table: 'classes' | 'subjects' | 'boards' | 'teacher_categories' | 'teaching_modes', column: string, value: string) => {
    const row = await db.selectFrom(table).select('id').where(column as 'id', '=', value).executeTakeFirst()
    if (!row) throw new Error(`Seed row missing: ${table}.${column}=${value}`)
    return row.id
  }

  const karnataka = await db.selectFrom('states').select('id').where('name', '=', 'Karnataka').executeTakeFirstOrThrow()
  const city = await db.selectFrom('cities').select(['id', 'name']).where('state_id', '=', karnataka.id).where('is_active', '=', true).executeTakeFirstOrThrow()
  const areas = await db.selectFrom('areas').select(['id', 'name']).where('city_id', '=', city.id).where('is_active', '=', true).orderBy('name').execute()
  // A second city in a different state, for "change city" tests.
  const otherCity = await db
    .selectFrom('cities')
    .select(['id', 'name', 'state_id'])
    .where('state_id', '!=', karnataka.id)
    .where('is_active', '=', true)
    .orderBy('name')
    .executeTakeFirstOrThrow()

  return {
    stateId: karnataka.id,
    city,
    areas,
    otherCity,
    classes: { five: await id('classes', 'name', 'Class 5'), nine: await id('classes', 'name', 'Class 9'), eleven: await id('classes', 'name', 'Class 11') },
    subjects: {
      maths: await id('subjects', 'name', 'Mathematics'),
      english: await id('subjects', 'name', 'English'),
      physics: await id('subjects', 'name', 'Physics'),
      chemistry: await id('subjects', 'name', 'Chemistry'),
      evs: await id('subjects', 'name', 'EVS'),
      science: await id('subjects', 'name', 'Science'),
      hindi: await id('subjects', 'name', 'Hindi'),
      computer: await id('subjects', 'name', 'Computer Science'),
      biology: await id('subjects', 'name', 'Biology'),
    },
    boards: {
      cbse: await id('boards', 'short_name', 'CBSE'),
      karnataka: await id('boards', 'short_name', 'Karnataka State Board'),
      maharashtra: await id('boards', 'short_name', 'Maharashtra State Board'),
    },
    categories: {
      homeTutor: await id('teacher_categories', 'name', 'Home Tutor'),
      schoolTeacher: await id('teacher_categories', 'name', 'School Teacher'),
      coaching: await id('teacher_categories', 'name', 'Coaching Faculty'),
      language: await id('teacher_categories', 'name', 'Language Trainer'),
      coding: await id('teacher_categories', 'name', 'Coding & Skills Mentor'),
    },
    modes: { home: await id('teaching_modes', 'name', 'Home tuition'), online: await id('teaching_modes', 'name', 'Online') },
  }
}

export type TestParent = {
  userId: string
  parentId: string
  token: string
  phone: string
  email: string
}

export async function createParent(
  m: Masters,
  overrides: { fullName?: string; areaId?: string | null; cityId?: string | null; stateId?: string | null; role?: 'parent' | 'teacher' } = {},
): Promise<TestParent> {
  const phone = `+9199${randomInt(10_000_000, 99_999_999)}`
  const email = `lakshmi.${randomUUID().slice(0, 8)}@example.com`
  const fullName = overrides.fullName ?? 'Lakshmi Venkatesh'

  const user = await db
    .insertInto('app_users')
    .values({ user_type: overrides.role ?? 'parent', phone, email, full_name: fullName, signup_source: 'organic' })
    .returning('id')
    .executeTakeFirstOrThrow()

  const parent = await db
    .insertInto('parents')
    .values({
      user_id: user.id,
      full_name: fullName,
      phone,
      email,
      state_id: overrides.stateId === undefined ? m.stateId : overrides.stateId,
      city_id: overrides.cityId === undefined ? m.city.id : overrides.cityId,
      area_id: overrides.areaId === undefined ? (m.areas[0]?.id ?? null) : overrides.areaId,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const token = signAppAccessToken({ sub: user.id, role: overrides.role ?? 'parent', pid: overrides.role === 'teacher' ? '' : parent.id, sid: randomUUID() })
  return { userId: user.id, parentId: parent.id, token, phone, email }
}

export async function deleteParent(p: TestParent) {
  await db.deleteFrom('user_notifications').where('user_id', '=', p.userId).execute()
  await db.deleteFrom('parents').where('id', '=', p.parentId).execute() // cascades to children and their join rows
  await db.deleteFrom('app_users').where('id', '=', p.userId).execute()
}

export const bearer = (p: { token: string }) => ({ Authorization: `Bearer ${p.token}` })


// ---- file uploads ----

// Smallest byte strings that pass the confirm step's content sniffing for each type.
export const SAMPLE_BYTES = {
  'image/jpeg': (size = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(size - 4, 0), 1)]),
  'image/png': (size = 64) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(Math.max(size - 8, 0), 1)]),
  'image/webp': (size = 64) => Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(Math.max(size - 12, 0), 1)]),
  'application/pdf': (size = 64) => Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.alloc(Math.max(size - 9, 0), 32)]),
} as const

// A presigned URL is absolute; supertest wants just the path and query.
export const pathOf = (url: string) => {
  const u = new URL(url)
  return `${u.pathname}${u.search}`
}

export async function presignFile(app: Express, p: { token: string }, body: { purpose: string; mimeType: string; sizeBytes: number; fileName?: string }) {
  return request(app)
    .post(`${APP}/uploads/presign`)
    .set(bearer(p))
    .send({ ...body, fileName: body.fileName ?? 'photo.jpg' })
}

// Full happy path: presign -> PUT the bytes to the signed URL -> confirm. Returns the confirm response.
export async function uploadFile(
  app: Express,
  p: { token: string },
  opts: { purpose?: string; mimeType?: keyof typeof SAMPLE_BYTES; bytes?: Buffer; fileName?: string } = {},
) {
  const mimeType = opts.mimeType ?? 'image/jpeg'
  const bytes = opts.bytes ?? SAMPLE_BYTES[mimeType](200)
  const presigned = await presignFile(app, p, { purpose: opts.purpose ?? 'avatar', mimeType, sizeBytes: bytes.length, fileName: opts.fileName })
  if (presigned.status !== 201) throw new Error(`presign failed: ${presigned.status} ${JSON.stringify(presigned.body)}`)
  const put = await request(app).put(pathOf(presigned.body.data.uploadUrl)).set('Content-Type', mimeType).send(bytes)
  if (put.status !== 200) throw new Error(`PUT failed: ${put.status} ${JSON.stringify(put.body)}`)
  const confirmed = await request(app).post(`${APP}/uploads/${presigned.body.data.fileId}/confirm`).set(bearer(p))
  return { presigned, confirmed, fileId: presigned.body.data.fileId as string }
}


// ---- student / teacher fixtures ----

import { smsOutbox } from '../lib/providers/sms.js'
import { signRegistrationToken } from '../lib/appJwt.js'
import { sql } from 'kysely'

// A valid Indian mobile number nobody else in the suite uses.
export const randomPhone = () => `+91${6 + randomInt(0, 4)}${randomInt(100_000_000, 999_999_999)}`

export const registrationToken = (phone: string, contactType: 'phone' | 'email' | 'google' = 'phone') => signRegistrationToken({ sub: phone, contactType })

// The 6-digit code in the latest SMS sent to a number (the dev SMS provider records messages in test mode).
export function lastSmsCode(to: string): string {
  const msg = [...smsOutbox].reverse().find((m) => m.to === to)
  const code = msg?.text.match(/\b(\d{6})\b/)?.[1]
  if (!code) throw new Error(`No SMS with a code was sent to ${to}`)
  return code
}

// Removes everything the M10–M15 tests create for these users, in foreign-key order. Safe to call with ids that no
// longer exist. App users are matched by phone so a half-failed test still gets cleaned up.
export async function purgeUsersByPhone(phones: string[]) {
  if (phones.length === 0) return
  const users = await db.selectFrom('app_users').select('id').where('phone', 'in', phones).execute()
  const ids = users.map((u) => u.id)
  if (ids.length === 0) return
  const teacherIds = (await db.selectFrom('teachers').select('id').where('user_id', 'in', ids).execute()).map((t) => t.id)
  if (teacherIds.length) {
    await db.updateTable('teachers').set({ registration_transaction_id: null }).where('id', 'in', teacherIds).execute()
    await db.updateTable('teacher_qualifications').set({ document_id: null }).where('teacher_id', 'in', teacherIds).execute()
    await db.deleteFrom('teacher_verification_logs').where('teacher_id', 'in', teacherIds).execute()
    await db.deleteFrom('teacher_documents').where('teacher_id', 'in', teacherIds).execute()
    for (const table of ['teacher_qualifications', 'teacher_subjects', 'teacher_classes', 'teacher_teaching_modes', 'teacher_locations'] as const) {
      await db.deleteFrom(table).where('teacher_id', 'in', teacherIds).execute()
    }
  }
  await db.deleteFrom('demo_requests').where('requester_user_id', 'in', ids).execute()
  if (teacherIds.length) await db.deleteFrom('demo_requests').where('teacher_id', 'in', teacherIds).execute()
  await db.deleteFrom('teacher_reviews').where('author_user_id', 'in', ids).execute()
  await db.deleteFrom('leads').where('requester_user_id', 'in', ids).execute()
  if (teacherIds.length) await db.deleteFrom('leads').where('teacher_id', 'in', teacherIds).execute()
  await db.deleteFrom('refunds').where('transaction_id', 'in', db.selectFrom('transactions').select('id').where('user_id', 'in', ids)).execute()
  await db.deleteFrom('wallet_ledger').where('user_id', 'in', ids).execute()
  await db.deleteFrom('subscriptions').where('user_id', 'in', ids).execute()
  await db.deleteFrom('referrals').where('referee_user_id', 'in', ids).execute()
  await db.deleteFrom('institute_managers').where('user_id', 'in', ids).execute()
  await db.deleteFrom('institutes').where('phone', 'in', phones).execute()
  await db.deleteFrom('students').where('user_id', 'in', ids).execute()
  await db.deleteFrom('teachers').where('user_id', 'in', ids).execute()
  await db.deleteFrom('transactions').where('user_id', 'in', ids).execute()
  await db.deleteFrom('files').where('uploaded_by_id', 'in', ids).execute()
  await db.deleteFrom('user_notifications').where('user_id', 'in', ids).execute()
  await db.deleteFrom('user_auth_identities').where('user_id', 'in', ids).execute()
  await db.deleteFrom('app_sessions').where('user_id', 'in', ids).execute()
  await db.deleteFrom('parents').where('user_id', 'in', ids).execute()
  await sql`DELETE FROM audit_logs WHERE actor_type = 'app_user' AND actor_id = ANY(${ids}::uuid[])`.execute(db)
  await db.deleteFrom('app_users').where('id', 'in', ids).execute()
}

export type TestTeacher = { userId: string; teacherId: string; phone: string; token: string }

// A teacher row for ranking/registration tests. `approved` teachers also get the optional listing data passed in.
export async function createTeacher(
  m: Masters,
  over: { status?: 'draft' | 'pending' | 'under_review' | 'approved' | 'reupload_requested' | 'rejected'; account?: 'active' | 'suspended'; categoryId?: string; trust?: number; ratingAvg?: number; verified?: boolean; classIds?: string[]; subjectIds?: string[]; cityId?: string | null; areaId?: string | null; fullName?: string } = {},
): Promise<TestTeacher> {
  const phone = randomPhone()
  const fullName = over.fullName ?? 'Meera Nair'
  const user = await db.insertInto('app_users').values({ user_type: 'teacher', phone, full_name: fullName, signup_source: 'organic' }).returning('id').executeTakeFirstOrThrow()
  const teacher = await db
    .insertInto('teachers')
    .values({
      user_id: user.id,
      full_name: fullName,
      phone,
      category_id: over.categoryId ?? m.categories.homeTutor,
      verification_status: over.status ?? 'approved',
      account_status: over.account ?? 'active',
      is_verified_badge: over.verified ?? false,
      rating_avg: over.ratingAvg === undefined ? null : String(over.ratingAvg),
      trust_score: over.trust === undefined ? null : String(over.trust),
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  for (const classId of over.classIds ?? []) await db.insertInto('teacher_classes').values({ teacher_id: teacher.id, class_id: classId }).execute()
  let first = true
  for (const subjectId of over.subjectIds ?? []) {
    await db.insertInto('teacher_subjects').values({ teacher_id: teacher.id, subject_id: subjectId, is_primary: first }).execute()
    first = false
  }
  const cityId = over.cityId === undefined ? m.city.id : over.cityId
  if (cityId) await db.insertInto('teacher_locations').values({ teacher_id: teacher.id, city_id: cityId, area_id: over.areaId ?? null, is_primary: true }).execute()
  if (over.trust !== undefined) {
    await sql`INSERT INTO trust_scores (teacher_id, score, computed_score, weights_version) VALUES (${teacher.id}, ${over.trust}, ${over.trust}, 1)`.execute(db)
  }
  const token = signAppAccessToken({ sub: user.id, role: 'teacher', pid: teacher.id, sid: randomUUID() })
  return { userId: user.id, teacherId: teacher.id, phone, token }
}

export type TestStudent = { userId: string; studentId: string; phone: string; token: string }

export async function createStudent(
  m: Masters,
  over: { parentalConsent?: 'not_required' | 'pending' | 'confirmed' | 'declined'; parentId?: string | null; parentLinkStatus?: 'none' | 'pending' | 'confirmed'; classId?: string } = {},
): Promise<TestStudent> {
  const phone = randomPhone()
  const user = await db.insertInto('app_users').values({ user_type: 'student', phone, full_name: 'Aarav Kumar', signup_source: 'organic' }).returning('id').executeTakeFirstOrThrow()
  const student = await db
    .insertInto('students')
    .values({
      user_id: user.id,
      full_name: 'Aarav Kumar',
      phone,
      class_id: over.classId ?? m.classes.eleven,
      city_id: m.city.id,
      parental_consent: over.parentalConsent ?? 'not_required',
      parent_id: over.parentId ?? null,
      parent_link_status: over.parentLinkStatus ?? 'none',
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const token = signAppAccessToken({ sub: user.id, role: 'student', pid: student.id, sid: randomUUID() })
  return { userId: user.id, studentId: student.id, phone, token }
}
