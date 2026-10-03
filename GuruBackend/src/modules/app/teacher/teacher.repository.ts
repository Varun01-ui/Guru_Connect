import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { db } from '../../../db/index.js'
import type { DB } from '../../../db/types.js'
import type { AppTrx } from '../registration/registration.repository.js'

type Executor = Kysely<DB>

const TEACHER_COLUMNS = [
  'id',
  'user_id',
  'public_code',
  'full_name',
  'gender',
  'email',
  'phone',
  'category_id',
  'highest_qualification',
  'experience_years',
  'bio',
  'languages',
  'fee_per_hour_paise',
  'demo_available',
  'verification_status',
  'profile_completeness',
  'profile_photo_file_id',
  'registration_transaction_id',
  'submitted_at',
  'updated_at',
] as const

export function findTeacher(teacherId: string, executor: Executor = db) {
  return executor
    .selectFrom('teachers')
    .select(TEACHER_COLUMNS)
    .select(sql<string | null>`date_of_birth::text`.as('date_of_birth'))
    .where('id', '=', teacherId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
}

// Locks the teacher row for the rest of the transaction so concurrent writes see a consistent status.
export function lockTeacher(trx: AppTrx, teacherId: string) {
  return trx
    .selectFrom('teachers')
    .select(['id', 'user_id', 'verification_status'])
    .select(sql<string | null>`date_of_birth::text`.as('date_of_birth'))
    .where('id', '=', teacherId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst()
}

export function isCategoryActive(categoryId: string) {
  return db.selectFrom('teacher_categories').select('id').where('id', '=', categoryId).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirst()
}

export function insertTeacherTx(trx: AppTrx, input: { userId: string; fullName: string; phone: string; gender: string; dateOfBirth: string; categoryId: string }) {
  return trx
    .insertInto('teachers')
    .values({
      user_id: input.userId,
      full_name: input.fullName,
      phone: input.phone,
      gender: input.gender as 'female',
      date_of_birth: input.dateOfBirth,
      category_id: input.categoryId,
      verification_status: 'draft',
      account_status: 'active',
      profile_completeness: 0,
    })
    .returning(['id', 'public_code'])
    .executeTakeFirstOrThrow()
}

// ---- progress (BR-14.3 / BR-14.4) ----

export async function loadProgressInputs(teacherId: string, executor: Executor = db) {
  const [teacher, qualifications, subjects, classes, modes, locations] = await Promise.all([
    executor
      .selectFrom('teachers')
      .select(['full_name', 'gender', 'date_of_birth', 'category_id', 'experience_years', 'highest_qualification', 'verification_status'])
      .where('id', '=', teacherId)
      .executeTakeFirstOrThrow(),
    executor.selectFrom('teacher_qualifications').select(db.fn.countAll<number>().as('n')).where('teacher_id', '=', teacherId).where('deleted_at', 'is', null).executeTakeFirstOrThrow(),
    executor.selectFrom('teacher_subjects').select(db.fn.countAll<number>().as('n')).where('teacher_id', '=', teacherId).executeTakeFirstOrThrow(),
    executor.selectFrom('teacher_classes').select(db.fn.countAll<number>().as('n')).where('teacher_id', '=', teacherId).executeTakeFirstOrThrow(),
    executor
      .selectFrom('teacher_teaching_modes as tm')
      .innerJoin('teaching_modes as m', 'm.id', 'tm.teaching_mode_id')
      .select(['m.requires_location', 'm.code'])
      .where('tm.teacher_id', '=', teacherId)
      .execute(),
    executor.selectFrom('teacher_locations').select(db.fn.countAll<number>().as('n')).where('teacher_id', '=', teacherId).executeTakeFirstOrThrow(),
  ])
  return { teacher, qualifications: Number(qualifications.n), subjects: Number(subjects.n), classes: Number(classes.n), modes, locations: Number(locations.n) }
}

// ---- profile completeness (M14 BR-14.9 / M17 BR-17.5, Admin FR-17.8) ----

export type CompletenessItem = { key: string; label: string; nextLabel: string; earned: number; of: number }

// One row per factor, in a stable order. The same weights drive the stored percentage, the Profile tab checklist and
// the dashboard's "next item" nudge, so the three can never disagree.
export async function completenessItems(executor: Executor, teacherId: string): Promise<CompletenessItem[]> {
  const result = await sql<Record<string, boolean>>`
    select
      t.profile_photo_file_id is not null as photo,
      char_length(coalesce(t.bio, '')) >= 100 as bio,
      exists (select 1 from teacher_qualifications q where q.teacher_id = t.id and q.deleted_at is null) as qualification,
      t.experience_years is not null as experience,
      exists (select 1 from teacher_subjects s where s.teacher_id = t.id) as subjects,
      exists (select 1 from teacher_classes c where c.teacher_id = t.id) as classes,
      (exists (select 1 from teacher_locations l where l.teacher_id = t.id)
        or (exists (select 1 from teacher_teaching_modes tm where tm.teacher_id = t.id)
            and not exists (select 1 from teacher_teaching_modes tm join teaching_modes m on m.id = tm.teaching_mode_id where tm.teacher_id = t.id and m.requires_location))) as locations,
      (t.fee_per_hour_paise is not null
        or exists (select 1 from teacher_fee_plans f where f.teacher_id = t.id and f.is_active and f.deleted_at is null)) as fee,
      cardinality(t.languages) > 0 as languages,
      exists (select 1 from teacher_documents d where d.teacher_id = t.id and d.is_current and d.status = 'approved' and d.doc_type = 'education_certificate') as certificate
    from teachers t where t.id = ${teacherId}`.execute(executor)
  const row = result.rows[0] ?? {}
  const factors: [string, string, string, number][] = [
    ['photo', 'A profile photo', 'Add a profile photo', 15],
    ['bio', 'An About section (100+ characters)', 'Write your About section', 10],
    ['qualification', 'A qualification', 'Add a qualification', 10],
    ['experience', 'Years of experience', 'Add your experience', 5],
    ['subjects', 'Subjects you teach', 'Add your subjects', 15],
    ['classes', 'Classes you teach', 'Add your classes', 10],
    ['locations', 'A teaching location', 'Add where you teach', 10],
    ['fee', 'Your fees', 'Add your fees', 5],
    ['languages', 'Languages you speak', 'Add your languages', 5],
    ['certificate', 'An approved certificate', 'Get a certificate approved', 15],
  ]
  return factors.map(([key, label, nextLabel, of]) => ({ key, label, nextLabel, earned: row[key] ? of : 0, of }))
}

export async function recomputeCompleteness(executor: Executor, teacherId: string): Promise<number> {
  const items = await completenessItems(executor, teacherId)
  const pct = Math.min(100, items.reduce((sum, i) => sum + i.earned, 0))
  await executor.updateTable('teachers').set({ profile_completeness: pct }).where('id', '=', teacherId).execute()
  return pct
}

// ---- basics ----

export type BasicsUpdate = Partial<{
  full_name: string
  gender: 'female' | 'male' | 'other' | 'undisclosed'
  date_of_birth: string
  email: string | null
  category_id: string
  languages: string[]
  experience_years: number
  highest_qualification: string
  bio: string
  fee_per_hour_paise: number | null
  demo_available: boolean
  profile_photo_file_id: string
}>

// Optimistic-lock update: only applies if updated_at still equals the version the client sent (millisecond precision).
export async function updateBasicsTx(trx: AppTrx, teacherId: string, version: Date, values: BasicsUpdate) {
  const row = await trx
    .updateTable('teachers')
    .set({ ...values, updated_at: sql`now()` })
    .where('id', '=', teacherId)
    .where(sql<boolean>`abs(extract(epoch from updated_at) - extract(epoch from ${version}::timestamptz)) < 0.001`)
    .returning('id')
    .executeTakeFirst()
  return Boolean(row)
}

// ---- qualifications ----

const QUALIFICATION_COLUMNS = ['id', 'level', 'degree', 'institution', 'year_completed', 'grade', 'document_id', 'is_highest', 'sort_order', 'updated_at'] as const

export function listQualifications(teacherId: string, executor: Executor = db) {
  return executor.selectFrom('teacher_qualifications').select(QUALIFICATION_COLUMNS).where('teacher_id', '=', teacherId).where('deleted_at', 'is', null).orderBy('sort_order').orderBy('created_at').execute()
}

export function findQualification(trx: AppTrx, teacherId: string, id: string) {
  return trx.selectFrom('teacher_qualifications').select(QUALIFICATION_COLUMNS).where('id', '=', id).where('teacher_id', '=', teacherId).where('deleted_at', 'is', null).forUpdate().executeTakeFirst()
}

export async function nextQualificationSortOrder(trx: AppTrx, teacherId: string): Promise<number> {
  const row = await trx.selectFrom('teacher_qualifications').select(sql<number>`coalesce(max(sort_order), 0) + 1`.as('n')).where('teacher_id', '=', teacherId).where('deleted_at', 'is', null).executeTakeFirstOrThrow()
  return Number(row.n)
}

export function clearHighestQualification(trx: AppTrx, teacherId: string, exceptId?: string) {
  let q = trx.updateTable('teacher_qualifications').set({ is_highest: false }).where('teacher_id', '=', teacherId).where('is_highest', '=', true).where('deleted_at', 'is', null)
  if (exceptId) q = q.where('id', '!=', exceptId)
  return q.execute()
}

export function insertQualification(
  trx: AppTrx,
  input: { teacherId: string; level: string; degree: string; institution: string; yearCompleted: number | null; grade: string | null; isHighest: boolean; sortOrder: number },
) {
  return trx
    .insertInto('teacher_qualifications')
    .values({
      teacher_id: input.teacherId,
      level: input.level as 'graduate',
      degree: input.degree,
      institution: input.institution,
      year_completed: input.yearCompleted,
      grade: input.grade,
      is_highest: input.isHighest,
      sort_order: input.sortOrder,
    })
    .returning(QUALIFICATION_COLUMNS)
    .executeTakeFirstOrThrow()
}

export function updateQualification(trx: AppTrx, id: string, values: Partial<{ level: string; degree: string; institution: string; year_completed: number | null; grade: string | null; is_highest: boolean }>) {
  return trx
    .updateTable('teacher_qualifications')
    .set(values as never)
    .where('id', '=', id)
    .returning(QUALIFICATION_COLUMNS)
    .executeTakeFirstOrThrow()
}

export function softDeleteQualification(trx: AppTrx, id: string) {
  return trx.updateTable('teacher_qualifications').set({ deleted_at: new Date(), is_highest: false }).where('id', '=', id).execute()
}

// ---- replace-set steps ----

export function listSubjects(teacherId: string, executor: Executor = db) {
  return executor
    .selectFrom('teacher_subjects as ts')
    .innerJoin('subjects as s', 's.id', 'ts.subject_id')
    .select(['ts.subject_id', 's.name', 'ts.is_primary', 'ts.experience_years'])
    .where('ts.teacher_id', '=', teacherId)
    .orderBy('ts.is_primary', 'desc')
    .orderBy('s.name')
    .execute()
}

export function listClasses(teacherId: string, executor: Executor = db) {
  return executor
    .selectFrom('teacher_classes as tc')
    .innerJoin('classes as c', 'c.id', 'tc.class_id')
    .select(['tc.class_id', 'tc.board_id', 'c.name', 'c.level_order'])
    .where('tc.teacher_id', '=', teacherId)
    .orderBy('c.level_order')
    .execute()
}

export function listTeachingModes(teacherId: string, executor: Executor = db) {
  return executor
    .selectFrom('teacher_teaching_modes as tm')
    .innerJoin('teaching_modes as m', 'm.id', 'tm.teaching_mode_id')
    .select(['tm.teaching_mode_id', 'm.name', 'm.code', 'm.requires_location'])
    .where('tm.teacher_id', '=', teacherId)
    .orderBy('m.sort_order')
    .execute()
}

export function listLocations(teacherId: string, executor: Executor = db) {
  return executor
    .selectFrom('teacher_locations as tl')
    .innerJoin('cities as c', 'c.id', 'tl.city_id')
    .leftJoin('areas as a', 'a.id', 'tl.area_id')
    .select(['tl.id', 'tl.city_id', 'c.name as city_name', 'tl.area_id', 'a.name as area_name', 'tl.is_primary', 'tl.travel_radius_km', 'tl.address_line', sql<string | null>`tl.latitude::text`.as('latitude'), sql<string | null>`tl.longitude::text`.as('longitude')])
    .where('tl.teacher_id', '=', teacherId)
    .orderBy('tl.is_primary', 'desc')
    .orderBy('c.name')
    .execute()
}

export async function countActiveSubjects(ids: string[]): Promise<number> {
  const row = await db.selectFrom('subjects').select(db.fn.countAll<number>().as('n')).where('id', 'in', ids).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirstOrThrow()
  return Number(row.n)
}

export async function countActiveClasses(ids: string[]): Promise<number> {
  const row = await db.selectFrom('classes').select(db.fn.countAll<number>().as('n')).where('id', 'in', ids).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirstOrThrow()
  return Number(row.n)
}

export async function countActiveBoards(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const row = await db.selectFrom('boards').select(db.fn.countAll<number>().as('n')).where('id', 'in', ids).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirstOrThrow()
  return Number(row.n)
}

export function findActiveTeachingModes(ids: string[]) {
  return db.selectFrom('teaching_modes').select(['id', 'code', 'requires_location']).where('id', 'in', ids).where('is_active', '=', true).where('deleted_at', 'is', null).execute()
}

export function findActiveCities(ids: string[]) {
  return db.selectFrom('cities').select('id').where('id', 'in', ids).where('is_active', '=', true).where('deleted_at', 'is', null).execute()
}

export function findActiveAreas(ids: string[]) {
  return db.selectFrom('areas').select(['id', 'city_id']).where('id', 'in', ids).where('is_active', '=', true).where('deleted_at', 'is', null).execute()
}

export async function replaceSubjects(trx: AppTrx, teacherId: string, items: { subjectId: string; isPrimary: boolean; experienceYears: number | null }[]) {
  const existing = await trx.selectFrom('teacher_subjects').select('subject_id').where('teacher_id', '=', teacherId).execute()
  const keep = new Set(items.map((i) => i.subjectId))
  const have = new Set(existing.map((e) => e.subject_id))
  const removed = existing.filter((e) => !keep.has(e.subject_id)).map((e) => e.subject_id)
  if (removed.length) await trx.deleteFrom('teacher_subjects').where('teacher_id', '=', teacherId).where('subject_id', 'in', removed).execute()
  // uq_teacher_subjects_primary allows one primary: clear first, then set the new one.
  await trx.updateTable('teacher_subjects').set({ is_primary: false }).where('teacher_id', '=', teacherId).where('is_primary', '=', true).execute()
  let added = 0
  for (const item of items) {
    if (have.has(item.subjectId)) {
      await trx.updateTable('teacher_subjects').set({ is_primary: item.isPrimary, experience_years: item.experienceYears }).where('teacher_id', '=', teacherId).where('subject_id', '=', item.subjectId).execute()
    } else {
      await trx.insertInto('teacher_subjects').values({ teacher_id: teacherId, subject_id: item.subjectId, is_primary: item.isPrimary, experience_years: item.experienceYears }).execute()
      added += 1
    }
  }
  return { added, removed: removed.length }
}

export async function replaceClasses(trx: AppTrx, teacherId: string, items: { classId: string; boardId: string | null }[]) {
  const existing = await trx.selectFrom('teacher_classes').select(['id', 'class_id', 'board_id']).where('teacher_id', '=', teacherId).execute()
  const key = (classId: string, boardId: string | null) => `${classId}:${boardId ?? ''}`
  const wanted = new Set(items.map((i) => key(i.classId, i.boardId)))
  const have = new Set(existing.map((e) => key(e.class_id, e.board_id)))
  const removed = existing.filter((e) => !wanted.has(key(e.class_id, e.board_id))).map((e) => e.id)
  if (removed.length) await trx.deleteFrom('teacher_classes').where('id', 'in', removed).execute()
  const toAdd = items.filter((i) => !have.has(key(i.classId, i.boardId)))
  for (const i of toAdd) await trx.insertInto('teacher_classes').values({ teacher_id: teacherId, class_id: i.classId, board_id: i.boardId }).execute()
  return { added: toAdd.length, removed: removed.length }
}

export async function replaceTeachingModes(trx: AppTrx, teacherId: string, modeIds: string[]) {
  const existing = (await trx.selectFrom('teacher_teaching_modes').select('teaching_mode_id').where('teacher_id', '=', teacherId).execute()).map((e) => e.teaching_mode_id)
  const removed = existing.filter((id) => !modeIds.includes(id))
  if (removed.length) await trx.deleteFrom('teacher_teaching_modes').where('teacher_id', '=', teacherId).where('teaching_mode_id', 'in', removed).execute()
  const toAdd = modeIds.filter((id) => !existing.includes(id))
  for (const id of toAdd) await trx.insertInto('teacher_teaching_modes').values({ teacher_id: teacherId, teaching_mode_id: id }).execute()
  return { added: toAdd.length, removed: removed.length }
}

export async function replaceLocations(
  trx: AppTrx,
  teacherId: string,
  items: { cityId: string; areaId: string | null; isPrimary: boolean; travelRadiusKm: number | null; addressLine: string | null; latitude: number | null; longitude: number | null }[],
) {
  const existing = await trx.selectFrom('teacher_locations').select(['id', 'city_id', 'area_id']).where('teacher_id', '=', teacherId).execute()
  const key = (cityId: string, areaId: string | null) => `${cityId}:${areaId ?? ''}`
  const wanted = new Set(items.map((i) => key(i.cityId, i.areaId)))
  const byKey = new Map(existing.map((e) => [key(e.city_id, e.area_id), e.id]))
  const removed = existing.filter((e) => !wanted.has(key(e.city_id, e.area_id))).map((e) => e.id)
  if (removed.length) await trx.deleteFrom('teacher_locations').where('id', 'in', removed).execute()
  await trx.updateTable('teacher_locations').set({ is_primary: false }).where('teacher_id', '=', teacherId).where('is_primary', '=', true).execute()
  let added = 0
  for (const i of items) {
    const values = { is_primary: i.isPrimary, travel_radius_km: i.travelRadiusKm, address_line: i.addressLine, latitude: i.latitude === null ? null : String(i.latitude), longitude: i.longitude === null ? null : String(i.longitude) }
    const id = byKey.get(key(i.cityId, i.areaId))
    if (id) {
      await trx.updateTable('teacher_locations').set(values).where('id', '=', id).execute()
    } else {
      await trx.insertInto('teacher_locations').values({ teacher_id: teacherId, city_id: i.cityId, area_id: i.areaId, ...values }).execute()
      added += 1
    }
  }
  return { added, removed: removed.length }
}
