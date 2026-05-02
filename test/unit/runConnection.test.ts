import { describe, expect, it } from 'vitest'
import { resolveRunConnectionId } from '@/lib/runConnection'
import type { RunState } from '@/types/pipeline'

const baseRun = {
  runId: 'run-1',
  pipelineId: 'pipeline-1',
  connectionId: 'old-dead-id',
  workDir: '/home/user/bioflow/run',
  createdAt: 0,
  updatedAt: 0,
  status: 'failed',
  nodes: {},
} as RunState

describe('resolveRunConnectionId', () => {
  it('uses a live active connection when a saved run has a stale connection id', () => {
    const resolved = resolveRunConnectionId(baseRun, 'live-id', {
      'live-id': {
        status: 'connected',
        isLocal: false,
        config: { name: 'Rorqual', host: 'rorqual.alliancecan.ca', port: 22, username: 'user', authMethod: 'key' },
      },
    })

    expect(resolved).toBe('live-id')
  })

  it('prefers a connection matching the run workspace name', () => {
    const run = {
      ...baseRun,
      workspace: { connectionName: 'Rorqual' },
    } as RunState

    const resolved = resolveRunConnectionId(run, 'other-id', {
      'other-id': {
        status: 'connected',
        isLocal: false,
        config: { name: 'Other cluster', host: 'other.example.edu', port: 22, username: 'user', authMethod: 'key' },
      },
      'rorqual-id': {
        status: 'connected',
        isLocal: false,
        config: { name: 'Rorqual', host: 'rorqual.alliancecan.ca', port: 22, username: 'user', authMethod: 'key' },
      },
    })

    expect(resolved).toBe('rorqual-id')
  })
})
