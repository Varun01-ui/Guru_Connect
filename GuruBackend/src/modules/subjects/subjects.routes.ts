import { Router } from 'express'
import type { Request } from 'express'
import { parseIfMatch } from '../../lib/ifMatch.js'
import { reasonBodySchema } from '../../lib/masters/query.js'
import { ctxOf, idParam, manageGuard } from '../../lib/masters/routes.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createSubjectSchema, listQuerySchema, mergeSubjectSchema, patchSubjectSchema } from './subjects.schemas.js'
import type { ListQuery } from './subjects.schemas.js'
import * as service from './subjects.service.js'

export const subjectsRouter = Router()

const READ = 'education_masters.read'
const MANAGE = 'education_masters.manage'
const manage = manageGuard(READ, MANAGE, 'subjects')
const id = (req: Request) => idParam(req, 'Subject not found.')

subjectsRouter.get('/subjects', authenticate, requirePermission(READ), validateQuery(listQuerySchema), async (req, res) => {
  const { data, meta } = await service.listSubjects(ctxOf(req), req.validatedQuery as ListQuery)
  res.status(200).json(meta ? { data, meta } : { data })
})

subjectsRouter.get('/subjects/:id', authenticate, requirePermission(READ), async (req, res) => {
  res.status(200).json({ data: await service.getSubject(ctxOf(req), id(req), req.query.includeDeleted === 'true') })
})

subjectsRouter.post('/subjects', authenticate, manage, validateBody(createSubjectSchema), async (req, res) => {
  res.status(201).json({ data: await service.createSubject(ctxOf(req), req.body) })
})

subjectsRouter.patch('/subjects/:id', authenticate, manage, validateBody(patchSubjectSchema), async (req, res) => {
  const subjectId = id(req)
  const version = parseIfMatch(req.header('If-Match'))
  res.status(200).json({ data: await service.patchSubject(ctxOf(req), subjectId, version, req.body) })
})

subjectsRouter.post('/subjects/:id/activate', authenticate, manage, validateBody(reasonBodySchema), async (req, res) => {
  res.status(200).json({ data: await service.setSubjectActive(ctxOf(req), id(req), true, req.body.reason) })
})

subjectsRouter.post('/subjects/:id/deactivate', authenticate, manage, validateBody(reasonBodySchema), async (req, res) => {
  res.status(200).json({ data: await service.setSubjectActive(ctxOf(req), id(req), false, req.body.reason) })
})

subjectsRouter.post('/subjects/:id/merge', authenticate, manage, validateBody(mergeSubjectSchema), async (req, res) => {
  res.status(200).json({ data: await service.mergeSubjects(ctxOf(req), id(req), req.body) })
})

subjectsRouter.delete('/subjects/:id', authenticate, manage, async (req, res) => {
  await service.deleteSubject(ctxOf(req), id(req))
  res.status(204).send()
})

subjectsRouter.post('/subjects/:id/restore', authenticate, manage, async (req, res) => {
  res.status(200).json({ data: await service.restoreSubject(ctxOf(req), id(req)) })
})
