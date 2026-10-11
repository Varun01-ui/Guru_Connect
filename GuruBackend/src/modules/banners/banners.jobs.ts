import { scheduleRepeatingJob } from '../../lib/jobs.js'
import { runBannerLifecycle } from './banners.service.js'

// M44 FR-44.1: every five minutes, scheduled banners go live and finished ones expire.
export function startBannerJobs() {
  return scheduleRepeatingJob({
    queueName: 'banners',
    schedulerId: 'banner-lifecycle',
    pattern: '*/5 * * * *',
    handler: async () => {
      const { activated, expired } = await runBannerLifecycle()
      if (activated + expired > 0) console.log(`[jobs] banners: ${activated} activated, ${expired} expired`)
    },
  })
}
