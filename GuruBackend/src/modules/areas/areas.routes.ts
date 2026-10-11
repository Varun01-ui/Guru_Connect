import express, { Router } from 'express'
import type { Request } from 'express'
import { fileTypeNotAllowed, validationFailed } from '../../lib/errors.js'
import { parseIfMatch } from '../../lib/ifMatch.js'
import { reasonBodySchema } from '../../lib/masters/query.js'
import { ctxOf, idParam, manageGuard } from '../../lib/masters/routes.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { importAreas } from './areas.import.js'
import { createAreaSchema, importQuerySchema, listQuerySchema, mergeAreaSchema, patchAreaSchema, pincodeParamSchema } from './areas.schemas.js'
import type { ListQuery } from './areas.schemas.js'
import * as service from './areas.service.js'

export const areasRouter = Router()

const READ = 'locations.read'
const MANAGE = 'locations.manage'
const manage = manageGuard(READ, MANAGE, 'areas')
const id = (req: Request) => idParam(req, 'Area not found.')

areasRouter.get('/areas', authenticate, requirePermission(READ), validateQuery(listQuerySchema), async (req, res) => {
  const { data, meta } = await service.listAreas(ctxOf(req), req.validatedQuery as ListQuery)
  res.status(200).json(meta ? { data, meta } : { data })
})

// FR-10.S3. Registered before /areas/:id so "by-pincode" is never read as an id.
areasRouter.get('/areas/by-pincode/:pin', authenticate, manage, async (req, res) => {
  const parsed = pincodeParamSchema.safeParse(req.params)
  if (!parsed.success) throw validationFailed([{ path: 'pin', message: parsed.error.issues[0]!.message }], parsed.error.issues[0]!.message)
  res.status(200).json({ data: await service.areasByPincode(parsed.data.pin) })
})

areasRouter.get('/areas/:id', authenticate, requirePermission(READ), async (req, res) => {
  res.status(200).json({ data: await service.getArea(ctxOf(req), id(req), req.query.includeDeleted === 'true') })
})

areasRouter.post('/areas', authenticate, manage, validateBody(createAreaSchema), async (req, res) => {
  res.status(201).json({ data: await service.createArea(ctxOf(req), req.body) })
})

// FR-10.S1: the body is the CSV itself (Content-Type: text/csv), up to 2,000 rows. ?dryRun=true checks without saving;
// ?skipInvalid=true applies the good rows and reports the bad ones instead of rejecting the file.
areasRouter.post('/areas/import', authenticate, manage, express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }), validateQuery(importQuerySchema), async (req, res) => {
  if (typeof req.body !== 'string') throw fileTypeNotAllowed('Send the file as text/csv.')
  const { dryRun, skipInvalid } = req.validatedQuery as { dryRun?: boolean; skipInvalid?: boolean }
  res.status(200).json({ data: await importAreas(ctxOf(req), req.body, dryRun === true, skipInvalid === true) })
})

areasRouter.patch('/areas/:id', authenticate, manage, validateBody(patchAreaSchema), async (req, res) => {
  const areaId = id(req)
  const version = parseIfMatch(req.header('If-Match'))
  res.status(200).json({ data: await service.patchArea(ctxOf(req), areaId, version, req.body) })
})

areasRouter.post('/areas/:id/activate', authenticate, manage, validateBody(reasonBodySchema), async (req, res) => {
  res.status(200).json({ data: await service.setAreaActive(ctxOf(req), id(req), true, req.body.reason) })
})

areasRouter.post('/areas/:id/deactivate', authenticate, manage, validateBody(reasonBodySchema), async (req, res) => {
  res.status(200).json({ data: await service.setAreaActive(ctxOf(req), id(req), false, req.body.reason) })
})

areasRouter.post('/areas/:id/merge', authenticate, manage, validateBody(mergeAreaSchema), async (req, res) => {
  res.status(200).json({ data: await service.mergeAreas(ctxOf(req), id(req), req.body) })
})

areasRouter.delete('/areas/:id', authenticate, manage, async (req, res) => {
  await service.deleteArea(ctxOf(req), id(req))
  res.status(204).send()
})

areasRouter.post('/areas/:id/restore', authenticate, manage, async (req, res) => {
  res.status(200).json({ data: await service.restoreArea(ctxOf(req), id(req)) })
})
