import { Router } from 'express'
import type { z } from 'zod'
import { authenticateApp } from '../../../middleware/authenticateApp.js'
import { requireParent } from '../../../middleware/requireParent.js'
import { requireStudent } from '../../../middleware/requireRole.js'
import { getStudentHome } from './home.student.js'
import { validateQuery } from '../../../middleware/validate.js'
import { homeQuerySchema } from './home.schemas.js'
import * as service from './home.service.js'

export const homeRouter = Router()

homeRouter.get('/home/parent', authenticateApp, requireParent, validateQuery(homeQuerySchema), async (req, res) => {
  const query = req.validatedQuery as z.infer<typeof homeQuerySchema>
  res.status(200).json(await service.getHome({ parentId: req.parent!.id }, query))
})

homeRouter.get('/home/student', authenticateApp, requireStudent, validateQuery(homeQuerySchema), async (req, res) => {
  const query = req.validatedQuery as z.infer<typeof homeQuerySchema>
  res.status(200).json(await getStudentHome({ studentId: req.student!.id, userId: req.student!.userId }, query))
})
