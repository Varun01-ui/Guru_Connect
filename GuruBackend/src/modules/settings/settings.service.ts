import { isDeepStrictEqual } from 'node:util'
import { sql } from 'kysely'
import { z } from 'zod'
import { db } from '../../db/index.js'
import { audit } from '../../lib/audit.js'
import { ApiError, conflictState, notFound, validationFailed } from '../../lib/errors.js'
import { purgeSettingsCache } from '../../lib/settingsCache.js'
import type { Ctx } from '../rbac/rbac.service.js'
import { GROUP_ORDER, JSON_SCHEMAS, MAINTENANCE_KEY, VERSION_PAIRS, compareSemver, rangeFor, requiresReason } from './settings.registry.js'
import type { PatchSettingsInput } from './settings.schemas.js'

export type { Ctx }

type ValueType = 'string' | 'number' | 'boolean' | 'url' | 'email' | 'phone' | 'semver' | 'json'

type Row = {
  id: string
  key: string
  group_name: string
  value: unknown
  value_type: ValueType
  label: string
  description: string | null
  is_public: boolean
  is_editable: boolean
  updated_at: Date
  updated_by: string | null
  updated_by_name: string | null
}

const stringRule = z.string().trim().min(1, 'Enter 1–200 characters.').max(200, 'Enter 1–200 characters.')
const urlRule = z
  .string()
  .trim()
  .max(500, 'Enter a shorter link.')
  .refine((v) => {
    try {
      return new URL(v).protocol === 'https:'
    } catch {
      return false
    }
  }, 'Enter a link starting with https://')
const emailRule = z.string().trim().max(200).email('Enter a valid email address.')
const phoneRule = z.string().trim().regex(/^\+[1-9]\d{6,14}$/, 'Enter a phone number like +919876543210.')
const semverRule = z.string().trim().regex(/^\d+\.\d+\.\d+$/, 'Enter a version like 1.2.0')

// FR-4.2: one rule per value_type; returns the normalised value or the message to show next to the input.
function check(row: Pick<Row, 'key' | 'value_type'>, raw: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  const parsed = (schema: z.ZodType) => {
    const r = schema.safeParse(raw)
    return r.success ? ({ ok: true, value: r.data } as const) : ({ ok: false, message: r.error.issues[0]?.message ?? 'Enter a valid value.' } as const)
  }
  switch (row.value_type) {
    case 'string':
      return parsed(stringRule)
    case 'url':
      return parsed(urlRule)
    case 'email':
      return parsed(emailRule)
    case 'phone':
      return parsed(phoneRule)
    case 'semver':
      return parsed(semverRule)
    case 'boolean':
      return parsed(z.boolean({ invalid_type_error: 'Choose on or off.', required_error: 'Choose on or off.' }))
    case 'number': {
      const { min, max } = rangeFor(row.key)
      return parsed(z.number({ invalid_type_error: 'Enter a whole number.', required_error: 'Enter a whole number.' }).int('Enter a whole number.').min(min, `Enter a number from ${min} to ${max}.`).max(max, `Enter a number from ${min} to ${max}.`))
    }
    case 'json':
      return raw === undefined ? { ok: false, message: 'A value is required.' } : parsed(JSON_SCHEMAS[row.key] ?? z.any())
  }
}

const SELECT = [
  'system_settings.id',
  'system_settings.key',
  'system_settings.group_name',
  'system_settings.value',
  'system_settings.value_type',
  'system_settings.label',
  'system_settings.description',
  'system_settings.is_public',
  'system_settings.is_editable',
  'system_settings.updated_at',
  'system_settings.updated_by',
  'admins.full_name as updated_by_name',
] as const

const baseQuery = () => db.selectFrom('system_settings').leftJoin('admins', 'admins.id', 'system_settings.updated_by').select(SELECT)

function present(r: Row) {
  const base = {
    key: r.key,
    group: r.group_name,
    label: r.label,
    valueType: r.value_type,
    value: r.value,
    description: r.description,
    isPublic: r.is_public,
    isEditable: r.is_editable,
    updatedAt: r.updated_at.toISOString(),
    updatedBy: r.updated_by ? { id: r.updated_by, name: r.updated_by_name ?? 'Admin' } : null,
  }
  if (r.value_type !== 'number') return base
  return { ...base, constraints: rangeFor(r.key) }
}

const groupRank = (name: string) => {
  const i = (GROUP_ORDER as readonly string[]).indexOf(name)
  return i === -1 ? GROUP_ORDER.length : i
}

export async function listSettings() {
  const rows = (await baseQuery().orderBy('system_settings.key').execute()) as Row[]
  const byGroup = new Map<string, ReturnType<typeof present>[]>()
  for (const r of rows) byGroup.set(r.group_name, [...(byGroup.get(r.group_name) ?? []), present(r)])
  const groups = [...byGroup]
    .map(([group, settings]) => ({ group, settings }))
    .sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.group.localeCompare(b.group))
  return { groups }
}

// FR-4.7: the audit trail of one key, newest first.
export async function getSetting(key: string) {
  const row = (await baseQuery().where('system_settings.key', '=', key).executeTakeFirst()) as Row | undefined
  if (!row) throw notFound('Setting not found.')
  const history = await db
    .selectFrom('audit_logs')
    .select(['id', 'action', 'actor_email', 'old_values', 'new_values', 'reason', 'created_at'])
    .where('entity_type', '=', 'system_settings')
    .where('entity_id', '=', row.id)
    .orderBy('created_at', 'desc')
    .limit(20)
    .execute()
  return {
    ...present(row),
    history: history.map((h) => ({
      id: h.id,
      action: h.action,
      actorEmail: h.actor_email,
      oldValue: (h.old_values as { value?: unknown } | null)?.value ?? null,
      newValue: (h.new_values as { value?: unknown } | null)?.value ?? null,
      reason: h.reason,
      at: h.created_at.toISOString(),
    })),
  }
}

const fieldErrors = (errors: { path: string; message: string }[]) => validationFailed(errors, errors[0]!.message)

// FR-4.3: validate everything, then write every changed key in one transaction (all or nothing).
export async function patchSettings(ctx: Ctx, version: Date, input: PatchSettingsInput) {
  const keys = Object.keys(input.values).sort()

  const result = await db.transaction().execute(async (trx) => {
    const rows = (await trx
      .selectFrom('system_settings')
      .select(['id', 'key', 'group_name', 'value', 'value_type', 'is_editable', 'updated_at'])
      .where('key', 'in', keys)
      .orderBy('key')
      .forUpdate()
      .execute()) as Pick<Row, 'id' | 'key' | 'group_name' | 'value' | 'value_type' | 'is_editable' | 'updated_at'>[]
    const byKey = new Map(rows.map((r) => [r.key, r]))

    const unknown = keys.find((k) => !byKey.has(k))
    if (unknown) throw fieldErrors([{ path: unknown, message: `Unknown setting: ${unknown}` }])
    const stray = rows.find((r) => r.group_name !== input.group)
    if (stray) throw fieldErrors([{ path: stray.key, message: `${stray.key} doesn't belong to the ${input.group} group.` }])

    // Values equal to what is stored aren't changes: they neither trip the read-only rule nor write an audit row.
    const changed = rows.filter((r) => !isDeepStrictEqual(input.values[r.key], r.value))
    const locked = changed.find((r) => !r.is_editable)
    if (locked) throw conflictState('This setting is managed by deployments.', { key: locked.key })

    const latest = Math.max(...rows.map((r) => r.updated_at.getTime()))
    if (latest !== version.getTime()) {
      throw new ApiError(409, 'VERSION_CONFLICT', 'Settings changed since you opened this page. Reload.', { currentVersion: new Date(latest).toISOString() })
    }

    const errors: { path: string; message: string }[] = []
    const next = new Map<string, unknown>()
    for (const r of rows) {
      const outcome = check(r, input.values[r.key])
      if (outcome.ok) next.set(r.key, outcome.value)
      else errors.push({ path: r.key, message: outcome.message })
    }
    if (errors.length > 0) throw fieldErrors(errors)

    const real = rows.filter((r) => !isDeepStrictEqual(next.get(r.key), r.value))

    // Minimum version must not exceed the latest one, judged on the values as they will be after this save.
    if (real.some((r) => VERSION_PAIRS.some((p) => p.min === r.key || p.latest === r.key))) {
      const current = new Map(
        (await trx.selectFrom('system_settings').select(['key', 'value']).where('key', 'in', VERSION_PAIRS.flatMap((p) => [p.min, p.latest])).execute()).map((r) => [r.key, r.value]),
      )
      for (const p of VERSION_PAIRS) {
        const min = (next.get(p.min) ?? current.get(p.min)) as string | undefined
        const latestVersion = (next.get(p.latest) ?? current.get(p.latest)) as string | undefined
        if (min && latestVersion && compareSemver(min, latestVersion) > 0 && (next.has(p.min) || next.has(p.latest))) {
          throw fieldErrors([{ path: p.min, message: "Minimum version can't be higher than the latest version." }])
        }
      }
    }

    const maintenance = real.find((r) => r.key === MAINTENANCE_KEY)
    const reason = input.reason?.trim() ?? ''
    const needsReason = real.some((r) => requiresReason(r.key))
    if ((needsReason || maintenance) && reason.length < 5) throw fieldErrors([{ path: 'reason', message: 'Add a reason for this change.' }])
    if (maintenance && next.get(MAINTENANCE_KEY) === true && input.confirmMaintenance !== true) {
      throw fieldErrors([{ path: 'confirmMaintenance', message: 'Confirm that you want to switch maintenance mode on.' }])
    }

    for (const r of real) {
      await trx.updateTable('system_settings').set({ value: sql`${JSON.stringify(next.get(r.key))}::jsonb` as never, updated_by: ctx.actor.id }).where('id', '=', r.id).execute()
      const action = r.key === MAINTENANCE_KEY ? (next.get(r.key) === true ? 'setting.maintenance_enabled' : 'setting.maintenance_disabled') : 'setting.updated'
      await audit(trx, {
        actorType: 'admin',
        actorId: ctx.actor.id,
        actorEmail: ctx.actor.email,
        action,
        module: 'settings',
        entityType: 'system_settings',
        entityId: r.id,
        // `value` is nested so the audit helper's key filter treats it like any other field.
        oldValues: { key: r.key, value: r.value },
        newValues: { key: r.key, value: next.get(r.key) },
        reason: reason || null,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      })
    }
    return real.length
  })

  if (result > 0) await purgeSettingsCache()
  const all = await listSettings()
  return { updated: result, group: all.groups.find((g) => g.group === input.group) ?? { group: input.group, settings: [] } }
}
