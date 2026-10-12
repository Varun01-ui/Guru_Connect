import { describe, expect, it } from 'vitest'
import { formatRupees, paiseToRupeesText, rupeesTextToPaise } from './money'

describe('money', () => {
  it.each([
    [0, '₹0'],
    [49900, '₹499'],
    [179900, '₹1,799'],
    [10_000_000, '₹1,00,000'],
    [99950, '₹999.50'],
  ])('formats %i paise as %s', (paise, text) => {
    expect(formatRupees(paise)).toBe(text)
  })

  it('shows paise in an input as plain rupees', () => {
    expect(paiseToRupeesText(179900)).toBe('1799')
    expect(paiseToRupeesText(99950)).toBe('999.50')
    expect(paiseToRupeesText(0)).toBe('0')
  })

  it.each([
    ['1799', 179900],
    ['1,799', 179900],
    ['₹ 1,799.5', 179950],
    ['999.50', 99950],
    ['0', 0],
    ['0.05', 5],
    ['100000', 10_000_000],
  ])('reads “%s” as %i paise', (text, paise) => {
    expect(rupeesTextToPaise(text)).toBe(paise)
  })

  it.each(['', 'abc', '12.345', '-5', '1.2.3', '1e3'])('rejects “%s”', (text) => {
    expect(rupeesTextToPaise(text)).toBeNull()
  })
})
