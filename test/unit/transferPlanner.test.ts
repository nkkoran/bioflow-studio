import { describe, expect, it } from 'vitest'
import { artifactRefForFileNode, planPipelineTransfers } from '@/lib/transferPlanner'
import type { FileNodeData, PipelineSnapshot } from '@/types/pipeline'

describe('transferPlanner', () => {
  it('preserves DNX file identity while migrating to an ArtifactRef', () => {
    const ref = artifactRefForFileNode({
      label: 'RAP VCF',
      path: '/Bulk/variants/cohort.vcf.gz',
      origin: 'dnx',
      artifactRef: {
        origin: 'dnx',
        path: '/Bulk/variants/cohort.vcf.gz',
        projectId: 'project-123',
        fileId: 'file-abc',
        fileType: 'vcf',
      },
      fileType: 'vcf',
      isInput: true,
    } as FileNodeData)

    expect(ref).toMatchObject({
      origin: 'dnx',
      path: '/Bulk/variants/cohort.vcf.gz',
      projectId: 'project-123',
      fileId: 'file-abc',
      fileType: 'vcf',
    })
  })

  it('plans implicit cross-backend edges with an insert-transfer action warning', () => {
    const snapshot: PipelineSnapshot = {
      version: 1,
      id: 'pipe',
      name: 'Hybrid',
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        {
          id: 'input',
          type: 'file',
          position: { x: 0, y: 0 },
          data: { label: 'DNX input', path: '/data/input.vcf.gz', origin: 'dnx', fileType: 'vcf', isInput: true },
        },
        {
          id: 'tool',
          type: 'tool',
          position: { x: 200, y: 0 },
          data: { label: 'Cluster tool', toolId: 'custom.shell', backend: 'ssh', paramValues: {} },
        },
      ],
      edges: [{ id: 'edge-1', source: 'input', target: 'tool', sourceHandle: 'output', targetHandle: 'input' }],
    }

    const plans = planPipelineTransfers(snapshot)

    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({
      id: 'implicit:edge-1',
      route: 'dnx->ssh',
      mode: 'implicit',
      status: 'planned',
    })
    expect(plans[0]?.warnings?.join(' ')).toContain('Transfer node')
  })

  it('creates an explicit plan for a Transfer node route', () => {
    const snapshot: PipelineSnapshot = {
      version: 1,
      id: 'pipe',
      name: 'Local upload',
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        {
          id: 'local-file',
          type: 'file',
          position: { x: 0, y: 0 },
          data: { label: 'Local TSV', path: '~/cohort.tsv', origin: 'local', fileType: 'tsv', isInput: true },
        },
        {
          id: 'upload',
          type: 'transfer',
          position: { x: 180, y: 0 },
          data: { label: 'Upload', from: 'local', to: 'ssh', sshFolder: '/scratch/run/input', outputName: 'cohort.tsv' },
        },
        {
          id: 'tool',
          type: 'tool',
          position: { x: 360, y: 0 },
          data: { label: 'Cluster tool', toolId: 'custom.shell', backend: 'ssh', paramValues: {} },
        },
      ],
      edges: [
        { id: 'edge-in', source: 'local-file', target: 'upload', sourceHandle: 'output', targetHandle: 'input' },
        { id: 'edge-out', source: 'upload', target: 'tool', sourceHandle: 'output', targetHandle: 'input' },
      ],
    }

    const plans = planPipelineTransfers(snapshot)

    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({
      id: 'transfer-node:upload',
      edgeId: 'edge-in',
      nodeId: 'upload',
      route: 'local->ssh',
      mode: 'explicit',
      target: {
        origin: 'ssh',
        path: '/scratch/run/input/cohort.tsv',
      },
    })
  })
})
