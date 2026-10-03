import { Router } from 'express'
import type { Request } from 'express'
import { z } from 'zod'
import { notFound } from '../../lib/errors.js'
import { getEffectivePermissions } from '../../lib/permissions.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import * as actions from './tv.actions.js'
import * as queries from './tv.queries.js'
import { approveTeacherSchema, caseQuerySchema, createTeacherSchema, documentDecisionSchema, forceQuerySchema, noteSchema, queueQuerySchema, rejectTeacherSchema, sendBackSchema } from './tv.schemas.js'

export const teacherVerificationRouter = Router()

async function ctx(req: Request): Promise<actions.Ctx> {
  const admin = req.admin!
  const held = new Set(admin.isSuperAdmin ? [] : await getEffectivePermissions(admin.id, false))
  return {
    actor: { id: admin.id, email: admin.email, isSuperAdmin: admin.isSuperAdmin },
    can: (permission) => admin.isSuperAdmin || held.has(permission),
    ip: req.ip ?? null,
    userAgent: req.header('User-Agent') ?? null,
    requestId: (req.id as string | undefined) ?? null,
  }
}

// A malformed UUID is "not found", never a 500.
function paramId(req: Request, name: string): string {
  const parsed = z.string().uuid().safeParse(req.params[name])
  if (!parsed.success) throw notFound()
  return parsed.data
}
const force = (req: Request) => forceQuerySchema.parse(req.query).force

const auth = [authenticate]
const read = [...auth, requirePermission('teachers.read')]
const review = [...auth, requirePermission('teacher_verification.review')]
const decide = [...auth, requirePermission('teacher_verification.decide')]

teacherVerificationRouter.get('/teacher-verifications', ...read, validateQuery(queueQuerySchema), async (req, res) => {
  const c = await ctx(req)
  const result = await queries.listQueue(req.validatedQuery as z.infer<typeof queueQuerySchema>, { id: c.actor.id, canSeePii: c.can('users.pii') })
  res.status(200).json(result)
})

// Registered before /:teacherId so "stats" is never read as an id.
teacherVerificationRouter.get('/teacher-verifications/stats', ...read, async (_req, res) => {
  res.status(200).json({ data: await queries.queueStats() })
})

teacherVerificationRouter.get('/teacher-verifications/:teacherId', ...read, validateQuery(caseQuerySchema), async (req, res) => {
  const c = await ctx(req)
  const { cursor } = req.validatedQuery as z.infer<typeof caseQuerySchema>
  res.status(200).json({ data: await queries.getCase(paramId(req, 'teacherId'), { canSeePii: c.can('users.pii') }, cursor) })
})

teacherVerificationRouter.post('/teacher-verifications/:teacherId/claim', ...review, async (req, res) => {
  await actions.claim(await ctx(req), paramId(req, 'teacherId'), force(req))
  res.status(200).json({ data: await queries.getCase(paramId(req, 'teacherId'), { canSeePii: false }) })
})

teacherVerificationRouter.post('/teacher-verifications/:teacherId/release', ...review, async (req, res) => {
  await actions.release(await ctx(req), paramId(req, 'teacherId'))
  res.status(200).json({ data: { released: true } })
})

for (const decision of ['approve', 'reject', 'request-reupload'] as const) {
  const middleware = decision === 'approve' ? [] : [validateBody(documentDecisionSchema, { firstIssueMessage: true })]
  teacherVerificationRouter.post(`/teacher-documents/:documentId/${decision}`, ...review, ...middleware, async (req, res) => {
    res.status(200).json({ data: await actions.decideDocument(await ctx(req), paramId(req, 'documentId'), decision, decision === 'approve' ? null : req.body, force(req)) })
  })
}

teacherVerificationRouter.get('/teacher-documents/:documentId/file', ...auth, requirePermission('teacher_documents.unmask'), async (req, res) => {
  res.status(200).json({ data: await queries.getDocumentFile(await ctx(req), paramId(req, 'documentId')) })
})

teacherVerificationRouter.post('/teacher-verifications/:teacherId/notes', ...review, validateBody(noteSchema), async (req, res) => {
  await actions.addNote(await ctx(req), paramId(req, 'teacherId'), req.body)
  res.status(201).json({ data: { added: true } })
})

teacherVerificationRouter.post('/teacher-verifications/:teacherId/request-reupload', ...review, validateBody(sendBackSchema), async (req, res) => {
  res.status(200).json({ data: await actions.sendBack(await ctx(req), paramId(req, 'teacherId'), req.body.message, force(req)) })
})

teacherVerificationRouter.post('/teacher-verifications/:teacherId/approve', ...decide, validateBody(approveTeacherSchema), async (req, res) => {
  res.status(200).json({ data: await actions.approve(await ctx(req), paramId(req, 'teacherId'), req.body, force(req)) })
})

teacherVerificationRouter.post('/teacher-verifications/:teacherId/reject', ...decide, validateBody(rejectTeacherSchema, { firstIssueMessage: true }), async (req, res) => {
  res.status(200).json({ data: await actions.reject(await ctx(req), paramId(req, 'teacherId'), req.body, force(req)) })
})

teacherVerificationRouter.post('/teachers', ...auth, requirePermission('teachers.create'), validateBody(createTeacherSchema), async (req, res) => {
  res.status(201).json({ data: await actions.createTeacher(await ctx(req), req.body) })
})
