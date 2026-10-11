import { Router } from 'express'
import { getPublicSettings } from '../../../lib/settingsCache.js'

export const publicSettingsRouter = Router()

// M04 FR-4.5: only is_public settings, as one flat object. Clients revalidate with If-None-Match; the response is
// also allowed to sit in a shared cache for five minutes (an admin save purges the server-side copy immediately).
publicSettingsRouter.get('/settings', async (req, res) => {
  const { data, etag } = await getPublicSettings()
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.setHeader('ETag', etag)
  if (req.header('If-None-Match') === etag) return void res.status(304).end()
  res.status(200).json({ data, meta: { maintenance: data['app.maintenance_mode'] === true } })
})
