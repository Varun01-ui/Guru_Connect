// "Apex JEE & NEET Academy" + "Koramangala" -> "apex-jee-neet-academy-koramangala" (lower-case ASCII, hyphens, max 80).
export function slugify(...parts: (string | null | undefined)[]): string {
  const text = parts.filter(Boolean).join(' ')
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
  return slug || 'institute'
}
