import { getRedis } from './redis.js'

// Small string key-value store with TTL. Redis-backed when available, in-process otherwise — same keys and TTLs
// either way, so callers don't care which one answered (spec "Redis fallback" rule). Used for short-lived flags
// such as the student cold-start subjects and OTP lockouts.
const memory = new Map<string, { value: string; expiresAt: number }>()

export async function kvSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
  const redis = await getRedis()
  if (!redis) return
  try {
    await redis.set(key, value, 'EX', ttlSeconds)
  } catch {
    // the in-process copy above still answers
  }
}

export async function kvGet(key: string): Promise<string | null> {
  const redis = await getRedis()
  if (redis) {
    try {
      const value = await redis.get(key)
      if (value !== null) return value
    } catch {
      // fall through to memory
    }
  }
  const entry = memory.get(key)
  if (entry && entry.expiresAt > Date.now()) return entry.value
  if (entry) memory.delete(key)
  return null
}

export async function kvDel(key: string): Promise<void> {
  memory.delete(key)
  const redis = await getRedis()
  if (!redis) return
  try {
    await redis.del(key)
  } catch {
    // best effort
  }
}
