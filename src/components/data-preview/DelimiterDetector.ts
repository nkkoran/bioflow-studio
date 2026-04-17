export type Delimiter = '\t' | ',' | ' '

export function detectDelimiter(text: string): Delimiter {
  // Sample first 5 lines
  const lines = text.split('\n').slice(0, 5).filter(l => l.trim())
  if (lines.length === 0) return '\t'

  // Count occurrences of each delimiter across all lines
  const counts = { '\t': 0, ',': 0, ' ': 0 }
  for (const line of lines) {
    counts['\t'] += (line.match(/\t/g) || []).length
    counts[','] += (line.match(/,/g) || []).length
    // For space, only count when there's 2+ consecutive spaces (to avoid counting spaces in values)
    counts[' '] += (line.match(/  +/g) || []).length
  }

  // Pick the delimiter with highest count (prefer tab, then comma, then space as tiebreaker)
  if (counts['\t'] >= counts[','] && counts['\t'] > 0) return '\t'
  if (counts[','] > 0) return ','
  if (counts[' '] > 0) return ' '
  return '\t'
}

export function parseTabularData(text: string, delimiter: Delimiter): { headers: string[], rows: string[][] } {
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length === 0) return { headers: [], rows: [] }

  // Handle comment lines at the start (e.g., #CHROM in .pvar files - still use as header but strip #)
  let headerLine = lines[0]
  if (headerLine.startsWith('#')) headerLine = headerLine.substring(1)

  const headers = headerLine.split(delimiter).map(h => h.trim())
  const rows = lines.slice(1).map(line => {
    const cells = line.split(delimiter).map(c => c.trim())
    // Pad or trim to match header count
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

  // Try to detect numeric
  const numericValues = values.map(Number).filter(n => !isNaN(n))
  if (numericValues.length > values.length * 0.8) {
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
