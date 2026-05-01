import { describe, expect, it } from 'vitest'
import { estimateResources } from '@/lib/resourceEstimator'
import { getTool } from '@/lib/toolRegistry'

describe('resourceEstimator', () => {
  it('estimates chromosome-split UKB PLINK GWAS per array task instead of blanket 84h', () => {
    const tool = getTool('plink2.assoc')
    if (!tool) throw new Error('missing plink2.assoc tool')

    const estimate = estimateResources({
      tool,
      nodeData: {
        toolId: 'plink2.assoc',
        label: 'Assoc',
        paramValues: { 'pheno-name': 'cad_mi', 'covar-name': 'age sexM PC1 PC2 PC3 PC4 PC5', glm: 'hide-covar', maf: 0.01 },
        status: 'idle',
      },
      inputSizes: { input: 2_000_000_000 },
      isArray: true,
      arraySize: 22,
      hasFilter: true,
      learned: {
        toolId: 'plink2.assoc',
        sampleCount: 5,
        p50RuntimeHours: 1,
        p90MemoryGB: 20,
        p90RuntimeHours: 2,
        sourceJobIds: ['1', '2', '3', '4', '5'],
        lastUpdated: Date.now(),
      },
    })

    expect(estimate.cpus).toBe(32)
    expect(estimate.memGB).toBe(100)
    expect(estimate.timeHours).toBe(16)
    expect(estimate.source).toBe('registry')
  })

  it('keeps long walltime for unsplit UKB-scale PLINK GWAS', () => {
    const tool = getTool('plink2.assoc')
    if (!tool) throw new Error('missing plink2.assoc tool')

    const estimate = estimateResources({
      tool,
      nodeData: {
        toolId: 'plink2.assoc',
        label: 'Assoc',
        paramValues: { 'pheno-name': 'cad_mi', 'covar-name': 'age sexM PC1 PC2 PC3 PC4 PC5', glm: 'hide-covar' },
        status: 'idle',
      },
      inputSizes: { input: 44_000_000_000 },
      isArray: false,
      hasFilter: true,
    })

    expect(estimate.timeHours).toBe(84)
    expect(estimate.memGB).toBe(128)
  })
})
