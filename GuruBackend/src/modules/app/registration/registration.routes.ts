import { Router } from 'express'
import { authenticateRegistration } from '../../../middleware/authenticateRegistration.js'
import { validateBody } from '../../../middleware/validate.js'
import { validationFailed } from '../../../lib/errors.js'
import { referralValidateSchema, registerParentSchema } from './registration.schemas.js'
import * as service from './registration.service.js'

export const registrationRouter = Router()

registrationRouter.get('/registration/context', authenticateRegistration, async (req, res) => {
  res.status(200).json({ data: await service.getContext(req.registration!) })
})

registrationRouter.post('/registration/referral/validate', authenticateRegistration, validateBody(referralValidateSchema), async (req, res) => {
  res.status(200).json({ data: await service.validateReferral(req.body.code) })
})

registrationRouter.post('/registration/parent', authenticateRegistration, validateBody(registerParentSchema), async (req, res) => {
  const idempotencyKey = req.header('Idempotency-Key')
  if (!idempotencyKey) throw validationFailed(undefined, 'Missing Idempotency-Key header.')

  const result = await service.registerParent(req.registration!, req.body, idempotencyKey, req.ip ?? null, req.header('X-Install-Id') ?? null)
  res.status(201).json({ data: result })
})
