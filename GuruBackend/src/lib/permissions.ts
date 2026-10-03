import { db } from '../db/index.js'
import { kvDel, kvGet, kvSet } from './kv.js'

// Effective permissions (M02 FR-2.6): the union of every live role the admin holds. Super admins implicitly hold every
// key in the catalogue. Cached per admin for 5 minutes (Redis `perm:<adminId>`, in-process fallback) and busted on any
// role or assignment change, so revoked access takes effect on the next request.
const TTL_SECONDS = 5 * 60
const cacheKey = (adminId: string) => `perm:${adminId}`

export async function allPermissionKeys(): Promise<string[]> {
  const rows = await db.selectFrom('permissions').select('key').orderBy('key').execute()
  return rows.map((r) => r.key)
}

export async function loadEffectivePermissions(adminId: string, isSuperAdmin: boolean): Promise<string[]> {
  if (isSuperAdmin) return allPermissionKeys()
  const rows = await db
    .selectFrom('admin_roles as ar')
    .innerJoin('roles as r', 'r.id', 'ar.role_id')
    .innerJoin('role_permissions as rp', 'rp.role_id', 'r.id')
    .innerJoin('permissions as p', 'p.id', 'rp.permission_id')
    .select('p.key')
    .distinct()
    .where('ar.admin_id', '=', adminId)
    .where('r.deleted_at', 'is', null)
    .orderBy('p.key')
    .execute()
  return rows.map((r) => r.key)
}

export async function getEffectivePermissions(adminId: string, isSuperAdmin: boolean): Promise<string[]> {
  const key = cacheKey(adminId)
  const cached = await kvGet(key)
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { sa: boolean; keys: string[] }
      // A cache entry written before the admin became (or stopped being) a super admin is stale.
      if (parsed.sa === isSuperAdmin) return parsed.keys
    } catch {
      // fall through and reload
    }
  }
  const keys = await loadEffectivePermissions(adminId, isSuperAdmin)
  await kvSet(key, JSON.stringify({ sa: isSuperAdmin, keys }), TTL_SECONDS)
  return keys
}

export async function bustPermissionCache(adminIds: string[]): Promise<void> {
  await Promise.all(adminIds.map((id) => kvDel(cacheKey(id))))
}
