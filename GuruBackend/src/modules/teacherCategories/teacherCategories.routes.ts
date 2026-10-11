import { Router } from 'express'
import type { Request } from 'express'
import { parseIfMatch } from '../../lib/ifMatch.js'
import { orderBodySchema, reasonBodySchema } from '../../lib/masters/query.js'
import { ctxOf, idParam, manageGuard } from '../../lib/masters/routes.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createTeacherCategorySchema, listQuerySchema, patchTeacherCategorySchema } from './teacherCategories.schemas.js'
import type { ListQuery } from './teacherCategories.schemas.js'
import * as service from './teacherCategories.service.js'

export const teacherCategoriesRouter = Router()

const READ = 'education_masters.read'
const MANAGE = 'education_masters.manage'
const manage = manageGuard(READ, MANAGE, 'teacher categories')
const id = (req: Request) => idParam(req, 'Teacher category not found.')

teacherCategoriesRouter.get('/teacher-categories', authenticate, requirePermission(READ), validateQuery(listQuerySchema), async (req, res) => {
  const { data, meta } = await service.listTeacherCategories(ctxOf(req), req.validatedQuery as ListQuery)
  res.status(200).json(meta ? { data, meta } : { data })
})

teacherCategoriesRouter.get('/teacher-categories/:id', authenticate, requirePermission(READ), async (req, res) => {
  res.status(200).json({ data: await service.getTeacherCategory(ctxOf(req), id(req), req.query.includeDeleted === 'true') })
})

teacherCategoriesRouter.post('/teacher-categories', authenticate, manage, validateBody(createTeacherCategorySchema), async (req, res) => {
  res.status(201).json({ data: await service.createTeacherCategory(ctxOf(req), req.body) })
})

teacherCategoriesRouter.put('/teacher-categories/order', authenticate, manage, validateBody(orderBodySchema), async (req, res) => {
  await service.reorderTeacherCategories(ctxOf(req), req.body.ids)
  res.status(200).json({ data: { ok: true } })
})

teacherCategoriesRouter.patch('/teacher-categories/:id', authenticate, manage, validateBody(patchTeacherCategorySchema), async (req, res) => {
  const categoryId = id(req)
  const version = parseIfMatch(req.header('If-Match'))
  res.status(200).json({ data: await service.patchTeacherCategory(ctxOf(req), categoryId, version, req.body) })
})

teacherCategoriesRouter.post('/teacher-categories/:id/activate', authenticate, manage, validateBody(reasonBodySchema), async (req, res) => {
  res.status(200).json({ data: await service.setTeacherCategoryActive(ctxOf(req), id(req), true, req.body.reason) })
})

teacherCategoriesRouter.post('/teacher-categories/:id/deactivate', authenticate, manage, validateBody(reasonBodySchema), async (req, res) => {
  res.status(200).json({ data: await service.setTeacherCategoryActive(ctxOf(req), id(req), false, req.body.reason) })
})

teacherCategoriesRouter.delete('/teacher-categories/:id', authenticate, manage, async (req, res) => {
  await service.deleteTeacherCategory(ctxOf(req), id(req))
  res.status(204).send()
})

teacherCategoriesRouter.post('/teacher-categories/:id/restore', authenticate, manage, async (req, res) => {
  res.status(200).json({ data: await service.restoreTeacherCategory(ctxOf(req), id(req)) })
})
