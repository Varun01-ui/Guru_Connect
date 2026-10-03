import type { NextFunction, Request, Response } from 'express'
import type { ZodType } from 'zod'
import { validationFailed } from '../lib/errors.js'

export function validateBody(schema: ZodType, opts: { firstIssueMessage?: boolean } = {}) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      throw opts.firstIssueMessage ? validationFailed(details, result.error.issues[0]?.message) : validationFailed(details)
    }
    req.body = result.data
    next()
  }
}

export function validateQuery(schema: ZodType) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query)
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      throw validationFailed(details)
    }
    req.validatedQuery = result.data
    next()
  }
}
