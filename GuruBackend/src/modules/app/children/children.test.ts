import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../app.js'
import { db, pool } from '../../../db/index.js'
import { closeRedis, getRedis } from '../../../lib/redis.js'
import { APP, bearer, createParent, deleteParent, loadMasters } from '../../../test/appHelpers.js'
import type { Masters, TestParent } from '../../../test/appHelpers.js'

const app = createApp()

let m: Masters
const parents: TestParent[] = []

async function newParent(overrides: Parameters<typeof createParent>[1] = {}) {
  const p = await createParent(m, overrides)
  parents.push(p)
  return p
}

const post = (p: TestParent, body: Record<string, unknown>, key = randomUUID()) =>
  request(app).post(`${APP}/parent/children`).set(bearer(p)).set('Idempotency-Key', key).send(body)

const aarav = () => ({ childName: 'Aarav', classId: m.classes.five, boardId: m.boards.cbse, subjectIds: [m.subjects.maths, m.subjects.english], categoryIds: [m.categories.homeTutor] })

const patch = (p: TestParent, id: string, body: Record<string, unknown>, version?: string) => {
  const req = request(app).patch(`${APP}/parent/children/${id}`).set(bearer(p))
  if (version !== undefined) req.set('If-Match', version)
  return req.send(body)
}

const list = (p: TestParent) => request(app).get(`${APP}/parent/children`).set(bearer(p))

beforeAll(async () => {
  m = await loadMasters()
})

afterAll(async () => {
  for (const p of parents) await deleteParent(p)
  await closeRedis()
  await pool.end()
})

describe('auth', () => {
  it('requires a bearer token on every children endpoint', async () => {
    const id = randomUUID()
    for (const res of [
      await request(app).get(`${APP}/parent/children`),
      await request(app).post(`${APP}/parent/children`).send({}),
      await request(app).patch(`${APP}/parent/children/${id}`).send({}),
      await request(app).delete(`${APP}/parent/children/${id}`),
      await request(app).put(`${APP}/parent/children/order`).send({}),
    ]) {
      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('AUTH_REQUIRED')
    }
  })

  it('rejects a non-parent account (FORBIDDEN)', async () => {
    const teacher = await newParent({ role: 'teacher' })
    const res = await list(teacher)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })
})

describe('GET /parent/children', () => {
  it('returns an empty list for a new parent', async () => {
    const p = await newParent()
    const res = await list(p)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
  })

  it('only ever returns the caller\'s own children', async () => {
    const a = await newParent()
    const b = await newParent()
    await post(a, aarav())
    expect((await list(b)).body.data).toEqual([])
    expect((await list(a)).body.data).toHaveLength(1)
  })
})

describe('POST /parent/children', () => {
  it('creates a child and returns the full shape plus an empty recommendationsPreview', async () => {
    const p = await newParent()
    const res = await post(p, { ...aarav(), preferredModeId: m.modes.home, schoolName: 'Delhi Public School' })

    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      childName: 'Aarav',
      classId: m.classes.five,
      class: { id: m.classes.five, name: 'Class 5' },
      boardId: m.boards.cbse,
      board: { id: m.boards.cbse, shortName: 'CBSE' },
      subjects: expect.arrayContaining(['Mathematics', 'English']),
      teacherCategories: ['Home Tutor'],
      categoryIds: [m.categories.homeTutor],
      preferredModeId: m.modes.home,
      preferredMode: { id: m.modes.home, name: 'Home tuition' },
      schoolName: 'Delhi Public School',
      sortOrder: 0,
    })
    expect(res.body.data.subjectIds.sort()).toEqual([m.subjects.maths, m.subjects.english].sort())
    expect(res.body.data.id).toEqual(expect.any(String))
    expect(res.body.data.updatedAt).toEqual(expect.any(String))
    expect(res.body.meta.recommendationsPreview).toEqual([])
  })

  it('accepts only the required fields', async () => {
    const p = await newParent()
    const res = await post(p, { childName: 'Riya', classId: m.classes.nine })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ boardId: null, board: null, subjects: [], subjectIds: [], teacherCategories: [], preferredMode: null, schoolName: null })
  })

  it('assigns sort_order = current max + 1 and lists in that order', async () => {
    const p = await newParent()
    await post(p, { childName: 'Aarav', classId: m.classes.five })
    await post(p, { childName: 'Riya', classId: m.classes.nine })
    const res = await list(p)
    expect(res.body.data.map((c: { childName: string; sortOrder: number }) => [c.childName, c.sortOrder])).toEqual([
      ['Aarav', 0],
      ['Riya', 1],
    ])
  })

  it('requires an Idempotency-Key header', async () => {
    const p = await newParent()
    const res = await request(app).post(`${APP}/parent/children`).set(bearer(p)).send(aarav())
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('replays the original response for a repeated Idempotency-Key without creating a second child', async () => {
    const p = await newParent()
    const key = randomUUID()
    const first = await post(p, aarav(), key)
    const second = await post(p, aarav(), key)

    expect(second.status).toBe(201)
    expect(second.body).toEqual(first.body)
    expect((await list(p)).body.data).toHaveLength(1)
  })

  it('returns 409 LIMIT_REACHED past the limit, with the limit details', async () => {
    const p = await newParent()
    for (const name of ['Aarav', 'Riya', 'Rohan']) expect((await post(p, { childName: name, classId: m.classes.five })).status).toBe(201)

    const res = await post(p, { childName: 'Extra', classId: m.classes.five })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('LIMIT_REACHED')
    expect(res.body.error.message).toBe('You can add up to 3 children.')
    expect(res.body.error.details).toEqual({ reason: 'max_children', limit: 3, current: 3 })
  })

  it('enforces the limit under concurrent creates', async () => {
    const p = await newParent()
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => post(p, { childName: `Kid${String.fromCharCode(65 + i)}`, classId: m.classes.five })))
    expect(results.filter((r) => r.status === 201)).toHaveLength(3)
    expect(results.filter((r) => r.status === 409)).toHaveLength(3)
    expect((await list(p)).body.data).toHaveLength(3)
  })

  it('does not count soft-deleted children toward the limit', async () => {
    const p = await newParent()
    const ids: string[] = []
    for (const name of ['Aarav', 'Riya', 'Rohan']) ids.push((await post(p, { childName: name, classId: m.classes.five })).body.data.id)
    await request(app).delete(`${APP}/parent/children/${ids[0]}`).set(bearer(p))
    expect((await post(p, { childName: 'Meera', classId: m.classes.five })).status).toBe(201)
  })

  it('rejects a subject not offered for the class, naming it (VALIDATION_FAILED)', async () => {
    const p = await newParent()
    const res = await post(p, { ...aarav(), subjectIds: [m.subjects.physics] })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details).toEqual(expect.arrayContaining([{ path: 'subjectIds', message: "Physics isn't offered for Class 5." }]))
  })

  it('accepts a subject that is offered at the class boundary', async () => {
    const p = await newParent()
    expect((await post(p, { childName: 'Ishaan', classId: m.classes.nine, subjectIds: [m.subjects.physics] })).status).toBe(201)
  })

  it('rejects more than 6 subjects and more than 4 teacher types', async () => {
    const p = await newParent()
    const tooManySubjects = await post(p, {
      childName: 'Aarav',
      classId: m.classes.eleven,
      subjectIds: [m.subjects.maths, m.subjects.english, m.subjects.physics, m.subjects.chemistry, m.subjects.biology, m.subjects.computer, m.subjects.hindi],
    })
    expect(tooManySubjects.status).toBe(422)
    expect(tooManySubjects.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'Choose up to 6 subjects.' })]))

    const tooManyCategories = await post(p, {
      childName: 'Aarav',
      classId: m.classes.five,
      categoryIds: [m.categories.homeTutor, m.categories.schoolTeacher, m.categories.coaching, m.categories.language, m.categories.coding],
    })
    expect(tooManyCategories.status).toBe(422)
    expect(tooManyCategories.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'Choose up to 4 teacher types.' })]))
  })

  it('rejects duplicate and unknown ids', async () => {
    const p = await newParent()
    expect((await post(p, { ...aarav(), subjectIds: [m.subjects.maths, m.subjects.maths] })).status).toBe(422)
    expect((await post(p, { ...aarav(), subjectIds: [randomUUID()] })).status).toBe(422)
    expect((await post(p, { ...aarav(), categoryIds: [randomUUID()] })).status).toBe(422)
    expect((await post(p, { ...aarav(), preferredModeId: randomUUID() })).status).toBe(422)
    expect((await post(p, { ...aarav(), classId: randomUUID() })).status).toBe(422)
    expect((await post(p, { ...aarav(), boardId: randomUUID() })).status).toBe(422)
  })

  it('validates the child name: first name only, letters and spaces, 1-40 chars', async () => {
    const p = await newParent()
    for (const bad of ['', '   ', 'Aarav123', 'Aarav!', 'A'.repeat(41), 'Aarav_S']) {
      const res = await post(p, { childName: bad, classId: m.classes.five })
      expect(res.status, `name "${bad}"`).toBe(422)
    }
    const ok = await post(p, { childName: '  Anna  Maria ', classId: m.classes.five })
    expect(ok.status).toBe(201)
    expect(ok.body.data.childName).toBe('Anna Maria')
    expect((await post(p, { childName: 'ஆரவ்', classId: m.classes.five })).status).toBe(201)
  })

  it('validates the school name length and blanks it to null', async () => {
    const p = await newParent()
    const long = await post(p, { childName: 'Aarav', classId: m.classes.five, schoolName: 'S'.repeat(121) })
    expect(long.status).toBe(422)
    expect(long.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'Keep the school name under 120 characters.' })]))
    const blank = await post(p, { childName: 'Riya', classId: m.classes.five, schoolName: '   ' })
    expect(blank.body.data.schoolName).toBeNull()
  })

  it("rejects another state's board but allows national boards and the parent's own state board", async () => {
    const p = await newParent()
    const wrong = await post(p, { childName: 'Aarav', classId: m.classes.five, boardId: m.boards.maharashtra })
    expect(wrong.status).toBe(422)
    expect(wrong.body.error.details).toEqual([{ path: 'boardId', message: 'Choose a board available in your state.' }])

    expect((await post(p, { childName: 'Riya', classId: m.classes.five, boardId: m.boards.karnataka })).status).toBe(201)
    expect((await post(p, { childName: 'Rohan', classId: m.classes.five, boardId: m.boards.cbse })).status).toBe(201)
  })

  it('requires childName and classId', async () => {
    const p = await newParent()
    expect((await post(p, { classId: m.classes.five })).status).toBe(422)
    expect((await post(p, { childName: 'Aarav' })).status).toBe(422)
  })

  it('writes an app.child_added audit row', async () => {
    const p = await newParent()
    const res = await post(p, aarav())
    const row = await db.selectFrom('audit_logs').select(['actor_id', 'actor_type', 'new_values']).where('action', '=', 'app.child_added').where('entity_id', '=', res.body.data.id).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ actor_id: p.userId, actor_type: 'app_user', new_values: { classId: m.classes.five, subjectsCount: 2, categoriesCount: 1 } })
  })

  it('drops the cached recommendations for the new child', async () => {
    const redis = (await getRedis())!
    expect(redis, 'Redis must be running for this test').not.toBeNull()
    const p = await newParent()
    const res = await post(p, aarav())
    // Nothing stale can exist for a brand-new id, but the invalidation path must not throw and the key stays absent.
    expect(await redis.exists(`rec:${res.body.data.id}`)).toBe(0)
  })
})

describe('/me registration.nextStep', () => {
  it("is 'child_setup' until the parent has at least one child, then null", async () => {
    const p = await newParent()
    const before = await request(app).get(`${APP}/me`).set(bearer(p))
    expect(before.body.data.registration).toEqual({ complete: false, nextStep: 'child_setup' })

    const created = await post(p, aarav())
    const after = await request(app).get(`${APP}/me`).set(bearer(p))
    expect(after.body.data.registration).toEqual({ complete: true, nextStep: null })

    await request(app).delete(`${APP}/parent/children/${created.body.data.id}`).set(bearer(p))
    const removed = await request(app).get(`${APP}/me`).set(bearer(p))
    expect(removed.body.data.registration.nextStep).toBe('child_setup')
  })
})

describe('PATCH /parent/children/:id', () => {
  it('requires If-Match', async () => {
    const p = await newParent()
    const child = (await post(p, aarav())).body.data
    const res = await patch(p, child.id, { childName: 'Aaru' })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect((await patch(p, child.id, { childName: 'Aaru' }, 'not-a-date')).status).toBe(422)
  })

  it('applies a name/school-only edit without a recommendation preview and moves updatedAt', async () => {
    const p = await newParent()
    const child = (await post(p, aarav())).body.data
    const res = await patch(p, child.id, { childName: 'Aaru', schoolName: 'New School' }, child.updatedAt)

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ childName: 'Aaru', schoolName: 'New School' })
    expect(res.body.data.updatedAt).not.toBe(child.updatedAt)
    expect(res.body.meta.droppedSubjects).toEqual([])
    expect(res.body.meta.recommendationsPreview).toBeUndefined()
    expect(res.body.data.subjects).toEqual(expect.arrayContaining(['Mathematics', 'English']))
  })

  it('accepts If-Match wrapped in quotes', async () => {
    const p = await newParent()
    const child = (await post(p, aarav())).body.data
    expect((await patch(p, child.id, { childName: 'Aaru' }, `"${child.updatedAt}"`)).status).toBe(200)
  })

  it('returns 409 VERSION_CONFLICT for a stale If-Match, and applies nothing', async () => {
    const p = await newParent()
    const child = (await post(p, aarav())).body.data
    const first = await patch(p, child.id, { childName: 'Aaru' }, child.updatedAt)
    expect(first.status).toBe(200)

    const stale = await patch(p, child.id, { childName: 'Zed' }, child.updatedAt)
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('VERSION_CONFLICT')
    expect(stale.body.error.message).toBe('Updated on another device. Review and save again.')
    expect((await list(p)).body.data[0].childName).toBe('Aaru')
  })

  it('lets exactly one of two concurrent edits with the same version win', async () => {
    const p = await newParent()
    const child = (await post(p, aarav())).body.data
    const [a, b] = await Promise.all([patch(p, child.id, { childName: 'Aaa' }, child.updatedAt), patch(p, child.id, { childName: 'Bbb' }, child.updatedAt)])
    expect([a.status, b.status].sort()).toEqual([200, 409])
  })

  it('reports a stale version before field errors', async () => {
    const p = await newParent()
    const child = (await post(p, aarav())).body.data
    await patch(p, child.id, { childName: 'Aaru' }, child.updatedAt)
    const res = await patch(p, child.id, { subjectIds: [m.subjects.physics] }, child.updatedAt)
    expect(res.status).toBe(409)
  })

  it('silently drops subjects the new class does not offer and reports them in meta.droppedSubjects', async () => {
    const p = await newParent()
    const child = (await post(p, { childName: 'Ishaan', classId: m.classes.nine, subjectIds: [m.subjects.maths, m.subjects.physics] })).body.data
    const res = await patch(p, child.id, { classId: m.classes.five }, child.updatedAt)

    expect(res.status).toBe(200)
    expect(res.body.data.class).toEqual({ id: m.classes.five, name: 'Class 5' })
    expect(res.body.data.subjects).toEqual(['Mathematics'])
    expect(res.body.data.subjectIds).toEqual([m.subjects.maths])
    expect(res.body.meta.droppedSubjects).toEqual(['Physics'])
    expect(res.body.meta.recommendationsPreview).toEqual([])

    const audit = await db.selectFrom('audit_logs').select('new_values').where('action', '=', 'app.child_updated').where('entity_id', '=', child.id).executeTakeFirstOrThrow()
    expect(audit.new_values).toMatchObject({ droppedSubjects: ['Physics'] })
  })

  it('keeps subjects when the class change still offers them', async () => {
    const p = await newParent()
    const child = (await post(p, { childName: 'Ishaan', classId: m.classes.nine, subjectIds: [m.subjects.maths, m.subjects.physics] })).body.data
    const res = await patch(p, child.id, { classId: m.classes.eleven }, child.updatedAt)
    expect(res.body.meta.droppedSubjects).toEqual([])
    expect(res.body.data.subjects).toHaveLength(2)
  })

  it('validates an explicit subject list strictly against the (new) class', async () => {
    const p = await newParent()
    const child = (await post(p, aarav())).body.data
    const bad = await patch(p, child.id, { subjectIds: [m.subjects.physics] }, child.updatedAt)
    expect(bad.status).toBe(422)
    expect(bad.body.error.details).toEqual([{ path: 'subjectIds', message: "Physics isn't offered for Class 5." }])

    const ok = await patch(p, child.id, { classId: m.classes.nine, subjectIds: [m.subjects.physics] }, child.updatedAt)
    expect(ok.status).toBe(200)
    expect(ok.body.data.subjects).toEqual(['Physics'])
    expect(ok.body.meta.droppedSubjects).toEqual([])
  })

  it('replaces the subject and category join rows and returns a preview for a qualifying edit', async () => {
    const p = await newParent()
    const child = (await post(p, aarav())).body.data
    const res = await patch(p, child.id, { subjectIds: [m.subjects.hindi], categoryIds: [m.categories.schoolTeacher, m.categories.language], preferredModeId: m.modes.online }, child.updatedAt)

    expect(res.status).toBe(200)
    expect(res.body.data.subjects).toEqual(['Hindi'])
    expect(res.body.data.teacherCategories.sort()).toEqual(['Language Trainer', 'School Teacher'])
    expect(res.body.data.preferredMode).toEqual({ id: m.modes.online, name: 'Online' })
    expect(res.body.meta.recommendationsPreview).toEqual([])
    const rows = await db.selectFrom('parent_child_subjects').select('subject_id').where('child_id', '=', child.id).execute()
    expect(rows.map((r) => r.subject_id)).toEqual([m.subjects.hindi])
  })

  it('can clear the optional fields with null and remove all subjects', async () => {
    const p = await newParent()
    const child = (await post(p, { ...aarav(), preferredModeId: m.modes.home, schoolName: 'DPS' })).body.data
    const res = await patch(p, child.id, { boardId: null, preferredModeId: null, schoolName: null, subjectIds: [], categoryIds: [] }, child.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ boardId: null, board: null, preferredMode: null, schoolName: null, subjects: [], teacherCategories: [] })
  })

  it("rejects another state's board on edit", async () => {
    const p = await newParent()
    const child = (await post(p, aarav())).body.data
    const res = await patch(p, child.id, { boardId: m.boards.maharashtra }, child.updatedAt)
    expect(res.status).toBe(422)
  })

  it('rejects an empty body', async () => {
    const p = await newParent()
    const child = (await post(p, aarav())).body.data
    expect((await patch(p, child.id, {}, child.updatedAt)).status).toBe(422)
  })

  it("returns 403 FORBIDDEN for someone else's child and 404 for an unknown id", async () => {
    const owner = await newParent()
    const other = await newParent()
    const child = (await post(owner, aarav())).body.data

    const foreign = await patch(other, child.id, { childName: 'Hax' }, child.updatedAt)
    expect(foreign.status).toBe(403)
    expect(foreign.body.error.code).toBe('FORBIDDEN')
    expect((await list(owner)).body.data[0].childName).toBe('Aarav')

    expect((await patch(owner, randomUUID(), { childName: 'Aaru' }, child.updatedAt)).status).toBe(404)
    expect((await patch(owner, 'not-a-uuid', { childName: 'Aaru' }, child.updatedAt)).status).toBe(422)
  })

  it('invalidates the cached recommendations only for qualifying edits', async () => {
    const redis = (await getRedis())!
    expect(redis, 'Redis must be running for this test').not.toBeNull()
    const p = await newParent()
    const child = (await post(p, aarav())).body.data
    const keys = [`rec:${child.id}`, `home:rec:teacher:${child.id}`, `home:rec:institute:${child.id}`]
    for (const key of keys) await redis.set(key, '[]', 'EX', 60)

    const nameOnly = await patch(p, child.id, { childName: 'Aaru' }, child.updatedAt)
    for (const key of keys) expect(await redis.exists(key), `${key} after a name-only edit`).toBe(1)

    await patch(p, child.id, { subjectIds: [m.subjects.maths] }, nameOnly.body.data.updatedAt)
    for (const key of keys) expect(await redis.exists(key), `${key} after a subject change`).toBe(0)
  })
})

describe('DELETE /parent/children/:id', () => {
  it('soft-deletes the child, keeps the join rows and drops it from the list', async () => {
    const p = await newParent()
    const child = (await post(p, aarav())).body.data
    const res = await request(app).delete(`${APP}/parent/children/${child.id}`).set(bearer(p))
    expect(res.status).toBe(200)

    expect((await list(p)).body.data).toEqual([])
    const row = await db.selectFrom('parent_children').select('deleted_at').where('id', '=', child.id).executeTakeFirstOrThrow()
    expect(row.deleted_at).not.toBeNull()
    const joins = await db.selectFrom('parent_child_subjects').select('subject_id').where('child_id', '=', child.id).execute()
    expect(joins).toHaveLength(2)
    const audit = await db.selectFrom('audit_logs').select('id').where('action', '=', 'app.child_removed').where('entity_id', '=', child.id).executeTakeFirst()
    expect(audit).toBeDefined()
  })

  it('returns 404 when deleted twice or unknown, and 403 for someone else\'s child', async () => {
    const owner = await newParent()
    const other = await newParent()
    const child = (await post(owner, aarav())).body.data

    const foreign = await request(app).delete(`${APP}/parent/children/${child.id}`).set(bearer(other))
    expect(foreign.status).toBe(403)
    expect((await list(owner)).body.data).toHaveLength(1)

    expect((await request(app).delete(`${APP}/parent/children/${child.id}`).set(bearer(owner))).status).toBe(200)
    expect((await request(app).delete(`${APP}/parent/children/${child.id}`).set(bearer(owner))).status).toBe(404)
    expect((await request(app).delete(`${APP}/parent/children/${randomUUID()}`).set(bearer(owner))).status).toBe(404)
  })

  it('cannot edit a deleted child', async () => {
    const p = await newParent()
    const child = (await post(p, aarav())).body.data
    await request(app).delete(`${APP}/parent/children/${child.id}`).set(bearer(p))
    expect((await patch(p, child.id, { childName: 'Aaru' }, child.updatedAt)).status).toBe(404)
  })

  it('drops the cached recommendations', async () => {
    const redis = (await getRedis())!
    const p = await newParent()
    const child = (await post(p, aarav())).body.data
    await redis.set(`rec:${child.id}`, '[]', 'EX', 60)
    await request(app).delete(`${APP}/parent/children/${child.id}`).set(bearer(p))
    expect(await redis.exists(`rec:${child.id}`)).toBe(0)
  })
})

describe('PUT /parent/children/order', () => {
  async function three(p: TestParent) {
    const ids: string[] = []
    for (const name of ['Aarav', 'Riya', 'Rohan']) ids.push((await post(p, { childName: name, classId: m.classes.five })).body.data.id)
    return ids as [string, string, string]
  }

  it('sets sort_order to each id\'s index in orderedIds', async () => {
    const p = await newParent()
    const [aarav, riya, rohan] = await three(p)
    const res = await request(app).put(`${APP}/parent/children/order`).set(bearer(p)).send({ orderedIds: [rohan, aarav, riya] })
    expect(res.status).toBe(200)

    const after = (await list(p)).body.data
    expect(after.map((c: { id: string; sortOrder: number }) => [c.id, c.sortOrder])).toEqual([
      [rohan, 0],
      [aarav, 1],
      [riya, 2],
    ])
  })

  it('keeps children that are not listed after the listed ones, in their existing order', async () => {
    const p = await newParent()
    const [aarav, riya, rohan] = await three(p)
    await request(app).put(`${APP}/parent/children/order`).set(bearer(p)).send({ orderedIds: [rohan] })
    expect((await list(p)).body.data.map((c: { id: string }) => c.id)).toEqual([rohan, aarav, riya])
  })

  it("rejects an id that isn't the caller's live child (FORBIDDEN) and duplicate ids (VALIDATION_FAILED)", async () => {
    const owner = await newParent()
    const other = await newParent()
    const [aarav] = await three(owner)
    const foreign = await request(app).put(`${APP}/parent/children/order`).set(bearer(other)).send({ orderedIds: [aarav] })
    expect(foreign.status).toBe(403)

    const unknown = await request(app).put(`${APP}/parent/children/order`).set(bearer(owner)).send({ orderedIds: [aarav, randomUUID()] })
    expect(unknown.status).toBe(403)

    const dup = await request(app).put(`${APP}/parent/children/order`).set(bearer(owner)).send({ orderedIds: [aarav, aarav] })
    expect(dup.status).toBe(422)
    expect((await request(app).put(`${APP}/parent/children/order`).set(bearer(owner)).send({ orderedIds: [] })).status).toBe(422)
  })
})
