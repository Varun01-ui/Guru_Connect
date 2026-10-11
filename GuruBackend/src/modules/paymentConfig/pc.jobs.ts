import { scheduleRepeatingJob } from '../../lib/jobs.js'
import { activateDueVersions } from './pc.actions.js'

// M05 FR-5.6: every minute, scheduled price changes whose time has come go live.
export function startPaymentConfigJobs() {
  return scheduleRepeatingJob({
    queueName: 'payment-config-activate',
    schedulerId: 'payment-config-activate',
    pattern: '* * * * *',
    handler: async () => {
      const n = await activateDueVersions()
      if (n > 0) console.log(`[jobs] payment-config: activated ${n} scheduled version(s)`)
    },
  })
}
