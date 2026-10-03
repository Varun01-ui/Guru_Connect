import { getRedis } from './redis.js'

// Idempotency-Key replay cache. Redis-backed (24 h) so a retried POST returns the original response even across
// API processes; falls back to an in-process map when Redis is disabled or unreachable.
type CacheEntry = { status: number; body: unknown; expiresAt: number }

const store = new Map<string, CacheEntry>()
const TTL_SECONDS = 24 * 60 * 60

const redisKey = (key: string) => `idem:${key}`

export async function getIdempotent(key: string): Promise<{ status: number; body: unknown } | undefined> {
  const redis = await getRedis()
  if (redis) {
    try {
      const raw = await redis.get(redisKey(key))
      if (raw) return JSON.parse(raw) as { status: number; body: unknown }
    } catch {
      // fall through to the in-process copy
    }
  }
  const entry = store.get(key)
  if (entry && entry.expiresAt > Date.now()) return entry
  if (entry) store.delete(key)
  return undefined
}

export async function putIdempotent(key: string, status: number, body: unknown): Promise<void> {
  // Always keep the in-process copy too: it covers the window where Redis is briefly unavailable.
  store.set(key, { status, body, expiresAt: Date.now() + TTL_SECONDS * 1000 })
  const redis = await getRedis()
  if (!redis) return
  try {
    await redis.set(redisKey(key), JSON.stringify({ status, body }), 'EX', TTL_SECONDS)
  } catch {
    // best effort
  }
}
