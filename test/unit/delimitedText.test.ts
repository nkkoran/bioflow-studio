import { describe, expect, it } from 'vitest'
import { detectDelimiter, parseTabularData } from '@/lib/delimitedText'

describe('delimitedText', () => {
  it('detects TSV headers reliably', () => {
    const text = 'FID\tIID\ttrait\nF001\tS001\t1.2\n'
    expect(detectDelimiter(text)).toBe('\t')
    expect(parseTabularData(text).headers).toEqual(['FID', 'IID', 'trait'])
  })

  it('parses quoted CSV values without splitting inside quotes', () => {
    const text = 'sample_id,group,note\nS001,EUR,"needs, review"\n'
    const parsed = parseTabularData(text)
    expect(parsed.delimiter).toBe(',')
    expect(parsed.rows[0]).toEqual(['S001', 'EUR', 'needs, review'])
  })
})
