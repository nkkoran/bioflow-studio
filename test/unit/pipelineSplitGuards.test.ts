import { describe, expect, it } from 'vitest'
import { planAxes, AxisPlanError } from '../../electron/pipeline/axisPlanner'
import { edgeAxisChips } from '@/lib/axisPlannerPure'
import { validatePipeline } from '@/lib/pipelineValidator'
import { getTool } from '@/lib/toolRegistry'
import type { FileNodeData, PipelineSnapshot } from '@/types/pipeline'

function snapshot(nodes: PipelineSnapshot['nodes'], edges: PipelineSnapshot['edges'] = []): PipelineSnapshot {
  return {
    version: 1,
    id: 'pipeline_split_guard_test',
    name: 'split guard test',
    createdAt: 0,
    updatedAt: 0,
    nodes,
    edges,
  }
}

function staleSplitFile(): PipelineSnapshot['nodes'][number] {
  return {
    id: 'stale_split',
    type: 'file',
    position: { x: 0, y: 0 },
    data: {
      label: 'Old split file',
      path: '/data/chromosomes',
      fileType: 'vcf',
      isInput: true,
      split: { axis: 'chrom', glob: '/data/chr*.vcf.gz' },
    } as unknown as FileNodeData,
  }
}

describe('pipeline split guards', () => {
  it('reports stale split nodes as empty instead of throwing', () => {
    const snap = snapshot([
      staleSplitFile(),
      {
        id: 'view',
        type: 'tool',
        position: { x: 1, y: 0 },
        data: { toolId: 'bcftools.view', label: 'View', paramValues: {}, status: 'idle' },
      },
    ])

    expect(() => validatePipeline(snap)).not.toThrow()
    expect(validatePipeline(snap).issues.some((issue) => issue.code === 'EMPTY_SPLIT')).toBe(true)
  })

  it('keeps renderer axis decoration tolerant of stale split nodes', () => {
    expect(() => edgeAxisChips(snapshot([staleSplitFile()]))).not.toThrow()
  })

  it('fails runtime planning with a typed validation error for stale split nodes', () => {
    expect(() => planAxes(snapshot([staleSplitFile()]), {
      outputRoot: '/work',
      getTool,
    })).toThrow(AxisPlanError)
  })
})
