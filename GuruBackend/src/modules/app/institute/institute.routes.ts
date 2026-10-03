import { Router } from 'express'
import type { Request } from 'express'
import { parseIfMatch } from '../../../lib/ifMatch.js'
import { validationFailed } from '../../../lib/errors.js'
import { authenticateApp } from '../../../middleware/authenticateApp.js'
import { authenticateRegistration } from '../../../middleware/authenticateRegistration.js'
import { requireInstituteManager } from '../../../middleware/requireRole.js'
import { validateBody } from '../../../middleware/validate.js'
import { requestContext } from '../student/student.routes.js'
import { basicsPatchSchema, registerInstituteSchema } from './institute.schemas.js'
import * as service from './institute.service.js'

export const instituteRouter = Router()

instituteRouter.post('/registration/institute', authenticateRegistration, validateBody(registerInstituteSchema), async (req, res) => {
  const idempotencyKey = req.header('Idempotency-Key')
  if (!idempotencyKey) throw validationFailed(undefined, 'Missing Idempotency-Key header.')
  const ctx = { ...requestContext(req), acceptLanguage: req.header('Accept-Language') ?? null }
  res.status(201).json({ data: await service.registerInstitute(req.registration!, req.body, idempotencyKey, ctx) })
})

const ctx = (req: Request) => ({ ...requestContext(req), userId: req.instituteManager!.userId, instituteId: req.instituteManager!.instituteId, managerId: req.instituteManager!.id })

instituteRouter.patch('/institute/registration/basics', authenticateApp, requireInstituteManager, validateBody(basicsPatchSchema), async (req, res) => {
  const version = parseIfMatch(req.header('If-Match'))
  res.status(200).json({ data: await service.updateBasics(ctx(req), version, req.body) })
})
