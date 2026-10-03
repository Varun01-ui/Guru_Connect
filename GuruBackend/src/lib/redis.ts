import { Redis } from 'ioredis'
import { env } from '../config/env.js'

// One shared connection for rate limits and the revoked-session deny-list. Every caller must cope with
// `null` (Redis disabled/unreachable): rate limiting falls back to in-process counters and the deny-list
// falls back to the admin_sessions check in Postgres, so a Redis outage degrades, never breaks, sign-in.
let client: Redis | null = null
let connecting: Promise<void> | null = null
let warned = false

function create(): Redis {
  const redis = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1500,
    commandTimeout: 1000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => Math.min(attempt * 500, 10_000),
  })
  redis.on('error', (err) => {
    if (warned) return
    warned = true
    console.warn(`[redis] unavailable (${err.message}) — using in-process fallbacks until it reconnects`)
  })
  redis.on('ready', () => {
    warned = false
  })
  return redis
}

export async function getRedis(): Promise<Redis | null> {
  if (!env.REDIS_ENABLED) return null
  if (!client) {
    client = create()
    // Shared by concurrent first callers: without it a second caller would see a still-"connecting" client and
    // wrongly conclude Redis is down.
    connecting = client.connect().then(
      () => undefined,
      () => undefined,
    )
  }
  if (connecting) await connecting
  return client.status === 'ready' ? client : null
}

export async function closeRedis(): Promise<void> {
  if (!client) return
  const c = client
  client = null
  connecting = null
  await c.quit().catch(() => c.disconnect())
}

// BullMQ needs its own connection with `maxRetriesPerRequest: null`.
export function createQueueConnection(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
}
