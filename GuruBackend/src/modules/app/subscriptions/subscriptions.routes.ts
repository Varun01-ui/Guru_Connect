import { Router } from 'express'
import type { Request } from 'express'
import { z } from 'zod'
import { validationFailed } from '../../../lib/errors.js'
import { authenticateApp } from '../../../middleware/authenticateApp.js'
import { validateBody, validateQuery } from '../../../middleware/validate.js'
import { requestContext } from '../student/student.routes.js'
import * as service from './subscriptions.service.js'

export const subscriptionsRouter = Router()

const roleQuery = z.object({ role: z.enum(['parent', 'student']).optional() })
const autoRenewBody = z.object({ enabled: z.literal(false, { errorMap: () => ({ message: 'Auto-renew can only be turned off here.' }) }) })
const cancelBody = z.object({
  mode: z.enum(['at_period_end', 'immediately']),
  reason: z.string().trim().max(300).nullish(),
})
const idParam = z.object({ id: z.string().uuid() })

const role = (req: Request, queryRole?: string) => service.resolveRole(req.appAuth!.role, queryRole)
const ctx = (req: Request): service.SubContext => ({ ...requestContext(req), userId: req.appAuth!.userId, role: role(req) })
function paramId(req: Request): string {
  const parsed = idParam.safeParse(req.params)
  if (!parsed.success) throw validationFailed([{ path: 'id', message: 'Invalid id.' }])
  return parsed.data.id
}

subscriptionsRouter.get('/plans', authenticateApp, validateQuery(roleQuery), async (req, res) => {
  const r = role(req, (req.validatedQuery as { role?: string }).role)
  res.status(200).json({ data: await service.listPlans(req.appAuth!.userId, r) })
})

subscriptionsRouter.get('/subscriptions/current', authenticateApp, validateQuery(roleQuery), async (req, res) => {
  const r = role(req, (req.validatedQuery as { role?: string }).role)
  res.status(200).json({ data: await service.getCurrent(req.appAuth!.userId, r) })
})

subscriptionsRouter.post('/subscriptions/:id/auto-renew', authenticateApp, validateBody(autoRenewBody), async (req, res) => {
  res.status(200).json({ data: await service.disableAutoRenew(ctx(req), paramId(req)) })
})

subscriptionsRouter.post('/subscriptions/:id/cancel', authenticateApp, validateBody(cancelBody), async (req, res) => {
  res.status(200).json({ data: await service.cancelSubscription(ctx(req), paramId(req), req.body) })
})
