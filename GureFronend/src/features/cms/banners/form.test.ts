import { describe, expect, it } from 'vitest'
import { changesOf, emptyForm, formFromBanner, fromLocalInput, payloadOf, toLocalInput, validateForm } from './form'
import { banner } from './testData'

const valid = () => ({ ...formFromBanner(banner()) })

describe('banner form', () => {
  it('round-trips an instant through the datetime-local input', () => {
    const iso = '2027-01-01T04:30:00.000Z'
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso)
    expect(toLocalInput(null)).toBe('')
  })

  it('starts a new banner at the next whole hour with no end', () => {
    const f = emptyForm()
    expect(f.endsAt).toBe('')
    expect(f.audience).toBe('all')
    expect(new Date(f.startsAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('builds the API payload from the form, tidying text and turning blanks into null', () => {
    const p = payloadOf({ ...valid(), title: '  Board   exams ', subtitle: '   ', endsAt: '' })
    expect(p).toMatchObject({ title: 'Board exams', subtitle: null, endsAt: null, imageFileId: 'f1', cityIds: ['c1'], deepLink: 'gc://plans' })
  })

  it('lists only what changed', () => {
    const was = valid()
    expect(changesOf(was, was)).toEqual({})
    expect(changesOf({ ...was, title: 'New title', priority: 70, cityIds: [] }, was)).toEqual({ title: 'New title', priority: 70, cityIds: [] })
  })

  it('accepts a complete form', () => {
    expect(validateForm(valid())).toEqual({})
  })

  it.each([
    [{ title: 'ab' }, 'title', 'Title must be 3–60 characters.'],
    [{ subtitle: 'x'.repeat(91) }, 'subtitle', 'Subtitle can be up to 90 characters.'],
    [{ imageFileId: '' }, 'imageFileId', 'Upload the banner image.'],
    [{ priority: 101 }, 'priority', 'Priority must be 0–100.'],
    [{ priority: 1.5 }, 'priority', 'Priority must be 0–100.'],
    [{ startsAt: '' }, 'startsAt', 'Pick a start date and time.'],
    [{ endsAt: '2020-01-01T00:00', startsAt: '2027-01-01T00:00' }, 'endsAt', 'The end must be after the start.'],
    [{ startsAt: '2027-01-01T00:00', endsAt: '2027-12-31T00:00' }, 'endsAt', 'A banner can run for at most 180 days.'],
  ])('flags %j', (over, key, message) => {
    expect(validateForm({ ...valid(), ...over })[key]).toBe(message)
  })

  it('flags more than 50 cities', () => {
    expect(validateForm({ ...valid(), cityIds: Array.from({ length: 51 }, (_, i) => `c${i}`) }).cityIds).toBe('Pick up to 50 cities.')
  })
})
