export type Delimiter = '\t' | ',' | ' ' | ';' | '|'

const DELIMITERS: Delimiter[] = ['\t', ',', ' ', ';', '|']

function stripMetaComments(lines: string[]): string[] {
  let firstNonMeta = 0
  while (firstNonMeta < lines.length && lines[firstNonMeta].startsWith('##')) {
    firstNonMeta++
  }
  return lines.slice(firstNonMeta)
}

function dataLines(text: string): string[] {
  return stripMetaComments(text.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim()))
}

export function delimiterForPath(path: string): Delimiter {
  const lower = path.toLowerCase()
  if (lower.endsWith('.csv')) return ','
  if (lower.endsWith('.psv')) return '|'
  if (lower.endsWith('.ssv')) return ' '
  return '\t'
}

export function splitDelimitedLine(line: string, delimiter: Delimiter): string[] {
  if (delimiter === ' ') {
    return line.trim().split(/\s+/).map((cell) => cell.trim())
  }

  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"' && cur.length === 0) {
      inQuotes = true
    } else if (ch === delimiter) {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur.trim())
  return out
}

function scoreDelimiter(lines: string[], delimiter: Delimiter): number {
  const widths = lines
    .map((line) => splitDelimitedLine(line.startsWith('#') ? line.slice(1) : line, delimiter).length)
    .filter((width) => width > 1)
  if (widths.length === 0) return 0

  const counts = new Map<number, number>()
  for (const width of widths) counts.set(width, (counts.get(width) ?? 0) + 1)
  const mode = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]
  const consistency = mode ? mode[1] / widths.length : 0
  const averageWidth = widths.reduce((sum, width) => sum + width, 0) / widths.length
  const coverage = widths.length / Math.max(lines.length, 1)
  return averageWidth * 5 + consistency * 20 + coverage * 10
}

export function detectDelimiter(text: string, preferred?: Delimiter): Delimiter {
  const lines = dataLines(text).slice(0, 30)
  if (lines.length === 0) return preferred ?? '\t'

  const ranked = DELIMITERS
    .map((delimiter) => ({
      delimiter,
      score: scoreDelimiter(lines, delimiter) + (delimiter === preferred ? 0.5 : 0),
    }))
    .sort((a, b) => b.score - a.score)

  return ranked[0]?.score ? ranked[0].delimiter : preferred ?? '\t'
}

export function parseHeaderLine(text: string, delimiter?: Delimiter): { columns: string[]; delimiter: Delimiter } {
  const lines = dataLines(text)
  if (lines.length === 0) return { columns: [], delimiter: delimiter ?? '\t' }

  const detected = delimiter ?? detectDelimiter(text)
  const headerLine = lines[0].startsWith('#') ? lines[0].slice(1) : lines[0]
  return {
    columns: splitDelimitedLine(headerLine, detected).filter(Boolean),
    delimiter: detected,
  }
}

export function parseTabularData(text: string, delimiter?: Delimiter): { headers: string[]; rows: string[][]; delimiter: Delimiter } {
  const lines = dataLines(text)
  if (lines.length === 0) return { headers: [], rows: [], delimiter: delimiter ?? '\t' }

  const detected = delimiter ?? detectDelimiter(text)
  const headerLine = lines[0].startsWith('#') ? lines[0].slice(1) : lines[0]
  const headers = splitDelimitedLine(headerLine, detected).filter(Boolean)
  const rows = lines.slice(1).map((line) => {
    const cells = splitDelimitedLine(line, detected)
    while (cells.length < headers.length) cells.push('')
    return cells.slice(0, headers.length)
  })

  return { headers, rows, delimiter: detected }
}
