import { Router } from 'express'
import type { z } from 'zod'
import { verifyAppAccessToken } from '../../../lib/appJwt.js'
import { validateBody, validateQuery } from '../../../middleware/validate.js'
import { eventsSchema, servingQuerySchema } from '../../banners/banners.schemas.js'
import * as service from '../../banners/banners.service.js'

export const appBannersRouter = Router()

const AUDIENCE_OF_ROLE = { parent: 'parents', student: 'students', teacher: 'teachers', institute_staff: 'institutes' } as const

// Banners are also shown before sign-in (onboarding), so a token is optional: a signed-in user is served for their
// own role, anyone else for the audience the client asks for, falling back to the "all" banners only.
appBannersRouter.get('/banners', validateQuery(servingQuerySchema), async (req, res) => {
  const query = req.validatedQuery as z.infer<typeof servingQuerySchema>
  let audience: string = query.audience ?? 'all'
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    try {
      audience = AUDIENCE_OF_ROLE[verifyAppAccessToken(header.slice(7)).role]
    } catch {
      // an expired or bad token just means "treat as signed out"
    }
  }
  const items = await service.serveBanners({ placement: query.placement, audience, cityId: query.cityId ?? null })
  res.status(200).json({ data: items.map(({ priority: _priority, ...banner }) => banner) })
})

appBannersRouter.post('/events', validateBody(eventsSchema), async (req, res) => {
  res.status(202).json({ data: await service.recordEvents(req.ip ?? null, req.body.events) })
})
