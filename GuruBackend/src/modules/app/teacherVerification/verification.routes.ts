import { Router } from 'express'
import type { Request } from 'express'
import { authenticateApp } from '../../../middleware/authenticateApp.js'
import { requireTeacher } from '../../../middleware/requireRole.js'
import { requestContext } from '../student/student.routes.js'
import * as service from './verification.service.js'

export const teacherVerificationRouter = Router()

const guard = [authenticateApp, requireTeacher]
const ctx = (req: Request) => ({ ...requestContext(req), teacherId: req.teacher!.id, userId: req.teacher!.userId })

teacherVerificationRouter.get('/teacher/verification', ...guard, async (req, res) => {
  res.status(200).json({ data: await service.getVerification(req.teacher!.id) })
})

teacherVerificationRouter.post('/teacher/verification/resubmit', ...guard, async (req, res) => {
  res.status(200).json({ data: await service.resubmit(ctx(req)) })
})
