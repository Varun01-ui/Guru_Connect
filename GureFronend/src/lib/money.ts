// Money is integer paise everywhere (API and state); only the screen shows rupees.

/** 179900 -> "₹1,799"; 99950 -> "₹999.50". Indian digit grouping. */
export function formatRupees(paise: number): string {
  const rupees = paise / 100
  const whole = Number.isInteger(rupees)
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`
}

/** What goes in a rupee input box: 179900 -> "1799", 99950 -> "999.50". */
export function paiseToRupeesText(paise: number): string {
  const rupees = paise / 100
  return Number.isInteger(rupees) ? String(rupees) : rupees.toFixed(2)
}

/** "1,799" or "999.5" -> paise, or null if it isn't a plain amount of rupees with at most two decimals. */
export function rupeesTextToPaise(text: string): number | null {
  const cleaned = text.trim().replace(/[,\s₹]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
  const [whole, fraction = ''] = cleaned.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}
