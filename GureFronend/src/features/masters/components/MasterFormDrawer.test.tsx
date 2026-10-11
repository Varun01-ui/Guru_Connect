import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { createMaster, getMaster, updateMaster } from '../api/masters.api'
import { countriesConfig } from '../config/countries.config'
import type { Country } from '../config/countries.config'
import { MasterFormDrawer } from './MasterFormDrawer'

vi.mock('../api/masters.api')

const india: Country = {
  id: 'c-in',
  name: 'India',
  iso2: 'IN',
  iso3: 'IND',
  phoneCode: '+91',
  currencyCode: 'INR',
  isActive: true,
  sortOrder: 1,
  stateCount: 13,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-20T08:11:02.114Z',
  deletedAt: null,
}

const onClose = vi.fn()
const onSaved = vi.fn()

function open(row: Country | null) {
  return render(<MasterFormDrawer config={countriesConfig} row={row} onClose={onClose} onSaved={onSaved} />)
}
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const submit = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

function fillValidNewCountry() {
  type('Country name', 'Nepal')
  type('ISO alpha-2', 'NP')
  type('ISO alpha-3', 'NPL')
  type('Dialling code', '+977')
  type('Currency', 'NPR')
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('MasterFormDrawer — create', () => {
  it('starts empty and active', () => {
    open(null)
    expect(screen.getByRole('dialog', { name: 'Add country' })).toBeInTheDocument()
    expect(screen.getByLabelText('Country name')).toHaveValue('')
    expect(screen.getByLabelText('Order')).toHaveValue(0)
    expect(screen.getByRole('switch', { name: 'Active' })).toBeChecked()
  })

  it('shows every field error and makes no API call when the form is empty', async () => {
    open(null)
    submit('Add country')
    expect(await screen.findByText('Country name must be 2–60 characters.')).toBeInTheDocument()
    expect(screen.getByText('ISO alpha-2 must be exactly 2 letters.')).toBeInTheDocument()
    expect(screen.getByText('ISO alpha-3 must be exactly 3 letters.')).toBeInTheDocument()
    expect(screen.getByText('Dialling code looks like +91.')).toBeInTheDocument()
    expect(screen.getByText('Currency must be a 3-letter ISO 4217 code, e.g. INR.')).toBeInTheDocument()
    expect(screen.getByLabelText('Country name')).toHaveAttribute('aria-invalid', 'true')
    expect(createMaster).not.toHaveBeenCalled()
  })

  it('rejects an order outside 0–9,999 and a blank order', async () => {
    open(null)
    fillValidNewCountry()
    type('Order', '10000')
    submit('Add country')
    expect(await screen.findByText('Order must be 0–9,999.')).toBeInTheDocument()

    type('Order', '')
    submit('Add country')
    expect(await screen.findByText('Order must be a number.')).toBeInTheDocument()
    expect(createMaster).not.toHaveBeenCalled()
  })

  it('sends upper-cased codes and reports the created row', async () => {
    const created = { ...india, id: 'c-np', name: 'Nepal' }
    vi.mocked(createMaster).mockResolvedValue(created)
    open(null)
    type('Country name', '  Nepal  ')
    type('ISO alpha-2', 'np')
    type('ISO alpha-3', 'npl')
    type('Dialling code', '+977')
    type('Currency', 'npr')
    type('Order', '4')
    fireEvent.click(screen.getByRole('switch', { name: 'Active' }))
    submit('Add country')

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(created, 'created'))
    expect(createMaster).toHaveBeenCalledWith('/countries', { name: 'Nepal', iso2: 'NP', iso3: 'NPL', phoneCode: '+977', currencyCode: 'NPR', sortOrder: 4, isActive: false })
  })

  it('disables the buttons while saving', async () => {
    vi.mocked(createMaster).mockReturnValue(new Promise(() => undefined))
    open(null)
    fillValidNewCountry()
    submit('Add country')
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('puts a duplicate-name error under the name field and keeps the drawer open', async () => {
    vi.mocked(createMaster).mockRejectedValue(new ApiError(409, 'CONFLICT_DUPLICATE', 'A country with this name already exists.', { field: 'name' }))
    open(null)
    fillValidNewCountry()
    submit('Add country')

    expect(await screen.findByText('A country with this name already exists.')).toBeInTheDocument()
    expect(screen.getByLabelText('Country name')).toHaveAttribute('aria-invalid', 'true')
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('maps server validation issues to their fields', async () => {
    vi.mocked(createMaster).mockRejectedValue(
      new ApiError(422, 'VALIDATION_FAILED', 'Some fields need attention.', [{ path: 'phoneCode', message: 'Dialling code looks like +91.' }]),
    )
    open(null)
    fillValidNewCountry()
    submit('Add country')
    expect(await screen.findByText('Dialling code looks like +91.')).toBeInTheDocument()
  })

  it('shows an unexpected error as a form-level alert', async () => {
    vi.mocked(createMaster).mockRejectedValue(new Error('network down'))
    open(null)
    fillValidNewCountry()
    submit('Add country')
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save this country. Try again.')
  })
})

describe('MasterFormDrawer — edit', () => {
  it('opens prefilled', () => {
    open(india)
    expect(screen.getByRole('dialog', { name: 'Edit country' })).toBeInTheDocument()
    expect(screen.getByLabelText('Country name')).toHaveValue('India')
    expect(screen.getByLabelText('ISO alpha-2')).toHaveValue('IN')
    expect(screen.getByLabelText('Dialling code')).toHaveValue('+91')
    expect(screen.getByLabelText('Order')).toHaveValue(1)
  })

  it('sends only the changed fields with the row version', async () => {
    const saved = { ...india, name: 'Bharat' }
    vi.mocked(updateMaster).mockResolvedValue(saved)
    open(india)
    type('Country name', 'Bharat')
    submit('Save changes')

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved, 'updated'))
    expect(updateMaster).toHaveBeenCalledWith('/countries', 'c-in', { name: 'Bharat' }, '2026-09-20T08:11:02.114Z')
  })

  it('closes without calling the API when nothing changed', async () => {
    open(india)
    submit('Save changes')
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(updateMaster).not.toHaveBeenCalled()
  })

  it('treats a code typed in lower case as unchanged', async () => {
    open(india)
    type('ISO alpha-2', 'in')
    submit('Save changes')
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(updateMaster).not.toHaveBeenCalled()
  })

  it('on a stale edit, explains it and reloads the latest row and version', async () => {
    const latest = { ...india, sortOrder: 5, updatedAt: '2026-10-01T09:00:00.000Z' }
    vi.mocked(updateMaster)
      .mockRejectedValueOnce(new ApiError(409, 'VERSION_CONFLICT', 'Someone else changed this country. Reload.', { current: latest }))
      .mockResolvedValueOnce({ ...latest, name: 'Bharat' })
    vi.mocked(getMaster).mockResolvedValue(latest)
    open(india)
    type('Country name', 'Bharat')
    submit('Save changes')

    expect(await screen.findByRole('alert')).toHaveTextContent('Someone else changed this country. Reload.')
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }))
    await waitFor(() => expect(screen.getByLabelText('Order')).toHaveValue(5))
    expect(screen.getByLabelText('Country name')).toHaveValue('India')
    expect(screen.queryByRole('alert')).toBeNull()

    type('Country name', 'Bharat')
    submit('Save changes')
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(updateMaster).toHaveBeenLastCalledWith('/countries', 'c-in', { name: 'Bharat' }, '2026-10-01T09:00:00.000Z')
  })
})

describe('MasterFormDrawer — dismissing', () => {
  it('closes on Escape and on Cancel', () => {
    open(india)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
