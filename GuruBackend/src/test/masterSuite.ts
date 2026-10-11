import { randomUUID } from 'node:crypto'
import request from 'supertest'
import type { Express } from 'express'
import { describe, expect, it } from 'vitest'
import { db } from '../db/index.js'
import { API, authed } from './helpers.js'

type Actor = { token: string }
export type Body = Record<string, unknown>
export type MasterView = { id: string; name: string; isActive: boolean; updatedAt: string; deletedAt?: string | null }
export type SuiteActors = { superAdmin: Actor & { id: string }; ops: Actor; reader: Actor; outsider: Actor }

export type MasterSuiteConfig<V extends MasterView> = {
  app: Express
  /** Resolved lazily: the admins are created in the module's own beforeAll. */
  actors: () => SuiteActors
  path: string
  /** Lower-case singular / plural, as they appear in the API messages ("teaching mode", "teaching modes"). */
  noun: string
  plural: string
  notFoundMessage: string
  readKey: string
  manageKey: string
  /** audit_logs.entity_type (the table) and the action prefix ("board" gives board.created). */
  entityType: string
  auditPrefix: string
  auditModule: string
  /** Creates a fixture through the API. A `name` override must give the row that name. */
  make: (overrides?: Body, as?: Actor) => Promise<V>
  /** A field that can be PATCHed twice (any two different values that differ from what `make` produces). */
  edit: { field: string; first: unknown; second: unknown }
  /** The field whose uniqueness `make` enforces, to rename one row onto another ("name" unless the module says otherwise). */
  uniqueField?: string
  /** POST body that re-creates `existing`'s unique fields exactly (after it was deleted, or to collide with it). */
  recreate: (existing: V) => Body
  /** Expected CONFLICT_DUPLICATE message and field when `recreate` collides with a live row. */
  duplicate: { message: string; field: string }
  /** Extra list query strings that must answer 422. */
  badQueries?: string[]
}

const uniqueTag = () => `zx${randomUUID().replace(/-/g, '').slice(0, 10)}`
export { uniqueTag }

/**
 * The behaviour every master-data module shares (conventions sections 3, 4, 8; the module spec's FR-x.1 to FR-x.6 and
 * Error Scenarios table). A module test builds its fixtures, calls this once, and then tests only what is special to it.
 */
export function describeMasterCommon<V extends MasterView>(c: MasterSuiteConfig<V>) {
  const a = () => c.actors()
  const get = (as: Actor, path: string) => request(c.app).get(`${API}${c.path}${path}`).set(authed(as.token))
  const send = (method: 'post' | 'patch' | 'delete', as: Actor, path: string, body?: Body, headers: Record<string, string> = {}) =>
    request(c.app)[method](`${API}${c.path}${path}`).set(authed(as.token)).set(headers).send(body)
  const patch = (id: string, body: Body, version: string, as: Actor = a().superAdmin) => send('patch', as, `/${id}`, body, { 'If-Match': version })
  const unique = c.uniqueField ?? 'name'
  const auditActions = async (id: string) =>
    (await db.selectFrom('audit_logs').select('action').where('entity_type', '=', c.entityType).where('entity_id', '=', id).orderBy('created_at').orderBy('id').execute()).map((r) => r.action)
  const ids = (res: { body: { data: MasterView[] } }) => res.body.data.map((r) => r.id)

  describe(`common: permissions (${c.plural})`, () => {
    it('rejects anonymous callers', async () => {
      expect((await request(c.app).get(`${API}${c.path}`)).status).toBe(401)
    })

    it('lets a read-only admin list but tells them they cannot change anything', async () => {
      const row = await c.make()
      expect((await get(a().reader, '')).status).toBe(200)
      expect((await get(a().reader, `/${row.id}`)).status).toBe(200)
      for (const res of [
        await send('post', a().reader, '', c.recreate(row)),
        await patch(row.id, { [c.edit.field]: c.edit.first }, row.updatedAt, a().reader),
        await send('post', a().reader, `/${row.id}/deactivate`, {}),
        await send('delete', a().reader, `/${row.id}`),
      ]) {
        expect(res.status).toBe(403)
        expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: `You can view ${c.plural} but not change them.`, details: { required: [c.manageKey] } })
      }
    })

    it('blocks admins with no permission from reading', async () => {
      const res = await get(a().outsider, '')
      expect(res.status).toBe(403)
      expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', details: { required: [c.readKey] } })
    })

    it('lets an operations admin manage them', async () => {
      const row = await c.make({}, a().ops)
      expect((await patch(row.id, { [c.edit.field]: c.edit.first }, row.updatedAt, a().ops)).status).toBe(200)
    })
  })

  describe(`common: read (${c.plural})`, () => {
    it('returns 404 NOT_FOUND for unknown and malformed ids', async () => {
      for (const id of [randomUUID(), 'not-a-uuid']) {
        const res = await get(a().superAdmin, `/${id}`)
        expect(res.status).toBe(404)
        expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: c.notFoundMessage })
      }
    })

    it('pages with meta', async () => {
      const tag = uniqueTag()
      for (const n of ['A', 'B', 'C']) await c.make({ name: `${tag} ${n}` })
      const q = encodeURIComponent(tag)
      expect((await get(a().reader, `?q=${q}&pageSize=2`)).body.meta).toEqual({ page: 1, pageSize: 2, total: 3, totalPages: 2 })
      expect((await get(a().reader, `?q=${q}&pageSize=2&page=2`)).body.data).toHaveLength(1)
    })

    it('sorts by name in either direction', async () => {
      const tag = uniqueTag()
      const first = await c.make({ name: `${tag} A` })
      const second = await c.make({ name: `${tag} B` })
      const q = encodeURIComponent(tag)
      expect(ids(await get(a().reader, `?q=${q}&sort=name:asc`))).toEqual([first.id, second.id])
      expect(ids(await get(a().reader, `?q=${q}&sort=name:desc`))).toEqual([second.id, first.id])
    })

    it('searches by the start of the name, case-insensitively', async () => {
      const tag = uniqueTag()
      const row = await c.make({ name: `${tag} Studio` })
      for (const term of [tag, tag.toUpperCase()]) expect(ids(await get(a().reader, `?q=${encodeURIComponent(term)}`)), term).toContain(row.id)
    })

    it('treats % and _ in the search term literally', async () => {
      const res = await get(a().reader, '?q=%25')
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual([])
    })

    it('filters by active state', async () => {
      const tag = uniqueTag()
      const on = await c.make({ name: `${tag} On`, isActive: true })
      const off = await c.make({ name: `${tag} Off`, isActive: false })
      const q = encodeURIComponent(tag)
      expect(ids(await get(a().reader, `?q=${q}`)).sort()).toEqual([on.id, off.id].sort())
      expect(ids(await get(a().reader, `?q=${q}&active=true`))).toEqual([on.id])
      expect(ids(await get(a().reader, `?q=${q}&active=false`))).toEqual([off.id])
    })

    it.each(['pageSize=101', 'pageSize=0', 'page=0', 'sort=bogus:asc', 'active=maybe', 'fields=name,secret', ...(c.badQueries ?? [])])('rejects ?%s with 422', async (qs) => {
      const res = await get(a().reader, `?${qs}`)
      expect(res.status).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    })

    it('hides deleted rows, and only a super admin may ask for them', async () => {
      const row = await c.make()
      expect((await send('delete', a().superAdmin, `/${row.id}`)).status).toBe(204)
      const q = encodeURIComponent(row.name)
      expect(ids(await get(a().reader, `?q=${q}`))).not.toContain(row.id)
      expect((await get(a().reader, `/${row.id}`)).status).toBe(404)
      expect((await get(a().ops, `?q=${q}&includeDeleted=true`)).status).toBe(403)
      expect((await get(a().ops, `/${row.id}?includeDeleted=true`)).status).toBe(403)
      const withDeleted = await get(a().superAdmin, `?q=${q}&includeDeleted=true`)
      expect(withDeleted.body.data.find((r: MasterView) => r.id === row.id).deletedAt).not.toBeNull()
      expect((await get(a().superAdmin, `/${row.id}?includeDeleted=true`)).status).toBe(200)
    })
  })

  describe(`common: create (${c.plural})`, () => {
    it('returns 409 CONFLICT_DUPLICATE when a live row has the same unique fields, and writes nothing', async () => {
      const row = await c.make()
      const res = await send('post', a().superAdmin, '', c.recreate(row))
      expect(res.status).toBe(409)
      expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', message: c.duplicate.message, details: { field: c.duplicate.field } })
    })

    it('rejects an empty body and an unknown field with 422', async () => {
      expect((await send('post', a().superAdmin, '', {})).status).toBe(422)
      const row = await c.make()
      expect((await send('post', a().superAdmin, '', { ...c.recreate(row), notAField: 1 })).status).toBe(422)
    })
  })

  describe(`common: dropdown mode (${c.plural})`, () => {
    it('returns only the requested fields, unpaginated, active rows only', async () => {
      const live = await c.make({ isActive: true })
      const inactive = await c.make({ isActive: false })
      const res = await get(a().reader, '?active=true&fields=id,name')
      expect(res.status).toBe(200)
      expect(res.body.meta).toBeUndefined()
      expect(res.body.data.find((r: MasterView) => r.id === live.id)).toEqual({ id: live.id, name: live.name })
      expect(res.body.data.some((r: MasterView) => r.id === inactive.id)).toBe(false)
    })

    it('purges the cached list on every write in the module', async () => {
      const url = '?active=true&fields=id,name'
      const before = await get(a().reader, url) // warms the cache
      const created = await c.make()
      const afterCreate = await get(a().reader, url)
      expect(afterCreate.body.data.some((r: MasterView) => r.id === created.id)).toBe(true)
      expect(afterCreate.body.data.length).toBe(before.body.data.length + 1)

      await send('post', a().superAdmin, `/${created.id}/deactivate`, {})
      expect((await get(a().reader, url)).body.data.some((r: MasterView) => r.id === created.id)).toBe(false)
      await send('post', a().superAdmin, `/${created.id}/activate`, {})
      expect((await get(a().reader, url)).body.data.some((r: MasterView) => r.id === created.id)).toBe(true)

      const current = (await get(a().reader, `/${created.id}`)).body.data
      await patch(created.id, { name: `${created.name} Renamed` }, current.updatedAt)
      expect((await get(a().reader, url)).body.data.find((r: MasterView) => r.id === created.id).name).toBe(`${created.name} Renamed`)

      await send('delete', a().superAdmin, `/${created.id}`)
      expect((await get(a().reader, url)).body.data.some((r: MasterView) => r.id === created.id)).toBe(false)
    })
  })

  describe(`common: update (${c.plural})`, () => {
    it('changes the sent field, returns the new version and audits the diff', async () => {
      const row = await c.make()
      const before = (row as unknown as Body)[c.edit.field]
      const res = await patch(row.id, { [c.edit.field]: c.edit.first }, row.updatedAt)
      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ id: row.id, name: row.name, [c.edit.field]: c.edit.first })
      expect(res.body.data.updatedAt).not.toBe(row.updatedAt)
      const log = await db.selectFrom('audit_logs').select(['old_values', 'new_values', 'actor_id', 'module']).where('entity_id', '=', row.id).where('action', '=', `${c.auditPrefix}.updated`).executeTakeFirstOrThrow()
      expect(log.old_values).toEqual({ [c.edit.field]: before })
      expect(log.new_values).toEqual({ [c.edit.field]: c.edit.first })
      expect(log.module).toBe(c.auditModule)
    })

    it('treats an unchanged value as a no-op: same version, no audit row', async () => {
      const row = await c.make()
      const res = await patch(row.id, { [c.edit.field]: (row as unknown as Body)[c.edit.field] }, row.updatedAt)
      expect(res.status).toBe(200)
      expect(res.body.data.updatedAt).toBe(row.updatedAt)
      expect(await auditActions(row.id)).toEqual([`${c.auditPrefix}.created`])
    })

    it('returns 409 VERSION_CONFLICT with the current row when the edit is stale', async () => {
      const row = await c.make()
      expect((await patch(row.id, { [c.edit.field]: c.edit.first }, row.updatedAt)).status).toBe(200)
      const stale = await patch(row.id, { [c.edit.field]: c.edit.second }, row.updatedAt)
      expect(stale.status).toBe(409)
      expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', message: `Someone else changed this ${c.noun}. Reload.`, details: { current: { id: row.id, [c.edit.field]: c.edit.first } } })
    })

    it('requires an If-Match header', async () => {
      const row = await c.make()
      const res = await send('patch', a().superAdmin, `/${row.id}`, { [c.edit.field]: c.edit.first })
      expect(res.status).toBe(422)
      expect(res.body.error.code).toBe('VALIDATION_FAILED')
    })

    it('rejects an empty body and an unknown field', async () => {
      const row = await c.make()
      expect((await patch(row.id, {}, row.updatedAt)).status).toBe(422)
      expect((await patch(row.id, { notAField: 1 }, row.updatedAt)).status).toBe(422)
    })

    it('returns 409 CONFLICT_DUPLICATE when renaming onto another row', async () => {
      const first = await c.make()
      const second = await c.make()
      const target = (first as unknown as Record<string, string>)[unique]!
      const res = await patch(second.id, { [unique]: target.toLowerCase() }, second.updatedAt)
      expect(res.status).toBe(409)
      expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', details: { field: unique } })
    })

    it('returns 404 for an unknown or deleted row', async () => {
      const row = await c.make()
      await send('delete', a().superAdmin, `/${row.id}`)
      const body = { [c.edit.field]: c.edit.first }
      expect((await patch(row.id, body, row.updatedAt)).status).toBe(404)
      expect((await patch(randomUUID(), body, row.updatedAt)).status).toBe(404)
      expect((await patch('nope', body, row.updatedAt)).status).toBe(404)
    })

    it('lets exactly one of two concurrent edits with the same version win', async () => {
      const row = await c.make()
      const [x, y] = await Promise.all([patch(row.id, { [c.edit.field]: c.edit.first }, row.updatedAt), patch(row.id, { [c.edit.field]: c.edit.second }, row.updatedAt)])
      expect([x.status, y.status].sort()).toEqual([200, 409])
    })
  })

  describe(`common: activate / deactivate (${c.plural})`, () => {
    it('toggles the flag, records the reason and keeps the row', async () => {
      const row = await c.make({ isActive: true })
      const off = await send('post', a().superAdmin, `/${row.id}/deactivate`, { reason: 'Pausing for now' })
      expect(off.status).toBe(200)
      expect(off.body.data.isActive).toBe(false)
      expect((await send('post', a().superAdmin, `/${row.id}/activate`)).body.data.isActive).toBe(true)
      expect(await auditActions(row.id)).toEqual([`${c.auditPrefix}.created`, `${c.auditPrefix}.deactivated`, `${c.auditPrefix}.activated`])
      const log = await db.selectFrom('audit_logs').select('reason').where('entity_id', '=', row.id).where('action', '=', `${c.auditPrefix}.deactivated`).executeTakeFirstOrThrow()
      expect(log.reason).toBe('Pausing for now')
    })

    it('is idempotent: repeating the action changes nothing and logs nothing', async () => {
      const row = await c.make({ isActive: true })
      const again = await send('post', a().superAdmin, `/${row.id}/activate`, {})
      expect(again.status).toBe(200)
      expect(again.body.data.updatedAt).toBe(row.updatedAt)
      expect(await auditActions(row.id)).toEqual([`${c.auditPrefix}.created`])
    })

    it('returns 404 for an unknown row and 422 for an over-long reason', async () => {
      expect((await send('post', a().superAdmin, `/${randomUUID()}/activate`, {})).status).toBe(404)
      const row = await c.make()
      expect((await send('post', a().superAdmin, `/${row.id}/deactivate`, { reason: 'x'.repeat(501) })).status).toBe(422)
    })
  })

  describe(`common: delete and restore (${c.plural})`, () => {
    it('soft-deletes an unused row, audits it and frees its unique fields', async () => {
      const row = await c.make()
      expect((await send('delete', a().superAdmin, `/${row.id}`)).status).toBe(204)
      const stored = await db.selectFrom(c.entityType as 'countries').select(['deleted_at', 'deleted_by']).where('id', '=', row.id).executeTakeFirstOrThrow()
      expect(stored.deleted_at).not.toBeNull()
      expect(stored.deleted_by).toBe(a().superAdmin.id)
      expect(await auditActions(row.id)).toEqual([`${c.auditPrefix}.created`, `${c.auditPrefix}.deleted`])
      expect((await send('post', a().superAdmin, '', c.recreate(row))).status).toBe(201)
      expect((await send('delete', a().superAdmin, `/${row.id}`)).status).toBe(404)
    })

    it('returns 404 for unknown and malformed ids', async () => {
      expect((await send('delete', a().superAdmin, `/${randomUUID()}`)).status).toBe(404)
      expect((await send('delete', a().superAdmin, '/nope')).status).toBe(404)
    })

    it('lets a super admin undelete a row', async () => {
      const row = await c.make()
      await send('delete', a().superAdmin, `/${row.id}`)
      const res = await send('post', a().superAdmin, `/${row.id}/restore`)
      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ id: row.id, deletedAt: null, name: row.name })
      expect(await auditActions(row.id)).toEqual([`${c.auditPrefix}.created`, `${c.auditPrefix}.deleted`, `${c.auditPrefix}.restored`])
    })

    it('refuses restore to an admin who is not a super admin, even with the manage permission', async () => {
      const row = await c.make()
      await send('delete', a().superAdmin, `/${row.id}`)
      const res = await send('post', a().ops, `/${row.id}/restore`)
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('FORBIDDEN')
      expect((await get(a().superAdmin, `/${row.id}`)).status).toBe(404)
    })

    it('returns 409 CONFLICT_DUPLICATE when the unique fields were taken meanwhile', async () => {
      const row = await c.make()
      await send('delete', a().superAdmin, `/${row.id}`)
      await send('post', a().superAdmin, '', c.recreate(row))
      const res = await send('post', a().superAdmin, `/${row.id}/restore`)
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('CONFLICT_DUPLICATE')
    })

    it('returns 409 CONFLICT_STATE for a row that is not deleted, 404 for an unknown one', async () => {
      const row = await c.make()
      const live = await send('post', a().superAdmin, `/${row.id}/restore`)
      expect(live.status).toBe(409)
      expect(live.body.error.code).toBe('CONFLICT_STATE')
      expect((await send('post', a().superAdmin, `/${randomUUID()}/restore`)).status).toBe(404)
    })
  })
}
