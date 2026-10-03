import type { NextFunction, Request, Response } from 'express'
import { db } from '../db/index.js'
import { forbidden } from '../lib/errors.js'

// Same contract as requireParent: runs after authenticateApp, resolves the role profile id from the token's `pid`
// (falling back to a lookup when the token pre-dates the profile) and exposes it on the request. Handlers scope by
// it and never accept a student/teacher id from the body or query.
async function resolveProfileId(req: Request, role: 'student' | 'teacher'): Promise<string> {
  const auth = req.appAuth
  if (!auth || auth.role !== role) throw forbidden("You can't do that.")
  if (auth.profileId) return auth.profileId

  const table = role === 'student' ? 'students' : 'teachers'
  const row = await db.selectFrom(table).select('id').where('user_id', '=', auth.userId).where('deleted_at', 'is', null).executeTakeFirst()
  if (!row) throw forbidden("You can't do that.")
  return row.id
}

export async function requireStudent(req: Request, _res: Response, next: NextFunction) {
  req.student = { id: await resolveProfileId(req, 'student'), userId: req.appAuth!.userId }
  next()
}

export async function requireTeacher(req: Request, _res: Response, next: NextFunction) {
  req.teacher = { id: await resolveProfileId(req, 'teacher'), userId: req.appAuth!.userId }
  next()
}

// Institute staff: the pid claim is institute_managers.id and iid the institute. The row is re-read on every call so a
// disabled manager loses access immediately, and `requireInstituteManager` additionally demands staff_role = manager
// (counsellors handle leads only).
async function loadManager(req: Request) {
  const auth = req.appAuth
  if (!auth || auth.role !== 'institute_staff') throw forbidden("You can't do that.")
  const row = await db
    .selectFrom('institute_managers')
    .select(['id', 'user_id', 'institute_id', 'staff_role', 'is_primary'])
    .where('user_id', '=', auth.userId)
    .where('status', '=', 'active')
    .$if(Boolean(auth.profileId), (qb) => qb.where('id', '=', auth.profileId!))
    .$if(Boolean(auth.instituteId), (qb) => qb.where('institute_id', '=', auth.instituteId!))
    .executeTakeFirst()
  if (!row) throw forbidden("You can't do that.")
  return row
}

export async function requireInstituteStaff(req: Request, _res: Response, next: NextFunction) {
  const row = await loadManager(req)
  req.instituteManager = { id: row.id, userId: row.user_id!, instituteId: row.institute_id, staffRole: row.staff_role, isPrimary: row.is_primary }
  next()
}

export async function requireInstituteManager(req: Request, _res: Response, next: NextFunction) {
  const row = await loadManager(req)
  if (row.staff_role !== 'manager') throw forbidden('Only a manager can change these details.')
  req.instituteManager = { id: row.id, userId: row.user_id!, instituteId: row.institute_id, staffRole: row.staff_role, isPrimary: row.is_primary }
  next()
}
