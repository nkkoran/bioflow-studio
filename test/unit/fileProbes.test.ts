import { describe, expect, it } from 'vitest'
import { analyzeDelimitedProbe, parseFastqRecordIds, plinkSidecarSuffixes } from '@/lib/fileProbes'

describe('fileProbes helpers', () => {
  it('extracts sample and variant IDs from tabular previews', () => {
    const probe = analyzeDelimitedProbe(
      'gwas.tsv',
      'FID\tIID\tID\tP\nF001\tS001\trs1\t0.01\nF002\tS002\trs2\t0.20\n',
    )
    expect(probe.header).toEqual(['FID', 'IID', 'ID', 'P'])
    expect(probe.sampleIds).toEqual(['S001', 'S002'])
    expect(probe.recordIds).toEqual(['rs1', 'rs2'])
  })

  it('returns the expected PLINK sidecars for BED and PGEN filesets', () => {
    expect(plinkSidecarSuffixes('cohort.bed')).toEqual(['.bim', '.fam'])
    expect(plinkSidecarSuffixes('cohort.pgen')).toEqual(['.pvar', '.psam'])
  })

  it('normalizes paired-end FASTQ read names', () => {
    const ids = parseFastqRecordIds('@READ_1/1 comment\nACGT\n+\n!!!!\n@READ_2/2\nTGCA\n+\n!!!!\n')
    expect(ids).toEqual(['READ_1', 'READ_2'])
  })
})
