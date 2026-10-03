import { Router } from 'express'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import * as service from './auth.service.js'
import {
  forgotPasswordSchema,
  loginSchema,
  otpLogsQuerySchema,
  otpRequestSchema,
  otpVerifySchema,
  resetPasswordSchema,
  validateResetTokenQuerySchema,
} from './auth.schemas.js'
import type { LoginResult } from './auth.service.js'

export const authRouter = Router()

function requestContext(req: Request) {
  return { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null, origin: req.headers.origin ?? null }
}

function setAuthCookies(res: Response, session: LoginResult) {
  if (!session.refreshToken || !session.csrfToken) return // parallel-refresh grace: cookies were already rotated
  const maxAge = session.sessionExpiresAt.getTime() - Date.now()
  res.cookie(env.REFRESH_COOKIE_NAME, session.refreshToken, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/admin/auth',
    maxAge,
  })
  res.cookie(env.CSRF_COOKIE_NAME, session.csrfToken, {
    httpOnly: false,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge,
  })
}

function clearAuthCookies(res: Response) {
  res.clearCookie(env.REFRESH_COOKIE_NAME, { path: '/api/v1/admin/auth' })
  res.clearCookie(env.CSRF_COOKIE_NAME, { path: '/' })
}

authRouter.post('/auth/login', validateBody(loginSchema), async (req, res) => {
  const { email, password, rememberMe } = req.body
  const session = await service.login(email, password, rememberMe, requestContext(req))
  setAuthCookies(res, session)
  res.status(200).json({ data: { accessToken: session.accessToken, expiresIn: session.expiresIn, admin: session.admin } })
})

authRouter.post('/auth/refresh', async (req, res) => {
  const refreshToken = req.cookies?.[env.REFRESH_COOKIE_NAME]
  const csrfCookie = req.cookies?.[env.CSRF_COOKIE_NAME]
  const csrfHeader = req.headers['x-csrf-token']
  const session = await service.refresh(refreshToken, Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader, csrfCookie, requestContext(req))
  setAuthCookies(res, session)
  res.status(200).json({ data: { accessToken: session.accessToken, expiresIn: session.expiresIn, admin: session.admin } })
})

authRouter.post('/auth/logout', authenticate, async (req, res) => {
  await service.logout(req.admin!, req.admin!.sessionId)
  clearAuthCookies(res)
  res.status(200).json({ data: { success: true } })
})

authRouter.post('/auth/logout-all', authenticate, async (req, res) => {
  await service.logoutAll(req.admin!)
  clearAuthCookies(res)
  res.status(200).json({ data: { success: true } })
})

authRouter.post('/auth/forgot-password', validateBody(forgotPasswordSchema), async (req, res) => {
  await service.forgotPassword(req.body.email, req.ip ?? null)
  res.status(202).json({ data: { message: "If an account exists, we've emailed a link." } })
})

authRouter.get('/auth/reset-password/validate', validateQuery(validateResetTokenQuerySchema), async (req, res) => {
  const { token } = req.validatedQuery as z.infer<typeof validateResetTokenQuerySchema>
  const result = await service.validateResetToken(token)
  res.status(200).json({ data: result })
})

authRouter.post('/auth/reset-password', validateBody(resetPasswordSchema), async (req, res) => {
  await service.resetPassword(req.body.token, req.body.newPassword)
  res.status(200).json({ data: { success: true } })
})

authRouter.get('/auth/me', authenticate, async (req, res) => {
  const result = await service.me(req.admin!.id)
  // Open tabs poll with ?etag=<last etag>; 304 means roles and permissions have not changed (M02 FR-2.4).
  if (typeof req.query.etag === 'string' && req.query.etag === result.etag) return void res.status(304).send()
  res.status(200).json({ data: result })
})

authRouter.get('/auth/sessions', authenticate, async (req, res) => {
  const rows = await service.sessions(req.admin!.id)
  res.status(200).json({ data: rows.map((s) => ({ ...s, isCurrent: s.id === req.admin!.sessionId })) })
})

authRouter.delete('/auth/sessions/:id', authenticate, async (req, res) => {
  await service.revokeOwnSession(req.admin!, req.params.id!)
  if (req.params.id === req.admin!.sessionId) clearAuthCookies(res)
  res.status(204).send()
})

authRouter.post('/auth/otp/request', validateBody(otpRequestSchema), async (req, res) => {
  const result = await service.requestOtp(req.body.phone, req.ip ?? null)
  res.status(200).json({ data: result })
})

authRouter.post('/auth/otp/verify', validateBody(otpVerifySchema), async (req, res) => {
  const { phone, code, rememberMe } = req.body
  const session = await service.verifyOtp(phone, code, rememberMe, requestContext(req))
  setAuthCookies(res, session)
  res.status(200).json({ data: { accessToken: session.accessToken, expiresIn: session.expiresIn, admin: session.admin } })
})

authRouter.get('/auth/otp/logs', validateQuery(otpLogsQuerySchema), async (req, res) => {
  const { phone } = req.validatedQuery as z.infer<typeof otpLogsQuerySchema>
  const rows = await service.otpLogs(phone)
  res.status(200).json({ data: rows })
})

authRouter.delete('/admins/:adminId/sessions', authenticate, requirePermission('sessions.revoke_any'), async (req, res) => {
  await service.revokeAllSessionsOfAdmin(req.admin!, req.params.adminId!)
  res.status(204).send()
})
