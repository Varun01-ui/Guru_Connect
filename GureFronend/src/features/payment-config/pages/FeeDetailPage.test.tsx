import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { usePermissions } from '../../auth/usePermissions'
import * as api from '../api/paymentConfig.api'
import { detail, meta, version } from '../testData'
import { FeeDetailPage } from './FeeDetailPage'

vi.mock('../api/paymentConfig.api')
vi.mock('../components/ConfigHistoryTimeline', () => ({ ConfigHistoryTimeline: () => <div>history timeline</div> }))
vi.mock('../../auth/usePermissions', () => ({ usePermissions: vi.fn() }))

const as = (edit: boolean, publish: boolean) =>
  vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: (k) => k === 'payment_config.read' || (edit && k === 'payment_config.edit') || (publish && k === 'payment_config.publish') })
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/payments/config/PARENT_SUBSCRIPTION_YEARLY']}>
        <Routes>
          <Route path="/payments/config/:feeCode" element={<FeeDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
const card = { title: 'Parent membership · Yearly', priceText: '₹1,799 / year', perMonthText: '₹150 / month', gstText: 'incl. ₹274 GST', trialText: '7-day free trial', enabled: true }
const preview = { card, impact: { liveSubscriptionsOnCurrentVersion: 1824, openCheckouts: 3, changePercent: -10 } }
const draftV = version({ id: 'd1', version: 4, status: 'draft', amountPaise: 179900, updatedAt: '2026-10-10T09:00:00.000Z' })

// Autosave waits a second after the last keystroke; the clock is faked so the tests don't.
const wait = (ms = 1100) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const price = (value: string) => fireEvent.change(screen.getByLabelText('Price'), { target: { value } })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.resetAllMocks()
  as(true, true)
  vi.mocked(api.fetchFee).mockResolvedValue({ data: detail(), meta: meta() })
  vi.mocked(api.previewDraft).mockResolvedValue(preview)
})
afterEach(() => vi.useRealTimers())

describe('FeeDetailPage', () => {
  it('shows a loading state and an error with a way back', async () => {
    vi.mocked(api.fetchFee).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Fee not found.'))
    show()
    expect(screen.getByText('Loading fee…')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('Fee not found.')
    expect(screen.getByRole('link', { name: 'Back to payment configuration' })).toHaveAttribute('href', '/payments/config')
  })

  it('shows the live price, the editor on the live values, the version table and the history', async () => {
    show()
    expect(await screen.findByRole('heading', { name: 'Parent membership · Yearly' })).toBeInTheDocument()
    expect(screen.getByText(/Live now:/)).toHaveTextContent('₹1,999')
    expect(screen.getByLabelText('Price')).toHaveValue('1999')
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('history timeline')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Publish…' })).toBeDisabled() // nothing to publish yet
    expect(screen.getByText('Change something to see what users will see.')).toBeInTheDocument()
  })

  it('autosaves a change as a draft a second after typing stops, sending only what changed', async () => {
    vi.mocked(api.saveDraft).mockResolvedValue(draftV)
    show()
    await screen.findByLabelText('Price')
    price('1799')
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Unsaved changes…')
    await wait(500)
    expect(api.saveDraft).not.toHaveBeenCalled()
    await wait(600)
    expect(api.saveDraft).toHaveBeenCalledTimes(1)
    expect(api.saveDraft).toHaveBeenCalledWith('PARENT_SUBSCRIPTION_YEARLY', { amountPaise: 179900 }, undefined)
    expect(await screen.findByText('All changes saved')).toBeInTheDocument()
  })

  it('restarts the wait on every keystroke, so one pause means one save', async () => {
    vi.mocked(api.saveDraft).mockResolvedValue(draftV)
    show()
    await screen.findByLabelText('Price')
    price('1')
    await wait(800)
    price('17')
    await wait(800)
    price('1799')
    await wait(1100)
    expect(api.saveDraft).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.saveDraft).mock.calls[0]![1]).toEqual({ amountPaise: 179900 })
  })

  it('sends the draft’s version on later saves', async () => {
    vi.mocked(api.fetchFee).mockResolvedValue({ data: detail({ draft: draftV, versions: [draftV, version()] }), meta: meta(2) })
    vi.mocked(api.saveDraft).mockResolvedValue({ ...draftV, amountPaise: 169900, updatedAt: '2026-10-10T09:05:00.000Z' })
    show()
    await screen.findByLabelText('Price')
    expect(screen.getByLabelText('Price')).toHaveValue('1799') // the draft, not the live price
    price('1699')
    await wait()
    expect(api.saveDraft).toHaveBeenCalledWith('PARENT_SUBSCRIPTION_YEARLY', { amountPaise: 169900 }, '2026-10-10T09:00:00.000Z')
    price('1599')
    await wait()
    expect(api.saveDraft).toHaveBeenLastCalledWith('PARENT_SUBSCRIPTION_YEARLY', { amountPaise: 159900 }, '2026-10-10T09:05:00.000Z')
  })

  it('does not save invalid values; it shows the problem instead', async () => {
    show()
    await screen.findByLabelText('Price')
    fireEvent.change(screen.getByLabelText('Validity (days)'), { target: { value: '300' } })
    await wait()
    expect(api.saveDraft).not.toHaveBeenCalled()
    expect(screen.getByText('Yearly plans last 365 or 366 days.')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Not saved')
  })

  it('shows the server’s verdict on a field', async () => {
    vi.mocked(api.saveDraft).mockRejectedValue(new ApiError(422, 'VALIDATION_FAILED', 'Yearly plans must use a yearly period.', [{ path: 'billingPeriod', message: 'Yearly plans must use a yearly period.' }]))
    show()
    await screen.findByLabelText('Price')
    price('1799')
    await wait()
    expect(await screen.findByText('Yearly plans must use a yearly period.')).toBeInTheDocument()
  })

  it('tells you when the draft changed in another tab and offers to reload', async () => {
    vi.mocked(api.fetchFee).mockResolvedValue({ data: detail({ draft: draftV, versions: [draftV, version()] }), meta: meta(2) })
    vi.mocked(api.saveDraft).mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'This draft changed in another tab.'))
    show()
    await screen.findByLabelText('Price')
    price('1699')
    await wait()
    expect(await screen.findByText('This draft changed in another tab.', { selector: 'span' })).toBeInTheDocument()
    vi.mocked(api.fetchFee).mockResolvedValue({ data: detail({ draft: { ...draftV, amountPaise: 155500, updatedAt: '2026-10-10T09:30:00.000Z' }, versions: [version()] }), meta: meta() })
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }))
    await waitFor(() => expect(screen.getByLabelText('Price')).toHaveValue('1555'))
  })

  it('shows the app’s price card for the saved draft', async () => {
    vi.mocked(api.fetchFee).mockResolvedValue({ data: detail({ draft: draftV, versions: [draftV, version()] }), meta: meta(2) })
    show()
    expect(await screen.findByText('₹1,799 / year')).toBeInTheDocument()
    expect(screen.getByText('-10% against the live price')).toBeInTheDocument()
  })

  it('publishes the draft through the dialog and reloads', async () => {
    vi.mocked(api.fetchFee).mockResolvedValue({ data: detail({ draft: draftV, versions: [draftV, version()] }), meta: meta(2) })
    vi.mocked(api.publishDraft).mockResolvedValue({} as never)
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Publish…' }))
    expect(await screen.findByRole('dialog', { name: 'Publish Parent membership · Yearly' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Diwali offer from 1 Nov' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publish now' }))
    await waitFor(() => expect(api.publishDraft).toHaveBeenCalledWith('PARENT_SUBSCRIPTION_YEARLY', { reason: 'Diwali offer from 1 Nov' }))
    await waitFor(() => expect(vi.mocked(api.fetchFee).mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('discards the draft after confirming', async () => {
    vi.mocked(api.fetchFee).mockResolvedValue({ data: detail({ draft: draftV, versions: [draftV, version()] }), meta: meta(2) })
    vi.mocked(api.discardDraft).mockResolvedValue(undefined)
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Discard draft' }))
    expect(api.discardDraft).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard draft' }))
    await waitFor(() => expect(api.discardDraft).toHaveBeenCalledWith('PARENT_SUBSCRIPTION_YEARLY'))
  })

  it('cancels a scheduled change from the banner', async () => {
    const scheduled = version({ id: 's1', version: 4, status: 'scheduled', amountPaise: 179900, effectiveFrom: '2026-11-01T00:00:00.000Z', changeReason: 'Diwali offer' })
    vi.mocked(api.fetchFee).mockResolvedValue({ data: detail({ scheduled, versions: [scheduled, version()] }), meta: meta(2) })
    vi.mocked(api.cancelVersion).mockResolvedValue({} as never)
    show()
    expect(await screen.findByText(/Scheduled:/)).toHaveTextContent('₹1,799')
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel this change' }))
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Decision reversed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the change' }))
    await waitFor(() => expect(api.cancelVersion).toHaveBeenCalledWith('s1', 'Decision reversed'))
  })

  it('restores an old version with a reason', async () => {
    const old = version({ id: 'o1', version: 2, status: 'superseded', amountPaise: 149900 })
    vi.mocked(api.fetchFee).mockResolvedValue({ data: detail({ versions: [version(), old] }), meta: meta(2) })
    vi.mocked(api.restoreVersion).mockResolvedValue({} as never)
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Restore version 2' }))
    expect(screen.getByRole('dialog', { name: 'Restore version 2?' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Price rise did not work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Restore now' }))
    await waitFor(() => expect(api.restoreVersion).toHaveBeenCalledWith('o1', { reason: 'Price rise did not work' }))
  })

  it('is read-only for someone without edit or publish rights', async () => {
    as(false, false)
    show()
    await screen.findByLabelText('Price')
    expect(screen.getByLabelText('Price')).toBeDisabled()
    expect(screen.getByText('You can view this fee but not change it.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Publish…' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Discard draft' })).toBeNull()
    price('1')
    await wait()
    expect(api.saveDraft).not.toHaveBeenCalled()
  })

  it('lets a maker edit but not publish', async () => {
    as(true, false)
    vi.mocked(api.fetchFee).mockResolvedValue({ data: detail({ draft: draftV, versions: [draftV, version()] }), meta: meta(2) })
    show()
    await screen.findByLabelText('Price')
    expect(screen.getByLabelText('Price')).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Publish…' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Discard draft' })).toBeInTheDocument()
  })
})
