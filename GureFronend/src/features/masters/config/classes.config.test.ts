import { describe, expect, it } from 'vitest'
import { classesConfig, classFormSchema } from './classes.config'
import type { ClassRow } from './classes.config'

const valid = { name: 'Class 11 (Droppers)', code: 'CLASS_11_DROP', stage: 'competitive', levelOrder: 15, isActive: true }
const row: ClassRow = {
  id: 'c1',
  name: 'Class 10',
  code: 'CLASS_10',
  stage: 'secondary',
  levelOrder: 10,
  isActive: true,
  teacherCount: 0,
  childCount: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-20T08:11:02.114Z',
  deletedAt: null,
}

const messages = (input: object) => {
  const result = classFormSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}

describe('classFormSchema', () => {
  it('accepts a valid class, including a lower-case code', () => {
    expect(classFormSchema.safeParse(valid).success).toBe(true)
    expect(classFormSchema.safeParse({ ...valid, code: 'class_11_drop' }).success).toBe(true)
  })

  it.each([
    [{ name: 'A' }, 'name: Name must be 2–40 characters.'],
    [{ name: 'x'.repeat(41) }, 'name: Name must be 2–40 characters.'],
    [{ code: 'A' }, 'code: Code uses 2–30 letters, digits or underscores.'],
    [{ code: 'CLASS 11' }, 'code: Code uses 2–30 letters, digits or underscores.'],
    [{ stage: 'nursery' }, 'stage: Pick a value from the list.'],
    [{ stage: '' }, 'stage: Pick a value from the list.'],
    [{ levelOrder: 51 }, 'levelOrder: Level order must be 0–50.'],
    [{ levelOrder: -1 }, 'levelOrder: Level order must be 0–50.'],
    [{ levelOrder: 1.5 }, 'levelOrder: Level order must be a whole number.'],
    [{ levelOrder: Number.NaN }, 'levelOrder: Level order must be a number.'],
  ])('rejects %j', (bad, expected) => {
    expect(messages({ ...valid, ...bad })).toContain(expected)
  })
})

describe('classesConfig', () => {
  it('sends the code upper-cased and trims the name', () => {
    expect(classesConfig.toPayload({ ...valid, name: '  Class 11 ', code: ' class_11 ' })).toEqual({ name: 'Class 11', code: 'CLASS_11', stage: 'competitive', levelOrder: 15, isActive: true })
  })

  it('round-trips a row through the form', () => {
    expect(classesConfig.toFormValues(row)).toEqual({ name: 'Class 10', code: 'CLASS_10', stage: 'secondary', levelOrder: 10, isActive: true })
  })

  it('marks the code as unchangeable and turns on reordering with a warning', () => {
    expect(classesConfig.fields.find((f) => f.name === 'code')?.immutable).toBe(true)
    expect(classesConfig.reorder?.sort).toBe('levelOrder')
    expect(classesConfig.reorder?.warning).toMatch(/recommendations/)
  })

  it.each([
    [{ teacherCount: 0, childCount: 0 }, { count: 0, label: 'Unused' }],
    [{ teacherCount: 1, childCount: 0 }, { count: 1, label: '1 teacher' }],
    [{ teacherCount: 12, childCount: 1 }, { count: 13, label: '12 teachers · 1 child' }],
    [{ teacherCount: 0, childCount: 4 }, { count: 4, label: '4 children' }],
  ])('describes usage for %j', (counts, expected) => {
    expect(classesConfig.usage({ ...row, ...counts })).toEqual(expected)
  })
})
