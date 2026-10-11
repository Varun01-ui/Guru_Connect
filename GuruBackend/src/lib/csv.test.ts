import { describe, expect, it } from 'vitest'
import { neutraliseFormula, parseCsv } from './csv.js'

describe('parseCsv', () => {
  it('reads plain rows with LF, CRLF and a missing final newline', () => {
    expect(parseCsv('a,b\n1,2\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']])
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('keeps commas, quotes and line breaks inside quoted fields', () => {
    expect(parseCsv('IN,"Andaman, Nicobar",AN\n')).toEqual([['IN', 'Andaman, Nicobar', 'AN']])
    expect(parseCsv('x,"say ""hi"""')).toEqual([['x', 'say "hi"']])
    expect(parseCsv('x,"two\nlines"')).toEqual([['x', 'two\nlines']])
  })

  it('drops a leading BOM and blank lines', () => {
    expect(parseCsv('﻿a,b\n\n \n1,2\n\n')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('keeps empty cells, so a short row is visibly short', () => {
    expect(parseCsv('IN,Kerala,KL,\nIN,Goa')).toEqual([['IN', 'Kerala', 'KL', ''], ['IN', 'Goa']])
  })

  it('returns nothing for empty input', () => {
    expect(parseCsv('')).toEqual([])
    expect(parseCsv('\n\r\n')).toEqual([])
  })
})

describe('neutraliseFormula', () => {
  it.each(['=SUM(A1)', '+1', '-1', '@cmd', '\tx'])('prefixes %j', (cell) => {
    expect(neutraliseFormula(cell)).toBe(`'${cell}`)
  })
  it('leaves ordinary text alone', () => {
    expect(neutraliseFormula('Kerala')).toBe('Kerala')
    expect(neutraliseFormula('')).toBe('')
  })
})
