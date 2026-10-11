import { Router } from 'express'
import type { Request } from 'express'
import { z } from 'zod'
import { forbidden, notFound } from '../../lib/errors.js'
import { getEffectivePermissions } from '../../lib/permissions.js'
import { authenticate } from '../../middleware/authenticate.js'
import { validateBody } from '../../middleware/validate.js'
import { ADMIN_UPLOAD_PURPOSE_NAMES } from '../app/uploads/uploads.config.js'
import * as service from '../app/uploads/uploads.service.js'

// M00 BR-0.8 for admins: presign, upload straight to storage, confirm. Same checks as the mobile flow (type, size,
// magic bytes); files are owned by the admin who presigned them. Used by the avatar (M03) and banner (M44) screens.
export const adminUploadsRouter = Router()

const presignSchema = z.object({
  purpose: z.enum(ADMIN_UPLOAD_PURPOSE_NAMES),
  mimeType: z.string().trim().toLowerCase().min(1).max(100),
  sizeBytes: z.number().int().min(1, 'The file is empty.').max(Number.MAX_SAFE_INTEGER),
  fileName: z
    .string()
    .transform((v) => v.replace(/[\\/\u0000-\u001f]/g, '_').trim())
    .pipe(z.string().min(1).max(255)),
})

// A purpose that belongs to one screen needs that screen's permission; the avatar is for every signed-in admin.
const PURPOSE_PERMISSION: Record<string, string | undefined> = { banner_image: 'banners.manage' }

const context = (req: Request) => ({ userId: req.admin!.id, ip: req.ip ?? null, ownerType: 'admin' as const, actorEmail: req.admin!.email })

adminUploadsRouter.post('/uploads/presign', authenticate, validateBody(presignSchema), async (req, res) => {
  const needed = PURPOSE_PERMISSION[req.body.purpose as string]
  if (needed && !req.admin!.isSuperAdmin && !(await getEffectivePermissions(req.admin!.id, false)).includes(needed)) {
    throw forbidden("You don't have permission to do that.")
  }
  res.status(201).json({ data: await service.presign(context(req), req.body) })
})

adminUploadsRouter.post('/uploads/:fileId/confirm', authenticate, async (req, res) => {
  const fileId = z.string().uuid().safeParse(req.params.fileId)
  if (!fileId.success) throw notFound('File not found.')
  res.status(200).json({ data: await service.confirm(context(req), fileId.data) })
})
