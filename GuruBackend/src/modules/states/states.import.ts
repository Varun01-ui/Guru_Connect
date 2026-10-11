import { db } from '../../db/index.js'
import { audit } from '../../lib/audit.js'
import { conflictDuplicate, validationFailed } from '../../lib/errors.js'
import { parseCsv } from '../../lib/csv.js'
import { auditBase } from '../../lib/masters/kernel.js'
import type { Ctx } from '../../lib/masters/kernel.js'
import { def, purgeStatesCache } from './states.service.js'
import { importRowSchema } from './states.schemas.js'

export const IMPORT_HEADER = ['country_iso2', 'name', 'code', 'type'] as const
export const IMPORT_MAX_ROWS = 500

type Problem = { row?: number; path?: string; message: string }
type Candidate = { row: number; countryId: string; countryIso2: string; name: string; code: string; type: 'state' | 'union_territory' }
export type ImportResult = {
  dryRun: boolean
  total: number
  created: { row: number; label: string }[]
  skipped: { row: number; label: string; reason: string }[]
}

const fail = (problems: Problem[]) => validationFailed(problems, problems.length === 1 ? problems[0]!.message : 'Fix the rows below. Nothing was imported.')

/**
 * POST /states/import (FR-8.S2). The whole file is validated first and any bad row rejects it with a row-level error
 * list, so a file is applied completely or not at all. Rows that already exist are skipped, not errors. With
 * `dryRun` the same checks run and the result is returned without writing anything.
 */
export async function importStates(ctx: Ctx, csv: string, dryRun: boolean): Promise<ImportResult> {
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
  const parsed: { row: number; countryIso2: string; name: string; code: string; type: 'state' | 'union_territory' }[] = []
  dataRows.forEach((cells, i) => {
    const row = i + 2 // file row, counting the header as row 1
    if (cells.length !== IMPORT_HEADER.length) {
      problems.push({ row, message: `Expected ${IMPORT_HEADER.length} columns but found ${cells.length}.` })
      return
    }
    const result = importRowSchema.safeParse({ countryIso2: cells[0], name: cells[1], code: cells[2], type: cells[3] })
    if (!result.success) {
      for (const issue of result.error.issues) problems.push({ row, path: String(issue.path[0] ?? ''), message: issue.message })
      return
    }
    parsed.push({ row, ...result.data })
  })

  // Rows that clash with each other are a mistake in the file, unlike rows that clash with existing states.
  const seenName = new Map<string, number>()
  const seenCode = new Map<string, number>()
  for (const r of parsed) {
    const nameKey = `${r.countryIso2}|${r.name.toLowerCase()}`
    const codeKey = `${r.countryIso2}|${r.code}`
    if (seenName.has(nameKey)) problems.push({ row: r.row, path: 'name', message: `Same country and name as row ${seenName.get(nameKey)}.` })
    else seenName.set(nameKey, r.row)
    if (seenCode.has(codeKey)) problems.push({ row: r.row, path: 'code', message: `Same country and code as row ${seenCode.get(codeKey)}.` })
    else seenCode.set(codeKey, r.row)
  }

  const isos = [...new Set(parsed.map((r) => r.countryIso2))]
  const countries = isos.length ? await db.selectFrom('countries').select(['id', 'iso2', 'is_active']).where('iso2', 'in', isos).where('deleted_at', 'is', null).execute() : []
  const byIso = new Map(countries.map((c) => [c.iso2, c]))
  const candidates: Candidate[] = []
  for (const r of parsed) {
    const country = byIso.get(r.countryIso2)
    if (!country || !country.is_active) {
      problems.push({ row: r.row, path: 'country_iso2', message: country ? `${r.countryIso2} is not an active country.` : `No country with ISO code ${r.countryIso2}.` })
    } else candidates.push({ ...r, countryId: country.id })
  }

  if (problems.length > 0) throw fail(problems.sort((a, b) => (a.row ?? 0) - (b.row ?? 0)))

  const existing = candidates.length
    ? await db.selectFrom('states').select(['country_id', 'name', 'code']).where('country_id', 'in', [...new Set(candidates.map((c) => c.countryId))]).where('deleted_at', 'is', null).execute()
    : []
  const existingNames = new Set(existing.map((s) => `${s.country_id}|${s.name.toLowerCase()}`))
  const existingCodes = new Set(existing.map((s) => `${s.country_id}|${s.code}`))

  const created: Candidate[] = []
  const skipped: ImportResult['skipped'] = []
  for (const c of candidates) {
    const label = `${c.name} (${c.code})`
    if (existingNames.has(`${c.countryId}|${c.name.toLowerCase()}`)) skipped.push({ row: c.row, label, reason: 'A state with this name already exists.' })
    else if (existingCodes.has(`${c.countryId}|${c.code}`)) skipped.push({ row: c.row, label, reason: 'A state with this code already exists.' })
    else created.push(c)
  }

  const result: ImportResult = {
    dryRun,
    total: dataRows.length,
    created: created.map((c) => ({ row: c.row, label: `${c.name} (${c.code})` })),
    skipped,
  }
  if (dryRun || created.length === 0) return result

  try {
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('states')
        .values(created.map((c) => ({ country_id: c.countryId, name: c.name, code: c.code, type: c.type, created_by: ctx.actor.id, updated_by: ctx.actor.id })))
        .execute()
      // One audit row for the request, listing what it created.
      await audit(trx, {
        ...auditBase(ctx, def, created[0]!.countryId),
        entityId: null,
        action: 'state.imported',
        newValues: { created: created.map((c) => ({ country: c.countryIso2, name: c.name, code: c.code, type: c.type })), skipped: skipped.length },
      })
    })
  } catch (e) {
    if ((e as { code?: string })?.code === '23505') throw conflictDuplicate('Some of these states were added by someone else while the file was importing. Check the file again.')
    throw e
  }
  await purgeStatesCache()
  return result
}
