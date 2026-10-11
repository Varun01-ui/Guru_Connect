import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePermissions } from '../auth/usePermissions'
import { Can } from './Can'

vi.mock('../auth/usePermissions', () => ({ usePermissions: vi.fn() }))

const grant = (keys: string[]) => vi.mocked(usePermissions).mockReturnValue({ isLoading: false, isSuperAdmin: false, can: (key) => keys.includes(key) })

beforeEach(() => vi.resetAllMocks())

describe('Can', () => {
  it('shows its children when the permission is held', () => {
    grant(['roles.manage'])
    render(<Can permission="roles.manage">New role</Can>)
    expect(screen.getByText('New role')).toBeInTheDocument()
  })

  it('shows the fallback, or nothing, when it is not', () => {
    grant([])
    const { rerender } = render(<Can permission="roles.manage">New role</Can>)
    expect(screen.queryByText('New role')).toBeNull()
    rerender(
      <Can permission="roles.manage" fallback={<span>Read only</span>}>
        New role
      </Can>,
    )
    expect(screen.getByText('Read only')).toBeInTheDocument()
  })

  it('passes when any of several permissions is held', () => {
    grant(['admins.read'])
    render(<Can anyOf={['roles.read', 'admins.read']}>Settings</Can>)
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('shows nothing for an empty list of permissions', () => {
    grant(['admins.read'])
    render(<Can anyOf={[]}>Settings</Can>)
    expect(screen.queryByText('Settings')).toBeNull()
  })
})
