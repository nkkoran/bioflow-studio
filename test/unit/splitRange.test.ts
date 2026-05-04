import { describe, expect, it } from 'vitest'
import { parseRangeKeys, resolveSplitItemsForRange } from '@/lib/splitRange'

describe('split range helpers', () => {
  it('expands numeric ranges without duplicates', () => {
    expect(parseRangeKeys('1-3,3,5')).toEqual(['1', '2', '3', '5'])
  })

  it('never creates blank paths for manual splits without an inferrable recipe', () => {
    const result = resolveSplitItemsForRange(
      '1-2',
      [],
      { kind: 'manual' },
      'chrom',
    )

    expect(result.error).toContain('cannot infer')
    expect(result.items).toEqual([])
  })

  it('infers UKB-style chromosome paths from accepted rows', () => {
    const result = resolveSplitItemsForRange(
      '1-3',
      [
        { key: '1', path: '/ukb/genotype/ukb22828_c1_b0_v3.pgen' },
        { key: '2', path: '/ukb/genotype/ukb22828_c2_b0_v3.pgen' },
      ],
      { kind: 'manual' },
      'chrom',
    )

    expect(result.error).toBeUndefined()
    expect(result.items.map((item) => item.path)).toEqual([
      '/ukb/genotype/ukb22828_c1_b0_v3.pgen',
      '/ukb/genotype/ukb22828_c2_b0_v3.pgen',
      '/ukb/genotype/ukb22828_c3_b0_v3.pgen',
    ])
  })

  it('infers UKB paths when the chromosome appears in both folder and filename', () => {
    const result = resolveSplitItemsForRange(
      '1-3',
      [
        { key: '1', path: '/ukb/genotype/chr1/ukb_imp_chr1_v3.pgen' },
        { key: '2', path: '/ukb/genotype/chr2/ukb_imp_chr2_v3.pgen' },
      ],
      { kind: 'manual' },
      'chrom',
    )

    expect(result.error).toBeUndefined()
    expect(result.items.map((item) => item.path)).toEqual([
      '/ukb/genotype/chr1/ukb_imp_chr1_v3.pgen',
      '/ukb/genotype/chr2/ukb_imp_chr2_v3.pgen',
      '/ukb/genotype/chr3/ukb_imp_chr3_v3.pgen',
    ])
  })

  it('uses explicit glob recipes for new split keys', () => {
    const result = resolveSplitItemsForRange(
      '1-3',
      [{ key: '1', path: '/data/chr1/genotypes.pgen' }],
      { kind: 'crossFolder', parentDir: '/data', childGlob: 'chr*', file: 'genotypes.pgen' },
      'chrom',
    )

    expect(result.error).toBeUndefined()
    expect(result.items.map((item) => item.path)).toEqual([
      '/data/chr1/genotypes.pgen',
      '/data/chr2/genotypes.pgen',
      '/data/chr3/genotypes.pgen',
    ])
  })
})
