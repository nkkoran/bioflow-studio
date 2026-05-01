import { describe, expect, it } from 'vitest'
import { evaluateWorkflowReadiness } from '@/lib/workflowReadiness'
import { inputFileNodes } from '@/stores/readinessStore'
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
  it('collects split input file items as probe targets', () => {
    const snap = snapshot(
      [
        {
          id: 'split',
          type: 'file',
          position: { x: 0, y: 0 },
          data: {
            label: 'Split genotypes',
            path: '',
            fileType: 'plink',
            isInput: true,
            split: {
              axis: 'chrom',
              items: [
                { key: '1', path: '/data/chr1.pgen' },
                { key: '2', path: '/data/chr2.pgen' },
              ],
              pattern: { kind: 'manual' },
            },
          },
        },
      ],
      [],
    )

    expect(inputFileNodes(snap)).toEqual([
      { path: '/data/chr1.pgen', fileType: 'plink', origin: 'ssh', projectId: undefined },
      { path: '/data/chr2.pgen', fileType: 'plink', origin: 'ssh', projectId: undefined },
    ])
  })

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

  it('does not warn when a keep file is a preview subset of the phenotype samples', () => {
    const snap = snapshot(
      [
        { id: 'geno', type: 'file', position: { x: 0, y: 0 }, data: { label: 'Genotypes', path: '/data/cohort.bed', fileType: 'plink', isInput: true } },
        { id: 'pheno', type: 'file', position: { x: 0, y: 1 }, data: { label: 'Phenotypes', path: '/data/pheno.tsv', fileType: 'tsv', isInput: true } },
        { id: 'keep', type: 'file', position: { x: 0, y: 2 }, data: { label: 'Keep', path: '/data/keep.txt', fileType: 'txt', isInput: true } },
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
        { id: 'e3', source: 'keep', sourceHandle: 'output', target: 'assoc', targetHandle: 'keep' },
      ],
    )
    const report = evaluateWorkflowReadiness(snap, {
      probes: {
        '/data/cohort.bed': fileProbe('/data/cohort.bed', {
          sidecars: { '.bim': true, '.fam': true },
          sampleIds: ['S001', 'S002', 'S003'],
        }),
        '/data/pheno.tsv': fileProbe('/data/pheno.tsv', {
          header: ['FID', 'IID', 'trait'],
          delimiter: '\t',
          previewRows: [['F1', 'S001', '1.2'], ['F1', 'S002', '0.4'], ['F1', 'S003', '1.1']],
        }),
        '/data/keep.txt': fileProbe('/data/keep.txt', {
          delimiter: ' ',
          previewRows: [['F1', 'S001'], ['F1', 'S999']],
        }),
      },
    })
    expect(report.issues.some((issue) => issue.code.includes('SAMPLE_OVERLAP') && issue.code !== 'SAMPLE_OVERLAP_ZERO')).toBe(false)
  })

  it('treats nonzero partial sample overlap as a preview note instead of a warning', () => {
    const snap = snapshot(
      [
        { id: 'geno', type: 'file', position: { x: 0, y: 0 }, data: { label: 'Genotypes', path: '/data/cohort.bed', fileType: 'plink', isInput: true } },
        { id: 'pheno', type: 'file', position: { x: 0, y: 1 }, data: { label: 'Phenotypes', path: '/data/pheno.tsv', fileType: 'tsv', isInput: true } },
        { id: 'covar', type: 'file', position: { x: 0, y: 2 }, data: { label: 'Covariates', path: '/data/covar.tsv', fileType: 'tsv', isInput: true } },
        {
          id: 'assoc',
          type: 'tool',
          position: { x: 1, y: 1 },
          data: {
            toolId: 'plink2.assoc',
            label: 'Assoc',
            paramValues: { 'pheno-name': 'trait', 'covar-name': 'age' },
            status: 'idle',
          },
        },
      ],
      [
        { id: 'e1', source: 'geno', sourceHandle: 'output', target: 'assoc', targetHandle: 'input' },
        { id: 'e2', source: 'pheno', sourceHandle: 'output', target: 'assoc', targetHandle: 'pheno' },
        { id: 'e3', source: 'covar', sourceHandle: 'output', target: 'assoc', targetHandle: 'covar' },
      ],
    )
    const report = evaluateWorkflowReadiness(snap, {
      probes: {
        '/data/cohort.bed': fileProbe('/data/cohort.bed', {
          sidecars: { '.bim': true, '.fam': true },
          sampleIds: ['S001', 'S002', 'S003'],
        }),
        '/data/pheno.tsv': fileProbe('/data/pheno.tsv', {
          header: ['FID', 'IID', 'trait'],
          delimiter: '\t',
          previewRows: [['F1', 'S001', '1.2'], ['F1', 'S002', '0.4'], ['F1', 'S003', '1.1']],
        }),
        '/data/covar.tsv': fileProbe('/data/covar.tsv', {
          header: ['FID', 'IID', 'age'],
          delimiter: '\t',
          previewRows: [['F1', 'S001', '54'], ['F1', 'S999', '63']],
        }),
      },
    })
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'SAMPLE_OVERLAP_PREVIEW_PARTIAL',
      severity: 'info',
    }))
    expect(report.issues.some((issue) => issue.code === 'SAMPLE_OVERLAP_PARTIAL')).toBe(false)
  })

  it('warns when a selected PLINK binary phenotype appears to be 0/1-coded without --1', () => {
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
            paramValues: { 'pheno-name': 'cad_mi' },
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
          sampleIds: ['S001', 'S002', 'S003', 'S004', 'S005', 'S006'],
        }),
        '/data/pheno.tsv': fileProbe('/data/pheno.tsv', {
          header: ['FID', 'IID', 'cad_mi'],
          delimiter: '\t',
          previewRows: [
            ['F1', 'S001', '0'],
            ['F1', 'S002', '0'],
            ['F1', 'S003', '1'],
            ['F1', 'S004', '0'],
            ['F1', 'S005', '1'],
            ['F1', 'S006', '0'],
          ],
        }),
      },
    })
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'PLINK_BINARY_PHENO_01_NEEDS_ONE',
      severity: 'warning',
    }))
  })

  it('does not warn for 0/1 PLINK phenotypes when --1 is already enabled', () => {
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
            paramValues: { 'pheno-name': 'cad_mi', one: true },
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
          sampleIds: ['S001', 'S002', 'S003', 'S004', 'S005', 'S006'],
        }),
        '/data/pheno.tsv': fileProbe('/data/pheno.tsv', {
          header: ['FID', 'IID', 'cad_mi'],
          delimiter: '\t',
          previewRows: [
            ['F1', 'S001', '0'],
            ['F1', 'S002', '0'],
            ['F1', 'S003', '1'],
            ['F1', 'S004', '0'],
            ['F1', 'S005', '1'],
            ['F1', 'S006', '0'],
          ],
        }),
      },
    })
    expect(report.issues.some((issue) => issue.code === 'PLINK_BINARY_PHENO_01_NEEDS_ONE')).toBe(false)
  })

  it('suggests PLINK iid-only and allow-no-covars when phenotype input shape needs it', () => {
    const snap = snapshot(
      [
        { id: 'geno', type: 'file', position: { x: 0, y: 0 }, data: { label: 'Genotypes', path: '/data/cohort.pgen', fileType: 'plink', isInput: true } },
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
        '/data/cohort.pgen': fileProbe('/data/cohort.pgen', {
          sidecars: { '.pvar': true, '.psam': true },
          sampleIds: ['S001', 'S002'],
        }),
        '/data/pheno.tsv': fileProbe('/data/pheno.tsv', {
          header: ['IID', 'trait'],
          delimiter: '\t',
          previewRows: [['S001', '12.4'], ['S002', '15.1']],
        }),
      },
    })
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'PLINK_PHENO_IID_ONLY',
      details: expect.objectContaining({ quickFixFlagId: 'pheno-iid-only' }),
    }))
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'PLINK_GLM_NO_COVARS_NEEDS_FLAG',
      details: expect.objectContaining({ quickFixFlagId: 'allow-no-covars' }),
    }))
  })

  it('warns when UKB-scale PLINK GWAS resources are below the safety recommendation', () => {
    const snap = snapshot(
      [
        {
          id: 'geno',
          type: 'file',
          position: { x: 0, y: 0 },
          data: {
            label: 'Split genotypes',
            path: '',
            fileType: 'plink',
            isInput: true,
            split: {
              axis: 'chrom',
              items: Array.from({ length: 22 }, (_, index) => ({
                key: String(index + 1),
                path: `/data/ukb/chr${index + 1}.pgen`,
              })),
            },
          },
        },
        { id: 'pheno', type: 'file', position: { x: 0, y: 1 }, data: { label: 'Phenotypes', path: '/data/pheno.tsv', fileType: 'tsv', isInput: true } },
        {
          id: 'assoc',
          type: 'tool',
          position: { x: 1, y: 1 },
          data: {
            toolId: 'plink2.assoc',
            label: 'Assoc',
            paramValues: { 'pheno-name': 'cad_mi', 'covar-name': 'age sexM PC1 PC2 PC3 PC4 PC5', glm: 'hide-covar' },
            slurmOverride: { cpus: 8, memoryGB: 32, timeHours: 4 },
            status: 'idle',
          },
        },
      ],
      [
        { id: 'e1', source: 'geno', sourceHandle: 'output', target: 'assoc', targetHandle: 'input' },
        { id: 'e2', source: 'pheno', sourceHandle: 'output', target: 'assoc', targetHandle: 'pheno' },
      ],
    )
    const probes: Record<string, FileProbeResult> = {
      '/data/pheno.tsv': fileProbe('/data/pheno.tsv', {
        header: ['FID', 'IID', 'cad_mi'],
        delimiter: '\t',
        previewRows: [['F1', 'S001', '1'], ['F1', 'S002', '2']],
      }),
    }
    for (let chr = 1; chr <= 22; chr++) {
      probes[`/data/ukb/chr${chr}.pgen`] = fileProbe(`/data/ukb/chr${chr}.pgen`, {
        size: 2_000_000_000,
        sidecars: { '.pvar': true, '.psam': true },
      })
    }

    const report = evaluateWorkflowReadiness(snap, { probes })
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'PLINK_GWAS_RESOURCES_LOW',
      category: 'Resources',
      details: expect.objectContaining({
        quickFixResourceCpus: 32,
        quickFixResourceMemoryGB: 100,
        quickFixResourceTimeHours: 16,
      }),
    }))
  })

  it('checks PLINK score headers, column numbers, duplicate IDs, and allele mismatches', () => {
    const snap = snapshot(
      [
        { id: 'geno', type: 'file', position: { x: 0, y: 0 }, data: { label: 'Genotypes', path: '/data/target.pgen', fileType: 'plink', isInput: true } },
        { id: 'scorefile', type: 'file', position: { x: 0, y: 1 }, data: { label: 'Score', path: '/data/score.tsv', fileType: 'tsv', isInput: true } },
        {
          id: 'score',
          type: 'tool',
          position: { x: 1, y: 1 },
          data: {
            toolId: 'plink2.score',
            label: 'Score',
            paramValues: { 'score-col-nums': '3 4 5' },
            status: 'idle',
          },
        },
      ],
      [
        { id: 'e1', source: 'geno', sourceHandle: 'output', target: 'score', targetHandle: 'input' },
        { id: 'e2', source: 'scorefile', sourceHandle: 'output', target: 'score', targetHandle: 'score' },
      ],
    )
    const report = evaluateWorkflowReadiness(snap, {
      probes: {
        '/data/target.pgen': fileProbe('/data/target.pgen', {
          sidecars: { '.pvar': true, '.psam': true },
          sampleIds: ['S001', 'S002'],
          variantHeader: ['#CHROM', 'POS', 'ID', 'REF', 'ALT'],
          variantPreviewRows: [['1', '101', 'rs1', 'A', 'G'], ['1', '102', 'rs2', 'C', 'T']],
        }),
        '/data/score.tsv': fileProbe('/data/score.tsv', {
          header: ['ID', 'A1', 'BETA'],
          delimiter: '\t',
          previewRows: [['rs1', 'T', '0.2'], ['rs1', 'G', '0.3']],
        }),
      },
    })
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'PLINK_SCORE_COL_NUMS_MISMATCH',
      details: expect.objectContaining({ quickFixFlagId: 'score-col-nums', quickFixValue: '1 2 3' }),
    }))
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'PLINK_SCORE_DUPLICATE_IDS',
      details: expect.objectContaining({ quickFixFlagId: 'ignore-dup-ids' }),
    }))
    expect(report.issues.some((issue) => issue.code === 'PLINK_SCORE_ALLELE_MISMATCH_PREVIEW')).toBe(true)
  })

  it('checks PLINK genotype variant previews for common variant hazards', () => {
    const snap = snapshot(
      [
        { id: 'geno', type: 'file', position: { x: 0, y: 0 }, data: { label: 'Genotypes', path: '/data/cohort.pgen', fileType: 'plink', isInput: true } },
        { id: 'pheno', type: 'file', position: { x: 0, y: 1 }, data: { label: 'Phenotypes', path: '/data/pheno.tsv', fileType: 'tsv', isInput: true } },
        {
          id: 'assoc',
          type: 'tool',
          position: { x: 1, y: 1 },
          data: {
            toolId: 'plink2.assoc',
            label: 'Assoc',
            paramValues: { 'pheno-name': 'trait', 'allow-no-covars': true },
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
        '/data/cohort.pgen': fileProbe('/data/cohort.pgen', {
          sidecars: { '.pvar': true, '.psam': true },
          sampleIds: ['S001', 'S002'],
          variantHeader: ['#CHROM', 'POS', 'ID', 'REF', 'ALT'],
          variantPreviewRows: [
            ['GL0001', '101', 'rs1', 'A', 'G'],
            ['1', '102', 'rs1', 'C', 'T'],
            ['1', '103', '.', 'A', 'C,G'],
            ['1', '104', 'rs4', 'AT', 'A'],
          ],
        }),
        '/data/pheno.tsv': fileProbe('/data/pheno.tsv', {
          header: ['FID', 'IID', 'trait'],
          delimiter: '\t',
          previewRows: [['F1', 'S001', '2.1'], ['F1', 'S002', '3.2']],
        }),
      },
    })
    expect(report.issues.some((issue) => issue.code === 'PLINK_DUPLICATE_VARIANT_IDS')).toBe(true)
    expect(report.issues.some((issue) => issue.code === 'PLINK_MISSING_VARIANT_IDS')).toBe(true)
    expect(report.issues.some((issue) => issue.code === 'PLINK_MULTIALLELIC_VARIANTS')).toBe(true)
    expect(report.issues.some((issue) => issue.code === 'PLINK_EXTRA_CHROMOSOMES')).toBe(true)
  })

  it('warns about ambiguous -9 phenotype values and collinear covariates', () => {
    const snap = snapshot(
      [
        { id: 'geno', type: 'file', position: { x: 0, y: 0 }, data: { label: 'Genotypes', path: '/data/cohort.pgen', fileType: 'plink', isInput: true } },
        { id: 'pheno', type: 'file', position: { x: 0, y: 1 }, data: { label: 'Phenotypes', path: '/data/pheno.tsv', fileType: 'tsv', isInput: true } },
        { id: 'covar', type: 'file', position: { x: 0, y: 2 }, data: { label: 'Covariates', path: '/data/covar.tsv', fileType: 'tsv', isInput: true } },
        {
          id: 'assoc',
          type: 'tool',
          position: { x: 1, y: 1 },
          data: {
            toolId: 'plink2.assoc',
            label: 'Assoc',
            paramValues: { 'pheno-name': 'trait', 'covar-name': 'age age_copy' },
            status: 'idle',
          },
        },
      ],
      [
        { id: 'e1', source: 'geno', sourceHandle: 'output', target: 'assoc', targetHandle: 'input' },
        { id: 'e2', source: 'pheno', sourceHandle: 'output', target: 'assoc', targetHandle: 'pheno' },
        { id: 'e3', source: 'covar', sourceHandle: 'output', target: 'assoc', targetHandle: 'covar' },
      ],
    )
    const report = evaluateWorkflowReadiness(snap, {
      probes: {
        '/data/cohort.pgen': fileProbe('/data/cohort.pgen', {
          sidecars: { '.pvar': true, '.psam': true },
          sampleIds: ['S001', 'S002', 'S003', 'S004'],
        }),
        '/data/pheno.tsv': fileProbe('/data/pheno.tsv', {
          header: ['FID', 'IID', 'trait'],
          delimiter: '\t',
          previewRows: [['F1', 'S001', '-9'], ['F1', 'S002', '-8.5'], ['F1', 'S003', '2.2'], ['F1', 'S004', '3.4']],
        }),
        '/data/covar.tsv': fileProbe('/data/covar.tsv', {
          header: ['FID', 'IID', 'age', 'age_copy'],
          delimiter: '\t',
          previewRows: [['F1', 'S001', '40', '40'], ['F1', 'S002', '50', '50'], ['F1', 'S003', '60', '60'], ['F1', 'S004', '70', '70']],
        }),
      },
    })
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'PLINK_NEG9_PHENO_AMBIGUOUS',
      details: expect.objectContaining({ quickFixFlagId: 'neg9-pheno-really-missing' }),
    }))
    expect(report.issues.some((issue) => issue.code === 'PLINK_COVARIATE_COLLINEAR_PREVIEW')).toBe(true)
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
