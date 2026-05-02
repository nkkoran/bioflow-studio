import { describe, expect, it } from 'vitest'
import { buildAxisAlignmentReport, buildCleanupPlan, collectProtectedInputPaths, plinkSidecarsForPath } from '@/lib/dataArtifacts'
import type { PipelineSnapshot } from '@/types/pipeline'

describe('dataArtifacts', () => {
  it('infers PLINK sidecars for either fileset member', () => {
    expect(plinkSidecarsForPath('/data/ukb_chr1.bed').map((sidecar) => sidecar.path)).toEqual([
      '/data/ukb_chr1.bed',
      '/data/ukb_chr1.bim',
      '/data/ukb_chr1.fam',
    ])
    expect(plinkSidecarsForPath('/data/ukb_chr1.pvar').map((sidecar) => sidecar.path)).toEqual([
      '/data/ukb_chr1.pgen',
      '/data/ukb_chr1.pvar',
      '/data/ukb_chr1.psam',
    ])
  })

  it('protects input split files and their PLINK sidecars from cleanup', () => {
    const snapshot: PipelineSnapshot = {
      version: 1,
      id: 'p1',
      name: 'test',
      createdAt: 1,
      updatedAt: 1,
      nodes: [
        {
          id: 'geno',
          type: 'file',
          position: { x: 0, y: 0 },
          data: {
            label: 'geno',
            path: '',
            isInput: true,
            fileType: 'pgen',
            split: {
              axis: 'chrom',
              items: [{ key: '1', rawKey: '01', path: '/data/chr01.pgen' }],
            },
          },
        },
      ],
      edges: [],
    }

    expect(collectProtectedInputPaths(snapshot)).toEqual([
      '/data/chr01.pgen',
      '/data/chr01.pvar',
      '/data/chr01.psam',
    ])
  })

  it('reports mismatched split input keys for a tool node', () => {
    const snapshot: PipelineSnapshot = {
      version: 1,
      id: 'p1',
      name: 'test',
      createdAt: 1,
      updatedAt: 1,
      nodes: [
        {
          id: 'geno',
          type: 'file',
          position: { x: 0, y: 0 },
          data: {
            label: 'geno',
            path: '',
            isInput: true,
            fileType: 'pgen',
            split: { axis: 'chrom', items: [{ key: '1', path: '/data/chr1.pgen' }, { key: '2', path: '/data/chr2.pgen' }] },
          },
        },
        {
          id: 'freq',
          type: 'file',
          position: { x: 0, y: 0 },
          data: {
            label: 'freq',
            path: '',
            isInput: true,
            fileType: 'tsv',
            split: { axis: 'chrom', items: [{ key: '1', path: '/data/freq1.tsv' }, { key: '3', path: '/data/freq3.tsv' }] },
          },
        },
        {
          id: 'assoc',
          type: 'tool',
          position: { x: 0, y: 0 },
          data: { toolId: 'plink2.assoc', label: 'Assoc', paramValues: {}, status: 'idle' },
        },
      ],
      edges: [
        { id: 'e1', source: 'geno', sourceHandle: 'output', target: 'assoc', targetHandle: 'input' },
        { id: 'e2', source: 'freq', sourceHandle: 'output', target: 'assoc', targetHandle: 'read-freq' },
      ],
    }

    const report = buildAxisAlignmentReport(snapshot, 'assoc')
    expect(report.status).toBe('mismatch')
    expect(report.rows[1].missingKeys).toEqual(['2'])
    expect(report.rows[1].extraKeys).toEqual(['3'])
  })

  it('keeps merged outputs when cleanup targets auto-merge intermediates', () => {
    const snapshot: PipelineSnapshot = {
      version: 1,
      id: 'p1',
      name: 'test',
      createdAt: 1,
      updatedAt: 1,
      nodes: [
        {
          id: 'assoc',
          type: 'tool',
          position: { x: 0, y: 0 },
          data: {
            toolId: 'plink2.assoc',
            label: 'Assoc',
            paramValues: {},
            outputIntermediate: { output: true },
            status: 'idle',
          },
        },
      ],
      edges: [],
      execution: { fileLifecyclePolicy: 'delete-intermediates-on-success' },
    }

    const cleanup = buildCleanupPlan(snapshot, [{
      nodeId: 'assoc',
      label: 'Assoc',
      mode: 'array',
      script: '',
      outputPaths: ['/work/assoc.output.merged.tsv'],
      intermediatePaths: ['/work/assoc.output.1.tsv', '/work/assoc.output.2.tsv'],
    }])

    expect(cleanup.generatedIntermediatePaths).toEqual(['/work/assoc.output.1.tsv', '/work/assoc.output.2.tsv'])
  })
})
