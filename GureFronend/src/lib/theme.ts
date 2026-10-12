export type ThemeChoice = 'light' | 'dark' | 'system'

// The design tokens switch on `data-theme="dark"` on <html>; light is the default with no attribute.
export function applyTheme(choice: ThemeChoice | string | undefined | null): void {
  if (typeof document === 'undefined') return
  const prefersDark = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
  const dark = choice === 'dark' || (choice !== 'light' && prefersDark)
  if (dark) document.documentElement.setAttribute('data-theme', 'dark')
  else document.documentElement.removeAttribute('data-theme')
}
