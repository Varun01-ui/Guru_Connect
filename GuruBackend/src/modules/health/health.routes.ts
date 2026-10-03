import { Router } from 'express'
import { sql } from 'kysely'
import { db } from '../../db/index.js'

export const healthRouter = Router()

healthRouter.get('/health', async (_req, res) => {
  await sql`select 1`.execute(db)
  res.status(200).json({ data: { status: 'ok' } })
})
