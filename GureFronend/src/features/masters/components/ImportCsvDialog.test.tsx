import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { importMasters } from '../api/masters.api'
import type { ImportResult } from '../api/masters.api'
import { statesConfig } from '../config/states.config'
import { ImportCsvDialog } from './ImportCsvDialog'

vi.mock('../api/masters.api')

const CSV = 'country_iso2,name,code,type\nIN,Kerala,KL,state\nIN,Goa,GA,state\nIN,Ladakh,LA,union_territory\n'
const checked: ImportResult = {
  dryRun: true,
  total: 3,
  created: [
    { row: 2, label: 'Kerala (KL)' },
    { row: 4, label: 'Ladakh (LA)' },
  ],
  skipped: [{ row: 3, label: 'Goa (GA)', reason: 'A state with this name already exists.' }],
}

const onClose = vi.fn()
const onImported = vi.fn()
const paste = (text: string) => fireEvent.change(screen.getByLabelText('Or paste the rows'), { target: { value: text } })
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))

beforeEach(() => {
  vi.resetAllMocks()
  render(<ImportCsvDialog config={statesConfig} onClose={onClose} onImported={onImported} />)
})

describe('ImportCsvDialog', () => {
  it('explains the columns and starts with nothing to check', () => {
    expect(screen.getByRole('dialog', { name: 'Import states from CSV' })).toBeInTheDocument()
    expect(screen.getByText('country_iso2,name,code,type')).toBeInTheDocument()
    expect(screen.getByLabelText('Or paste the rows')).toHaveAttribute('placeholder', expect.stringContaining('IN,Kerala,KL,state'))
    expect(screen.getByRole('button', { name: 'Check file' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
  })

  it('checks the file without saving, then imports what would be created', async () => {
    vi.mocked(importMasters).mockResolvedValueOnce(checked)
    paste(CSV)
    click('Check file')

    const summary = await screen.findByRole('status')
    expect(summary).toHaveTextContent('2 to add, 1 already exist (skipped), out of 3 rows.')
    expect(summary).toHaveTextContent('Row 3: Goa (GA) — A state with this name already exists.')
    expect(importMasters).toHaveBeenCalledWith('/states', CSV, true)

    vi.mocked(importMasters).mockResolvedValueOnce({ ...checked, dryRun: false })
    click('Import 2 states')
    await waitFor(() => expect(onImported).toHaveBeenCalledWith({ ...checked, dryRun: false }))
    expect(importMasters).toHaveBeenLastCalledWith('/states', CSV, false)
  })

  it('forgets the check as soon as the text changes', async () => {
    vi.mocked(importMasters).mockResolvedValue(checked)
    paste(CSV)
    click('Check file')
    await screen.findByRole('status')
    expect(screen.getByRole('button', { name: 'Import 2 states' })).toBeEnabled()

    paste(`${CSV}IN,Sikkim,SK,state\n`)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
  })

  it('cannot import when every row already exists', async () => {
    vi.mocked(importMasters).mockResolvedValue({ dryRun: true, total: 1, created: [], skipped: [{ row: 2, label: 'Kerala (KL)', reason: 'A state with this name already exists.' }] })
    paste(CSV)
    click('Check file')
    expect(await screen.findByRole('status')).toHaveTextContent('0 to add, 1 already exist')
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
  })

  it('lists every bad row, says nothing was imported and keeps Import disabled', async () => {
    vi.mocked(importMasters).mockRejectedValue(
      new ApiError(422, 'VALIDATION_FAILED', 'Fix the rows below. Nothing was imported.', [
        { row: 3, path: 'code', message: 'Code uses 1–5 capital letters or digits.' },
        { row: 6, path: 'country_iso2', message: 'No country with ISO code ZZ.' },
      ]),
    )
    paste(CSV)
    click('Check file')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Nothing was imported. Fix these and check again:')
    expect(within(alert).getByText('Row 3').closest('tr')).toHaveTextContent('Code uses 1–5 capital letters or digits.')
    expect(within(alert).getByText('Row 6').closest('tr')).toHaveTextContent('No country with ISO code ZZ.')
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
    expect(importMasters).toHaveBeenCalledTimes(1)
  })

  it('shows a problem with the file as a whole', async () => {
    vi.mocked(importMasters).mockRejectedValue(new ApiError(422, 'VALIDATION_FAILED', 'The file is empty.', [{ message: 'The file is empty.' }]))
    paste('x')
    click('Check file')
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('File')).toBeInTheDocument()
    expect(alert).toHaveTextContent('The file is empty.')
  })

  it('falls back to a plain message for an unexpected failure', async () => {
    vi.mocked(importMasters).mockRejectedValue(new Error('network down'))
    paste(CSV)
    click('Check file')
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read that file. Try again.')
  })

  it('shows a failure while applying and stays open', async () => {
    vi.mocked(importMasters).mockResolvedValueOnce(checked).mockRejectedValueOnce(new ApiError(409, 'CONFLICT_DUPLICATE', 'Some of these states were added by someone else while the file was importing. Check the file again.'))
    paste(CSV)
    click('Check file')
    await screen.findByRole('status')
    click('Import 2 states')
    expect(await screen.findByRole('alert')).toHaveTextContent('added by someone else')
    expect(onImported).not.toHaveBeenCalled()
  })

  it('reads a chosen file into the box', async () => {
    const file = new File([CSV], 'states.csv', { type: 'text/csv' })
    fireEvent.change(screen.getByLabelText('CSV file'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByLabelText('Or paste the rows')).toHaveValue(CSV))
    expect(screen.getByRole('button', { name: 'Check file' })).toBeEnabled()
  })

  it('closes on Cancel and on Escape', () => {
    click('Cancel')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
