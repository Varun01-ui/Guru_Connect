import { Router } from 'express'
import type { Request } from 'express'
import { z } from 'zod'
import { notFound } from '../../lib/errors.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import * as actions from './pc.actions.js'
import * as queries from './pc.queries.js'
import { cancelSchema, draftSchema, historyQuerySchema, publishSchema, restoreSchema, toggleSchema, versionsQuerySchema } from './pc.schemas.js'
import type { HistoryQuery, VersionsQuery } from './pc.schemas.js'

export const paymentConfigRouter = Router()

const ctx = (req: Request): actions.Ctx => ({
  actor: { id: req.admin!.id, email: req.admin!.email, isSuperAdmin: req.admin!.isSuperAdmin },
  ip: req.ip ?? null,
  userAgent: req.header('User-Agent') ?? null,
  requestId: (req.id as string | undefined) ?? null,
})

const feeCode = (req: Request) => queries.assertFeeCode(String(req.params.feeCode))
const versionId = (req: Request) => {
  const parsed = z.string().uuid().safeParse(req.params.id)
  if (!parsed.success) throw notFound('Version not found.')
  return parsed.data
}

const read = requirePermission('payment_config.read')
const edit = requirePermission('payment_config.edit')
const publish = requirePermission('payment_config.publish')

paymentConfigRouter.get('/payment-configs', authenticate, read, async (_req, res) => {
  res.status(200).json({ data: await queries.listFees() })
})

// Fixed paths first, so "history" and "versions" are never read as a fee code.
paymentConfigRouter.get('/payment-configs/history', authenticate, read, validateQuery(historyQuerySchema), async (req, res) => {
  const { data, meta } = await queries.listHistory(req.validatedQuery as HistoryQuery)
  res.status(200).json({ data, meta })
})

paymentConfigRouter.post('/payment-configs/versions/:id/cancel', authenticate, publish, validateBody(cancelSchema), async (req, res) => {
  res.status(200).json({ data: await actions.cancelScheduled(ctx(req), versionId(req), req.body.reason) })
})

paymentConfigRouter.post('/payment-configs/versions/:id/restore', authenticate, publish, validateBody(restoreSchema), async (req, res) => {
  res.status(200).json({ data: await actions.restoreVersion(ctx(req), versionId(req), req.body) })
})

paymentConfigRouter.get('/payment-configs/:feeCode', authenticate, read, validateQuery(versionsQuerySchema), async (req, res) => {
  const { data, meta } = await queries.getFee(String(req.params.feeCode), req.validatedQuery as VersionsQuery)
  res.status(200).json({ data, meta })
})

paymentConfigRouter.put('/payment-configs/:feeCode/draft', authenticate, edit, validateBody(draftSchema), async (req, res) => {
  const code = feeCode(req)
  res.status(200).json({ data: await actions.saveDraft(ctx(req), code, req.body, req.header('If-Match')) })
})

paymentConfigRouter.delete('/payment-configs/:feeCode/draft', authenticate, edit, async (req, res) => {
  await actions.discardDraft(ctx(req), feeCode(req))
  res.status(204).send()
})

paymentConfigRouter.get('/payment-configs/:feeCode/draft/preview', authenticate, read, async (req, res) => {
  res.status(200).json({ data: await queries.previewDraft(String(req.params.feeCode)) })
})

paymentConfigRouter.post('/payment-configs/:feeCode/draft/publish', authenticate, publish, validateBody(publishSchema), async (req, res) => {
  const code = feeCode(req)
  res.status(200).json({ data: await actions.publishDraft(ctx(req), code, req.body) })
})

paymentConfigRouter.post('/payment-configs/:feeCode/toggle', authenticate, publish, validateBody(toggleSchema), async (req, res) => {
  const code = feeCode(req)
  res.status(200).json({ data: await actions.toggleFee(ctx(req), code, req.body) })
})
