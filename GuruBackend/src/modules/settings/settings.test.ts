import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'
import { db } from '../../db/index.js'
import { purgeSettingsCache } from '../../lib/settingsCache.js'
import { API, authed, createAdminWithToken, purgeRbacFixtures } from '../../test/helpers.js'
import type { TestAdmin } from '../../test/helpers.js'

const app = createApp()
const EMAIL_PREFIX = 'set-test'
const TOUCHED = [
  'contact.support_email',
  'contact.support_phone',
  'contact.grievance_officer',
  'legal.terms_url',
  'platform.name',
  'app.android_min_version',
  'app.android_latest_version',
  'app.ios_min_version',
  'app.ios_latest_version',
  'app.maintenance_mode',
  'app.maintenance_message',
  'limits.parent_max_children',
  'limits.review_min_chars',
  'banners.allowed_domains',
  'notifications.quiet_hours',
  'institutes.rating_weights',
]

let superAdmin: TestAdmin
let ops: TestAdmin // settings.read only
let finance: TestAdmin // settings.read only
let outsider: TestAdmin // a role without any settings key
let snapshot: { key: string; value: unknown; updated_by: string | null; updated_at: Date }[] = []

type Setting = { key: string; value: unknown; updatedAt: string; isEditable: boolean; isPublic: boolean }

const list = async (as: TestAdmin = superAdmin) => {
  const res = await request(app).get(`${API}/settings`).set(authed(as.token))
  expect(res.status).toBe(200)
  return (res.body.data.groups as { group: string; settings: Setting[] }[]).flatMap((g) => g.settings)
}
const versionOf = async (keys: string[]) => {
  const all = await list()
  return new Date(Math.max(...keys.map((k) => new Date(all.find((s) => s.key === k)!.updatedAt).getTime()))).toISOString()
}
const save = async (group: string, values: Record<string, unknown>, extra: Record<string, unknown> = {}, opts: { version?: string; as?: TestAdmin } = {}) => {
  const version = opts.version ?? (await versionOf(Object.keys(values)))
  return request(app)
    .patch(`${API}/settings`)
    .set(authed((opts.as ?? superAdmin).token))
    .set('If-Match', version)
    .send({ group, values, ...extra })
}
const valueOf = async (key: string) => (await db.selectFrom('system_settings').select('value').where('key', '=', key).executeTakeFirstOrThrow()).value
const auditFor = async (key: string) => {
  const row = await db.selectFrom('system_settings').select('id').where('key', '=', key).executeTakeFirstOrThrow()
  return db.selectFrom('audit_logs').selectAll().where('entity_type', '=', 'system_settings').where('entity_id', '=', row.id).orderBy('created_at', 'desc').execute()
}

async function restore() {
  for (const s of snapshot) {
    await db.updateTable('system_settings').set({ value: JSON.stringify(s.value) as never, updated_by: null, updated_at: s.updated_at }).where('key', '=', s.key).execute()
  }
  await purgeSettingsCache()
}

beforeAll(async () => {
  snapshot = await db.selectFrom('system_settings').select(['key', 'value', 'updated_by', 'updated_at']).where('key', 'in', TOUCHED).execute()
  superAdmin = await createAdminWithToken({ superAdmin: true, roles: ['super_admin'], emailPrefix: EMAIL_PREFIX, fullName: 'Settings Boss' })
  ops = await createAdminWithToken({ roles: ['operations_admin'], emailPrefix: EMAIL_PREFIX })
  finance = await createAdminWithToken({ roles: ['finance_admin'], emailPrefix: EMAIL_PREFIX })
  outsider = await createAdminWithToken({ emailPrefix: EMAIL_PREFIX })
})

afterAll(async () => {
  await restore()
  await purgeRbacFixtures(EMAIL_PREFIX)
})

describe('permissions', () => {
  it('needs a signed-in admin', async () => {
    expect((await request(app).get(`${API}/settings`)).status).toBe(401)
    expect((await request(app).patch(`${API}/settings`).send({})).status).toBe(401)
  })

  it('lets anyone holding settings.read look, but not save', async () => {
    for (const a of [ops, finance]) {
      expect((await request(app).get(`${API}/settings`).set(authed(a.token))).status).toBe(200)
    }
    const res = await save('contact', { 'contact.support_email': 'ops@example.com' }, {}, { as: ops })
    expect(res.status).toBe(403)
    expect(res.body.error.details.required).toEqual(['settings.update'])
    expect(await valueOf('contact.support_email')).not.toBe('ops@example.com')
  })

  it('refuses an admin with no settings permission', async () => {
    expect((await request(app).get(`${API}/settings`).set(authed(outsider.token))).status).toBe(403)
    expect((await request(app).get(`${API}/settings/platform.name`).set(authed(outsider.token))).status).toBe(403)
  })
})

describe('reading', () => {
  it('returns every setting grouped, groups in display order and keys sorted', async () => {
    const res = await request(app).get(`${API}/settings`).set(authed(superAdmin.token))
    const groups = res.body.data.groups as { group: string; settings: { key: string }[] }[]
    const names = groups.map((g) => g.group)
    expect(names.slice(0, 5)).toEqual(['general', 'contact', 'legal', 'app_versions', 'limits'])
    for (const g of groups) {
      const keys = g.settings.map((s) => s.key)
      expect(keys).toEqual([...keys].sort())
    }
    const contact = groups.find((g) => g.group === 'contact')!.settings[0] as Record<string, unknown>
    expect(contact).toMatchObject({ valueType: expect.any(String), label: expect.any(String), isPublic: expect.any(Boolean), isEditable: true })
  })

  it('tells the UI the allowed range of a number', async () => {
    const children = (await list()).find((s) => s.key === 'limits.parent_max_children') as Setting & { constraints: { min: number; max: number } }
    expect(children.constraints).toEqual({ min: 1, max: 5 })
  })

  it('returns one setting with its history, and 404 for an unknown key', async () => {
    const saved = await save('general', { 'platform.name': 'GuruConnect QA' })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    const res = await request(app).get(`${API}/settings/platform.name`).set(authed(finance.token))
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ key: 'platform.name', value: 'GuruConnect QA', updatedBy: { name: 'Settings Boss' } })
    expect(res.body.data.history[0]).toMatchObject({ action: 'setting.updated', newValue: 'GuruConnect QA' })
    expect((await request(app).get(`${API}/settings/no.such_key`).set(authed(superAdmin.token))).status).toBe(404)
    expect((await request(app).get(`${API}/settings/%20bad`).set(authed(superAdmin.token))).status).toBe(404)
  })
})

describe('saving', () => {
  it('saves several keys of one group at once and audits each change', async () => {
    const res = await save('contact', { 'contact.support_email': 'help@example.com', 'contact.support_phone': '+919876543210' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.updated).toBe(2)
    expect(res.body.data.group.group).toBe('contact')
    expect(await valueOf('contact.support_email')).toBe('help@example.com')
    const [entry] = await auditFor('contact.support_email')
    expect(entry).toMatchObject({ action: 'setting.updated', module: 'settings', actor_id: superAdmin.id })
    expect(entry!.new_values).toMatchObject({ value: 'help@example.com' })
    const row = await db.selectFrom('system_settings').select('updated_by').where('key', '=', 'contact.support_email').executeTakeFirstOrThrow()
    expect(row.updated_by).toBe(superAdmin.id)
  })

  it('treats unchanged values as a no-op: nothing written, nothing audited', async () => {
    await save('contact', { 'contact.support_email': 'same@example.com' })
    const before = (await auditFor('contact.support_email')).length
    const res = await save('contact', { 'contact.support_email': 'same@example.com' })
    expect(res.status).toBe(200)
    expect(res.body.data.updated).toBe(0)
    expect((await auditFor('contact.support_email')).length).toBe(before)
  })

  it('rejects an unknown key (422)', async () => {
    const res = await save('general', { 'platform.nope': 'x' }, {}, { version: new Date().toISOString() })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.message).toBe('Unknown setting: platform.nope')
  })

  it('rejects a key that belongs to another group', async () => {
    const res = await save('legal', { 'contact.support_email': 'a@example.com' })
    expect(res.status).toBe(422)
    expect(res.body.error.details[0].path).toBe('contact.support_email')
  })

  it.each([
    ['email', 'contact', 'contact.support_email', 'not-an-email', 'Enter a valid email address.'],
    ['phone', 'contact', 'contact.support_phone', '98765', 'Enter a phone number like +919876543210.'],
    ['url (https only)', 'legal', 'legal.terms_url', 'http://guruconnect.in/terms', 'Enter a link starting with https://'],
    ['url (garbage)', 'legal', 'legal.terms_url', 'terms', 'Enter a link starting with https://'],
    ['string (empty)', 'general', 'platform.name', '   ', 'Enter 1–200 characters.'],
    ['string (too long)', 'general', 'platform.name', 'x'.repeat(201), 'Enter 1–200 characters.'],
    ['semver', 'app_versions', 'app.android_latest_version', '1.2', 'Enter a version like 1.2.0'],
    ['number (above range)', 'limits', 'limits.parent_max_children', 6, 'Enter a number from 1 to 5.'],
    ['number (below range)', 'limits', 'limits.review_min_chars', 9, 'Enter a number from 10 to 200.'],
    ['number (fraction)', 'limits', 'limits.parent_max_children', 2.5, 'Enter a whole number.'],
    ['number (text)', 'limits', 'limits.parent_max_children', '3', 'Enter a whole number.'],
    ['boolean', 'app_versions', 'app.maintenance_mode', 'yes', 'Choose on or off.'],
    ['json (weights)', 'limits', 'institutes.rating_weights', { infrastructure: 0.5, faculty: 0.1 }, 'Weights must add up to 1.'],
    ['json (domain)', 'limits', 'banners.allowed_domains', ['https://evil.example'], 'Enter a bare domain like guruconnect.in.'],
    ['json (empty list)', 'limits', 'banners.allowed_domains', [], 'Keep at least one domain.'],
    ['json (quiet hours)', 'limits', 'notifications.quiet_hours', { start: '25:00', end: '08:00' }, 'Use HH:MM, e.g. 21:30.'],
  ])('rejects a bad %s value (422)', async (_label, group, key, value, message) => {
    const res = await save(group, { [key]: value }, { reason: 'Testing validation' })
    expect(res.status, JSON.stringify(res.body)).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details[0]).toEqual({ path: key, message })
  })

  it('accepts a valid json value', async () => {
    const res = await save('limits', { 'banners.allowed_domains': ['guruconnect.in', 'blog.guruconnect.in'] })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await valueOf('banners.allowed_domains')).toEqual(['guruconnect.in', 'blog.guruconnect.in'])
  })

  it('saves all or nothing', async () => {
    const before = await valueOf('contact.support_email')
    const res = await save('contact', { 'contact.support_email': 'fresh@example.com', 'contact.support_phone': 'bad' })
    expect(res.status).toBe(422)
    expect(await valueOf('contact.support_email')).toBe(before)
  })

  it('reports every bad field, not just the first', async () => {
    const res = await save('contact', { 'contact.support_email': 'bad', 'contact.support_phone': 'bad' })
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['contact.support_email', 'contact.support_phone'])
  })

  it('refuses a minimum version above the latest (422)', async () => {
    const reason = 'Raise the minimum'
    expect((await save('app_versions', { 'app.android_latest_version': '2.0.0', 'app.android_min_version': '1.0.0' }, { reason })).status).toBe(200)
    const both = await save('app_versions', { 'app.android_min_version': '3.0.0' }, { reason })
    expect(both.status).toBe(422)
    expect(both.body.error.message).toBe("Minimum version can't be higher than the latest version.")
    // Lowering the latest below the stored minimum is refused too, and so is the same check for iOS.
    expect((await save('app_versions', { 'app.android_min_version': '1.5.0' }, { reason })).status).toBe(200)
    expect((await save('app_versions', { 'app.android_latest_version': '1.2.0' }, { reason })).status).toBe(422)
    const ios = await save('app_versions', { 'app.ios_min_version': '9.0.0', 'app.ios_latest_version': '1.0.0' }, { reason })
    expect(ios.status).toBe(422)
    expect(await valueOf('app.android_min_version')).toBe('1.5.0')
    // Equal versions are fine.
    expect((await save('app_versions', { 'app.android_min_version': '2.0.0' }, { reason })).status).toBe(200)
  })

  it('refuses to change a setting managed by deployments (409)', async () => {
    const res = await save('general', { 'seo.redirects': { '/old': '/new' } })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_STATE', message: 'This setting is managed by deployments.' })
    const settings = await list()
    expect(settings.find((s) => s.key === 'seo.redirects')!.isEditable).toBe(false)
  })

  it('does not trip the read-only rule when the value is unchanged', async () => {
    const current = await valueOf('seo.redirects')
    expect((await save('general', { 'seo.redirects': current })).status).toBe(200)
  })

  it('refuses a stale form (409) and names the current version', async () => {
    const stale = await versionOf(['platform.name'])
    expect((await save('general', { 'platform.name': 'Version A' })).status).toBe(200)
    const res = await save('general', { 'platform.name': 'Version B' }, {}, { version: stale })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'VERSION_CONFLICT', message: 'Settings changed since you opened this page. Reload.' })
    expect(await valueOf('platform.name')).toBe('Version A')
  })

  it('needs an If-Match header', async () => {
    const res = await request(app).patch(`${API}/settings`).set(authed(superAdmin.token)).send({ group: 'general', values: { 'platform.name': 'No header' } })
    expect(res.status).toBe(422)
  })

  it('needs a reason for app.* keys (422) and accepts one', async () => {
    const res = await save('app_versions', { 'app.android_latest_version': '2.1.0' })
    expect(res.status).toBe(422)
    expect(res.body.error.details[0]).toEqual({ path: 'reason', message: 'Add a reason for this change.' })
    const short = await save('app_versions', { 'app.android_latest_version': '2.1.0' }, { reason: 'no' })
    expect(short.status).toBe(422)
    const ok = await save('app_versions', { 'app.android_latest_version': '2.1.0' }, { reason: 'Security fix in 2.1.0' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect((await auditFor('app.android_latest_version'))[0]!.reason).toBe('Security fix in 2.1.0')
  })

  it('does not ask for a reason for ordinary keys', async () => {
    expect((await save('contact', { 'contact.support_email': 'noreason@example.com' })).status).toBe(200)
  })

  it('rejects malformed bodies', async () => {
    const send = (body: object) => request(app).patch(`${API}/settings`).set(authed(superAdmin.token)).set('If-Match', new Date().toISOString()).send(body)
    expect((await send({ group: 'general', values: {} })).status).toBe(422)
    expect((await send({ values: { 'platform.name': 'x' } })).status).toBe(422)
    expect((await send({ group: 'general', values: { 'platform.name': 'x' }, extra: 1 })).status).toBe(422)
    const bad = await request(app).patch(`${API}/settings`).set(authed(superAdmin.token)).set('If-Match', 'yesterday').send({ group: 'general', values: { 'platform.name': 'x' } })
    expect(bad.status).toBe(422)
  })
})

describe('maintenance mode', () => {
  const toggle = (on: boolean, extra: Record<string, unknown> = {}) => save('app_versions', { 'app.maintenance_mode': on }, extra)

  it('needs a reason and a confirmation to switch on', async () => {
    const noReason = await toggle(true, { confirmMaintenance: true })
    expect(noReason.status).toBe(422)
    expect(noReason.body.error.details[0].path).toBe('reason')
    const noConfirm = await toggle(true, { reason: 'Database migration' })
    expect(noConfirm.status).toBe(422)
    expect(noConfirm.body.error.details[0].path).toBe('confirmMaintenance')
    expect(await valueOf('app.maintenance_mode')).toBe(false)
  })

  it('switches the mobile API to 503 while keeping bootstrap, settings and sign-in open, then back again', async () => {
    expect((await request(app).get('/api/v1/app/masters')).status).toBe(200)

    const on = await toggle(true, { reason: 'Database migration', confirmMaintenance: true })
    expect(on.status, JSON.stringify(on.body)).toBe(200)
    expect((await auditFor('app.maintenance_mode'))[0]).toMatchObject({ action: 'setting.maintenance_enabled', reason: 'Database migration' })

    const blocked = await request(app).get('/api/v1/app/masters')
    expect(blocked.status).toBe(503)
    expect(blocked.body.error.code).toBe('MAINTENANCE')
    expect((await request(app).get('/api/v1/app/home/parent')).status).toBe(503)
    expect((await request(app).get('/api/v1/app/bootstrap')).status).toBe(200)
    const pub = await request(app).get('/api/v1/app/settings')
    expect(pub.status).toBe(200)
    expect(pub.body.data['app.maintenance_mode']).toBe(true)
    expect(pub.body.meta.maintenance).toBe(true)
    expect((await request(app).post('/api/v1/app/auth/otp/request').send({})).status).not.toBe(503)
    // The admin portal is never affected.
    expect((await request(app).get(`${API}/settings`).set(authed(superAdmin.token))).status).toBe(200)

    const off = await toggle(false, { reason: 'Migration finished' })
    expect(off.status).toBe(200)
    expect((await auditFor('app.maintenance_mode'))[0]!.action).toBe('setting.maintenance_disabled')
    expect((await request(app).get('/api/v1/app/masters')).status).toBe(200)
    expect((await request(app).get('/api/v1/app/settings')).body.meta.maintenance).toBe(false)
  })
})

describe('public settings for the app', () => {
  it('serves only public settings as a flat object, with an ETag and a five minute cache header', async () => {
    const res = await request(app).get('/api/v1/app/settings')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toContain('max-age=300')
    expect(res.headers.etag).toBeTruthy()
    expect(res.body.data['platform.name']).toBeTypeOf('string')
    expect(res.body.data['limits.parent_max_children']).toBeTypeOf('number')
    expect(res.body.data).not.toHaveProperty('limits.featured_slots_per_city') // is_public = false
    expect(res.body.data).not.toHaveProperty('seo.redirects')
  })

  it('answers 304 to a matching If-None-Match and a fresh body after a save purges the cache', async () => {
    const first = await request(app).get('/api/v1/app/settings')
    const etag = first.headers.etag as string
    const same = await request(app).get('/api/v1/app/settings').set('If-None-Match', etag)
    expect(same.status).toBe(304)

    expect((await save('general', { 'platform.name': 'Purged Name' })).status).toBe(200)
    const after = await request(app).get('/api/v1/app/settings').set('If-None-Match', etag)
    expect(after.status).toBe(200)
    expect(after.body.data['platform.name']).toBe('Purged Name')
    expect(after.headers.etag).not.toBe(etag)
  })

  it('needs no sign-in', async () => {
    expect((await request(app).get('/api/v1/app/settings')).status).toBe(200)
  })
})
