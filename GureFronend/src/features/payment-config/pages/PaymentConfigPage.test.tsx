import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { usePermissions } from '../../auth/usePermissions'
import { fetchFees, toggleFee } from '../api/paymentConfig.api'
import { summary, version } from '../testData'
import { PaymentConfigPage } from './PaymentConfigPage'

vi.mock('../api/paymentConfig.api')
vi.mock('../components/ConfigHistoryTimeline', () => ({ ConfigHistoryTimeline: () => <div>history timeline</div> }))
vi.mock('../../auth/usePermissions', () => ({ usePermissions: vi.fn() }))

const as = (canPublish: boolean) => vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: (k) => k === 'payment_config.read' || (canPublish && k === 'payment_config.publish') })
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <PaymentConfigPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
const fees = [summary(), summary({ feeCode: 'PREMIUM_TEACHER', active: version({ id: 'p', feeCode: 'PREMIUM_TEACHER', name: 'Premium listing', amountPaise: 99900, billingPeriod: 'per_30_days' }) })]

beforeEach(() => {
  vi.resetAllMocks()
  as(true)
  vi.mocked(fetchFees).mockResolvedValue(fees)
  vi.mocked(toggleFee).mockResolvedValue({} as never)
})

describe('PaymentConfigPage', () => {
  it('shows a loading state', () => {
    vi.mocked(fetchFees).mockReturnValue(new Promise(() => undefined))
    show()
    expect(screen.getByText('Loading fees…')).toBeInTheDocument()
  })

  it('shows the error with a way to try again', async () => {
    vi.mocked(fetchFees).mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong.'))
    show()
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Payment configuration' })).toBeInTheDocument()
  })

  it('shows a card per fee and the change history', async () => {
    show()
    expect(await screen.findByRole('link', { name: 'Parent membership · Yearly' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Premium listing' })).toBeInTheDocument()
    expect(screen.getByText('history timeline')).toBeInTheDocument()
  })

  it('switches a fee off after asking for a reason, then refreshes', async () => {
    show()
    fireEvent.click(await screen.findByRole('switch', { name: 'Premium listing on or off' }))
    expect(screen.getByRole('dialog', { name: 'Switch off Premium listing?' })).toBeInTheDocument()
    expect(toggleFee).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Free listings in launch month' } })
    fireEvent.click(screen.getByRole('button', { name: 'Switch off' }))
    await waitFor(() => expect(toggleFee).toHaveBeenCalledWith('PREMIUM_TEACHER', { enabled: false, reason: 'Free listings in launch month' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fetchFees).toHaveBeenCalledTimes(2)
  })

  it('switches a fee on from the off state', async () => {
    vi.mocked(fetchFees).mockResolvedValue([summary({ active: version({ isEnabled: false }) })])
    show()
    fireEvent.click(await screen.findByRole('switch'))
    expect(screen.getByRole('dialog', { name: /Switch on/ })).toBeInTheDocument()
  })

  it('keeps the dialog open and shows the refusal', async () => {
    vi.mocked(toggleFee).mockRejectedValue(new ApiError(409, 'CONFLICT_STATE', 'Cancel the change scheduled for 1 Nov first.'))
    show()
    fireEvent.click(await screen.findByRole('switch', { name: 'Premium listing on or off' }))
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Because reasons' } })
    fireEvent.click(screen.getByRole('button', { name: 'Switch off' }))
    expect(await screen.findByText('Cancel the change scheduled for 1 Nov first.')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('locks the switches for someone who cannot publish', async () => {
    as(false)
    show()
    await screen.findByRole('link', { name: 'Premium listing' })
    for (const toggle of screen.getAllByRole('switch')) expect(toggle).toBeDisabled()
  })
})
