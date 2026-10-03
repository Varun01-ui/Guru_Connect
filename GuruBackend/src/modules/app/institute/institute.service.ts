import { sql } from 'kysely'
import type { z } from 'zod'
import { db } from '../../../db/index.js'
import { audit } from '../../../lib/audit.js'
import type { RegistrationClaims } from '../../../lib/appJwt.js'
import { ApiError, conflictState, forbidden, notFound, rateLimited, validationFailed, versionConflict } from '../../../lib/errors.js'
import { GSTIN_MESSAGES, isValidGstin, maskGstin, normaliseGstin } from '../../../lib/gstin.js'
import { haversineKm } from '../../../lib/geo.js'
import { getIdempotent, putIdempotent } from '../../../lib/idempotency.js'
import { kvGet, kvSet } from '../../../lib/kv.js'
import { createNotification } from '../../../lib/notify.js'
import { consoleEmailProvider } from '../../../lib/providers/email.js'
import { hitRateLimit } from '../../../lib/rateLimit.js'
import { slugify } from '../../../lib/slug.js'
import { issueSession } from '../auth/session.js'
import * as registrationRepo from '../registration/registration.repository.js'
import { resolveReferral } from '../registration/registration.service.js'
import type { RequestContext } from '../student/student.service.js'
import * as repo from './institute.repository.js'
import type { basicsPatchSchema, registerJoinSchema, registerOwnerSchema } from './institute.schemas.js'
import type { AppTrx } from '../registration/registration.repository.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const MAX_PIN_DISTANCE_KM = 40
const INVITE_TTL_MS = 72 * HOUR
const REAPPLY_AFTER_MS = 30 * DAY
const MAX_OWNER_REGISTRATIONS_PER_INSTALL = 2

type OwnerBody = z.infer<typeof registerOwnerSchema>
type JoinBody = z.infer<typeof registerJoinSchema>
export type InstituteRequestContext = RequestContext & { acceptLanguage: string | null }

type FieldError = { path: string; message: string }
const fieldErrors = (errors: FieldError[]) => validationFailed(errors, 'Please check the highlighted fields.')
const usedTokenKey = (jti: string) => `regtoken:used:${jti}`
const tokenExpired = () => new ApiError(401, 'AUTH_REQUIRED', 'Please verify your number again to finish.', { reason: 'registration_token_expired' })

function languageOf(acceptLanguage: string | null): string {
  const tag = acceptLanguage?.split(',')[0]?.trim().slice(0, 2).toLowerCase()
  return tag && /^[a-z]{2}$/.test(tag) ? tag : 'en'
}

// ---- shared validation: location + GSTIN (BR-21.4, BR-21.5) ----

async function checkLocation(input: { cityId: string; areaId: string; latitude: number; longitude: number }, prefix: string, errors: FieldError[]) {
  const city = await repo.findCityWithState(input.cityId)
  if (!city) {
    errors.push({ path: `${prefix}cityId`, message: 'Choose your city.' })
    return { city: null, area: null }
  }
  const area = await repo.findAreaInCity(input.areaId, input.cityId)
  if (!area) errors.push({ path: `${prefix}areaId`, message: 'Choose your area.' })
  if (city.latitude !== null && city.longitude !== null) {
    const km = haversineKm({ lat: Number(city.latitude), lng: Number(city.longitude) }, { lat: input.latitude, lng: input.longitude })
    if (km > MAX_PIN_DISTANCE_KM) errors.push({ path: `${prefix}latitude`, message: `The pin is too far from ${city.name}. Move it to your institute.` })
  }
  return { city, area: area ?? null }
}

function checkGstinFormat(gstin: string | null, stateCode: string | null, path: string, errors: FieldError[]): boolean {
  if (!gstin) return true
  const result = isValidGstin(gstin, stateCode)
  if (!result.ok) {
    errors.push({ path, message: GSTIN_MESSAGES[result.reason] })
    return false
  }
  return true
}

const gstinInUse = (path: string) =>
  new ApiError(409, 'CONFLICT_DUPLICATE', 'This GSTIN is already registered on GuruConnect. Contact support if this is your institute.', { reason: 'gstin_in_use', path })
const phoneInUse = () => new ApiError(409, 'CONFLICT_DUPLICATE', 'This number already has a GuruConnect account. Sign in instead.', { reason: 'phone_in_use', path: 'owner.mobile' })

async function uniqueSlug(trx: AppTrx, name: string, areaName: string | null, exceptInstituteId?: string): Promise<string> {
  const base = slugify(name, areaName)
  if (!(await repo.slugTaken(base, trx, exceptInstituteId))) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const candidate = `${base.slice(0, 80 - suffix.length)}${suffix}`
    if (!(await repo.slugTaken(candidate, trx, exceptInstituteId))) return candidate
  }
}

// ---- POST /registration/institute (BR-21.6, BR-21.8) ----

export async function registerInstitute(claims: RegistrationClaims, body: OwnerBody | JoinBody, idempotencyKey: string, ctx: InstituteRequestContext) {
  const cacheKey = `inst:${claims.jti}:${idempotencyKey}`
  const cached = await getIdempotent(cacheKey)
  if (cached) return cached.body // a retry after a timeout gets the original 201 body

  const role = (claims as { role?: string }).role
  if (role && role !== 'institute_staff') throw forbidden("You can't do that.")
  if (await kvGet(usedTokenKey(claims.jti))) throw tokenExpired()

  const installKey = ctx.installId ?? ctx.ip ?? 'unknown'
  const attempts = await hitRateLimit(`inst-reg:${installKey}`, 5, HOUR)
  if (!attempts.allowed) throw rateLimited(attempts.retryAfterSeconds)

  // The mobile must be the verified phone from the token; an email or Google token cannot register yet (no combined token).
  if (claims.contactType !== 'phone') throw fieldErrors([{ path: 'owner.mobile', message: 'Verify your mobile number to continue.' }])

  const response = body.mode === 'owner' ? await registerOwner(claims, body, installKey, ctx) : await registerJoin(claims, body, ctx)
  await kvSet(usedTokenKey(claims.jti), '1', 3600)
  await putIdempotent(cacheKey, 201, response)
  return response
}

async function registerOwner(claims: RegistrationClaims, body: OwnerBody, installKey: string, ctx: InstituteRequestContext) {
  const okKey = `inst:reg:ok:${installKey}`
  if (Number((await kvGet(okKey)) ?? 0) >= MAX_OWNER_REGISTRATIONS_PER_INSTALL) {
    throw new ApiError(429, 'LIMIT_REACHED', "You've registered the maximum number of institutes from this phone. Contact support.", { reason: 'install_registrations', limit: MAX_OWNER_REGISTRATIONS_PER_INSTALL })
  }

  const phone = claims.sub // the token's verified phone, never the body's
  const i = body.institute
  const errors: FieldError[] = []
  const gstin = normaliseGstin(i.gstin)
  const { city, area } = await checkLocation(i, 'institute.', errors)
  checkGstinFormat(gstin, city?.state_code ?? null, 'institute.gstin', errors)
  if (errors.length > 0) throw fieldErrors(errors)

  if (await registrationRepo.isContactClaimed(phone, undefined)) throw phoneInUse()
  if (gstin && (await repo.isGstinInUse(gstin))) throw gstinInUse('institute.gstin')
  const referral = await resolveReferral(body.referralCode, 'INSTITUTE_REFERRAL')
  const programOn = referral ? Boolean((await db.selectFrom('referral_settings').select('is_enabled').where('id', '=', referral.settingId).executeTakeFirst())?.is_enabled) : false

  let created: { userId: string; managerId: string; institute: { id: string; public_code: string; slug: string; name: string } }
  try {
    created = await db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext('institute-slug'))`.execute(trx)
      const user = await registrationRepo.insertAppUserTx(trx, { fullName: body.owner.fullName, phone, email: null, signupSource: referral && programOn ? 'referral' : 'organic', userType: 'institute_staff', language: languageOf(ctx.acceptLanguage) })
      await registrationRepo.insertPhoneIdentityTx(trx, user.id, phone)
      const slug = await uniqueSlug(trx, i.name, area!.name)
      const institute = await repo.insertInstituteTx(trx, { name: i.name, slug, instituteType: i.instituteType, phone, email: i.email ?? null, gstin, addressLine: i.addressLine, cityId: i.cityId, areaId: i.areaId, pincode: i.pincode, latitude: i.latitude, longitude: i.longitude })
      const manager = await repo.insertOwnerManagerTx(trx, { instituteId: institute.id, userId: user.id, fullName: body.owner.fullName, email: i.email ?? null, phone })
      await repo.insertConsentsTx(trx, user.id, { documentVersion: body.consents.documentVersion, ipAddress: ctx.ip, installId: ctx.installId })
      if (referral && programOn) {
        await registrationRepo.insertReferralTx(trx, { referralCodeId: referral.row.id, referrerUserId: referral.row.user_id, refereeUserId: user.id, referralSettingId: referral.settingId })
      }
      await audit(trx, {
        actorType: 'app_user',
        actorId: user.id,
        action: 'app.institute_registered',
        module: 'app.institute_registration',
        entityType: 'institute',
        entityId: institute.id,
        newValues: { instituteId: institute.id, publicCode: institute.public_code, instituteType: i.instituteType, cityId: i.cityId, hasGstin: Boolean(gstin), signupSource: referral && programOn ? 'referral' : 'organic' },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      })
      return { userId: user.id, managerId: manager.id, institute }
    })
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') {
      const constraint = (err as { constraint?: string }).constraint ?? ''
      if (constraint.includes('app_users') || constraint.includes('identities')) throw phoneInUse()
    }
    throw err
  }

  await kvSet(okKey, String(Number((await kvGet(okKey)) ?? 0) + 1), 30 * 24 * 3600)
  const session = await issueSession(created.userId, 'institute_staff', { authMethod: 'otp', ipAddress: ctx.ip, userAgent: ctx.userAgent })
  if (i.email) await consoleEmailProvider.send(i.email, 'Welcome to GuruConnect', `Hi ${body.owner.fullName}, ${i.name} is registered. Upload your documents to get verified.`).catch(() => undefined)

  return {
    session: { accessToken: session.accessToken, expiresIn: session.expiresIn, refreshToken: session.refreshToken, sessionId: session.session.id },
    user: { id: created.userId, role: 'institute_staff' as const, profileId: created.managerId, fullName: body.owner.fullName },
    institute: { id: created.institute.id, publicCode: created.institute.public_code, slug: created.institute.slug, name: created.institute.name, verificationStatus: 'draft' as const, staffRole: 'manager' as const, isPrimary: true },
    nextStep: 'institute_documents' as const,
  }
}

async function registerJoin(claims: RegistrationClaims, body: JoinBody, ctx: InstituteRequestContext) {
  const phone = claims.sub
  if (await registrationRepo.isContactClaimed(phone, undefined)) throw phoneInUse()

  const done = await db.transaction().execute(async (trx) => {
    const invite = await repo.findInviteTx(trx, body.inviteId)
    // Not found, someone else's number, already used, disabled: all the same answer, so ids cannot be probed.
    if (!invite || invite.phone !== phone || invite.status !== 'invited' || invite.user_id !== null || invite.institute_deleted_at !== null || invite.account_status !== 'active') {
      throw fieldErrors([{ path: 'inviteId', message: 'This invite is no longer valid.' }])
    }
    if (!invite.invited_at || Date.now() - invite.invited_at.getTime() > INVITE_TTL_MS) throw conflictState('This invite has expired. Ask the manager to send a new one.', { reason: 'invite_expired' })

    const user = await registrationRepo.insertAppUserTx(trx, { fullName: body.fullName, phone, email: null, signupSource: 'organic', userType: 'institute_staff', language: languageOf(ctx.acceptLanguage) })
    await registrationRepo.insertPhoneIdentityTx(trx, user.id, phone)
    await repo.insertConsentsTx(trx, user.id, { documentVersion: body.consents.documentVersion, ipAddress: ctx.ip, installId: ctx.installId })
    await repo.acceptInviteTx(trx, { managerId: invite.id, userId: user.id, fullName: body.fullName })
    await audit(trx, {
      actorType: 'app_user',
      actorId: user.id,
      action: 'app.institute_staff_joined',
      module: 'app.institute_registration',
      entityType: 'institute_manager',
      entityId: invite.id,
      newValues: { instituteId: invite.institute_id, staffId: invite.id, staffRole: invite.staff_role },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    })
    return { userId: user.id, invite }
  })

  const { invite, userId } = done
  // M24 owns the template; the primary manager hears about it in-app (push delivery is out of scope).
  const primary = await repo.findPrimaryManager(invite.institute_id)
  if (primary?.user_id) {
    await createNotification(db, {
      userId: primary.user_id,
      category: 'account',
      eventType: 'institute.staff_joined',
      title: `${body.fullName} joined your team`,
      body: `They can now answer enquiries as ${invite.staff_role === 'manager' ? 'Manager' : 'Counsellor'}.`,
      deepLink: '/institute/staff',
      data: { staffId: invite.id },
      dedupeKey: `institute.staff_joined:${invite.id}`,
    })
  }

  const session = await issueSession(userId, 'institute_staff', { authMethod: 'otp', ipAddress: ctx.ip, userAgent: ctx.userAgent })
  return {
    session: { accessToken: session.accessToken, expiresIn: session.expiresIn, refreshToken: session.refreshToken, sessionId: session.session.id },
    user: { id: userId, role: 'institute_staff' as const, profileId: invite.id, fullName: body.fullName },
    institute: { id: invite.institute_id, name: invite.institute_name, verificationStatus: invite.verification_status, staffRole: invite.staff_role, isPrimary: false },
    nextStep: null,
  }
}

// ---- PATCH /institute/registration/basics (BR-21.9) ----

type BasicsBody = z.infer<typeof basicsPatchSchema>
export type InstituteContext = RequestContext & { userId: string; instituteId: string; managerId: string }

const IN_REVIEW = ['pending', 'under_review', 'visit_scheduled', 'evaluation_done']

export async function updateBasics(ctx: InstituteContext, version: Date, body: BasicsBody) {
  const gate = await hitRateLimit(`inst-basics:${ctx.userId}`, 30, HOUR)
  if (!gate.allowed) throw rateLimited(gate.retryAfterSeconds)

  return db.transaction().execute(async (trx) => {
    const cur = await trx.selectFrom('institutes').selectAll().where('id', '=', ctx.instituteId).where('deleted_at', 'is', null).forUpdate().executeTakeFirst()
    if (!cur) throw notFound('This is no longer available.')

    let reapplied = false
    if (cur.verification_status === 'rejected') {
      const canReapplyAt = cur.rejected_at ? new Date(cur.rejected_at.getTime() + REAPPLY_AFTER_MS) : null
      if (canReapplyAt && canReapplyAt.getTime() > Date.now()) throw conflictState('You can apply again later.', { reason: 'reapply_not_yet', canReapplyAt: canReapplyAt.toISOString() })
      reapplied = true
    } else if (cur.verification_status === 'approved') {
      throw conflictState('Edit these details from your institute profile.', { reason: 'approved_use_profile' })
    } else if (IN_REVIEW.includes(cur.verification_status)) {
      throw conflictState("Your application is being reviewed and can't be edited right now.", { reason: 'in_review' })
    }

    const errors: FieldError[] = []
    const cityChanged = body.cityId !== undefined && body.cityId !== cur.city_id
    const cityId = body.cityId ?? cur.city_id
    // A new city clears the area and needs a fresh pin (BR-21.9).
    if (cityChanged) {
      if (body.areaId === undefined) errors.push({ path: 'areaId', message: 'Choose your area.' })
      if (body.latitude === undefined || body.longitude === undefined) errors.push({ path: 'latitude', message: "Set your institute's location on the map." })
    }
    if ((body.latitude === undefined) !== (body.longitude === undefined)) errors.push({ path: 'latitude', message: "Set your institute's location on the map." })

    const areaId = body.areaId ?? (cityChanged ? null : cur.area_id)
    const latitude = body.latitude ?? Number(cur.latitude)
    const longitude = body.longitude ?? Number(cur.longitude)
    let stateCode: string | null = null
    let areaName: string | null = null

    if (errors.length === 0) {
      const city = await repo.findCityWithState(cityId)
      if (!city) errors.push({ path: 'cityId', message: 'Choose your city.' })
      else {
        stateCode = city.state_code
        const area = areaId ? await repo.findAreaInCity(areaId, cityId) : null
        if (!area) errors.push({ path: 'areaId', message: 'Choose your area.' })
        else areaName = area.name
        if ((body.latitude !== undefined || cityChanged) && city.latitude !== null && city.longitude !== null) {
          if (haversineKm({ lat: Number(city.latitude), lng: Number(city.longitude) }, { lat: latitude, lng: longitude }) > MAX_PIN_DISTANCE_KM) {
            errors.push({ path: 'latitude', message: `The pin is too far from ${city.name}. Move it to your institute.` })
          }
        }
      }
    }

    // GSTIN is re-checked against the (possibly new) city's state whenever either changes.
    const gstin = body.gstin !== undefined ? normaliseGstin(body.gstin) : cur.gstin
    if (body.gstin !== undefined || cityChanged) checkGstinFormat(gstin, stateCode, 'gstin', errors)
    if (errors.length > 0) throw fieldErrors(errors)
    if (gstin && gstin !== cur.gstin && (await repo.isGstinInUse(gstin, cur.id))) throw gstinInUse('gstin')

    const name = body.name ?? cur.name
    const slug = body.name !== undefined && body.name !== cur.name ? await uniqueSlug(trx, name, areaName, cur.id) : cur.slug
    const next = {
      name,
      slug,
      institute_type: (body.instituteType ?? cur.institute_type) as typeof cur.institute_type,
      email: body.email !== undefined ? body.email : cur.email,
      gstin,
      address_line: body.addressLine ?? cur.address_line,
      city_id: cityId,
      area_id: areaId!,
      pincode: body.pincode ?? cur.pincode,
      latitude: latitude.toFixed(6),
      longitude: longitude.toFixed(6),
      ...(reapplied ? { verification_status: 'draft' as const, rejection_reason_code: null, rejection_note: null } : {}),
    }

    const updated = await trx
      .updateTable('institutes')
      .set(next)
      .where('id', '=', cur.id)
      .where(sql<boolean>`abs(extract(epoch from updated_at) - extract(epoch from ${version}::timestamptz)) < 0.001`)
      .returning(['id', 'name', 'slug', 'gstin', 'pincode', 'verification_status', 'updated_at'])
      .executeTakeFirst()
    if (!updated) throw versionConflict()

    if (body.ownerName !== undefined) {
      const primary = await trx.selectFrom('institute_managers').select(['id', 'user_id']).where('institute_id', '=', cur.id).where('is_primary', '=', true).where('status', '<>', 'disabled').executeTakeFirst()
      if (primary) {
        await trx.updateTable('institute_managers').set({ full_name: body.ownerName }).where('id', '=', primary.id).execute()
        if (primary.user_id) await trx.updateTable('app_users').set({ full_name: body.ownerName }).where('id', '=', primary.user_id).execute()
      }
    }

    // Old/new for every changed field; the GSTIN is only ever logged as its last four characters.
    const changes: Record<string, { old: unknown; new: unknown }> = {}
    const note = (field: string, oldV: unknown, newV: unknown) => {
      if (oldV !== newV) changes[field] = { old: oldV, new: newV }
    }
    if (body.name !== undefined) note('name', cur.name, name)
    if (body.instituteType !== undefined) note('instituteType', cur.institute_type, next.institute_type)
    if (body.email !== undefined) note('email', cur.email, next.email)
    if (body.gstin !== undefined) note('gstin', maskGstin(cur.gstin), maskGstin(gstin))
    if (body.addressLine !== undefined) note('addressLine', cur.address_line, next.address_line)
    if (body.cityId !== undefined) note('cityId', cur.city_id, cityId)
    if (body.areaId !== undefined) note('areaId', cur.area_id, areaId)
    if (body.pincode !== undefined) note('pincode', cur.pincode, next.pincode)
    if (body.latitude !== undefined) note('latitude', cur.latitude, next.latitude)
    if (body.longitude !== undefined) note('longitude', cur.longitude, next.longitude)
    if (body.ownerName !== undefined) changes.ownerName = { old: null, new: body.ownerName }

    const base = { actorType: 'app_user' as const, actorId: ctx.userId, module: 'app.institute_registration', entityType: 'institute', entityId: cur.id, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId }
    await audit(trx, { ...base, action: 'app.institute_basics_updated', newValues: { changes } })
    if (reapplied) await audit(trx, { ...base, action: 'app.institute_reapplied', newValues: { previousRejectionReasonCode: cur.rejection_reason_code } })

    return { id: updated.id, name: updated.name, slug: updated.slug, gstin: updated.gstin, pincode: updated.pincode, verificationStatus: updated.verification_status, updatedAt: updated.updated_at.toISOString() }
  })
}

// ---- GET /me for institute staff (BR-21.10) ----

export async function getStaffMe(userId: string) {
  const row = await db
    .selectFrom('institute_managers as m')
    .innerJoin('institutes as i', 'i.id', 'm.institute_id')
    .select(['m.id as manager_id', 'm.staff_role', 'm.is_primary', 'i.id', 'i.name', 'i.verification_status'])
    .where('m.user_id', '=', userId)
    .where('m.status', '=', 'active')
    .where('i.deleted_at', 'is', null)
    .executeTakeFirst()
  if (!row) return null

  // Only the primary manager of a draft institute has registration steps left. The institute document rules belong to
  // Module 22, so "documents complete" is approximated as "at least one current document uploaded".
  let nextStep: 'institute_documents' | 'institute_submit' | null = null
  if (row.verification_status === 'draft' && row.staff_role === 'manager') {
    const docs = await db.selectFrom('institute_documents').select(db.fn.countAll<number>().as('n')).where('institute_id', '=', row.id).where('is_current', '=', true).executeTakeFirstOrThrow()
    nextStep = Number(docs.n) > 0 ? 'institute_submit' : 'institute_documents'
  }
  return { profileId: row.manager_id, nextStep, institute: { id: row.id, name: row.name, staffRole: row.staff_role, isPrimary: row.is_primary, verificationStatus: row.verification_status } }
}

// ---- reminders: a draft that was never submitted (section 16) ----

export async function sendDraftReminders(now = new Date()): Promise<number> {
  const rows = await db
    .selectFrom('institutes as i')
    .innerJoin('institute_managers as m', (j) => j.onRef('m.institute_id', '=', 'i.id').on('m.is_primary', '=', true).on('m.status', '=', 'active'))
    .select(['i.id', 'i.name', 'i.created_at', 'm.user_id'])
    .where('i.verification_status', '=', 'draft')
    .where('i.deleted_at', 'is', null)
    .where('i.created_at', '<=', new Date(now.getTime() - DAY))
    .where('i.created_at', '>', new Date(now.getTime() - 30 * DAY))
    .execute()

  let sent = 0
  for (const inst of rows) {
    if (!inst.user_id) continue
    const age = now.getTime() - inst.created_at.getTime()
    const milestone = age >= 7 * DAY ? '7d' : age >= 3 * DAY ? '72h' : '24h'
    const inserted = await createNotification(db, {
      userId: inst.user_id,
      category: 'verification',
      eventType: 'institute.draft_reminder',
      title: `Finish verifying ${inst.name}`,
      body: 'Upload your documents so parents can find you.',
      deepLink: '/institute/documents',
      data: { instituteId: inst.id, milestone },
      dedupeKey: `institute_draft_reminder_${milestone}:${inst.id}`,
    })
    if (inserted) sent += 1
  }
  return sent
}

