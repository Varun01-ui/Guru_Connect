import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { catalogue } from '../testData'
import { PermissionMatrix } from './PermissionMatrix'

const onChange = vi.fn()
const show = (selected: string[], readOnly = false) => render(<PermissionMatrix catalogue={catalogue} selected={new Set(selected)} onChange={onChange} readOnly={readOnly} />)

describe('PermissionMatrix', () => {
  it('groups permissions by module with how many are selected', () => {
    show(['teachers.read'])
    const teachers = screen.getByRole('region', { name: 'Teachers' })
    expect(within(teachers).getByText('1 of 3')).toBeInTheDocument()
    expect(within(teachers).getByRole('checkbox', { name: 'teachers.read' })).toBeChecked()
    expect(within(teachers).getByRole('checkbox', { name: 'teachers.update' })).not.toBeChecked()
    expect(within(screen.getByRole('region', { name: 'Locations' })).getByText('0 of 2')).toBeInTheDocument()
  })

  it('marks sensitive permissions', () => {
    show([])
    expect(screen.getAllByText('Sensitive')).toHaveLength(1)
    expect(within(screen.getByRole('checkbox', { name: 'teachers.export' }).closest('label')!).getByText('Sensitive')).toBeInTheDocument()
  })

  it('reports a single permission being ticked and unticked', () => {
    onChange.mockClear()
    show(['teachers.read'])
    fireEvent.click(screen.getByRole('checkbox', { name: 'teachers.update' }))
    expect([...onChange.mock.calls[0]![0]].sort()).toEqual(['teachers.read', 'teachers.update'])
    fireEvent.click(screen.getByRole('checkbox', { name: 'teachers.read' }))
    expect([...onChange.mock.calls[1]![0]]).toEqual([])
  })

  it('selects and clears a whole module without touching the others', () => {
    onChange.mockClear()
    show(['locations.read'])
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all in Teachers' }))
    expect([...onChange.mock.calls[0]![0]].sort()).toEqual(['locations.read', 'teachers.export', 'teachers.read', 'teachers.update'])

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all in Locations' }))
    expect([...onChange.mock.calls[1]![0]].sort()).toEqual(['locations.manage', 'locations.read'])
  })

  it('shows a partly selected module as indeterminate and a full one as checked', () => {
    show(['teachers.read', 'locations.read', 'locations.manage'])
    expect((screen.getByRole('checkbox', { name: 'Select all in Teachers' }) as HTMLInputElement).indeterminate).toBe(true)
    expect(screen.getByRole('checkbox', { name: 'Select all in Locations' })).toBeChecked()
  })

  it('cannot be changed when read-only', () => {
    show(['teachers.read'], true)
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled()
  })
})
