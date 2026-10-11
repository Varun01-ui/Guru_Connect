import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'
import { ApiError, notFound } from '../../lib/errors.js'
import { getEffectivePermissions } from '../../lib/permissions.js'
import { parseIfMatch } from '../../lib/ifMatch.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createCountrySchema, listQuerySchema, patchCountrySchema, reasonBodySchema } from './countries.schemas.js'
import type { ListQuery } from './countries.schemas.js'
import * as service from './countries.service.js'

export const countriesRouter = Router()

const ctx = (req: Request): service.Ctx => ({
  actor: { id: req.admin!.id, email: req.admin!.email, isSuperAdmin: req.admin!.isSuperAdmin },
  ip: req.ip ?? null,
  userAgent: req.header('User-Agent') ?? null,
  requestId: (req.id as string | undefined) ?? null,
})

// A malformed UUID is "not found", never a 500 (conventions section 8).
function paramId(req: Request): string {
  const parsed = z.string().uuid().safeParse(req.params.id)
  if (!parsed.success) throw notFound('Country not found.')
  return parsed.data
}

const requireManage = requirePermission('locations.manage')

// Section 20: an admin who can read countries is told so, instead of the generic message.
async function manage(req: Request, res: Response, next: NextFunction) {
  try {
    await requireManage(req, res, next)
  } catch (e) {
    if (e instanceof ApiError && e.status === 403 && req.admin && (req.admin.isSuperAdmin || (await getEffectivePermissions(req.admin.id, false)).includes('locations.read'))) {
      throw new ApiError(403, 'FORBIDDEN', 'You can view countries but not change them.', e.details)
    }
    throw e
  }
}

countriesRouter.get('/countries', authenticate, requirePermission('locations.read'), validateQuery(listQuerySchema), async (req, res) => {
  const { data, meta } = await service.listCountries(ctx(req), req.validatedQuery as ListQuery)
  res.status(200).json(meta ? { data, meta } : { data })
})

countriesRouter.get('/countries/:id', authenticate, requirePermission('locations.read'), async (req, res) => {
  res.status(200).json({ data: await service.getCountry(ctx(req), paramId(req), req.query.includeDeleted === 'true') })
})

countriesRouter.post('/countries', authenticate, manage, validateBody(createCountrySchema), async (req, res) => {
  res.status(201).json({ data: await service.createCountry(ctx(req), req.body) })
})

countriesRouter.patch('/countries/:id', authenticate, manage, validateBody(patchCountrySchema), async (req, res) => {
  const id = paramId(req)
  const version = parseIfMatch(req.header('If-Match'))
  res.status(200).json({ data: await service.patchCountry(ctx(req), id, version, req.body) })
})

countriesRouter.post('/countries/:id/activate', authenticate, manage, validateBody(reasonBodySchema), async (req, res) => {
  res.status(200).json({ data: await service.setCountryActive(ctx(req), paramId(req), true, req.body.reason) })
})

countriesRouter.post('/countries/:id/deactivate', authenticate, manage, validateBody(reasonBodySchema), async (req, res) => {
  res.status(200).json({ data: await service.setCountryActive(ctx(req), paramId(req), false, req.body.reason) })
})

countriesRouter.delete('/countries/:id', authenticate, manage, async (req, res) => {
  await service.deleteCountry(ctx(req), paramId(req))
  res.status(204).send()
})

countriesRouter.post('/countries/:id/restore', authenticate, manage, async (req, res) => {
  res.status(200).json({ data: await service.restoreCountry(ctx(req), paramId(req)) })
})
