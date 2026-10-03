import { Router } from 'express'
import type { Request } from 'express'
import { validationFailed } from '../../../lib/errors.js'
import { authenticateApp } from '../../../middleware/authenticateApp.js'
import { requireTeacher } from '../../../middleware/requireRole.js'
import { validateBody } from '../../../middleware/validate.js'
import { requestContext } from '../student/student.routes.js'
import { createDocumentSchema, documentIdParamSchema, submitSchema } from './docs.schemas.js'
import * as service from './docs.service.js'

export const teacherDocsRouter = Router()

const guard = [authenticateApp, requireTeacher]
const ctx = (req: Request) => ({ ...requestContext(req), teacherId: req.teacher!.id, userId: req.teacher!.userId })

teacherDocsRouter.get('/teacher/documents', ...guard, async (req, res) => {
  res.status(200).json({ data: await service.listDocuments(ctx(req)) })
})

teacherDocsRouter.post('/teacher/documents', ...guard, validateBody(createDocumentSchema), async (req, res) => {
  res.status(201).json({ data: await service.createDocument(ctx(req), req.body, req.header('Idempotency-Key') ?? undefined) })
})

teacherDocsRouter.delete('/teacher/documents/:id', ...guard, async (req, res) => {
  const parsed = documentIdParamSchema.safeParse(req.params)
  if (!parsed.success) throw validationFailed([{ path: 'id', message: 'Invalid id.' }])
  await service.deleteDocument(ctx(req), parsed.data.id)
  res.status(200).json({ data: { ok: true } })
})

teacherDocsRouter.post('/teacher/registration/submit', ...guard, validateBody(submitSchema), async (req, res) => {
  res.status(200).json({ data: await service.submitRegistration(ctx(req), req.body.transactionId) })
})
