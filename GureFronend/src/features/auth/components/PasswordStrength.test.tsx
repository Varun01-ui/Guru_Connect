import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { isPasswordAcceptable, passwordChecks } from '../passwordPolicy'
import { PasswordStrength } from './PasswordStrength'

describe('passwordChecks', () => {
  it('fails everything for an empty password', () => {
    expect(passwordChecks('').map((c) => c.ok)).toEqual([false, false])
  })

  it('checks length and character classes independently', () => {
    expect(passwordChecks('alllowercaseletters')).toEqual([
      expect.objectContaining({ id: 'length', ok: true }),
      expect.objectContaining({ id: 'classes', ok: false }),
    ])
    expect(passwordChecks('Aa1!')).toEqual([
      expect.objectContaining({ id: 'length', ok: false }),
      expect.objectContaining({ id: 'classes', ok: true }),
    ])
  })

  it('flags a password equal to the email or name', () => {
    const ctx = { email: 'priya@guruconnect.in', fullName: 'Priya Sharma' }
    expect(passwordChecks('priya@guruconnect.in', ctx).find((c) => c.id === 'identity')?.ok).toBe(false)
    expect(passwordChecks('Priya Sharma', ctx).find((c) => c.id === 'identity')?.ok).toBe(false)
    expect(passwordChecks('Maple!Lantern-2026', ctx).find((c) => c.id === 'identity')?.ok).toBe(true)
  })
})

describe('isPasswordAcceptable', () => {
  it('accepts a policy-compliant password', () => {
    expect(isPasswordAcceptable('Maple!Lantern-2026')).toBe(true)
  })

  it('rejects short, single-class and over-long passwords', () => {
    expect(isPasswordAcceptable('Short1!')).toBe(false)
    expect(isPasswordAcceptable('alllowercaseletters')).toBe(false)
    expect(isPasswordAcceptable(`Aa1!${'x'.repeat(130)}`)).toBe(false)
  })
})

describe('PasswordStrength', () => {
  it('renders each requirement and marks the met ones', () => {
    render(<PasswordStrength password="Maple!Lantern" />)
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items.every((li) => li.getAttribute('data-ok') === 'true')).toBe(true)
  })

  it('marks unmet requirements', () => {
    render(<PasswordStrength password="abc" />)
    expect(screen.getAllByRole('listitem').every((li) => li.getAttribute('data-ok') === 'false')).toBe(true)
    expect(screen.getAllByText('(not met yet)')).toHaveLength(2)
  })
})
