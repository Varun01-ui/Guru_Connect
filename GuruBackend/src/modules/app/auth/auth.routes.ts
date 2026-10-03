import { Router } from 'express'
import { authenticateApp } from '../../../middleware/authenticateApp.js'
import { validateBody } from '../../../middleware/validate.js'
import {
  emailLoginSchema,
  emailOtpRequestSchema,
  googleSignInSchema,
  otpRequestSchema,
  otpVerifySchema,
  passwordForgotSchema,
  passwordResetSchema,
  refreshSchema,
} from './auth.schemas.js'
import * as service from './auth.service.js'

export const appAuthRouter = Router()

function requestContext(req: import('express').Request) {
  return { ip: req.ip ?? null, userAgent: req.header('User-Agent') ?? null }
}

appAuthRouter.post('/auth/otp/request', validateBody(otpRequestSchema), async (req, res) => {
  const data = await service.requestPhoneOtp(req.body.phone, req.ip ?? null, req.header('X-Install-Id') ?? null)
  res.status(200).json({ data })
})

appAuthRouter.post('/auth/otp/verify', validateBody(otpVerifySchema), async (req, res) => {
  const ctx = requestContext(req)
  const result = await service.verifyOtp(req.body.challengeId, req.body.code, req.body.intendedRole, ctx.ip, ctx.userAgent)
  res.status(200).json({ data: result })
})

appAuthRouter.post('/auth/email/login', validateBody(emailLoginSchema), async (req, res) => {
  const ctx = requestContext(req)
  const result = await service.emailPasswordLogin(req.body.email, req.body.password, ctx.ip, ctx.userAgent)
  res.status(200).json({ data: result })
})

appAuthRouter.post('/auth/email/otp/request', validateBody(emailOtpRequestSchema), async (req, res) => {
  const data = await service.requestEmailOtp(req.body.email, req.ip ?? null)
  res.status(200).json({ data })
})

appAuthRouter.post('/auth/password/forgot', validateBody(passwordForgotSchema), async (req, res) => {
  const data = await service.forgotPassword(req.body.email)
  res.status(200).json({ data })
})

appAuthRouter.post('/auth/password/reset', validateBody(passwordResetSchema), async (req, res) => {
  await service.resetPassword(req.body.challengeId, req.body.code, req.body.newPassword)
  res.status(200).json({ data: { ok: true } })
})

appAuthRouter.post('/auth/google', validateBody(googleSignInSchema), async (req, res) => {
  const ctx = requestContext(req)
  const result = await service.googleSignIn(req.body.idToken, req.body.intendedRole, ctx.ip, ctx.userAgent)
  res.status(200).json({ data: result })
})

appAuthRouter.post('/auth/refresh', validateBody(refreshSchema), async (req, res) => {
  const data = await service.refreshSession(req.body.refreshToken)
  res.status(200).json({ data })
})

appAuthRouter.post('/auth/logout', authenticateApp, async (req, res) => {
  await service.logout(req.appAuth!.sessionId)
  res.status(200).json({ data: { ok: true } })
})

appAuthRouter.post('/auth/logout-all', authenticateApp, async (req, res) => {
  await service.logoutAll(req.appAuth!.userId)
  res.status(200).json({ data: { ok: true } })
})

appAuthRouter.get('/auth/sessions', authenticateApp, async (req, res) => {
  const data = await service.listSessions(req.appAuth!.userId, req.appAuth!.sessionId)
  res.status(200).json({ data })
})

appAuthRouter.delete('/auth/sessions/:id', authenticateApp, async (req, res) => {
  await service.revokeOneSession(req.appAuth!.userId, req.params.id!)
  res.status(200).json({ data: { ok: true } })
})
