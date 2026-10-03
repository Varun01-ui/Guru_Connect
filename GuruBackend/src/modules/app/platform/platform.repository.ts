import { db } from '../../../db/index.js'
import { computeProgress } from '../teacher/teacher.service.js'
import { getStaffMe } from '../institute/institute.service.js'

export async function findUserWithRoleProfile(userId: string) {
  const user = await db.selectFrom('app_users').selectAll().where('id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst()
  if (!user) return null

  if (user.user_type === 'parent') {
    const parent = await db.selectFrom('parents').selectAll().where('user_id', '=', userId).executeTakeFirst()
    const childCount = parent
      ? await db
          .selectFrom('parent_children')
          .select(db.fn.countAll<number>().as('n'))
          .where('parent_id', '=', parent.id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst()
      : { n: 0 }
    return { user, profileId: parent?.id ?? null, nextStep: Number(childCount?.n ?? 0) > 0 ? null : ('child_setup' as const) }
  }

  if (user.user_type === 'student') {
    const student = await db.selectFrom('students').select(['id', 'parental_consent']).where('user_id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst()
    return { user, profileId: student?.id ?? null, nextStep: null, student: student ? { parentalConsent: student.parental_consent } : null }
  }

  if (user.user_type === 'teacher') {
    const teacher = await db.selectFrom('teachers').select(['id', 'verification_status']).where('user_id', '=', userId).where('deleted_at', 'is', null).executeTakeFirst()
    // The wizard resumes only while drafting; once submitted the app follows verification status instead (M14 BR-14.3).
    const nextStep = teacher && teacher.verification_status === 'draft' ? (await computeProgress(teacher.id)).nextStep : null
    return { user, profileId: teacher?.id ?? null, nextStep, teacher: teacher ? { verificationStatus: teacher.verification_status } : null }
  }

  if (user.user_type === 'institute_staff') {
    const staff = await getStaffMe(userId)
    return { user, profileId: staff?.profileId ?? null, nextStep: staff?.nextStep ?? null, institute: staff?.institute ?? null }
  }

  return { user, profileId: null, nextStep: null }
}

export async function findUserPhotoKey(userId: string): Promise<string | null> {
  const row = await db
    .selectFrom('app_users as u')
    .innerJoin('files as f', (join) => join.onRef('f.id', '=', 'u.profile_photo_file_id').on('f.deleted_at', 'is', null).on('f.status', '=', 'uploaded').on('f.visibility', '=', 'public'))
    .select('f.object_key')
    .where('u.id', '=', userId)
    .executeTakeFirst()
  return row?.object_key ?? null
}

export async function upsertDevice(
  userId: string,
  input: {
    installId: string
    platform: 'android' | 'ios'
    osVersion?: string
    appVersion: string
    buildNumber?: number
    deviceModel?: string
    locale?: string
    timezone?: string
  },
) {
  await db
    .insertInto('user_devices')
    .values({
      user_id: userId,
      install_id: input.installId,
      platform: input.platform,
      os_version: input.osVersion ?? null,
      app_version: input.appVersion,
      build_number: input.buildNumber ?? null,
      device_model: input.deviceModel ?? null,
      locale: input.locale ?? null,
      timezone: input.timezone ?? 'Asia/Kolkata',
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'install_id']).doUpdateSet({
        os_version: input.osVersion ?? null,
        app_version: input.appVersion,
        build_number: input.buildNumber ?? null,
        device_model: input.deviceModel ?? null,
        locale: input.locale ?? null,
        last_seen_at: new Date(),
        revoked_at: null,
      }),
    )
    .execute()
}

export async function revokeDevice(userId: string, installId: string) {
  await db.updateTable('user_devices').set({ revoked_at: new Date() }).where('user_id', '=', userId).where('install_id', '=', installId).execute()
}

export async function listMasters() {
  const [states, cities, boards, classes, subjects, teacherCategories, teachingModes] = await Promise.all([
    db.selectFrom('states').select(['id', 'name', 'code']).where('is_active', '=', true).where('deleted_at', 'is', null).orderBy('name').execute(),
    db.selectFrom('cities').select(['id', 'state_id', 'name']).where('is_active', '=', true).where('deleted_at', 'is', null).orderBy('name').execute(),
    db
      .selectFrom('boards')
      .select(['id', 'name', 'short_name', 'type', 'state_id'])
      .where('is_active', '=', true)
      .where('deleted_at', 'is', null)
      .orderBy('sort_order')
      .orderBy('short_name')
      .execute(),
    db.selectFrom('classes').select(['id', 'name', 'level_order']).where('is_active', '=', true).where('deleted_at', 'is', null).orderBy('level_order').execute(),
    db
      .selectFrom('subjects')
      .select(['id', 'name', 'min_class_order', 'max_class_order'])
      .where('is_active', '=', true)
      .where('deleted_at', 'is', null)
      .orderBy('sort_order')
      .orderBy('name')
      .execute(),
    db.selectFrom('teacher_categories').select(['id', 'name']).where('is_active', '=', true).where('deleted_at', 'is', null).orderBy('sort_order').orderBy('name').execute(),
    db.selectFrom('teaching_modes').select(['id', 'name']).where('is_active', '=', true).where('deleted_at', 'is', null).orderBy('sort_order').orderBy('name').execute(),
  ])
  return { states, cities, boards, classes, subjects, teacherCategories, teachingModes }
}

export async function listAreasForCity(cityId: string) {
  return db
    .selectFrom('areas')
    .select(['id', 'city_id', 'name'])
    .where('city_id', '=', cityId)
    .where('is_active', '=', true)
    .where('deleted_at', 'is', null)
    .orderBy('name')
    .execute()
}
