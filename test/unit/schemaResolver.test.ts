import { describe, expect, it } from 'vitest'
import { connectedInputSchema } from '../../src/lib/schemaResolver'
import type { PipelineSnapshot } from '../../src/types/pipeline'

describe('schemaResolver', () => {
  it('exposes declared GWAS result columns to downstream R nodes', () => {
    const snapshot: PipelineSnapshot = {
      version: 1,
      id: 'schema-test',
      name: 'Schema test',
      createdAt: 1,
      updatedAt: 1,
      nodes: [
        {
          id: 'assoc',
          type: 'tool',
          position: { x: 0, y: 0 },
          data: { toolId: 'plink2.assoc', label: 'GWAS', paramValues: {}, status: 'idle' },
        },
        {
          id: 'manhattan',
          type: 'tool',
          position: { x: 200, y: 0 },
          data: { toolId: 'plot.manhattan', label: 'Manhattan', paramValues: {}, status: 'idle' },
        },
      ],
      edges: [{ id: 'e1', source: 'assoc', target: 'manhattan', sourceHandle: 'output', targetHandle: 'sumstats' }],
    }

    const schema = connectedInputSchema(snapshot, 'manhattan', 'sumstats', {})

    expect(schema?.columns).toEqual(expect.arrayContaining(['#CHROM', 'POS', 'ID', 'P']))
    expect(schema?.roles).toEqual(expect.arrayContaining([
      { roleId: 'chromosome', column: '#CHROM' },
      { roleId: 'position', column: 'POS' },
      { roleId: 'p_value', column: 'P' },
    ]))
  })

  it('uses the first split item header when a split file node has no top-level path', () => {
    const snapshot: PipelineSnapshot = {
      version: 1,
      id: 'split-schema-test',
      name: 'Split schema test',
      createdAt: 1,
      updatedAt: 1,
      nodes: [
        {
          id: 'split',
          type: 'file',
          position: { x: 0, y: 0 },
          data: {
            label: 'Split summary stats',
            isInput: true,
            path: '',
            fileType: 'tsv',
            split: {
              axis: 'chr',
              items: [{ key: '1', path: '/project/gwas/chr1.tsv' }],
              pattern: { kind: 'manual' },
            },
          },
        },
        {
          id: 'qq',
          type: 'tool',
          position: { x: 200, y: 0 },
          data: { toolId: 'plot.qq', label: 'QQ', paramValues: {}, status: 'idle' },
        },
      ],
      edges: [{ id: 'e1', source: 'split', target: 'qq', targetHandle: 'sumstats' }],
    }

    const schema = connectedInputSchema(snapshot, 'qq', 'sumstats', {
      '/project/gwas/chr1.tsv': { columns: ['CHR', 'BP', 'P'], delimiter: '\t', fetchedAt: 1 },
    })

    expect(schema?.columns).toEqual(['CHR', 'BP', 'P'])
    expect(schema?.sourcePath).toBe('/project/gwas/chr1.tsv')
  })

  it('maps REGENIE LOG10P output as the p-value role for plotting', () => {
    const snapshot: PipelineSnapshot = {
      version: 1,
      id: 'regenie-schema-test',
      name: 'REGENIE schema test',
      createdAt: 1,
      updatedAt: 1,
      nodes: [
        {
          id: 'regenie',
          type: 'tool',
          position: { x: 0, y: 0 },
          data: { toolId: 'regenie.step2', label: 'REGENIE Step 2', paramValues: {}, status: 'idle' },
        },
        {
          id: 'qq',
          type: 'tool',
          position: { x: 200, y: 0 },
          data: { toolId: 'plot.qq', label: 'QQ', paramValues: {}, status: 'idle' },
        },
      ],
      edges: [{ id: 'e1', source: 'regenie', target: 'qq', sourceHandle: 'output', targetHandle: 'sumstats' }],
    }

    const schema = connectedInputSchema(snapshot, 'qq', 'sumstats', {})

    expect(schema?.columns).toEqual(expect.arrayContaining(['CHROM', 'GENPOS', 'ID', 'LOG10P']))
    expect(schema?.roles).toContainEqual({ roleId: 'p_value', column: 'LOG10P' })
  })
})
