import type { NextFunction, Request, Response } from 'express'
import { ApiError } from '../lib/errors.js'

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = req.id as string | undefined

  if (err instanceof ApiError) {
    const retryAfter = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds
    if (err.status === 429 && retryAfter) res.setHeader('Retry-After', String(retryAfter))
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, requestId },
    })
    return
  }

  req.log?.error({ err }, 'unhandled error')
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.', requestId },
  })
}
