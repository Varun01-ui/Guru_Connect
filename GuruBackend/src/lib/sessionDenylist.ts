import { env } from '../config/env.js'
import { getRedis } from './redis.js'

// `revoked_sid:<sid>` marks a session as revoked for as long as any access token minted for it could
// still be valid (its TTL), so a sign-out takes effect on the very next request without a DB lookup.
// Postgres (admin_sessions.revoked_at) stays the source of truth — see middleware/authenticate.ts.
const key = (sid: string) => `revoked_sid:${sid}`

export async function denySessions(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return
  const redis = await getRedis()
  if (!redis) return
  try {
    const pipeline = redis.pipeline()
    for (const sid of sessionIds) pipeline.set(key(sid), '1', 'EX', env.ACCESS_TOKEN_TTL_SECONDS)
    await pipeline.exec()
  } catch {
    // Best effort: the DB check in authenticate still rejects the session.
  }
}

export async function isSessionDenied(sid: string): Promise<boolean> {
  const redis = await getRedis()
  if (!redis) return false
  try {
    return (await redis.exists(key(sid))) === 1
  } catch {
    return false
  }
}
