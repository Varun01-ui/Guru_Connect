import { Router } from 'express'
import type { Request } from 'express'
import { validationFailed } from '../../../lib/errors.js'
import { authenticateApp } from '../../../middleware/authenticateApp.js'
import { requireTeacher } from '../../../middleware/requireRole.js'
import { validateBody } from '../../../middleware/validate.js'
import { requestContext } from '../student/student.routes.js'
import { createTimeOffSchema, idParamSchema, setAvailabilitySchema } from './availability.schemas.js'
import * as service from './availability.service.js'

export const teacherAvailabilityRouter = Router()

const guard = [authenticateApp, requireTeacher]
const ctx = (req: Request) => ({ ...requestContext(req), teacherId: req.teacher!.id, userId: req.teacher!.userId })

teacherAvailabilityRouter.get('/teacher/availability', ...guard, async (req, res) => {
  res.status(200).json({ data: await service.getAvailability(req.teacher!.id) })
})

teacherAvailabilityRouter.put('/teacher/availability', ...guard, validateBody(setAvailabilitySchema), async (req, res) => {
  res.status(200).json({ data: await service.setAvailability(ctx(req), req.body) })
})

teacherAvailabilityRouter.get('/teacher/time-off', ...guard, async (req, res) => {
  res.status(200).json({ data: await service.listTimeOff(req.teacher!.id) })
})

teacherAvailabilityRouter.post('/teacher/time-off', ...guard, validateBody(createTimeOffSchema), async (req, res) => {
  res.status(201).json({ data: await service.createTimeOff(ctx(req), req.body, req.header('Idempotency-Key') ?? undefined) })
})

teacherAvailabilityRouter.delete('/teacher/time-off/:id', ...guard, async (req, res) => {
  const parsed = idParamSchema.safeParse(req.params)
  if (!parsed.success) throw validationFailed([{ path: 'id', message: 'Invalid id.' }])
  await service.deleteTimeOff(ctx(req), parsed.data.id)
  res.status(200).json({ data: { ok: true } })
})
