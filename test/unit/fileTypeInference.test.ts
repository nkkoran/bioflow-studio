import { describe, expect, it } from 'vitest'
import { inferFileType } from '@/lib/fileTypeInference'

describe('fileTypeInference', () => {
  it('handles compressed compound extensions first', () => {
    expect(inferFileType('cohort.vcf.gz')).toBe('vcf')
    expect(inferFileType('reads.fastq.gz')).toBe('fastq')
  })

  it('recognizes common PLINK and tabular inputs', () => {
    expect(inferFileType('cohort.bed')).toBe('bed')
    expect(inferFileType('phenotypes.tsv')).toBe('tsv')
    expect(inferFileType('notes.txt')).toBe('txt')
  })
})
