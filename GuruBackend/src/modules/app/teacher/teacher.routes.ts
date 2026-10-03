import { Router } from 'express'
import type { Request } from 'express'
import { validationFailed } from '../../../lib/errors.js'
import { parseIfMatch } from '../../../lib/ifMatch.js'
import { authenticateApp } from '../../../middleware/authenticateApp.js'
import { authenticateRegistration } from '../../../middleware/authenticateRegistration.js'
import { requireTeacher } from '../../../middleware/requireRole.js'
import { validateBody } from '../../../middleware/validate.js'
import { requestContext } from '../student/student.routes.js'
import { basicsSchema, createQualificationSchema, idParamSchema, registerTeacherSchema, setClassesSchema, setLocationsSchema, setSubjectsSchema, setTeachingModesSchema, updateQualificationSchema } from './teacher.schemas.js'
import * as service from './teacher.service.js'

export const teacherRouter = Router()

const ctx = (req: Request) => ({ ...requestContext(req), teacherId: req.teacher!.id, userId: req.teacher!.userId })

function paramId(req: Request): string {
  const parsed = idParamSchema.safeParse(req.params)
  if (!parsed.success) throw validationFailed([{ path: 'id', message: 'Invalid id.' }])
  return parsed.data.id
}

teacherRouter.post('/registration/teacher', authenticateRegistration, validateBody(registerTeacherSchema), async (req, res) => {
  const idempotencyKey = req.header('Idempotency-Key')
  if (!idempotencyKey) throw validationFailed(undefined, 'Missing Idempotency-Key header.')
  res.status(201).json({ data: await service.registerTeacher(req.registration!, req.body, idempotencyKey, requestContext(req)) })
})

const guard = [authenticateApp, requireTeacher]

teacherRouter.get('/teacher/registration', ...guard, async (req, res) => {
  res.status(200).json({ data: await service.getRegistration(req.teacher!.id) })
})

teacherRouter.patch('/teacher/registration/basics', ...guard, validateBody(basicsSchema), async (req, res) => {
  const version = parseIfMatch(req.header('If-Match'))
  res.status(200).json({ data: await service.updateBasics(ctx(req), version, req.body) })
})

teacherRouter.post('/teacher/qualifications', ...guard, validateBody(createQualificationSchema), async (req, res) => {
  res.status(201).json({ data: await service.createQualification(ctx(req), req.body) })
})

teacherRouter.patch('/teacher/qualifications/:id', ...guard, validateBody(updateQualificationSchema), async (req, res) => {
  res.status(200).json({ data: await service.updateQualification(ctx(req), paramId(req), req.body) })
})

teacherRouter.delete('/teacher/qualifications/:id', ...guard, async (req, res) => {
  await service.deleteQualification(ctx(req), paramId(req))
  res.status(200).json({ data: { ok: true } })
})

teacherRouter.put('/teacher/subjects', ...guard, validateBody(setSubjectsSchema), async (req, res) => {
  res.status(200).json({ data: await service.setSubjects(ctx(req), req.body) })
})

teacherRouter.put('/teacher/classes', ...guard, validateBody(setClassesSchema), async (req, res) => {
  res.status(200).json({ data: await service.setClasses(ctx(req), req.body) })
})

teacherRouter.put('/teacher/teaching-modes', ...guard, validateBody(setTeachingModesSchema), async (req, res) => {
  res.status(200).json({ data: await service.setTeachingModes(ctx(req), req.body) })
})

teacherRouter.put('/teacher/locations', ...guard, validateBody(setLocationsSchema), async (req, res) => {
  res.status(200).json({ data: await service.setLocations(ctx(req), req.body) })
})
