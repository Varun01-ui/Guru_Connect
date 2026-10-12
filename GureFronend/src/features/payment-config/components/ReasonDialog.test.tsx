import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { HandledError, ReasonDialog } from './ReasonDialog'

const show = (onSubmit = vi.fn().mockResolvedValue(undefined)) => {
  const onClose = vi.fn()
  render(
    <ReasonDialog title="Switch off Premium?" description="Hides the purchase." confirmLabel="Switch off" onSubmit={onSubmit} onClose={onClose}>
      <p>extra context</p>
    </ReasonDialog>,
  )
  return { onSubmit, onClose }
}
const reason = (text: string) => fireEvent.change(screen.getByLabelText('Reason'), { target: { value: text } })
const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'Switch off' }))

describe('ReasonDialog', () => {
  it('shows its title, description and extra content', () => {
    show()
    expect(screen.getByRole('dialog', { name: 'Switch off Premium?' })).toBeInTheDocument()
    expect(screen.getByText('Hides the purchase.')).toBeInTheDocument()
    expect(screen.getByText('extra context')).toBeInTheDocument()
  })

  it.each(['', '   ', 'no', 'x'.repeat(501)])('will not submit the reason “%s”', async (text) => {
    const { onSubmit } = show()
    reason(text)
    confirm()
    expect(await screen.findByText('Add a reason (5–500 characters).')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits the trimmed reason', async () => {
    const { onSubmit } = show()
    reason('  Free listings during launch  ')
    confirm()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Free listings during launch', false))
  })

  it('keeps the dialog open with the server’s message when the action fails', async () => {
    const { onSubmit } = show(vi.fn().mockRejectedValue(new ApiError(409, 'CONFLICT_STATE', 'This fee is already off.')))
    reason('Because we can')
    confirm()
    expect(await screen.findByRole('alert')).toHaveTextContent('This fee is already off.')
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Switch off' })).toBeEnabled()
  })

  it('asks for a tick when the server says the price change is large, then resubmits with it', async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(422, 'VALIDATION_FAILED', "This is a 100% change. Confirm it's intended.", [{ path: 'confirmLargeChange', message: "This is a 100% change. Confirm it's intended." }]))
      .mockResolvedValueOnce(undefined)
    show(onSubmit)
    reason('Doubling the price')
    confirm()
    expect(await screen.findByText("This is a 100% change. Confirm it's intended.")).toBeInTheDocument()
    confirm()
    expect(await screen.findByText('Tick the box to confirm the large change.')).toBeInTheDocument()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('checkbox'))
    confirm()
    await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith('Doubling the price', true))
  })

  it('shows nothing extra when the caller already reported the problem itself', async () => {
    show(vi.fn().mockRejectedValue(new HandledError()))
    reason('A fine reason')
    confirm()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Switch off' })).toBeEnabled())
    expect(screen.queryByText('That did not work. Try again.')).toBeNull()
  })

  it('shows a generic message for an unexpected failure', async () => {
    show(vi.fn().mockRejectedValue(new Error('boom')))
    reason('A fine reason')
    confirm()
    expect(await screen.findByText('That did not work. Try again.')).toBeInTheDocument()
  })

  it('closes from Cancel', () => {
    const { onClose } = show()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })
})
