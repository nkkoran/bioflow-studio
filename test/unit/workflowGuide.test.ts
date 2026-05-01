import { describe, expect, it } from 'vitest'
import { buildWorkflowGuide } from '@/lib/workflowGuide'
import type { PipelineSnapshot } from '@/types/pipeline'

function snapshot(nodes: PipelineSnapshot['nodes'], edges: PipelineSnapshot['edges'] = []): PipelineSnapshot {
  return {
    version: 1,
    id: 'workflow_guide_test',
    name: 'workflow guide test',
    createdAt: 0,
    updatedAt: 0,
    nodes,
    edges,
  }
}

describe('workflowGuide', () => {
  it('points users to missing file inputs before run setup', () => {
    const guide = buildWorkflowGuide(snapshot([
      {
        id: 'input',
        type: 'file',
        position: { x: 0, y: 0 },
        data: { label: 'Input file', path: '', fileType: 'vcf', isInput: true },
      },
    ]))

    expect(guide.current.id).toBe('data')
    expect(guide.current.action).toBe('select-node')
    expect(guide.current.nodeId).toBe('input')
  })

  it('surfaces connection setup when an SSH-backed tool is ready', () => {
    const guide = buildWorkflowGuide(snapshot([
      {
        id: 'input',
        type: 'file',
        position: { x: 0, y: 0 },
        data: { label: 'Input VCF GRCh38', path: '/data/input.GRCh38.vcf.gz', fileType: 'vcf', genomeBuild: 'GRCh38', isInput: true },
      },
      {
        id: 'view',
        type: 'tool',
        position: { x: 1, y: 0 },
        data: { toolId: 'bcftools.view', label: 'View', paramValues: {}, status: 'idle' },
      },
    ], [
      { id: 'edge', source: 'input', sourceHandle: 'output', target: 'view', targetHandle: 'input' },
    ]), {
      validation: { ok: true, issues: [], errorCount: 0, warningCount: 0, infoCount: 0 },
      activeConnectionId: 'local',
      localConnectionId: 'local',
    })

    expect(guide.current.id).toBe('connection')
    expect(guide.current.action).toBe('connect')
  })

  it('points to results when active run outputs are recorded', () => {
    const guide = buildWorkflowGuide(snapshot([]), {
      activeRunStatus: 'done',
      activeRunOutputCount: 2,
    })

    expect(guide.current.id).toBe('results')
    expect(guide.current.action).toBe('results')
  })
})
