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
