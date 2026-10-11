/** "1 teacher", "13 teachers" — pass the plural for irregular nouns ("child", "children"). */
export function countLabel(n: number, singular: string, plural = `${singular}s`) {
  return `${n} ${n === 1 ? singular : plural}`
}
