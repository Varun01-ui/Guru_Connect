import { Router } from 'express'
import type { Request } from 'express'
import { validationFailed } from '../../../lib/errors.js'
import { authenticateApp } from '../../../middleware/authenticateApp.js'
import { validateBody, validateQuery } from '../../../middleware/validate.js'
import { requestContext } from '../student/student.routes.js'
import { createOrderSchema, quoteQuerySchema, transactionIdParamSchema, verifyPaymentSchema } from './payments.schemas.js'
import * as service from './payments.service.js'

export const paymentsRouter = Router()

const payer = (req: Request) => ({ userId: req.appAuth!.userId, role: req.appAuth!.role })
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

paymentsRouter.get('/payments/quote', authenticateApp, validateQuery(quoteQuerySchema), async (req, res) => {
  res.status(200).json({ data: await service.getQuote(payer(req), req.validatedQuery as Parameters<typeof service.getQuote>[1]) })
})

paymentsRouter.post('/payments/orders', authenticateApp, validateBody(createOrderSchema), async (req, res) => {
  const key = req.header('Idempotency-Key')
  if (!key || !UUID_V4.test(key)) throw validationFailed([{ path: 'Idempotency-Key', message: 'Something went wrong. Try again.' }], 'Something went wrong. Try again.')
  const ctx = { ...requestContext(req), platform: req.header('X-Platform') ?? null, appVersion: req.header('X-App-Version') ?? null }
  res.status(201).json({ data: await service.createOrder(payer(req), req.body, key, ctx) })
})

paymentsRouter.post('/payments/verify', authenticateApp, validateBody(verifyPaymentSchema), async (req, res) => {
  res.status(200).json({ data: await service.verifyPayment(payer(req), req.body, requestContext(req)) })
})

paymentsRouter.get('/payments/:id/status', authenticateApp, async (req, res) => {
  const parsed = transactionIdParamSchema.safeParse(req.params)
  if (!parsed.success) throw validationFailed([{ path: 'id', message: 'Payment not found.' }], 'Payment not found.')
  res.status(200).json({ data: await service.getStatus(payer(req), parsed.data.id) })
})
