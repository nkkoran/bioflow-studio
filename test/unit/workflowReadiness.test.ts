import { describe, expect, it } from 'vitest'
import { evaluateWorkflowReadiness } from '@/lib/workflowReadiness'
import type { PipelineSnapshot } from '@/types/pipeline'
import type { FileProbeResult } from '@/types/readiness'

function snapshot(nodes: PipelineSnapshot['nodes'], edges: PipelineSnapshot['edges']): PipelineSnapshot {
  return {
    version: 1,
    id: 'pipeline_test',
    name: 'test',
    createdAt: 0,
    updatedAt: 0,
    nodes,
    edges,
  }
}

function fileProbe(path: string, partial: Partial<FileProbeResult>): FileProbeResult {
  return {
    key: path,
    path,
    exists: true,
    ...partial,
  }
}

describe('workflowReadiness', () => {
  it('flags missing PLINK sidecars', () => {
    const snap = snapshot(
      [
        { id: 'geno', type: 'file', position: { x: 0, y: 0 }, data: { label: 'Genotypes', path: '/data/cohort.bed', fileType: 'plink', isInput: true } },
        { id: 'qc', type: 'tool', position: { x: 1, y: 1 }, data: { toolId: 'plink2.qc', label: 'QC', paramValues: {}, status: 'idle' } },
      ],
      [
        { id: 'e1', source: 'geno', sourceHandle: 'output', target: 'qc', targetHandle: 'input' },
      ],
    )
    const report = evaluateWorkflowReadiness(snap, {
      probes: {
        '/data/cohort.bed': fileProbe('/data/cohort.bed', {
          sidecars: { '.bim': true, '.fam': false },
          sampleIds: ['S001', 'S002'],
        }),
      },
    })
    expect(report.issues.some((issue) => issue.code === 'PLINK_SIDECAR_MISSING')).toBe(true)
  })

  it('flags zero sample overlap between genotype and phenotype inputs', () => {
    const snap = snapshot(
      [
        { id: 'geno', type: 'file', position: { x: 0, y: 0 }, data: { label: 'Genotypes', path: '/data/cohort.bed', fileType: 'plink', isInput: true } },
        { id: 'pheno', type: 'file', position: { x: 0, y: 1 }, data: { label: 'Phenotypes', path: '/data/pheno.tsv', fileType: 'tsv', isInput: true } },
        {
          id: 'assoc',
          type: 'tool',
          position: { x: 1, y: 1 },
          data: {
            toolId: 'plink2.assoc',
            label: 'Assoc',
            paramValues: { 'pheno-name': 'trait' },
            status: 'idle',
          },
        },
      ],
      [
        { id: 'e1', source: 'geno', sourceHandle: 'output', target: 'assoc', targetHandle: 'input' },
        { id: 'e2', source: 'pheno', sourceHandle: 'output', target: 'assoc', targetHandle: 'pheno' },
      ],
    )
    const report = evaluateWorkflowReadiness(snap, {
      probes: {
        '/data/cohort.bed': fileProbe('/data/cohort.bed', {
          sidecars: { '.bim': true, '.fam': true },
          sampleIds: ['S001', 'S002'],
        }),
        '/data/pheno.tsv': fileProbe('/data/pheno.tsv', {
          header: ['FID', 'IID', 'trait'],
          delimiter: '\t',
          previewRows: [['X001', 'X001', '1.2'], ['X002', 'X002', '0.4']],
          sampleIds: ['X001', 'X002'],
        }),
      },
    })
    expect(report.issues.some((issue) => issue.code === 'SAMPLE_OVERLAP_ZERO')).toBe(true)
  })

  it('warns when a GWAS p-value filter preview would remove everything', () => {
    const snap = snapshot(
      [
        { id: 'gwas', type: 'file', position: { x: 0, y: 0 }, data: { label: 'GWAS', path: '/data/gwas.tsv', fileType: 'tsv', isInput: true } },
        {
          id: 'filter',
          type: 'transform',
          position: { x: 1, y: 1 },
          data: {
            label: 'Sig hits',
            fileType: 'tsv',
            preset: 'gwas-pval-filter',
            presetConfig: { threshold: 5e-8 },
            roleMappings: {
              p_value: { roleId: 'p_value', column: 'P', confirmed: true },
            },
            status: 'idle',
          },
        },
      ],
      [
        { id: 'e1', source: 'gwas', sourceHandle: 'output', target: 'filter', targetHandle: 'input' },
      ],
    )
    const report = evaluateWorkflowReadiness(snap, {
      probes: {
        '/data/gwas.tsv': fileProbe('/data/gwas.tsv', {
          header: ['ID', 'A1', 'P'],
          delimiter: '\t',
          previewRows: [['rs1', 'A', '0.1'], ['rs2', 'G', '0.2']],
        }),
      },
    })
    expect(report.issues.some((issue) => issue.code === 'PVAL_FILTER_EMPTY_PREVIEW')).toBe(true)
  })

  it('warns when score-file builder uses odds ratios without log transform', () => {
    const snap = snapshot(
      [
        { id: 'sumstats', type: 'file', position: { x: 0, y: 0 }, data: { label: 'Sumstats', path: '/data/gwas.tsv', fileType: 'tsv', isInput: true } },
        {
          id: 'score',
          type: 'transform',
          position: { x: 1, y: 1 },
          data: {
            label: 'Score file',
            fileType: 'tsv',
            preset: 'plink-score-file',
            presetConfig: { weightTransform: 'identity' },
            roleMappings: {
              variant_id: { roleId: 'variant_id', column: 'ID', confirmed: true },
              effect_allele: { roleId: 'effect_allele', column: 'A1', confirmed: true },
              weight: { roleId: 'weight', column: 'OR', confirmed: true },
            },
            status: 'idle',
          },
        },
      ],
      [
        { id: 'e1', source: 'sumstats', sourceHandle: 'output', target: 'score', targetHandle: 'input' },
      ],
    )
    const report = evaluateWorkflowReadiness(snap, {
      probes: {
        '/data/gwas.tsv': fileProbe('/data/gwas.tsv', {
          header: ['ID', 'A1', 'OR'],
          delimiter: '\t',
          previewRows: [['rs1', 'A', '1.12'], ['rs2', 'G', '0.95']],
        }),
      },
    })
    expect(report.issues.some((issue) => issue.code === 'SCORE_WEIGHT_OR_IDENTITY')).toBe(true)
  })
})
