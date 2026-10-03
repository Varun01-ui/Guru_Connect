import { Router } from 'express'
import { buildBootstrap } from './bootstrap.service.js'

export const bootstrapRouter = Router()

bootstrapRouter.get('/bootstrap', async (_req, res) => {
  res.status(200).json({ data: await buildBootstrap() })
})
