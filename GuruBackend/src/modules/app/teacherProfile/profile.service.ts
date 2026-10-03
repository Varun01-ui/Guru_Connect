import type { Kysely } from 'kysely'
import type { z } from 'zod'
import { db } from '../../../db/index.js'
import type { DB } from '../../../db/types.js'
import { audit } from '../../../lib/audit.js'
import { conflictState, notFound, validationFailed, versionConflict } from '../../../lib/errors.js'
import { cdnUrl } from '../../../lib/present.js'
import type { AppTrx } from '../registration/registration.repository.js'
import * as teacherRepo from '../teacher/teacher.repository.js'
import type { TeacherContext } from '../teacher/teacher.service.js'
import { ageOn } from '../teacher/teacher.schemas.js'
import { listWindows } from '../teacherAvailability/availability.service.js'
import type { createFeePlanSchema, patchProfileSchema, updateFeePlanSchema } from './profile.schemas.js'

type Executor = Kysely<DB>
const MAX_FEE_PLANS = 12

const fieldError = (path: string, message: string, extra: Record<string, unknown> = {}) => validationFailed([{ path, message, ...extra }], message)
const notApproved = () => conflictState('Complete verification before editing your public profile.', { reason: 'not_approved' })

// ---- fee plans ----

const PLAN_COLUMNS = ['id', 'label', 'subject_id', 'class_from_id', 'class_to_id', 'teaching_mode_id', 'fee_unit', 'amount_paise', 'sessions_per_week', 'session_minutes', 'notes', 'sort_order'] as const

type PlanRow = { id: string; label: string; subject_id: string | null; class_from_id: string | null; class_to_id: string | null; teaching_mode_id: string | null; fee_unit: string; amount_paise: number | string; sessions_per_week: number | null; session_minutes: number | null; notes: string | null; sort_order: number }

const presentPlan = (p: PlanRow) => ({
  id: p.id,
  label: p.label,
  subjectId: p.subject_id,
  classFromId: p.class_from_id,
  classToId: p.class_to_id,
  teachingModeId: p.teaching_mode_id,
  feeUnit: p.fee_unit,
  amountPaise: Number(p.amount_paise),
  sessionsPerWeek: p.sessions_per_week,
  sessionMinutes: p.session_minutes,
  notes: p.notes,
  sortOrder: p.sort_order,
})

export async function listFeePlans(teacherId: string, executor: Executor = db) {
  const rows = await executor
    .selectFrom('teacher_fee_plans')
    .select(PLAN_COLUMNS)
    .where('teacher_id', '=', teacherId)
    .where('is_active', '=', true)
    .where('deleted_at', 'is', null)
    .orderBy('sort_order')
    .orderBy('created_at')
    .execute()
  return rows.map((r) => presentPlan(r as PlanRow))
}

type PlanInput = { label: string; subjectId: string | null; classFromId: string | null; classToId: string | null; teachingModeId: string | null; feeUnit: 'per_hour' | 'per_month' | 'per_course'; amountPaise: number; sessionsPerWeek: number | null; sessionMinutes: number | null; notes: string | null }

// BR-17.4, checked against the merged plan so partial PATCHes are validated as a whole.
async function validatePlan(trx: AppTrx, teacherId: string, plan: PlanInput) {
  if (plan.feeUnit === 'per_hour' && plan.sessionMinutes === null) throw fieldError('sessionMinutes', 'Enter a class length')
  if (plan.feeUnit !== 'per_hour' && plan.sessionsPerWeek === null) throw fieldError('sessionsPerWeek', 'Enter sessions per week')

  if (plan.classFromId && plan.classToId) {
    const classes = await trx.selectFrom('classes').select(['id', 'level_order']).where('id', 'in', [plan.classFromId, plan.classToId]).where('is_active', '=', true).where('deleted_at', 'is', null).execute()
    const from = classes.find((c) => c.id === plan.classFromId)
    const to = classes.find((c) => c.id === plan.classToId)
    if (!from || !to) throw fieldError('classFromId', 'Choose valid classes.')
    if (from.level_order > to.level_order) throw fieldError('classToId', 'The last class must not be lower than the first class.')
  } else {
    for (const [path, id] of [['classFromId', plan.classFromId], ['classToId', plan.classToId]] as const) {
      if (id && !(await trx.selectFrom('classes').select('id').where('id', '=', id).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirst())) throw fieldError(path, 'Choose a valid class.')
    }
  }
  if (plan.subjectId) {
    const own = await trx.selectFrom('teacher_subjects').select('id').where('teacher_id', '=', teacherId).where('subject_id', '=', plan.subjectId).executeTakeFirst()
    if (!own) throw fieldError('subjectId', 'Add this subject to your profile first')
  }
  if (plan.teachingModeId) {
    const own = await trx.selectFrom('teacher_teaching_modes').select('teaching_mode_id').where('teacher_id', '=', teacherId).where('teaching_mode_id', '=', plan.teachingModeId).executeTakeFirst()
    if (!own) throw fieldError('teachingModeId', 'Add this mode to your profile first')
  }
}

async function audited(trx: AppTrx, ctx: TeacherContext, action: string, plan: { id: string; label: string; amountPaise: number }) {
  await audit(trx, {
    actorType: 'app_user',
    actorId: ctx.userId,
    action,
    module: 'app.teacher_profile',
    entityType: 'teacher_fee_plan',
    entityId: plan.id,
    newValues: { planId: plan.id, label: plan.label, amountPaise: plan.amountPaise },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  })
}

async function lockApproved(trx: AppTrx, teacherId: string) {
  const t = await teacherRepo.lockTeacher(trx, teacherId)
  if (!t) throw notFound('Profile not found.')
  if (t.verification_status !== 'approved') throw notApproved()
}

export async function createFeePlan(ctx: TeacherContext, body: z.infer<typeof createFeePlanSchema>) {
  return db.transaction().execute(async (trx) => {
    await lockApproved(trx, ctx.teacherId)
    const plan: PlanInput = { label: body.label, subjectId: body.subjectId ?? null, classFromId: body.classFromId ?? null, classToId: body.classToId ?? null, teachingModeId: body.teachingModeId ?? null, feeUnit: body.feeUnit, amountPaise: body.amountPaise, sessionsPerWeek: body.sessionsPerWeek ?? null, sessionMinutes: body.sessionMinutes ?? null, notes: body.notes?.trim() || null }
    await validatePlan(trx, ctx.teacherId, plan)

    const active = await trx.selectFrom('teacher_fee_plans').select((eb) => [eb.fn.countAll<number>().as('n'), eb.fn.max('sort_order').as('max')]).where('teacher_id', '=', ctx.teacherId).where('is_active', '=', true).where('deleted_at', 'is', null).executeTakeFirstOrThrow()
    if (Number(active.n) >= MAX_FEE_PLANS) throw fieldError('label', 'You can add up to 12 fee plans', { reason: 'max_fee_plans' })

    const row = (await trx
      .insertInto('teacher_fee_plans')
      .values({ teacher_id: ctx.teacherId, label: plan.label, subject_id: plan.subjectId, class_from_id: plan.classFromId, class_to_id: plan.classToId, teaching_mode_id: plan.teachingModeId, fee_unit: plan.feeUnit, amount_paise: plan.amountPaise, sessions_per_week: plan.sessionsPerWeek, session_minutes: plan.sessionMinutes, notes: plan.notes, sort_order: Number(active.max ?? 0) + 1 })
      .returning(PLAN_COLUMNS)
      .executeTakeFirstOrThrow()) as PlanRow
    await audited(trx, ctx, 'app.teacher_fee_plan_added', { id: row.id, label: row.label, amountPaise: plan.amountPaise })
    await teacherRepo.recomputeCompleteness(trx, ctx.teacherId)
    return presentPlan(row)
  })
}

export async function updateFeePlan(ctx: TeacherContext, id: string, body: z.infer<typeof updateFeePlanSchema>) {
  return db.transaction().execute(async (trx) => {
    await lockApproved(trx, ctx.teacherId)
    const existing = (await trx.selectFrom('teacher_fee_plans').select(PLAN_COLUMNS).where('id', '=', id).where('teacher_id', '=', ctx.teacherId).where('is_active', '=', true).where('deleted_at', 'is', null).forUpdate().executeTakeFirst()) as PlanRow | undefined
    if (!existing) throw notFound('This is no longer available.')

    const merged: PlanInput = {
      label: body.label ?? existing.label,
      subjectId: body.subjectId !== undefined ? body.subjectId : existing.subject_id,
      classFromId: body.classFromId !== undefined ? body.classFromId : existing.class_from_id,
      classToId: body.classToId !== undefined ? body.classToId : existing.class_to_id,
      teachingModeId: body.teachingModeId !== undefined ? body.teachingModeId : existing.teaching_mode_id,
      feeUnit: (body.feeUnit ?? existing.fee_unit) as PlanInput['feeUnit'],
      amountPaise: body.amountPaise ?? Number(existing.amount_paise),
      sessionsPerWeek: body.sessionsPerWeek !== undefined ? body.sessionsPerWeek : existing.sessions_per_week,
      sessionMinutes: body.sessionMinutes !== undefined ? body.sessionMinutes : existing.session_minutes,
      notes: body.notes !== undefined ? (body.notes?.trim() || null) : existing.notes,
    }
    await validatePlan(trx, ctx.teacherId, merged)

    const row = (await trx
      .updateTable('teacher_fee_plans')
      .set({ label: merged.label, subject_id: merged.subjectId, class_from_id: merged.classFromId, class_to_id: merged.classToId, teaching_mode_id: merged.teachingModeId, fee_unit: merged.feeUnit, amount_paise: merged.amountPaise, sessions_per_week: merged.sessionsPerWeek, session_minutes: merged.sessionMinutes, notes: merged.notes })
      .where('id', '=', id)
      .returning(PLAN_COLUMNS)
      .executeTakeFirstOrThrow()) as PlanRow
    await audited(trx, ctx, 'app.teacher_fee_plan_updated', { id, label: row.label, amountPaise: merged.amountPaise })
    return presentPlan(row)
  })
}

// Soft delete only: a lead or demo conversation may still show the plan's old label.
export async function deleteFeePlan(ctx: TeacherContext, id: string) {
  await db.transaction().execute(async (trx) => {
    await lockApproved(trx, ctx.teacherId)
    const existing = await trx.selectFrom('teacher_fee_plans').select(['id', 'label', 'amount_paise']).where('id', '=', id).where('teacher_id', '=', ctx.teacherId).where('deleted_at', 'is', null).where('is_active', '=', true).forUpdate().executeTakeFirst()
    if (!existing) throw notFound('This is no longer available.')
    await trx.updateTable('teacher_fee_plans').set({ deleted_at: new Date() }).where('id', '=', id).execute()
    await audited(trx, ctx, 'app.teacher_fee_plan_deleted', { id, label: existing.label, amountPaise: Number(existing.amount_paise) })
    await teacherRepo.recomputeCompleteness(trx, ctx.teacherId)
  })
}

// ---- GET /teacher/profile ----

async function photoUrl(fileId: string | null, executor: Executor = db) {
  if (!fileId) return null
  const f = await executor.selectFrom('files').select('object_key').where('id', '=', fileId).where('status', '=', 'uploaded').where('visibility', '=', 'public').where('deleted_at', 'is', null).executeTakeFirst()
  return cdnUrl(f?.object_key)
}

export async function getProfile(teacherId: string, executor: Executor = db) {
  const t = await teacherRepo.findTeacher(teacherId, executor)
  if (!t) throw notFound('Profile not found.')
  const flags = await executor.selectFrom('teachers').select(['is_verified_badge']).where('id', '=', teacherId).executeTakeFirstOrThrow()
  const [items, subjects, classes, feePlans, photo] = await Promise.all([
    teacherRepo.completenessItems(executor, teacherId),
    teacherRepo.listSubjects(teacherId, executor),
    executor
      .selectFrom('teacher_classes as tc')
      .innerJoin('classes as c', 'c.id', 'tc.class_id')
      .leftJoin('boards as b', 'b.id', 'tc.board_id')
      .select(['tc.class_id', 'c.name', 'b.short_name as board_name', 'c.level_order'])
      .where('tc.teacher_id', '=', teacherId)
      .orderBy('c.level_order')
      .execute(),
    listFeePlans(teacherId, executor),
    photoUrl(t.profile_photo_file_id, executor),
  ])
  return {
    teacher: {
      id: t.id,
      fullName: t.full_name,
      gender: t.gender,
      dateOfBirth: t.date_of_birth,
      email: t.email,
      categoryId: t.category_id,
      bio: t.bio,
      languages: t.languages,
      photoUrl: photo,
      experienceYears: t.experience_years,
      highestQualification: t.highest_qualification,
      feePerHourPaise: t.fee_per_hour_paise === null ? null : Number(t.fee_per_hour_paise),
      demoAvailable: t.demo_available,
      isVerifiedBadge: flags.is_verified_badge,
      verificationStatus: t.verification_status,
      updatedAt: t.updated_at.toISOString(),
    },
    completeness: { percent: Math.min(100, items.reduce((s, i) => s + i.earned, 0)), items: items.map(({ key, label, earned, of }) => ({ key, label, earned, of })) },
    subjects: subjects.map((s) => ({ subjectId: s.subject_id, name: s.name, isPrimary: s.is_primary })),
    classes: classes.map((c) => ({ classId: c.class_id, name: c.name, boardName: c.board_name })),
    feePlans,
  }
}

// ---- PATCH /teacher/profile (BR-17.2) ----

export async function updateProfile(ctx: TeacherContext, version: Date, body: z.infer<typeof patchProfileSchema>) {
  await db.transaction().execute(async (trx) => {
    const locked = await teacherRepo.lockTeacher(trx, ctx.teacherId)
    if (!locked) throw notFound('Profile not found.')
    if (locked.verification_status !== 'approved') throw notApproved()
    const current = (await teacherRepo.findTeacher(ctx.teacherId, trx))!

    if (body.categoryId && !(await teacherRepo.isCategoryActive(body.categoryId))) throw fieldError('categoryId', 'Choose a category')
    const dob = body.dateOfBirth ?? current.date_of_birth
    if (body.experienceYears !== undefined && dob && body.experienceYears > ageOn(dob) - 16) throw fieldError('experienceYears', "Experience can't exceed your working years")

    // Identity-linked fields: a change needs a reason and leaves a trail for support (Admin FR-17.3).
    const identityChanges: { field: string; oldValue: string | null; newValue: string }[] = []
    if (body.fullName !== undefined && body.fullName !== current.full_name) identityChanges.push({ field: 'fullName', oldValue: current.full_name, newValue: body.fullName })
    if (body.dateOfBirth !== undefined && body.dateOfBirth !== current.date_of_birth) identityChanges.push({ field: 'dateOfBirth', oldValue: current.date_of_birth, newValue: body.dateOfBirth })
    if (identityChanges.length > 0 && !body.reason) throw fieldError('reason', "Tell us why you're changing this")

    if (body.profilePhotoFileId) {
      const file = await trx
        .selectFrom('files')
        .select('id')
        .where('id', '=', body.profilePhotoFileId)
        .where('purpose', '=', 'teacher_photo')
        .where('status', '=', 'uploaded')
        .where('visibility', '=', 'public')
        .where('uploaded_by_type', '=', 'app_user')
        .where('uploaded_by_id', '=', ctx.userId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst()
      if (!file) throw fieldError('profilePhotoFileId', 'Upload a photo first')
    }

    const values: teacherRepo.BasicsUpdate = {
      ...(body.fullName !== undefined && { full_name: body.fullName }),
      ...(body.gender !== undefined && { gender: body.gender }),
      ...(body.dateOfBirth !== undefined && { date_of_birth: body.dateOfBirth }),
      ...(body.email !== undefined && { email: body.email }),
      ...(body.categoryId !== undefined && { category_id: body.categoryId }),
      ...(body.languages !== undefined && { languages: body.languages }),
      ...(body.experienceYears !== undefined && { experience_years: body.experienceYears }),
      ...(body.highestQualification !== undefined && { highest_qualification: body.highestQualification }),
      ...(body.bio !== undefined && { bio: body.bio }),
      ...(body.feePerHourPaise !== undefined && { fee_per_hour_paise: body.feePerHourPaise }),
      ...(body.demoAvailable !== undefined && { demo_available: body.demoAvailable }),
      ...(body.profilePhotoFileId !== undefined && { profile_photo_file_id: body.profilePhotoFileId }),
    }
    if (!(await teacherRepo.updateBasicsTx(trx, ctx.teacherId, version, values))) throw versionConflict()
    if (body.fullName !== undefined) await trx.updateTable('app_users').set({ full_name: body.fullName }).where('id', '=', ctx.userId).execute()

    const base = { actorType: 'app_user' as const, actorId: ctx.userId, module: 'app.teacher_profile', entityType: 'teacher', entityId: ctx.teacherId, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId }
    for (const change of identityChanges) {
      // Internal note: support sees it in the verification timeline; verification_status does not change.
      await trx
        .insertInto('teacher_verification_logs')
        .values({ teacher_id: ctx.teacherId, action: 'note_added', note: body.reason!, is_internal: true, metadata: JSON.stringify({ profile_changed_after_approval: true, ...change }) as never })
        .execute()
      await audit(trx, { ...base, action: 'app.teacher_identity_field_changed', newValues: { field: change.field, reason: body.reason } })
    }
    await audit(trx, { ...base, action: 'app.teacher_profile_updated', newValues: { changedFields: Object.keys(body).filter((k) => k !== 'reason') } })
    await teacherRepo.recomputeCompleteness(trx, ctx.teacherId)
  })
  return getProfile(ctx.teacherId)
}

// ---- GET /teacher/profile/preview (BR-17.6) ----

// Module 31's public profile shape is not part of the spec pack, so this is a best-effort equivalent built from the
// same data: what a parent would see (never the phone, email, date of birth or street address).
export async function getPreview(teacherId: string) {
  const t = await db
    .selectFrom('teachers as t')
    .leftJoin('teacher_categories as c', 'c.id', 't.category_id')
    .select(['t.id', 't.full_name', 't.public_code', 'c.name as category_name', 't.bio', 't.languages', 't.profile_photo_file_id', 't.experience_years', 't.highest_qualification', 't.fee_per_hour_paise', 't.demo_available', 't.is_verified_badge', 't.rating_avg', 't.rating_count', 't.verification_status', 't.account_status'])
    .where('t.id', '=', teacherId)
    .where('t.deleted_at', 'is', null)
    .executeTakeFirst()
  if (!t) throw notFound('Profile not found.')

  const [trust, subjects, classes, modes, locations, feePlans, windows, photo] = await Promise.all([
    db.selectFrom('trust_scores').select('score').where('teacher_id', '=', teacherId).executeTakeFirst(),
    teacherRepo.listSubjects(teacherId),
    teacherRepo.listClasses(teacherId),
    teacherRepo.listTeachingModes(teacherId),
    teacherRepo.listLocations(teacherId),
    listFeePlans(teacherId),
    listWindows(teacherId),
    photoUrl(t.profile_photo_file_id),
  ])
  const demoDays = [...new Set(windows.filter((w) => w.acceptsDemos).map((w) => w.dayOfWeek))].sort((a, b) => a - b)
  return {
    visibleToParents: t.verification_status === 'approved' && t.account_status === 'active',
    teacher: {
      id: t.id,
      publicCode: t.public_code,
      fullName: t.full_name,
      categoryName: t.category_name,
      photoUrl: photo,
      bio: t.bio,
      languages: t.languages,
      experienceYears: t.experience_years,
      highestQualification: t.highest_qualification,
      feePerHourPaise: t.fee_per_hour_paise === null ? null : Number(t.fee_per_hour_paise),
      demoAvailable: t.demo_available,
      isVerifiedBadge: t.is_verified_badge,
    },
    trustScore: trust ? Number(trust.score) : null,
    rating: { avg: t.rating_avg === null ? null : Number(t.rating_avg), count: t.rating_count },
    subjects: subjects.map((s) => ({ subjectId: s.subject_id, name: s.name, isPrimary: s.is_primary })),
    classes: classes.map((c) => ({ classId: c.class_id, name: c.name })),
    teachingModes: modes.map((m) => ({ id: m.teaching_mode_id, name: m.name })),
    locations: locations.map((l) => ({ cityName: l.city_name, areaName: l.area_name, isPrimary: l.is_primary })),
    feePlans,
    availability: { weeklySlots: windows.length, demoDays },
  }
}

