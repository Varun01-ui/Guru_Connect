import { createHash } from 'node:crypto'
import { db } from '../db/index.js'
import { kvDel, kvGet, kvSet } from './kv.js'

// Public settings (M04 FR-4.5) and the maintenance flag (FR-4.4), cached so the mobile API doesn't hit Postgres on
// every request. Any admin save purges both keys (`purgeSettingsCache`), so a change is visible on the next call.
const PUBLIC_KEY = 'settings:public:v1'
const MAINTENANCE_KEY = 'settings:maintenance:v1'
const PUBLIC_TTL_SECONDS = 300
const MAINTENANCE_TTL_SECONDS = 15

export type PublicSettings = { data: Record<string, unknown>; etag: string }

export async function getPublicSettings(): Promise<PublicSettings> {
  const hit = await kvGet(PUBLIC_KEY)
  if (hit) return JSON.parse(hit) as PublicSettings
  const rows = await db.selectFrom('system_settings').select(['key', 'value']).where('is_public', '=', true).orderBy('key').execute()
  const data: Record<string, unknown> = {}
  for (const row of rows) data[row.key] = row.value
  const etag = `"${createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 20)}"`
  const payload: PublicSettings = { data, etag }
  await kvSet(PUBLIC_KEY, JSON.stringify(payload), PUBLIC_TTL_SECONDS)
  return payload
}

export async function isMaintenanceOn(): Promise<boolean> {
  const hit = await kvGet(MAINTENANCE_KEY)
  if (hit !== null) return hit === '1'
  const row = await db.selectFrom('system_settings').select('value').where('key', '=', 'app.maintenance_mode').executeTakeFirst()
  const on = row?.value === true
  await kvSet(MAINTENANCE_KEY, on ? '1' : '0', MAINTENANCE_TTL_SECONDS)
  return on
}

export async function purgeSettingsCache(): Promise<void> {
  await Promise.all([kvDel(PUBLIC_KEY), kvDel(MAINTENANCE_KEY)])
}
