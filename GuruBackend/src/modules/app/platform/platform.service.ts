import { notFound } from '../../../lib/errors.js'
import { cdnUrl } from '../../../lib/present.js'
import * as repo from './platform.repository.js'

export async function getMe(userId: string) {
  const result = await repo.findUserWithRoleProfile(userId)
  if (!result) throw notFound('Account not found.')
  const { user, profileId, nextStep } = result
  const student = 'student' in result ? result.student : null
  const teacher = 'teacher' in result ? result.teacher : null
  const institute = 'institute' in result ? result.institute : null
  const photoUrl = cdnUrl(await repo.findUserPhotoKey(userId))

  return {
    userId: user.id,
    role: user.user_type,
    profileId,
    name: user.full_name,
    photo: photoUrl,
    photoUrl,
    language: user.preferred_language,
    accountStatus: user.account_status,
    registration: { complete: nextStep === null, nextStep },
    // Drives the Home banner for students waiting on a parent (M11 BR-11.8): a status enum only, never the parent phone.
    student,
    teacher,
    institute,
    unreadCount: 0,
    subscriptionSummary: null,
    featureFlags: {},
  }
}

export async function getMasters() {
  const masters = await repo.listMasters()
  return {
    states: masters.states.map((s) => ({ id: s.id, name: s.name, code: s.code })),
    cities: masters.cities.map((c) => ({ id: c.id, stateId: c.state_id, name: c.name })),
    boards: masters.boards.map((b) => ({ id: b.id, name: b.name, shortName: b.short_name, type: b.type, stateId: b.state_id })),
    classes: masters.classes.map((c) => ({ id: c.id, name: c.name, levelOrder: c.level_order })),
    subjects: masters.subjects.map((s) => ({ id: s.id, name: s.name, minClassOrder: s.min_class_order, maxClassOrder: s.max_class_order })),
    teacherCategories: masters.teacherCategories.map((c) => ({ id: c.id, name: c.name })),
    teachingModes: masters.teachingModes.map((m) => ({ id: m.id, name: m.name })),
  }
}

export async function getAreas(cityId: string) {
  const areas = await repo.listAreasForCity(cityId)
  return { areas: areas.map((a) => ({ id: a.id, cityId: a.city_id, name: a.name })) }
}
