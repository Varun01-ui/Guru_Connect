import { Router } from 'express'
import type { Request } from 'express'
import { z } from 'zod'
import { notFound } from '../../lib/errors.js'
import { parseIfMatch } from '../../lib/ifMatch.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createBannerSchema, listQuerySchema, patchBannerSchema, previewQuerySchema, reorderSchema } from './banners.schemas.js'
import type { ListQuery, PreviewQuery } from './banners.schemas.js'
import * as service from './banners.service.js'

export const bannersRouter = Router()

const ctx = (req: Request): service.Ctx => ({
  actor: { id: req.admin!.id, email: req.admin!.email, isSuperAdmin: req.admin!.isSuperAdmin },
  ip: req.ip ?? null,
  userAgent: req.header('User-Agent') ?? null,
  requestId: (req.id as string | undefined) ?? null,
})

// A malformed UUID is "not found", never a 500 (conventions section 8).
function paramId(req: Request): string {
  const parsed = z.string().uuid().safeParse(req.params.id)
  if (!parsed.success) throw notFound('Banner not found.')
  return parsed.data
}

const read = requirePermission('banners.read')
const manage = requirePermission('banners.manage')

bannersRouter.get('/banners', authenticate, read, validateQuery(listQuerySchema), async (req, res) => {
  const { data, meta } = await service.listBanners(ctx(req), req.validatedQuery as ListQuery)
  res.status(200).json({ data, meta })
})

// Registered before /banners/:id so "preview" is not read as an id.
bannersRouter.get('/banners/preview', authenticate, read, validateQuery(previewQuerySchema), async (req, res) => {
  res.status(200).json({ data: await service.previewBanners(req.validatedQuery as PreviewQuery) })
})

bannersRouter.get('/banners/:id', authenticate, read, async (req, res) => {
  res.status(200).json({ data: await service.getBanner(ctx(req), paramId(req), req.query.includeDeleted === 'true') })
})

bannersRouter.post('/banners', authenticate, manage, validateBody(createBannerSchema), async (req, res) => {
  res.status(201).json({ data: await service.createBanner(ctx(req), req.body) })
})

bannersRouter.post('/banners/reorder', authenticate, manage, validateBody(reorderSchema), async (req, res) => {
  res.status(200).json({ data: await service.reorderBanners(ctx(req), req.body) })
})

bannersRouter.patch('/banners/:id', authenticate, manage, validateBody(patchBannerSchema), async (req, res) => {
  const id = paramId(req)
  const version = parseIfMatch(req.header('If-Match'))
  res.status(200).json({ data: await service.patchBanner(ctx(req), id, version, req.body) })
})

bannersRouter.post('/banners/:id/publish', authenticate, manage, async (req, res) => {
  res.status(200).json({ data: await service.publishBanner(ctx(req), paramId(req)) })
})

bannersRouter.post('/banners/:id/pause', authenticate, manage, async (req, res) => {
  res.status(200).json({ data: await service.pauseBanner(ctx(req), paramId(req)) })
})

bannersRouter.post('/banners/:id/resume', authenticate, manage, async (req, res) => {
  res.status(200).json({ data: await service.resumeBanner(ctx(req), paramId(req)) })
})

bannersRouter.delete('/banners/:id', authenticate, manage, async (req, res) => {
  await service.deleteBanner(ctx(req), paramId(req))
  res.status(204).send()
})
