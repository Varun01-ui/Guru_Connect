import { z } from 'zod'
import { db } from '../../db/index.js'
import { audit } from '../../lib/audit.js'
import { parseCsv } from '../../lib/csv.js'
import { conflictDuplicate, validationFailed } from '../../lib/errors.js'
import { auditBase } from '../../lib/masters/kernel.js'
import type { Ctx } from '../../lib/masters/kernel.js'
import { areaName, latitude, longitude, pincodeList } from './areas.schemas.js'
import { def, freeSlug, purgeAreasCache } from './areas.service.js'

export const IMPORT_HEADER = ['city_slug', 'name', 'pincodes', 'latitude', 'longitude'] as const
export const IMPORT_MAX_ROWS = 2000

type Problem = { row?: number; path?: string; message: string }
export type ImportResult = {
  dryRun: boolean
  total: number
  created: { row: number; label: string }[]
  skipped: { row: number; label: string; reason: string }[]
}

// PIN codes share one cell: separated by spaces, "|", ";" or "," (quote the cell when using a comma).
const importRowSchema = z.object({
  citySlug: z.string().trim().toLowerCase().min(1, 'city_slug is required.'),
  name: areaName,
  pincodes: z.string().transform((v) => v.split(/[\s|;,]+/).filter(Boolean)).pipe(pincodeList),
  latitude: z.string().transform((v) => (v.trim() === '' ? null : Number(v))).pipe(latitude),
  longitude: z.string().transform((v) => (v.trim() === '' ? null : Number(v))).pipe(longitude),
})

const fail = (problems: Problem[]) => validationFailed(problems, problems.length === 1 ? problems[0]!.message : 'Fix the rows below. Nothing was imported.')

type Candidate = { row: number; citySlug: string; name: string; pincodes: string[]; latitude: number | null; longitude: number | null }

/**
 * POST /areas/import (FR-10.S1). Every row is validated first. Without `skipInvalid` one bad row rejects the whole file
 * with a row-level error list; with it, bad rows are reported as skipped and the rest are applied. Rows that already
 * exist are always skipped. `dryRun` returns the same report without writing.
 */
export async function importAreas(ctx: Ctx, csv: string, dryRun: boolean, skipInvalid: boolean): Promise<ImportResult> {
  const rows = parseCsv(csv)
  if (rows.length === 0) throw fail([{ message: 'The file is empty.' }])
  const header = rows[0]!.map((h) => h.trim().toLowerCase())
  if (header.length !== IMPORT_HEADER.length || IMPORT_HEADER.some((h, i) => header[i] !== h)) {
    throw fail([{ row: 1, message: `The first row must be the header: ${IMPORT_HEADER.join(',')}` }])
  }
  const dataRows = rows.slice(1)
  if (dataRows.length === 0) throw fail([{ message: 'The file has a header but no rows.' }])
  if (dataRows.length > IMPORT_MAX_ROWS) throw fail([{ message: `Up to ${IMPORT_MAX_ROWS} rows per file; this one has ${dataRows.length}.` }])

  const problems: Problem[] = []
  const labels = new Map<number, string>()
  const parsed: Candidate[] = []
  dataRows.forEach((cells, i) => {
    const row = i + 2 // file row, counting the header as row 1
    labels.set(row, cells[1]?.trim() || `Row ${row}`)
    if (cells.length !== IMPORT_HEADER.length) {
      problems.push({ row, message: `Expected ${IMPORT_HEADER.length} columns but found ${cells.length}.` })
      return
    }
    const result = importRowSchema.safeParse({ citySlug: cells[0], name: cells[1], pincodes: cells[2], latitude: cells[3], longitude: cells[4] })
    if (!result.success) {
      for (const issue of result.error.issues) problems.push({ row, path: String(issue.path[0] ?? ''), message: issue.message })
      return
    }
    parsed.push({ row, ...result.data })
  })

  // Rows that clash with each other are a mistake in the file, unlike rows that clash with existing areas.
  const bad = new Set(problems.map((p) => p.row))
  const seen = new Map<string, number>()
  for (const r of parsed) {
    const key = `${r.citySlug}|${r.name.toLowerCase()}`
    if (seen.has(key)) {
      problems.push({ row: r.row, path: 'name', message: `Same city and name as row ${seen.get(key)}.` })
      bad.add(r.row)
    } else seen.set(key, r.row)
  }

  const slugs = [...new Set(parsed.map((r) => r.citySlug))]
  const cities = slugs.length ? await db.selectFrom('cities').select(['id', 'slug', 'is_active']).where('slug', 'in', slugs).where('deleted_at', 'is', null).execute() : []
  const bySlug = new Map(cities.map((c) => [c.slug, c]))
  const candidates: (Candidate & { cityId: string })[] = []
  for (const r of parsed) {
    if (bad.has(r.row)) continue
    const city = bySlug.get(r.citySlug)
    if (!city || !city.is_active) {
      problems.push({ row: r.row, path: 'city_slug', message: city ? `${r.citySlug} is not an active city.` : `No city with slug ${r.citySlug}.` })
      bad.add(r.row)
    } else candidates.push({ ...r, cityId: city.id })
  }

  problems.sort((a, b) => (a.row ?? 0) - (b.row ?? 0))
  if (problems.length > 0 && !skipInvalid) throw fail(problems)

  const skipped: ImportResult['skipped'] = [...new Set(problems.map((p) => p.row!))].map((row) => ({
    row,
    label: labels.get(row)!,
    reason: problems.filter((p) => p.row === row).map((p) => p.message).join(' '),
  }))

  const existing = candidates.length
    ? await db.selectFrom('areas').select(['city_id', 'name']).where('city_id', 'in', [...new Set(candidates.map((c) => c.cityId))]).where('deleted_at', 'is', null).execute()
    : []
  const existingNames = new Set(existing.map((a) => `${a.city_id}|${a.name.toLowerCase()}`))
  const toCreate = candidates.filter((c) => {
    if (!existingNames.has(`${c.cityId}|${c.name.toLowerCase()}`)) return true
    skipped.push({ row: c.row, label: c.name, reason: 'An area with this name already exists.' })
    return false
  })
  skipped.sort((a, b) => a.row - b.row)

  const result: ImportResult = { dryRun, total: dataRows.length, created: toCreate.map((c) => ({ row: c.row, label: c.name })), skipped }
  if (dryRun || toCreate.length === 0) return result

  try {
    await db.transaction().execute(async (trx) => {
      // Slugs must be unique within the city, including the ones this file is about to create.
      const claimed = new Map<string, Set<string>>()
      const values = []
      for (const c of toCreate) {
        const taken = claimed.get(c.cityId) ?? new Set<string>()
        const slug = await freeSlug(trx, c.cityId, c.name, taken)
        taken.add(slug)
        claimed.set(c.cityId, taken)
        values.push({
          city_id: c.cityId,
          name: c.name,
          slug,
          pincodes: c.pincodes,
          latitude: c.latitude === null ? null : String(c.latitude),
          longitude: c.longitude === null ? null : String(c.longitude),
          created_by: ctx.actor.id,
          updated_by: ctx.actor.id,
        })
      }
      await trx.insertInto('areas').values(values).execute()
      await audit(trx, {
        ...auditBase(ctx, def, toCreate[0]!.cityId),
        entityId: null,
        action: 'area.imported',
        newValues: { created: toCreate.map((c) => ({ city: c.citySlug, name: c.name, pincodes: c.pincodes })), skipped: skipped.length },
      })
    })
  } catch (e) {
    if ((e as { code?: string })?.code === '23505') throw conflictDuplicate('Some of these areas were added by someone else while the file was importing. Check the file again.')
    throw e
  }
  await purgeAreasCache()
  return result
}
