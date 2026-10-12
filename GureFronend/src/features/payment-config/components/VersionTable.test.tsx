import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { version } from '../testData'
import { VersionTable } from './VersionTable'

const versions = [
  version({ id: 'a', version: 4, status: 'scheduled', amountPaise: 179900, effectiveFrom: '2026-11-01T00:00:00.000Z', changeReason: 'Diwali offer' }),
  version({ id: 'b', version: 3, status: 'active' }),
  version({ id: 'c', version: 2, status: 'superseded', amountPaise: 149900, effectiveTo: '2026-09-18T06:12:00.000Z', isEnabled: false }),
  version({ id: 'd', version: 1, status: 'cancelled', publishedBy: null, changeReason: null }),
  version({ id: 'e', version: 5, status: 'draft' }),
]
const show = (canPublish = true) => {
  const onCancel = vi.fn()
  const onRestore = vi.fn()
  render(<VersionTable versions={versions} canPublish={canPublish} onCancel={onCancel} onRestore={onRestore} />)
  return { onCancel, onRestore }
}

describe('VersionTable', () => {
  it('shows version, status, price, who and why for each row', () => {
    show()
    expect(screen.getAllByRole('row')).toHaveLength(6)
    expect(screen.getByText('v4')).toBeInTheDocument()
    expect(screen.getByText('scheduled')).toBeInTheDocument()
    expect(screen.getByText('₹1,799')).toBeInTheDocument()
    expect(screen.getByText('Diwali offer')).toBeInTheDocument()
    expect(screen.getAllByText('Farah Khan').length).toBeGreaterThan(0)
    expect(screen.getByText(/until/)).toBeInTheDocument()
    expect(screen.getByText('off')).toBeInTheDocument()
  })

  it('offers Cancel on scheduled versions and Restore on past ones only', () => {
    const { onCancel, onRestore } = show()
    expect(screen.getAllByRole('button')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel version 4' }))
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restore version 2' }))
    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }))
    expect(screen.getByRole('button', { name: 'Restore version 1' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restore version 3' })).toBeNull() // the live one
    expect(screen.queryByRole('button', { name: 'Restore version 5' })).toBeNull() // a draft
  })

  it('has no actions for someone who cannot publish', () => {
    show(false)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says so when there are no versions', () => {
    render(<VersionTable versions={[]} canPublish onCancel={vi.fn()} onRestore={vi.fn()} />)
    expect(screen.getByText('No versions yet.')).toBeInTheDocument()
  })
})
