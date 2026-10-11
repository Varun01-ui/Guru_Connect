import { Router } from 'express'
import type { Request } from 'express'
import { parseIfMatch } from '../../lib/ifMatch.js'
import { ctxOf, idParam, manageGuard } from '../../lib/masters/routes.js'
import { orderBodySchema, reasonBodySchema } from '../../lib/masters/query.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createClassSchema, listQuerySchema, patchClassSchema } from './classes.schemas.js'
import type { ListQuery } from './classes.schemas.js'
import * as service from './classes.service.js'

export const classesRouter = Router()

const READ = 'education_masters.read'
const MANAGE = 'education_masters.manage'
const manage = manageGuard(READ, MANAGE, 'classes')
const id = (req: Request) => idParam(req, 'Class not found.')

classesRouter.get('/classes', authenticate, requirePermission(READ), validateQuery(listQuerySchema), async (req, res) => {
  const { data, meta } = await service.listClasses(ctxOf(req), req.validatedQuery as ListQuery)
  res.status(200).json(meta ? { data, meta } : { data })
})

classesRouter.get('/classes/:id', authenticate, requirePermission(READ), async (req, res) => {
  res.status(200).json({ data: await service.getClass(ctxOf(req), id(req), req.query.includeDeleted === 'true') })
})

classesRouter.post('/classes', authenticate, manage, validateBody(createClassSchema), async (req, res) => {
  res.status(201).json({ data: await service.createClass(ctxOf(req), req.body) })
})

// Registered before nothing else with PUT, so "order" can never be read as an :id.
classesRouter.put('/classes/order', authenticate, manage, validateBody(orderBodySchema), async (req, res) => {
  await service.reorderClasses(ctxOf(req), req.body.ids)
  res.status(200).json({ data: { ok: true } })
})

classesRouter.patch('/classes/:id', authenticate, manage, validateBody(patchClassSchema), async (req, res) => {
  const classId = id(req)
  const version = parseIfMatch(req.header('If-Match'))
  res.status(200).json({ data: await service.patchClass(ctxOf(req), classId, version, req.body) })
})

classesRouter.post('/classes/:id/activate', authenticate, manage, validateBody(reasonBodySchema), async (req, res) => {
  res.status(200).json({ data: await service.setClassActive(ctxOf(req), id(req), true, req.body.reason) })
})

classesRouter.post('/classes/:id/deactivate', authenticate, manage, validateBody(reasonBodySchema), async (req, res) => {
  res.status(200).json({ data: await service.setClassActive(ctxOf(req), id(req), false, req.body.reason) })
})

classesRouter.delete('/classes/:id', authenticate, manage, async (req, res) => {
  await service.deleteClass(ctxOf(req), id(req))
  res.status(204).send()
})

classesRouter.post('/classes/:id/restore', authenticate, manage, async (req, res) => {
  res.status(200).json({ data: await service.restoreClass(ctxOf(req), id(req)) })
})
