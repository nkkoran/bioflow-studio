import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkflowReadinessStore } from '@/stores/readinessStore'
import { LOCAL_CONNECTION_ID } from '@/stores/connectionStore'
import type { PipelineSnapshot } from '@/types/pipeline'

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

function sumstatsSnapshot(path: string, origin: 'ssh' | 'local'): PipelineSnapshot {
  return snapshot(
    [
      {
        id: 'sumstats',
        type: 'file',
        position: { x: 0, y: 0 },
        data: {
          label: 'Summary stats',
          path,
          fileType: 'tsv',
          isInput: true,
          source: origin === 'local' ? 'local' : 'remote',
          origin,
        },
      },
      {
        id: 'plot',
        type: 'tool',
        position: { x: 1, y: 0 },
        data: {
          toolId: 'plot.manhattan',
          label: 'Manhattan Plot',
          paramValues: { chrCol: 'CHR', bpCol: 'BP', pCol: 'P' },
          status: 'idle',
        },
      },
    ],
    [
      { id: 'edge-1', source: 'sumstats', sourceHandle: 'output', target: 'plot', targetHandle: 'sumstats' },
    ],
  )
}

describe('workflowReadinessStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    useWorkflowReadinessStore.setState({ probeCache: {}, loading: false, lastReport: null })

    ;(globalThis as any).window = {
      api: {
        ssh: {
          exec: vi.fn().mockImplementation(async (_connectionId: string, command: string) => {
            if (command === 'printf %s "$HOME"') return { stdout: '/home/nk', stderr: '', exitCode: 0 }
            if (command.includes('stat -Lc')) return { stdout: '0 0 ---------- file', stderr: '', exitCode: 0 }
            if (command.startsWith('head -n ')) return { stdout: 'CHR\tBP\tP\n1\t123\t0.5\n', stderr: '', exitCode: 0 }
            return { stdout: '', stderr: '', exitCode: 0 }
          }),
        },
        sftp: {
          stat: vi.fn().mockRejectedValue(new Error('remote stat failed')),
          head: vi.fn().mockResolvedValue('CHR\tBP\tP\n1\t123\t0.5\n'),
        },
        local: {
          stat: vi.fn().mockResolvedValue({
            size: 128,
            modified: 1234,
            isDirectory: false,
            permissions: '-rw-r--r--',
          }),
          head: vi.fn().mockResolvedValue('CHR\tBP\tP\n1\t123\t0.5\n'),
          homedir: vi.fn().mockResolvedValue('/Users/test'),
        },
      },
    }
  })

  it('treats a remote file as existing when shell fallback can confirm it', async () => {
    const report = await useWorkflowReadinessStore.getState().evaluateSnapshot(
      'rorqual',
      sumstatsSnapshot('/home/nk/project/sumstats.tsv', 'ssh'),
      { force: true },
    )

    expect(report.probes['/home/nk/project/sumstats.tsv']?.exists).toBe(true)
    expect(report.issues.some((issue) => issue.code === 'READINESS_FILE_MISSING')).toBe(false)
    expect(window.api.sftp.stat).toHaveBeenCalledWith('rorqual', '/home/nk/project/sumstats.tsv')
    expect(window.api.ssh.exec).toHaveBeenCalledWith('rorqual', expect.stringContaining("stat -Lc"))
  })

  it('probes local-origin files through the local API even during a remote run', async () => {
    const report = await useWorkflowReadinessStore.getState().evaluateSnapshot(
      'rorqual',
      sumstatsSnapshot('/Users/test/sumstats.tsv', 'local'),
      { force: true },
    )

    expect(report.probes['/Users/test/sumstats.tsv']?.exists).toBe(true)
    expect(report.issues.some((issue) => issue.code === 'READINESS_FILE_MISSING')).toBe(false)
    expect(window.api.local.stat).toHaveBeenCalledWith('/Users/test/sumstats.tsv')
    expect(window.api.sftp.stat).not.toHaveBeenCalledWith('rorqual', '/Users/test/sumstats.tsv')
    expect(window.api.local.head).toHaveBeenCalledWith('/Users/test/sumstats.tsv', 30)
    expect(window.api.ssh.exec).not.toHaveBeenCalledWith(LOCAL_CONNECTION_ID, expect.any(String))
  })
})
