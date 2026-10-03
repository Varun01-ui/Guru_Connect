import { db } from '../../db/index.js'
import { audit } from '../../lib/audit.js'
import { scheduleRepeatingJob } from '../../lib/jobs.js'
import * as repo from './auth.repository.js'

const DAY_MS = 86_400_000

// M01 §22 nightly retention: expired/revoked sessions older than 30 days, used/expired reset tokens older than 7.
export async function cleanupAuthData(now = new Date()) {
  const sessions = await repo.deleteStaleSessions(new Date(now.getTime() - 30 * DAY_MS))
  const resetTokens = await repo.deleteStaleResetTokens(new Date(now.getTime() - 7 * DAY_MS))
  if (sessions > 0 || resetTokens > 0) {
    await audit(db, { actorType: 'system', action: 'auth.cleanup', module: 'auth', newValues: { sessionsDeleted: sessions, resetTokensDeleted: resetTokens } })
  }
  return { sessions, resetTokens }
}

// Scheduled through BullMQ, so it needs Redis (see lib/jobs.ts). Stale rows are harmless without it: every lookup
// already filters on revoked_at / expires_at, they just aren't pruned.
export function startAuthJobs() {
  return scheduleRepeatingJob({
    queueName: 'auth-maintenance',
    schedulerId: 'auth-cleanup-nightly',
    pattern: '0 3 * * *',
    tz: 'Asia/Kolkata',
    handler: async () => {
      const result = await cleanupAuthData()
      console.log(`[jobs] auth cleanup removed ${result.sessions} sessions, ${result.resetTokens} reset tokens`)
    },
  })
}
