import { Router } from 'express'
import { z } from 'zod'
import { authenticateApp } from '../../../middleware/authenticateApp.js'
import { requireTeacher } from '../../../middleware/requireRole.js'
import { validateQuery } from '../../../middleware/validate.js'
import * as service from './dashboard.service.js'

export const teacherDashboardRouter = Router()

// BR-18.1: 7 or 30 days only (default 7).
const querySchema = z.object({
  range: z
    .enum(['7', '30'], { errorMap: () => ({ message: 'Range must be 7 or 30.' }) })
    .default('7')
    .transform((v) => Number(v) as 7 | 30),
})

teacherDashboardRouter.get('/teacher/dashboard', authenticateApp, requireTeacher, validateQuery(querySchema), async (req, res) => {
  const { range } = req.validatedQuery as z.infer<typeof querySchema>
  res.status(200).json({ data: await service.getDashboard(req.teacher!.id, range) })
})
