import type { z } from 'zod'
import { env } from '../../../config/env.js'
import { db } from '../../../db/index.js'
import { trackEvent } from '../../../lib/analytics.js'
import { audit } from '../../../lib/audit.js'
import type { RegistrationClaims } from '../../../lib/appJwt.js'
import { conflictState, forbidden, notFound, rateLimited, validationFailed, versionConflict } from '../../../lib/errors.js'
import { getIdempotent, putIdempotent } from '../../../lib/idempotency.js'
import { hitRateLimit } from '../../../lib/rateLimit.js'
import { issueSession } from '../auth/session.js'
import * as registrationRepo from '../registration/registration.repository.js'
import { resolveReferral } from '../registration/registration.service.js'
import { insertStudentConsentsTx } from '../student/student.repository.js'
import type { RequestContext } from '../student/student.service.js'
import * as repo from './teacher.repository.js'
import { EXPERIENCE_FIELDS, PERSONAL_FIELDS, ageOn } from './teacher.schemas.js'
import type { basicsSchema, createQualificationSchema, registerTeacherSchema, setClassesSchema, setLocationsSchema, setSubjectsSchema, setTeachingModesSchema, updateQualificationSchema } from './teacher.schemas.js'

export type TeacherContext = RequestContext & { teacherId: string; userId: string }

const fieldError = (path: string, message: string, extra: Record<string, unknown> = {}) => validationFailed([{ path, message, ...extra }], message)

// ---- wizard progress (BR-14.3 / BR-14.4) ----

export const WIZARD_STEPS = ['personal', 'qualification', 'experience', 'subjects', 'classes', 'teaching_modes', 'locations'] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

export async function computeProgress(teacherId: string, executor = db) {
  const p = await repo.loadProgressInputs(teacherId, executor)
  const t = p.teacher
  const onlineOnly = p.modes.length > 0 && p.modes.every((m) => !m.requires_location)
  const done: Record<WizardStep, boolean> = {
    personal: Boolean(t.full_name && t.gender && t.date_of_birth && t.category_id),
    qualification: p.qualifications >= 1,
    experience: t.experience_years !== null && Boolean(t.highest_qualification),
    subjects: p.subjects >= 1,
    classes: p.classes >= 1,
    teaching_modes: p.modes.length >= 1,
    locations: p.locations >= 1 || onlineOnly,
  }
  const completedSteps = WIZARD_STEPS.filter((s) => done[s])
  const nextStep: WizardStep | 'documents' = WIZARD_STEPS.find((s) => !done[s]) ?? 'documents'
  return { completedSteps, nextStep, verificationStatus: t.verification_status }
}

// BR-14.8: the qualification and replace-set endpoints are open while drafting or once approved (M17 reuses them).
function assertEditable(status: string) {
  if (status !== 'draft' && status !== 'approved') {
    throw conflictState("Your application is already under review and can't be edited here.", { reason: 'verification_in_progress' })
  }
}

async function throttle(teacherId: string) {
  const r = await hitRateLimit(`teacher-reg:${teacherId}`, 30, 60_000)
  if (!r.allowed) throw rateLimited(r.retryAfterSeconds)
}

// One audit row per successful step save, plus the specific event the spec lists, plus the analytics event name.
async function auditStep(trx: Parameters<typeof audit>[0], ctx: TeacherContext, step: string, extra?: { action: string; details: Record<string, unknown> }) {
  const base = { actorType: 'app_user' as const, actorId: ctx.userId, module: 'app.teacher_registration', entityType: 'teacher', entityId: ctx.teacherId, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId }
  await audit(trx, { ...base, action: 'app.teacher_registration_step_saved', newValues: { step } })
  if (extra) await audit(trx, { ...base, action: extra.action, newValues: extra.details })
}

// ---- POST /registration/teacher (BR-14.1) ----

type RegisterTeacherBody = z.infer<typeof registerTeacherSchema>

const inflight = new Map<string, Promise<unknown>>()

export async function registerTeacher(claims: RegistrationClaims, body: RegisterTeacherBody, idempotencyKey: string, ctx: RequestContext) {
  // Concurrent duplicates of the same call share one execution (T14.12); later duplicates replay from the cache.
  const cacheKey = `teacher:${claims.jti}:${idempotencyKey}`
  const running = inflight.get(cacheKey)
  if (running) return (await running) as Awaited<ReturnType<typeof doRegisterTeacher>>
  const promise = doRegisterTeacher(claims, body, cacheKey, ctx)
  inflight.set(cacheKey, promise)
  try {
    return await promise
  } finally {
    inflight.delete(cacheKey)
  }
}

async function doRegisterTeacher(claims: RegistrationClaims, body: RegisterTeacherBody, cacheKey: string, ctx: RequestContext) {
  const cached = await getIdempotent(cacheKey)
  if (cached) return cached.body as TeacherRegistrationResult

  // Only a teacher registration token may create a teacher (M14 section 17). Tokens minted today carry no role
  // claim, so a missing role is accepted; an explicit different role is refused.
  const role = (claims as { role?: string }).role
  if (role && role !== 'teacher') throw forbidden("You can't do that.")

  const attempts = await hitRateLimit(`reg-teacher:${claims.jti}`, 5, 30 * 60 * 1000)
  if (!attempts.allowed) throw rateLimited(attempts.retryAfterSeconds)

  if (claims.contactType !== 'phone') throw fieldError('mobile', 'Verify your mobile number to continue.')
  const phone = claims.sub
  if (await registrationRepo.isContactClaimed(phone, undefined)) throw conflictState('An account already exists for this number. Sign in instead.')
  if (!(await repo.isCategoryActive(body.categoryId))) throw fieldError('categoryId', 'Choose a category')

  const referral = await resolveReferral(body.referralCode, 'TEACHER_REFERRAL')

  let created: { userId: string; teacherId: string }
  try {
    created = await db.transaction().execute(async (trx) => {
      const user = await registrationRepo.insertAppUserTx(trx, { fullName: body.fullName, phone, email: null, signupSource: referral ? 'referral' : 'organic', userType: 'teacher' })
      const teacher = await repo.insertTeacherTx(trx, { userId: user.id, fullName: body.fullName, phone, gender: body.gender, dateOfBirth: body.dateOfBirth, categoryId: body.categoryId })
      await registrationRepo.insertPhoneIdentityTx(trx, user.id, phone)
      await insertStudentConsentsTx(trx, user.id, { termsVersion: env.LEGAL_TERMS_VERSION, privacyVersion: env.LEGAL_PRIVACY_VERSION, marketing: false, ipAddress: ctx.ip, installId: ctx.installId })
      if (referral) {
        await registrationRepo.insertReferralTx(trx, { referralCodeId: referral.row.id, referrerUserId: referral.row.user_id, refereeUserId: user.id, referralSettingId: referral.settingId })
      }
      await repo.recomputeCompleteness(trx, teacher.id)
      await audit(trx, {
        actorType: 'app_user',
        actorId: user.id,
        action: 'app.teacher_registered',
        module: 'app.teacher_registration',
        entityType: 'teacher',
        entityId: teacher.id,
        newValues: { categoryId: body.categoryId, referralCodeUsed: Boolean(referral) },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      })
      return { userId: user.id, teacherId: teacher.id }
    })
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') throw conflictState('An account already exists for this number. Sign in instead.')
    throw err
  }

  const session = await issueSession(created.userId, 'teacher', { authMethod: 'otp', ipAddress: ctx.ip, userAgent: ctx.userAgent })
  trackEvent('teacher.registration_step_saved')
  const response = { teacherId: created.teacherId, accessToken: session.accessToken, refreshToken: session.refreshToken, role: 'teacher' as const, nextStep: 'qualification' as const }
  await putIdempotent(cacheKey, 201, response)
  return response
}
type TeacherRegistrationResult = { teacherId: string; accessToken: string; refreshToken: string; role: 'teacher'; nextStep: 'qualification' }

// ---- GET /teacher/registration (BR-14.3) ----

const toQualification = (q: Awaited<ReturnType<typeof repo.listQualifications>>[number]) => ({
  id: q.id,
  level: q.level,
  degree: q.degree,
  institution: q.institution,
  yearCompleted: q.year_completed,
  grade: q.grade,
  isHighest: q.is_highest,
  sortOrder: q.sort_order,
})

export async function getRegistration(teacherId: string) {
  const t = await repo.findTeacher(teacherId)
  if (!t) throw notFound('Profile not found.')
  const [qualifications, subjects, classes, modes, locations, progress] = await Promise.all([
    repo.listQualifications(teacherId),
    repo.listSubjects(teacherId),
    repo.listClasses(teacherId),
    repo.listTeachingModes(teacherId),
    repo.listLocations(teacherId),
    computeProgress(teacherId),
  ])
  return {
    teacher: {
      id: t.id,
      fullName: t.full_name,
      gender: t.gender,
      dateOfBirth: t.date_of_birth,
      email: t.email,
      categoryId: t.category_id,
      languages: t.languages,
      verificationStatus: t.verification_status,
      experienceYears: t.experience_years,
      highestQualification: t.highest_qualification,
      bio: t.bio,
      feePerHourPaise: t.fee_per_hour_paise === null ? null : Number(t.fee_per_hour_paise),
      demoAvailable: t.demo_available,
      profileCompleteness: t.profile_completeness,
      updatedAt: t.updated_at.toISOString(),
    },
    qualifications: qualifications.map(toQualification),
    subjects: subjects.map((s) => ({ subjectId: s.subject_id, name: s.name, isPrimary: s.is_primary, experienceYears: s.experience_years })),
    classes: classes.map((c) => ({ classId: c.class_id, boardId: c.board_id, name: c.name })),
    teachingModes: modes.map((m) => ({ teachingModeId: m.teaching_mode_id, name: m.name, code: m.code })),
    locations: locations.map(toLocation),
    completedSteps: progress.completedSteps,
    nextStep: progress.nextStep,
  }
}

const toLocation = (l: Awaited<ReturnType<typeof repo.listLocations>>[number]) => ({
  id: l.id,
  cityId: l.city_id,
  cityName: l.city_name,
  areaId: l.area_id,
  areaName: l.area_name,
  isPrimary: l.is_primary,
  travelRadiusKm: l.travel_radius_km,
  addressLine: l.address_line,
  latitude: l.latitude === null ? null : Number(l.latitude),
  longitude: l.longitude === null ? null : Number(l.longitude),
})

// ---- PATCH /teacher/registration/basics (BR-14.2) ----

type BasicsBody = z.infer<typeof basicsSchema>

export async function updateBasics(ctx: TeacherContext, version: Date, body: BasicsBody) {
  await throttle(ctx.teacherId)
  return db.transaction().execute(async (trx) => {
    const t = await repo.lockTeacher(trx, ctx.teacherId)
    if (!t) throw notFound('Profile not found.')
    // Draft-only: once approved the same fields are edited through the profile editor (Module 17).
    if (t.verification_status === 'approved') throw conflictState('Edit these details from your profile.', { reason: 'use_profile_editor' })
    if (t.verification_status !== 'draft') throw conflictState("Your application is already under review and can't be edited here.", { reason: 'verification_in_progress' })

    if (body.categoryId && !(await repo.isCategoryActive(body.categoryId))) throw fieldError('categoryId', 'Choose a category')
    const dob = body.dateOfBirth ?? t.date_of_birth
    if (body.experienceYears !== undefined && dob && body.experienceYears > ageOn(dob) - 16) {
      throw fieldError('experienceYears', "Experience can't exceed your working years")
    }

    const values: repo.BasicsUpdate = {
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
    }
    // A changed name also updates the login identity's display name.
    if (!(await repo.updateBasicsTx(trx, ctx.teacherId, version, values))) throw versionConflict()
    if (body.fullName !== undefined) await trx.updateTable('app_users').set({ full_name: body.fullName }).where('id', '=', ctx.userId).execute()

    const present = Object.keys(body)
    if (PERSONAL_FIELDS.some((f) => present.includes(f))) await auditStep(trx, ctx, 'personal')
    if (EXPERIENCE_FIELDS.some((f) => present.includes(f))) await auditStep(trx, ctx, 'experience')
    await repo.recomputeCompleteness(trx, ctx.teacherId)
    trackEvent('teacher.registration_step_saved')
    return getBasicsResponse(ctx.teacherId, trx)
  })
}

async function getBasicsResponse(teacherId: string, executor: Parameters<typeof repo.findTeacher>[1]) {
  const t = (await repo.findTeacher(teacherId, executor))!
  return {
    id: t.id,
    fullName: t.full_name,
    gender: t.gender,
    dateOfBirth: t.date_of_birth,
    email: t.email,
    categoryId: t.category_id,
    languages: t.languages,
    experienceYears: t.experience_years,
    highestQualification: t.highest_qualification,
    bio: t.bio,
    feePerHourPaise: t.fee_per_hour_paise === null ? null : Number(t.fee_per_hour_paise),
    demoAvailable: t.demo_available,
    profileCompleteness: t.profile_completeness,
    updatedAt: t.updated_at.toISOString(),
  }
}

// ---- qualifications (BR-14.5) ----

export async function createQualification(ctx: TeacherContext, body: z.infer<typeof createQualificationSchema>) {
  await throttle(ctx.teacherId)
  return db.transaction().execute(async (trx) => {
    const t = await repo.lockTeacher(trx, ctx.teacherId)
    if (!t) throw notFound('Profile not found.')
    assertEditable(t.verification_status)
    const sortOrder = await repo.nextQualificationSortOrder(trx, ctx.teacherId)
    if (body.isHighest) await repo.clearHighestQualification(trx, ctx.teacherId)
    const row = await repo.insertQualification(trx, { teacherId: ctx.teacherId, level: body.level, degree: body.degree, institution: body.institution, yearCompleted: body.yearCompleted ?? null, grade: body.grade ?? null, isHighest: body.isHighest, sortOrder })
    await auditStep(trx, ctx, 'qualification', { action: 'app.teacher_qualification_added', details: { qualificationId: row.id, level: row.level, isHighest: row.is_highest } })
    await repo.recomputeCompleteness(trx, ctx.teacherId)
    trackEvent('teacher.registration_step_saved')
    return toQualification(row)
  })
}

export async function updateQualification(ctx: TeacherContext, id: string, body: z.infer<typeof updateQualificationSchema>) {
  await throttle(ctx.teacherId)
  return db.transaction().execute(async (trx) => {
    const t = await repo.lockTeacher(trx, ctx.teacherId)
    if (!t) throw notFound('Profile not found.')
    assertEditable(t.verification_status)
    const existing = await repo.findQualification(trx, ctx.teacherId, id)
    if (!existing) throw notFound('This is no longer available.')
    if (body.isHighest) await repo.clearHighestQualification(trx, ctx.teacherId, id)
    const row = await repo.updateQualification(trx, id, {
      ...(body.level !== undefined && { level: body.level }),
      ...(body.degree !== undefined && { degree: body.degree }),
      ...(body.institution !== undefined && { institution: body.institution }),
      ...(body.yearCompleted !== undefined && { year_completed: body.yearCompleted }),
      ...(body.grade !== undefined && { grade: body.grade }),
      ...(body.isHighest !== undefined && { is_highest: body.isHighest }),
    })
    await auditStep(trx, ctx, 'qualification', { action: 'app.teacher_qualification_updated', details: { qualificationId: id, level: row.level, isHighest: row.is_highest } })
    await repo.recomputeCompleteness(trx, ctx.teacherId)
    return toQualification(row)
  })
}

export async function deleteQualification(ctx: TeacherContext, id: string) {
  await throttle(ctx.teacherId)
  await db.transaction().execute(async (trx) => {
    const t = await repo.lockTeacher(trx, ctx.teacherId)
    if (!t) throw notFound('Profile not found.')
    assertEditable(t.verification_status)
    const existing = await repo.findQualification(trx, ctx.teacherId, id)
    if (!existing) throw notFound('This is no longer available.')
    await repo.softDeleteQualification(trx, id)
    await auditStep(trx, ctx, 'qualification', { action: 'app.teacher_qualification_deleted', details: { qualificationId: id, level: existing.level, isHighest: existing.is_highest } })
    await repo.recomputeCompleteness(trx, ctx.teacherId)
  })
}

// ---- replace-set steps (BR-14.6) ----

async function withEditableTeacher<T>(ctx: TeacherContext, fn: (trx: Parameters<typeof repo.lockTeacher>[0]) => Promise<T>): Promise<T> {
  await throttle(ctx.teacherId)
  return db.transaction().execute(async (trx) => {
    const t = await repo.lockTeacher(trx, ctx.teacherId)
    if (!t) throw notFound('Profile not found.')
    assertEditable(t.verification_status)
    return fn(trx)
  })
}

const countOf = (items: { isPrimary: boolean }[]) => items.filter((i) => i.isPrimary).length

export async function setSubjects(ctx: TeacherContext, body: z.infer<typeof setSubjectsSchema>) {
  const items = body.items.map((i) => ({ subjectId: i.subjectId, isPrimary: i.isPrimary, experienceYears: i.experienceYears ?? null }))
  const ids = items.map((i) => i.subjectId)
  if (new Set(ids).size !== ids.length) throw fieldError('items', 'Each subject can only be added once.')
  const primaries = countOf(items)
  if (primaries > 1) throw fieldError('items', 'Choose one primary subject.')
  if (primaries === 0) items[0]!.isPrimary = true // auto-promote the first (Admin FR-18.2)
  if ((await repo.countActiveSubjects(ids)) !== ids.length) throw fieldError('items', 'One of those subjects is not available.')

  return withEditableTeacher(ctx, async (trx) => {
    const diff = await repo.replaceSubjects(trx, ctx.teacherId, items)
    await auditStep(trx, ctx, 'subjects', { action: 'app.teacher_subjects_set', details: diff })
    await repo.recomputeCompleteness(trx, ctx.teacherId)
    trackEvent('teacher.registration_step_saved')
    return { items: (await repo.listSubjects(ctx.teacherId, trx)).map((s) => ({ subjectId: s.subject_id, name: s.name, isPrimary: s.is_primary, experienceYears: s.experience_years })) }
  })
}

export async function setClasses(ctx: TeacherContext, body: z.infer<typeof setClassesSchema>) {
  const items = body.items.map((i) => ({ classId: i.classId, boardId: i.boardId ?? null }))
  const classIds = items.map((i) => i.classId)
  if (new Set(classIds).size !== classIds.length) throw fieldError('items', 'Each class can only be added once.')
  if ((await repo.countActiveClasses(classIds)) !== classIds.length) throw fieldError('items', 'One of those classes is not available.')
  const boardIds = [...new Set(items.map((i) => i.boardId).filter((b): b is string => b !== null))]
  if ((await repo.countActiveBoards(boardIds)) !== boardIds.length) throw fieldError('items', 'One of those boards is not available.')

  return withEditableTeacher(ctx, async (trx) => {
    const diff = await repo.replaceClasses(trx, ctx.teacherId, items)
    await auditStep(trx, ctx, 'classes', { action: 'app.teacher_classes_set', details: diff })
    await repo.recomputeCompleteness(trx, ctx.teacherId)
    trackEvent('teacher.registration_step_saved')
    return { items: (await repo.listClasses(ctx.teacherId, trx)).map((c) => ({ classId: c.class_id, boardId: c.board_id, name: c.name })) }
  })
}

export async function setTeachingModes(ctx: TeacherContext, body: z.infer<typeof setTeachingModesSchema>) {
  const ids = body.items
  if (new Set(ids).size !== ids.length) throw fieldError('items', 'Each teaching mode can only be added once.')
  if ((await repo.findActiveTeachingModes(ids)).length !== ids.length) throw fieldError('items', 'One of those teaching modes is not available.')

  return withEditableTeacher(ctx, async (trx) => {
    const diff = await repo.replaceTeachingModes(trx, ctx.teacherId, ids)
    await auditStep(trx, ctx, 'teaching_modes', { action: 'app.teacher_modes_set', details: diff })
    await repo.recomputeCompleteness(trx, ctx.teacherId)
    trackEvent('teacher.registration_step_saved')
    return { items: (await repo.listTeachingModes(ctx.teacherId, trx)).map((m) => ({ teachingModeId: m.teaching_mode_id, name: m.name, code: m.code })) }
  })
}

export async function setLocations(ctx: TeacherContext, body: z.infer<typeof setLocationsSchema>) {
  const items = body.items.map((i) => ({
    cityId: i.cityId,
    areaId: i.areaId ?? null,
    isPrimary: i.isPrimary,
    travelRadiusKm: i.travelRadiusKm ?? null,
    addressLine: i.addressLine?.trim() || null,
    latitude: i.latitude ?? null,
    longitude: i.longitude ?? null,
  }))

  if (items.length > 0 && countOf(items) !== 1) throw fieldError('items', 'Choose one primary location.')
  const keys = items.map((i) => `${i.cityId}:${i.areaId ?? ''}`)
  if (new Set(keys).size !== keys.length) throw fieldError('items', 'Each location can only be added once.')

  if (items.length > 0) {
    const cityIds = [...new Set(items.map((i) => i.cityId))]
    if ((await repo.findActiveCities(cityIds)).length !== cityIds.length) throw fieldError('items', 'One of those cities is not available.')
    const areaIds = items.map((i) => i.areaId).filter((a): a is string => a !== null)
    if (areaIds.length) {
      const areas = await repo.findActiveAreas(areaIds)
      for (const i of items) {
        if (i.areaId && areas.find((a) => a.id === i.areaId)?.city_id !== i.cityId) throw fieldError('items', 'Pick an area in the selected city.')
      }
    }
  }

  return withEditableTeacher(ctx, async (trx) => {
    const modes = await repo.listTeachingModes(ctx.teacherId, trx)
    // Required unless the teacher has chosen modes and none of them needs a location (pure online tutor).
    const onlineOnly = modes.length > 0 && modes.every((m) => !m.requires_location)
    if (items.length === 0 && !onlineOnly) {
      throw validationFailed([{ path: 'items', message: 'Add a city you teach in', reason: 'location_required' }], 'Add a city you teach in')
    }
    if (modes.some((m) => m.code === 'HOME_TUITION')) {
      const missing = items.findIndex((i) => i.travelRadiusKm === null)
      if (missing !== -1) throw fieldError(`items.${missing}.travelRadiusKm`, "Set how far you're willing to travel")
    }
    const diff = await repo.replaceLocations(trx, ctx.teacherId, items)
    await auditStep(trx, ctx, 'locations', { action: 'app.teacher_locations_set', details: diff })
    await repo.recomputeCompleteness(trx, ctx.teacherId)
    trackEvent('teacher.registration_step_saved')
    return { items: (await repo.listLocations(ctx.teacherId, trx)).map(toLocation) }
  })
}

