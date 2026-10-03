import { Router } from 'express'
import type { Request } from 'express'
import { validationFailed } from '../../../lib/errors.js'
import { parseIfMatch } from '../../../lib/ifMatch.js'
import { authenticateApp } from '../../../middleware/authenticateApp.js'
import { requireTeacher } from '../../../middleware/requireRole.js'
import { validateBody } from '../../../middleware/validate.js'
import { requestContext } from '../student/student.routes.js'
import { createFeePlanSchema, idParamSchema, patchProfileSchema, updateFeePlanSchema } from './profile.schemas.js'
import * as service from './profile.service.js'

export const teacherProfileRouter = Router()

const guard = [authenticateApp, requireTeacher]
const ctx = (req: Request) => ({ ...requestContext(req), teacherId: req.teacher!.id, userId: req.teacher!.userId })
function paramId(req: Request): string {
  const parsed = idParamSchema.safeParse(req.params)
  if (!parsed.success) throw validationFailed([{ path: 'id', message: 'Invalid id.' }])
  return parsed.data.id
}

teacherProfileRouter.get('/teacher/profile', ...guard, async (req, res) => {
  res.status(200).json({ data: await service.getProfile(req.teacher!.id) })
})

teacherProfileRouter.patch('/teacher/profile', ...guard, validateBody(patchProfileSchema), async (req, res) => {
  const version = parseIfMatch(req.header('If-Match'))
  res.status(200).json({ data: await service.updateProfile(ctx(req), version, req.body) })
})

teacherProfileRouter.get('/teacher/profile/preview', ...guard, async (req, res) => {
  res.status(200).json({ data: await service.getPreview(req.teacher!.id) })
})

teacherProfileRouter.get('/teacher/fee-plans', ...guard, async (req, res) => {
  res.status(200).json({ data: await service.listFeePlans(req.teacher!.id) })
})

teacherProfileRouter.post('/teacher/fee-plans', ...guard, validateBody(createFeePlanSchema), async (req, res) => {
  res.status(201).json({ data: await service.createFeePlan(ctx(req), req.body) })
})

teacherProfileRouter.patch('/teacher/fee-plans/:id', ...guard, validateBody(updateFeePlanSchema), async (req, res) => {
  res.status(200).json({ data: await service.updateFeePlan(ctx(req), paramId(req), req.body) })
})

teacherProfileRouter.delete('/teacher/fee-plans/:id', ...guard, async (req, res) => {
  await service.deleteFeePlan(ctx(req), paramId(req))
  res.status(200).json({ data: { ok: true } })
})
