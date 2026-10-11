import { Router } from 'express'
import type { Request } from 'express'
import { parseIfMatch } from '../../lib/ifMatch.js'
import { reasonBodySchema } from '../../lib/masters/query.js'
import { ctxOf, idParam, manageGuard } from '../../lib/masters/routes.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { createBoardSchema, listQuerySchema, patchBoardSchema } from './boards.schemas.js'
import type { ListQuery } from './boards.schemas.js'
import * as service from './boards.service.js'

export const boardsRouter = Router()

const READ = 'education_masters.read'
const MANAGE = 'education_masters.manage'
const manage = manageGuard(READ, MANAGE, 'boards')
const id = (req: Request) => idParam(req, 'Board not found.')

boardsRouter.get('/boards', authenticate, requirePermission(READ), validateQuery(listQuerySchema), async (req, res) => {
  const { data, meta } = await service.listBoards(ctxOf(req), req.validatedQuery as ListQuery)
  res.status(200).json(meta ? { data, meta } : { data })
})

boardsRouter.get('/boards/:id', authenticate, requirePermission(READ), async (req, res) => {
  res.status(200).json({ data: await service.getBoard(ctxOf(req), id(req), req.query.includeDeleted === 'true') })
})

boardsRouter.post('/boards', authenticate, manage, validateBody(createBoardSchema), async (req, res) => {
  res.status(201).json({ data: await service.createBoard(ctxOf(req), req.body) })
})

boardsRouter.patch('/boards/:id', authenticate, manage, validateBody(patchBoardSchema), async (req, res) => {
  const boardId = id(req)
  const version = parseIfMatch(req.header('If-Match'))
  res.status(200).json({ data: await service.patchBoard(ctxOf(req), boardId, version, req.body) })
})

boardsRouter.post('/boards/:id/activate', authenticate, manage, validateBody(reasonBodySchema), async (req, res) => {
  res.status(200).json({ data: await service.setBoardActive(ctxOf(req), id(req), true, req.body.reason) })
})

boardsRouter.post('/boards/:id/deactivate', authenticate, manage, validateBody(reasonBodySchema), async (req, res) => {
  res.status(200).json({ data: await service.setBoardActive(ctxOf(req), id(req), false, req.body.reason) })
})

boardsRouter.delete('/boards/:id', authenticate, manage, async (req, res) => {
  await service.deleteBoard(ctxOf(req), id(req))
  res.status(204).send()
})

boardsRouter.post('/boards/:id/restore', authenticate, manage, async (req, res) => {
  res.status(200).json({ data: await service.restoreBoard(ctxOf(req), id(req)) })
})
