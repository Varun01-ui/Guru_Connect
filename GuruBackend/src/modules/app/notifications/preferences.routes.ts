import { Router } from 'express'
import { authenticateApp } from '../../../middleware/authenticateApp.js'
import { validateBody } from '../../../middleware/validate.js'
import { requestContext } from '../student/student.routes.js'
import * as service from './preferences.service.js'

export const notificationPreferencesRouter = Router()

notificationPreferencesRouter.get('/notification-preferences', authenticateApp, async (req, res) => {
  res.status(200).json({ data: await service.getPreferences(req.appAuth!.userId, req.appAuth!.role) })
})

notificationPreferencesRouter.put('/notification-preferences', authenticateApp, validateBody(service.putPreferencesSchema), async (req, res) => {
  const ctx = { ...requestContext(req), userId: req.appAuth!.userId, role: req.appAuth!.role }
  res.status(200).json({ data: await service.putPreferences(ctx, req.body.items) })
})
