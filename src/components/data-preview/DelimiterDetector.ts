export { detectDelimiter, parseTabularData, type Delimiter } from '@/lib/delimitedText'

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
    let min = numericValues[0]
    let max = numericValues[0]
    for (let i = 1; i < numericValues.length; i++) {
      const value = numericValues[i]
      if (value < min) min = value
      if (value > max) max = value
    }
    return {
      type: 'numeric',
      nonNull,
      total,
      unique,
      min,
      max,
      mean: numericValues.reduce((a, b) => a + b, 0) / numericValues.length
    }
  }

  if (unique <= 20) {
    return { type: 'categorical', nonNull, total, unique }
  }

  return { type: 'string', nonNull, total, unique }
}
