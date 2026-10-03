import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DashboardPage } from './DashboardPage'

describe('DashboardPage', () => {
  it('renders a greeting heading and the KPI grid', () => {
    render(<DashboardPage />)
    expect(screen.getByRole('heading', { name: /Good (morning|afternoon|evening), there/ })).toBeInTheDocument()
    expect(screen.getByText('Total Teachers')).toBeInTheDocument()
    expect(screen.getByText('Pending Approvals')).toBeInTheDocument()
  })
})
