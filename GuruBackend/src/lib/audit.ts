import type { Kysely } from 'kysely'
import type { DB } from '../db/types.js'

type AuditEntry = {
  actorType: 'admin' | 'system' | 'app_user'
  actorId?: string | null
  actorEmail?: string | null
  action: string
  module: string
  entityType?: string | null
  entityId?: string | null
  oldValues?: unknown
  newValues?: unknown
  reason?: string | null
  ip?: string | null
  userAgent?: string | null
  requestId?: string | null
}

const SENSITIVE_KEY = /password|token|secret|aadhaar_number|pan_number|signed_url/i

function strip(values: unknown): unknown {
  if (!values || typeof values !== 'object') return values
  return Object.fromEntries(Object.entries(values as Record<string, unknown>).filter(([k]) => !SENSITIVE_KEY.test(k)))
}

export async function audit(db: Kysely<DB>, entry: AuditEntry): Promise<void> {
  await db
    .insertInto('audit_logs')
    .values({
      actor_type: entry.actorType,
      actor_id: entry.actorId ?? null,
      actor_email: entry.actorEmail ?? null,
      action: entry.action,
      module: entry.module,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId ?? null,
      old_values: strip(entry.oldValues) as never,
      new_values: strip(entry.newValues) as never,
      reason: entry.reason ?? null,
      ip_address: entry.ip ?? null,
      user_agent: entry.userAgent ?? null,
      request_id: entry.requestId ?? null,
    })
    .execute()
}
