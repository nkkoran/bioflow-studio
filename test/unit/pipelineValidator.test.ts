import { describe, expect, it } from 'vitest'
import { validatePipeline } from '@/lib/pipelineValidator'
import type { PipelineSnapshot } from '@/types/pipeline'

function snapshot(nodes: PipelineSnapshot['nodes'], edges: PipelineSnapshot['edges'] = []): PipelineSnapshot {
  return {
    version: 1,
    id: 'pipeline_validator_test',
    name: 'validator test',
    createdAt: 0,
    updatedAt: 0,
    nodes,
    edges,
  }
}

describe('pipelineValidator DNX rules', () => {
  it('warns when an edge crosses backends without a transfer node', () => {
    const result = validatePipeline(snapshot(
      [
        {
          id: 'file_ssh',
          type: 'file',
          position: { x: 0, y: 0 },
          data: { label: 'Remote VCF', path: '/data/input.vcf.gz', fileType: 'vcf', isInput: true, origin: 'ssh' },
        },
        {
          id: 'tool_dnx',
          type: 'tool',
          position: { x: 1, y: 0 },
          data: { toolId: 'bcftools.view', label: 'DNX View', paramValues: {}, backend: 'dnx', status: 'idle' },
        },
      ],
      [
        { id: 'edge_1', source: 'file_ssh', sourceHandle: 'output', target: 'tool_dnx', targetHandle: 'input' },
      ],
    ), {
      dnx: { defaultProjectId: 'project-123', authenticated: true },
    })

    expect(result.issues.some((issue) => issue.code === 'BACKEND_MISMATCH_NEEDS_TRANSFER' && issue.edgeId === 'edge_1')).toBe(true)
    expect(result.issues.some((issue) => issue.code === 'DNX_UPLOAD_ADVISORY' && issue.edgeId === 'edge_1')).toBe(true)
  })

  it('requires a default project when DNX-backed nodes are present', () => {
    const result = validatePipeline(snapshot([
      {
        id: 'tool_dnx',
        type: 'tool',
        position: { x: 0, y: 0 },
        data: { toolId: 'bcftools.view', label: 'DNX View', paramValues: {}, backend: 'dnx', status: 'idle' },
      },
    ]), {
      dnx: { defaultProjectId: null, authenticated: true },
    })

    expect(result.issues.some((issue) => issue.code === 'DNX_NO_PROJECT')).toBe(true)
  })

  it('requires authentication when DNX-backed nodes are present', () => {
    const result = validatePipeline(snapshot([
      {
        id: 'tool_dnx',
        type: 'tool',
        position: { x: 0, y: 0 },
        data: { toolId: 'bcftools.view', label: 'DNX View', paramValues: {}, backend: 'dnx', status: 'idle' },
      },
    ]), {
      dnx: { defaultProjectId: 'project-123', authenticated: false },
    })

    expect(result.issues.some((issue) => issue.code === 'DNX_NOT_AUTHENTICATED')).toBe(true)
  })
})

describe('pipelineValidator genomic workflow rules', () => {
  it('warns when connected steps declare different genome builds', () => {
    const result = validatePipeline(snapshot(
      [
        {
          id: 'file_grch37',
          type: 'file',
          position: { x: 0, y: 0 },
          data: { label: 'GRCh37 VCF', path: '/data/input.GRCh37.vcf.gz', fileType: 'vcf', isInput: true, origin: 'ssh', genomeBuild: 'GRCh37' },
        },
        {
          id: 'view_grch38',
          type: 'tool',
          position: { x: 1, y: 0 },
          data: { toolId: 'bcftools.view', label: 'GRCh38 filter', paramValues: {}, genomeBuild: 'GRCh38', status: 'idle' },
        },
      ],
      [
        { id: 'edge_build', source: 'file_grch37', sourceHandle: 'output', target: 'view_grch38', targetHandle: 'input' },
      ],
    ))

    const issue = result.issues.find((issue) => issue.code === 'GENOME_BUILD_MISMATCH' && issue.edgeId === 'edge_build')
    expect(issue).toBeTruthy()
    expect(issue?.details).toMatchObject({ sourceBuild: 'GRCh37', targetBuild: 'GRCh38' })
  })

  it('requires a target reference when CrossMap lifts VCF coordinates', () => {
    const result = validatePipeline(snapshot(
      [
        {
          id: 'vcf',
          type: 'file',
          position: { x: 0, y: 0 },
          data: { label: 'Input VCF', path: '/data/input.vcf.gz', fileType: 'vcf', isInput: true, origin: 'ssh', genomeBuild: 'GRCh37' },
        },
        {
          id: 'chain',
          type: 'file',
          position: { x: 0, y: 80 },
          data: { label: 'Chain', path: '/refs/hg19ToHg38.over.chain.gz', fileType: 'any', isInput: true, origin: 'ssh' },
        },
        {
          id: 'liftover',
          type: 'tool',
          position: { x: 1, y: 0 },
          data: { toolId: 'crossmap.liftover', label: 'Liftover', paramValues: { format: 'vcf', 'source-build': 'GRCh37', 'target-build': 'GRCh38' }, status: 'idle' },
        },
      ],
      [
        { id: 'edge_vcf', source: 'vcf', sourceHandle: 'output', target: 'liftover', targetHandle: 'input' },
        { id: 'edge_chain', source: 'chain', sourceHandle: 'output', target: 'liftover', targetHandle: 'chain' },
      ],
    ))

    expect(result.issues.some((issue) => issue.code === 'LIFTOVER_REFERENCE_REQUIRED')).toBe(true)
  })

  it('requires PheWAS phenotype columns or a phenotype-list file', () => {
    const result = validatePipeline(snapshot(
      [
        {
          id: 'geno',
          type: 'file',
          position: { x: 0, y: 0 },
          data: { label: 'Genotypes', path: '/data/cohort.pgen', fileType: 'plink', isInput: true, origin: 'ssh' },
        },
        {
          id: 'pheno',
          type: 'file',
          position: { x: 0, y: 80 },
          data: { label: 'Phenotypes', path: '/data/pheno.tsv', fileType: 'tsv', isInput: true, origin: 'ssh' },
        },
        {
          id: 'phewas',
          type: 'tool',
          position: { x: 1, y: 0 },
          data: { toolId: 'plink2.phewas', label: 'PheWAS', paramValues: {}, status: 'idle' },
        },
      ],
      [
        { id: 'edge_geno', source: 'geno', sourceHandle: 'output', target: 'phewas', targetHandle: 'input' },
        { id: 'edge_pheno', source: 'pheno', sourceHandle: 'output', target: 'phewas', targetHandle: 'pheno' },
      ],
    ))

    expect(result.issues.some((issue) => issue.code === 'PHEWAS_NO_PHENOTYPES')).toBe(true)
  })
})
