import { Router } from 'express'
import { getPublicPricing } from '../../paymentConfig/pc.actions.js'

export const pricingRouter = Router()

// M05 FR-5.12: every fee's resolved price for the purchase screens. Display data only; the amount charged is always
// recomputed on the server when an order is created.
pricingRouter.get('/pricing', async (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60')
  res.status(200).json({ data: await getPublicPricing() })
})
