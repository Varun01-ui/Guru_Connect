import { Router } from 'express'
import type { Request } from 'express'
import { parseIfMatch } from '../../lib/ifMatch.js'
import { reasonBodySchema } from '../../lib/masters/query.js'
import { ctxOf, idParam, manageGuard } from '../../lib/masters/routes.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createCitySchema, listQuerySchema, patchCitySchema } from './cities.schemas.js'
import type { ListQuery } from './cities.schemas.js'
import * as service from './cities.service.js'

export const citiesRouter = Router()

const READ = 'locations.read'
const MANAGE = 'locations.manage'
const manage = manageGuard(READ, MANAGE, 'cities')
const id = (req: Request) => idParam(req, 'City not found.')

citiesRouter.get('/cities', authenticate, requirePermission(READ), validateQuery(listQuerySchema), async (req, res) => {
  const { data, meta } = await service.listCities(ctxOf(req), req.validatedQuery as ListQuery)
  res.status(200).json(meta ? { data, meta } : { data })
})

citiesRouter.get('/cities/:id', authenticate, requirePermission(READ), async (req, res) => {
  res.status(200).json({ data: await service.getCity(ctxOf(req), id(req), req.query.includeDeleted === 'true') })
})

// FR-9.S3. Needs locations.manage (it is what the "mark as launch city" confirmation shows).
citiesRouter.get('/cities/:id/stats', authenticate, manage, async (req, res) => {
  res.status(200).json({ data: await service.getCityStats(id(req)) })
})

citiesRouter.post('/cities', authenticate, manage, validateBody(createCitySchema), async (req, res) => {
  res.status(201).json({ data: await service.createCity(ctxOf(req), req.body) })
})

citiesRouter.patch('/cities/:id', authenticate, manage, validateBody(patchCitySchema), async (req, res) => {
  const cityId = id(req)
  const version = parseIfMatch(req.header('If-Match'))
  res.status(200).json({ data: await service.patchCity(ctxOf(req), cityId, version, req.body) })
})

citiesRouter.post('/cities/:id/activate', authenticate, manage, validateBody(reasonBodySchema), async (req, res) => {
  res.status(200).json({ data: await service.setCityActive(ctxOf(req), id(req), true, req.body.reason) })
})

citiesRouter.post('/cities/:id/deactivate', authenticate, manage, validateBody(reasonBodySchema), async (req, res) => {
  res.status(200).json({ data: await service.setCityActive(ctxOf(req), id(req), false, req.body.reason) })
})

citiesRouter.delete('/cities/:id', authenticate, manage, async (req, res) => {
  await service.deleteCity(ctxOf(req), id(req))
  res.status(204).send()
})

citiesRouter.post('/cities/:id/restore', authenticate, manage, async (req, res) => {
  res.status(200).json({ data: await service.restoreCity(ctxOf(req), id(req)) })
})
