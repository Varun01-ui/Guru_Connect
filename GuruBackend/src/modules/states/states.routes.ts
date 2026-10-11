import express, { Router } from 'express'
import type { Request } from 'express'
import { fileTypeNotAllowed } from '../../lib/errors.js'
import { parseIfMatch } from '../../lib/ifMatch.js'
import { reasonBodySchema } from '../../lib/masters/query.js'
import { ctxOf, idParam, manageGuard } from '../../lib/masters/routes.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { importStates } from './states.import.js'
import { createStateSchema, importQuerySchema, listQuerySchema, patchStateSchema } from './states.schemas.js'
import type { ListQuery } from './states.schemas.js'
import * as service from './states.service.js'

export const statesRouter = Router()

const READ = 'locations.read'
const MANAGE = 'locations.manage'
const manage = manageGuard(READ, MANAGE, 'states')
const id = (req: Request) => idParam(req, 'State not found.')

statesRouter.get('/states', authenticate, requirePermission(READ), validateQuery(listQuerySchema), async (req, res) => {
  const { data, meta } = await service.listStates(ctxOf(req), req.validatedQuery as ListQuery)
  res.status(200).json(meta ? { data, meta } : { data })
})

statesRouter.get('/states/:id', authenticate, requirePermission(READ), async (req, res) => {
  res.status(200).json({ data: await service.getState(ctxOf(req), id(req), req.query.includeDeleted === 'true') })
})

statesRouter.post('/states', authenticate, manage, validateBody(createStateSchema), async (req, res) => {
  res.status(201).json({ data: await service.createState(ctxOf(req), req.body) })
})

// FR-8.S2: the body is the CSV itself (Content-Type: text/csv), up to 500 rows. ?dryRun=true checks without saving.
statesRouter.post('/states/import', authenticate, manage, express.text({ type: ['text/csv', 'text/plain'], limit: '512kb' }), validateQuery(importQuerySchema), async (req, res) => {
  if (typeof req.body !== 'string') throw fileTypeNotAllowed('Send the file as text/csv.')
  const { dryRun } = req.validatedQuery as { dryRun?: boolean }
  res.status(200).json({ data: await importStates(ctxOf(req), req.body, dryRun === true) })
})

statesRouter.patch('/states/:id', authenticate, manage, validateBody(patchStateSchema), async (req, res) => {
  const stateId = id(req)
  const version = parseIfMatch(req.header('If-Match'))
  res.status(200).json({ data: await service.patchState(ctxOf(req), stateId, version, req.body) })
})

statesRouter.post('/states/:id/activate', authenticate, manage, validateBody(reasonBodySchema), async (req, res) => {
  res.status(200).json({ data: await service.setStateActive(ctxOf(req), id(req), true, req.body.reason) })
})

statesRouter.post('/states/:id/deactivate', authenticate, manage, validateBody(reasonBodySchema), async (req, res) => {
  res.status(200).json({ data: await service.setStateActive(ctxOf(req), id(req), false, req.body.reason) })
})

statesRouter.delete('/states/:id', authenticate, manage, async (req, res) => {
  await service.deleteState(ctxOf(req), id(req))
  res.status(204).send()
})

statesRouter.post('/states/:id/restore', authenticate, manage, async (req, res) => {
  res.status(200).json({ data: await service.restoreState(ctxOf(req), id(req)) })
})
