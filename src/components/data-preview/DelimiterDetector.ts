export type Delimiter = '\t' | ',' | ' '

/**
 * Strip leading comment lines (VCF/PLINK `##meta` blocks). The *last* comment
 * line is often the column header (e.g. `#CHROM POS ID REF ALT ...` in VCF,
 * `#CHROM POS ID REF ALT` in PLINK .pvar), so we keep that one with the `#`
 * stripped.
 */
function stripMetaComments(lines: string[]): string[] {
  let firstNonMeta = 0
  while (firstNonMeta < lines.length && lines[firstNonMeta].startsWith('##')) {
    firstNonMeta++
  }
  return lines.slice(firstNonMeta)
}

export function detectDelimiter(text: string): Delimiter {
  // Strip VCF/PLINK metadata blocks so we don't pick up commas in comment text.
  const allLines = text.split('\n').filter(l => l.length > 0)
  const lines = stripMetaComments(allLines).slice(0, 20)
  if (lines.length === 0) return '\t'

  const counts = { '\t': 0, ',': 0, ' ': 0 }
  for (const line of lines) {
    counts['\t'] += (line.match(/\t/g) || []).length
    counts[','] += (line.match(/,/g) || []).length
    // Only count runs of 2+ spaces so we don't mistake spaces inside values
    // (e.g. a phenotype name) for field separators.
    counts[' '] += (line.match(/  +/g) || []).length
  }

  if (counts['\t'] >= counts[','] && counts['\t'] > 0) return '\t'
  if (counts[','] > 0) return ','
  if (counts[' '] > 0) return ' '
  return '\t'
}

/**
 * Split a line on the given delimiter while respecting RFC-4180 double-quoted
 * fields (used by CSV files exported from R/Excel/pandas). Quotes inside a
 * quoted field are escaped by doubling them (`""`).
 *
 * For tab- and multi-space-delimited files the quoting rules don't apply in
 * practice, but running them through the same parser is safe: without quotes
 * the function degrades to a plain split.
 */
function splitLine(line: string, delimiter: Delimiter): string[] {
  // Space delimiter: collapse runs of whitespace. Quoting is not idiomatic.
  if (delimiter === ' ') {
    return line.trim().split(/\s+/)
  }
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ }
        else inQuotes = false
      } else {
        cur += ch
      }
    } else if (ch === '"' && cur.length === 0) {
      inQuotes = true
    } else if (ch === delimiter) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map(cell => cell.trim())
}

export function parseTabularData(text: string, delimiter: Delimiter): { headers: string[], rows: string[][] } {
  const rawLines = text.split('\n').filter(l => l.trim())
  const lines = stripMetaComments(rawLines)
  if (lines.length === 0) return { headers: [], rows: [] }

  // VCF/PLINK header lines are prefixed with a single `#`; keep the content.
  let headerLine = lines[0]
  if (headerLine.startsWith('#')) headerLine = headerLine.substring(1)

  const headers = splitLine(headerLine, delimiter)
  const rows = lines.slice(1).map(line => {
    const cells = splitLine(line, delimiter)
    while (cells.length < headers.length) cells.push('')
    return cells.slice(0, headers.length)
  })

  return { headers, rows }
}

export function getColumnSummary(rows: string[][], colIndex: number): {
  type: 'numeric' | 'string' | 'categorical'
  nonNull: number
  total: number
  unique: number
  min?: number
  max?: number
  mean?: number
} {
  const values = rows.map(r => r[colIndex]).filter(v => v !== '' && v !== 'NA' && v !== 'na' && v !== '.')
  const total = rows.length
  const nonNull = values.length
  const unique = new Set(values).size

  const numericValues = values.map(Number).filter(n => !isNaN(n))
  if (numericValues.length > values.length * 0.8 && numericValues.length > 0) {
    return {
      type: 'numeric',
      nonNull,
      total,
      unique,
      min: Math.min(...numericValues),
      max: Math.max(...numericValues),
      mean: numericValues.reduce((a, b) => a + b, 0) / numericValues.length
    }
  }

  if (unique <= 20) {
    return { type: 'categorical', nonNull, total, unique }
  }

  return { type: 'string', nonNull, total, unique }
}
