import { scheduleRepeatingJob } from '../../../lib/jobs.js'
import { storage } from '../../../lib/storage.js'
import type { Bucket } from '../../../lib/storage.js'
import { STALE_PENDING_HOURS } from './uploads.config.js'
import * as repo from './uploads.repository.js'

const BATCH = 500

// M00 BR-0.8: pending uploads older than 24 h were never confirmed (abandoned or failed); remove object and row.
export async function cleanupPendingUploads(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_PENDING_HOURS * 3_600_000)
  let removed = 0
  for (;;) {
    const batch = await repo.listStalePendingFiles(cutoff, BATCH)
    if (batch.length === 0) return removed
    for (const file of batch) await storage.delete(file.bucket as Bucket, file.object_key).catch(() => undefined)
    await repo.deleteFileRows(batch.map((f) => f.id))
    removed += batch.length
    if (batch.length < BATCH) return removed
  }
}

export function startUploadJobs() {
  return scheduleRepeatingJob({
    queueName: 'uploads-maintenance',
    schedulerId: 'uploads-pending-cleanup-hourly',
    pattern: '15 * * * *',
    handler: async () => {
      const removed = await cleanupPendingUploads()
      if (removed > 0) console.log(`[jobs] removed ${removed} abandoned pending uploads`)
    },
  })
}
