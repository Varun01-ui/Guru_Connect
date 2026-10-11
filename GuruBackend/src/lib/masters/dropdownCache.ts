import { kvGet, kvSet } from '../kv.js'

const TTL_SECONDS = 600

// Dropdown lists (`?fields=...`) are cached for 10 minutes and purged on any write in the module (FR-x.S2). A purge
// bumps a version that is part of every cache key, which orphans all cached variants at once without scanning keys.
export function createDropdownCache(name: string) {
  const versionKey = `master:${name}:ver`
  const keyFor = async (variant: string) => `master:${name}:dd:${(await kvGet(versionKey)) ?? '0'}:${variant}`

  return {
    async get<T>(variant: string): Promise<T | null> {
      const hit = await kvGet(await keyFor(variant))
      return hit ? (JSON.parse(hit) as T) : null
    },
    async set(variant: string, data: unknown): Promise<void> {
      await kvSet(await keyFor(variant), JSON.stringify(data), TTL_SECONDS)
    },
    async purge(): Promise<void> {
      await kvSet(versionKey, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, 30 * 86_400)
    },
  }
}
