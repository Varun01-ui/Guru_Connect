import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyTheme } from './theme'

const prefersDark = (dark: boolean) => vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: dark }))

afterEach(() => {
  document.documentElement.removeAttribute('data-theme')
  vi.unstubAllGlobals()
})

describe('applyTheme', () => {
  it('sets data-theme="dark" for dark and clears it for light', () => {
    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    applyTheme('light')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('follows the operating system for "system"', () => {
    prefersDark(true)
    applyTheme('system')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    prefersDark(false)
    applyTheme('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('treats a missing choice like "system" and survives a browser without matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined)
    applyTheme(undefined)
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })
})
