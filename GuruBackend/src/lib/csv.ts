// Minimal RFC 4180 reader for admin imports: commas, "quoted, fields" with "" for a quote, LF or CRLF line ends, a
// leading BOM (Excel adds one), and blank lines skipped. Returns rows of strings; the caller checks the shape.
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let touched = false // anything seen on this line, so "a,b\n\n" doesn't yield an empty row

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    if (touched) {
      endField()
      rows.push(row)
    }
    row = []
    field = ''
    touched = false
  }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') {
      quoted = true
      touched = true
    } else if (ch === ',') {
      touched = true
      endField()
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++
      endRow()
    } else {
      field += ch
      touched = true
    }
  }
  endRow()
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

/** Spreadsheets run text that starts with = + - @ as a formula; prefix such cells when exporting a CSV. */
export function neutraliseFormula(cell: string): string {
  return /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell
}
