import { describe, expect, it } from 'vitest'
import { buildRunManifest } from '@/lib/runManifest'
import type { PipelineSnapshot, RunState } from '@/types/pipeline'

describe('runManifest', () => {
  it('prefers the workspace captured on the run', () => {
    const snapshot: PipelineSnapshot = {
      version: 1,
      id: 'pipeline_1',
      name: 'Example',
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        { id: 'score', type: 'tool', position: { x: 0, y: 0 }, data: { toolId: 'plink2.score', label: 'GRS', paramValues: {}, status: 'done' } },
      ],
      edges: [],
    }
    const run: RunState = {
      runId: 'run_1',
      pipelineId: 'pipeline_1',
      pipelineName: 'Example',
      snapshot,
      workspace: { id: 'ws_captured', name: 'Captured workspace', analysisRoot: '/captured' },
      connectionId: 'conn_1',
      workDir: '/work/run_1',
      status: 'done',
      createdAt: 0,
      updatedAt: 0,
      nodes: {
        score: {
          nodeId: 'score',
          status: 'done',
          outputPaths: ['/work/grs.profile.tsv'],
        },
      },
    }

    const manifest = buildRunManifest(run, snapshot, { id: 'ws_current', name: 'Current workspace', createdAt: 0, updatedAt: 0 })
    expect(manifest.workspace).toMatchObject({ id: 'ws_captured', name: 'Captured workspace' })
    expect(manifest.outputs[0]).toMatchObject({
      nodeId: 'score',
      label: 'GRS',
      paths: ['/work/grs.profile.tsv'],
    })
  })
})
