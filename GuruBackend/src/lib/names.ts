// "Lakshmi Venkatesh" -> "Lakshmi V." — the only way another user's name is shown to a teacher (no phone, no email).
export function shortName(full: string): string {
  const [first, ...rest] = full.trim().split(/\s+/)
  return rest.length ? `${first} ${rest[rest.length - 1]![0]!.toUpperCase()}.` : (first ?? '')
}
