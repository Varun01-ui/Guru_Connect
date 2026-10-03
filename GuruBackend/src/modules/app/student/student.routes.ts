import { Router } from 'express'
import type { Request } from 'express'
import { authenticateApp } from '../../../middleware/authenticateApp.js'
import { authenticateRegistration } from '../../../middleware/authenticateRegistration.js'
import { requireStudent } from '../../../middleware/requireRole.js'
import { validateBody } from '../../../middleware/validate.js'
import { registerStudentSchema, verifyParentConsentSchema } from './student.schemas.js'
import * as service from './student.service.js'

export const studentRouter = Router()

export const requestContext = (req: Request) => ({
  ip: req.ip ?? null,
  userAgent: req.header('User-Agent') ?? null,
  installId: req.header('X-Install-Id') ?? null,
  requestId: (req.id as string | undefined) ?? null,
})

// Idempotency-Key is the registration token's jti (M11 section 9): the single-use token already guarantees "once",
// so the header is accepted but not needed to enforce it.
studentRouter.post('/registration/student', authenticateRegistration, validateBody(registerStudentSchema), async (req, res) => {
  res.status(201).json({ data: await service.registerStudent(req.registration!, req.body, requestContext(req)) })
})

studentRouter.post('/student/parent-consent/request', authenticateApp, requireStudent, async (req, res) => {
  res.status(200).json({ data: await service.requestParentConsent(req.student!.id, requestContext(req)) })
})

studentRouter.post('/student/parent-consent/verify', authenticateApp, requireStudent, validateBody(verifyParentConsentSchema), async (req, res) => {
  res.status(200).json({ data: await service.verifyParentConsent(req.student!.id, req.body.code, requestContext(req)) })
})
