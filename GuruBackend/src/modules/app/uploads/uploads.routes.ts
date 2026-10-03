import { Router } from 'express'
import type { Request } from 'express'
import { validationFailed } from '../../../lib/errors.js'
import { authenticateApp } from '../../../middleware/authenticateApp.js'
import { validateBody } from '../../../middleware/validate.js'
import { presignSchema } from './uploads.schemas.js'
import * as service from './uploads.service.js'

export const uploadsRouter = Router()

const context = (req: Request) => ({ userId: req.appAuth!.userId, ip: req.ip ?? null })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function fileId(req: Request, name: string): string {
  const value = req.params[name]
  if (!value || !UUID.test(value)) throw validationFailed([{ path: name, message: 'Invalid file id.' }])
  return value
}

// Any signed-in app user (parent, student, teacher, institute staff) may upload; ownership is enforced per file.
uploadsRouter.post('/uploads/presign', authenticateApp, validateBody(presignSchema), async (req, res) => {
  res.status(201).json({ data: await service.presign(context(req), req.body) })
})

uploadsRouter.post('/uploads/:fileId/confirm', authenticateApp, async (req, res) => {
  res.status(200).json({ data: await service.confirm(context(req), fileId(req, 'fileId')) })
})

uploadsRouter.get('/files/:id/url', authenticateApp, async (req, res) => {
  res.status(200).json({ data: await service.fileUrl(context(req), fileId(req, 'id')) })
})
