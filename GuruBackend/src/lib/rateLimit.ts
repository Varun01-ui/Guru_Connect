import { getRedis } from './redis.js'

// Fixed-window counter. Backed by Redis (INCR + PEXPIRE) so limits hold across processes and restarts;
// if Redis is disabled or unreachable it degrades to an in-process map (single-process only).
type Bucket = { count: number; windowStartedAt: number }
const buckets = new Map<string, Bucket>()

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number }

function hitMemory(key: string, max: number, windowMs: number): RateLimitResult {
  const now = Date.now()
  const existing = buckets.get(key)

  if (!existing || now - existing.windowStartedAt >= windowMs) {
    buckets.set(key, { count: 1, windowStartedAt: now })
    return { allowed: true, retryAfterSeconds: 0 }
  }

  existing.count += 1
  if (existing.count > max) {
    return { allowed: false, retryAfterSeconds: Math.ceil((existing.windowStartedAt + windowMs - now) / 1000) }
  }
  return { allowed: true, retryAfterSeconds: 0 }
}

export async function hitRateLimit(key: string, max: number, windowMs: number): Promise<RateLimitResult> {
  const redis = await getRedis()
  if (!redis) return hitMemory(key, max, windowMs)

  try {
    const redisKey = `rl:${key}`
    const count = await redis.incr(redisKey)
    if (count === 1) await redis.pexpire(redisKey, windowMs)
    if (count <= max) return { allowed: true, retryAfterSeconds: 0 }

    const ttl = await redis.pttl(redisKey)
    // A key that lost its expiry (crash between INCR and PEXPIRE) would block forever — repair it.
    if (ttl < 0) await redis.pexpire(redisKey, windowMs)
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((ttl < 0 ? windowMs : ttl) / 1000)) }
  } catch {
    return hitMemory(key, max, windowMs)
  }
}
