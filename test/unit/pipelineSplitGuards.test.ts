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

  it('does not let local output sinks become remote execution paths', () => {
    const snap = snapshot([
      {
        id: 'view',
        type: 'tool',
        position: { x: 0, y: 0 },
        data: { toolId: 'bcftools.view', label: 'View', paramValues: {}, status: 'idle' },
      },
      {
        id: 'local_out',
        type: 'file',
        position: { x: 1, y: 0 },
        data: {
          label: 'Local result',
          path: '/Users/me/CAD.tsv',
          source: 'local',
          origin: 'local',
          fileType: 'vcf',
          isInput: false,
        },
      },
    ], [
      { id: 'edge_out', source: 'view', target: 'local_out', sourceHandle: 'output', targetHandle: 'input' },
    ])

    const plans = planAxes(snap, {
      outputRoot: '/scratch/bioflow/outputs',
      getTool,
      nodeSlug: () => 'view',
    })

    const output = plans.get('view')?.outputs.output
    expect(output?.kind).toBe('single')
    expect(output?.path).toBe('/scratch/bioflow/outputs/view/view.output.vcf.gz')
  })

  it('uses explicit transfer destination folders without appending the node slug', () => {
    const snap = snapshot([
      {
        id: 'view',
        type: 'tool',
        position: { x: 0, y: 0 },
        data: { toolId: 'bcftools.view', label: 'View', paramValues: {}, status: 'idle' },
      },
      {
        id: 'download',
        type: 'transfer',
        position: { x: 1, y: 0 },
        data: {
          label: 'Download result',
          from: 'ssh',
          to: 'local',
          localFolder: '/Users/me/BioFlow',
          outputName: 'cad.tsv',
          status: 'idle',
        },
      },
    ], [
      { id: 'edge_transfer', source: 'view', target: 'download', sourceHandle: 'output', targetHandle: 'input' },
    ])

    const plans = planAxes(snap, {
      outputRoot: '/scratch/bioflow/outputs',
      getTool,
      nodeSlug: (id) => id,
    })

    const output = plans.get('download')?.outputs.output
    expect(output?.kind).toBe('single')
    expect(output?.path).toBe('/Users/me/BioFlow/cad.tsv')
  })
})
