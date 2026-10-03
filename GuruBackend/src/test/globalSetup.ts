import { rm } from 'node:fs/promises'
import { Redis } from 'ioredis'

// Runs once before the whole suite: clears rate-limit counters and deny-list entries left in the Redis test
// database (db 1 via .env.test) by previous runs, so fixed-key limits (phone/email cooldowns) start fresh.
export default async function setup() {
  // Uploaded test files live in the local-disk storage driver's directory; start each run empty.
  await rm(process.env.STORAGE_LOCAL_DIR ?? '.storage-test', { recursive: true, force: true })

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1', {
    lazyConnect: true,
    connectTimeout: 1000,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  })
  redis.on('error', () => undefined)
  try {
    await redis.connect()
    for (const pattern of ['rl:*', 'revoked_sid:*']) {
      const keys = await redis.keys(pattern)
      if (keys.length) await redis.del(...keys)
    }
  } catch {
    console.warn('[test] Redis not reachable — tests run against the in-process fallbacks')
  } finally {
    redis.disconnect()
  }
}
