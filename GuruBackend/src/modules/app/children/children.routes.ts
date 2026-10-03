import { Router } from 'express'
import type { Request } from 'express'
import { validationFailed } from '../../../lib/errors.js'
import { parseIfMatch } from '../../../lib/ifMatch.js'
import { authenticateApp } from '../../../middleware/authenticateApp.js'
import { requireParent } from '../../../middleware/requireParent.js'
import { validateBody } from '../../../middleware/validate.js'
import { childIdParamSchema, createChildSchema, reorderChildrenSchema, updateChildSchema } from './children.schemas.js'
import * as service from './children.service.js'

export const childrenRouter = Router()

const context = (req: Request) => ({ parentId: req.parent!.id, userId: req.parent!.userId, ip: req.ip ?? null })

function childId(req: Request): string {
  const parsed = childIdParamSchema.safeParse(req.params)
  if (!parsed.success) throw validationFailed([{ path: 'id', message: 'Invalid child id.' }])
  return parsed.data.id
}

childrenRouter.get('/parent/children', authenticateApp, requireParent, async (req, res) => {
  res.status(200).json({ data: await service.listChildren(context(req)) })
})

childrenRouter.post('/parent/children', authenticateApp, requireParent, validateBody(createChildSchema), async (req, res) => {
  const idempotencyKey = req.header('Idempotency-Key')
  if (!idempotencyKey) throw validationFailed(undefined, 'Missing Idempotency-Key header.')
  res.status(201).json(await service.createChild(context(req), req.body, idempotencyKey))
})

// Registered before /:id so "order" is never read as a child id.
childrenRouter.put('/parent/children/order', authenticateApp, requireParent, validateBody(reorderChildrenSchema), async (req, res) => {
  await service.reorderChildren(context(req), req.body.orderedIds)
  res.status(200).json({ data: { ok: true } })
})

childrenRouter.patch('/parent/children/:id', authenticateApp, requireParent, validateBody(updateChildSchema), async (req, res) => {
  const version = parseIfMatch(req.header('If-Match'))
  res.status(200).json(await service.updateChild(context(req), childId(req), version, req.body))
})

childrenRouter.delete('/parent/children/:id', authenticateApp, requireParent, async (req, res) => {
  await service.deleteChild(context(req), childId(req))
  res.status(200).json({ data: { ok: true } })
})
