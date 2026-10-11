import { Router } from 'express'
import type { Request } from 'express'
import { parseIfMatch } from '../../lib/ifMatch.js'
import { reasonBodySchema } from '../../lib/masters/query.js'
import { ctxOf, idParam, manageGuard } from '../../lib/masters/routes.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createTeachingModeSchema, listQuerySchema, patchTeachingModeSchema } from './teachingModes.schemas.js'
import type { ListQuery } from './teachingModes.schemas.js'
import * as service from './teachingModes.service.js'

export const teachingModesRouter = Router()

const READ = 'education_masters.read'
const MANAGE = 'education_masters.manage'
const manage = manageGuard(READ, MANAGE, 'teaching modes')
const id = (req: Request) => idParam(req, 'Teaching mode not found.')

teachingModesRouter.get('/teaching-modes', authenticate, requirePermission(READ), validateQuery(listQuerySchema), async (req, res) => {
  const { data, meta } = await service.listTeachingModes(ctxOf(req), req.validatedQuery as ListQuery)
  res.status(200).json(meta ? { data, meta } : { data })
})

teachingModesRouter.get('/teaching-modes/:id', authenticate, requirePermission(READ), async (req, res) => {
  res.status(200).json({ data: await service.getTeachingMode(ctxOf(req), id(req), req.query.includeDeleted === 'true') })
})

teachingModesRouter.post('/teaching-modes', authenticate, manage, validateBody(createTeachingModeSchema), async (req, res) => {
  res.status(201).json({ data: await service.createTeachingMode(ctxOf(req), req.body) })
})

teachingModesRouter.patch('/teaching-modes/:id', authenticate, manage, validateBody(patchTeachingModeSchema), async (req, res) => {
  const modeId = id(req)
  const version = parseIfMatch(req.header('If-Match'))
  res.status(200).json({ data: await service.patchTeachingMode(ctxOf(req), modeId, version, req.body) })
})

teachingModesRouter.post('/teaching-modes/:id/activate', authenticate, manage, validateBody(reasonBodySchema), async (req, res) => {
  res.status(200).json({ data: await service.setTeachingModeActive(ctxOf(req), id(req), true, req.body.reason) })
})

teachingModesRouter.post('/teaching-modes/:id/deactivate', authenticate, manage, validateBody(reasonBodySchema), async (req, res) => {
  res.status(200).json({ data: await service.setTeachingModeActive(ctxOf(req), id(req), false, req.body.reason) })
})

teachingModesRouter.delete('/teaching-modes/:id', authenticate, manage, async (req, res) => {
  await service.deleteTeachingMode(ctxOf(req), id(req))
  res.status(204).send()
})

teachingModesRouter.post('/teaching-modes/:id/restore', authenticate, manage, async (req, res) => {
  res.status(200).json({ data: await service.restoreTeachingMode(ctxOf(req), id(req)) })
})
