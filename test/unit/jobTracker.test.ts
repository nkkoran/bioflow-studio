import { describe, expect, it } from 'vitest'
import {
  mergeArrayTaskStatuses,
  normalizeSlurmState,
  parseArrayAccounting,
  parseExpandedQueue,
} from '../../electron/pipeline/JobTracker'

describe('JobTracker array parsing', () => {
  it('parses expanded squeue array task ids without losing task ids', () => {
    const parsed = parseExpandedQueue([
      '12345_1|RUNNING|00:01:02|None|cn001',
      '12345_22|PENDING|00:00:00|Priority|',
      '67890|RUNNING|00:00:04|None|cn002',
    ].join('\n'))

    expect(parsed.parentRows.get('12345')?.state).toBe('PENDING')
    expect(parsed.taskRows.get('12345')?.get('1')?.state).toBe('running')
    expect(parsed.taskRows.get('12345')?.get('22')?.state).toBe('queued')
    expect(parsed.parentRows.get('67890')?.state).toBe('RUNNING')
  })

  it('parses terminal sacct rows for array tasks', () => {
    const parsed = parseArrayAccounting([
      '12345_1|COMPLETED|0:0|00:10:00|cn001|',
      '12345_2|FAILED|1:0|00:03:00|cn002|NonZeroExitCode',
      '12345_2.batch|FAILED|1:0|00:03:00|cn002|',
      '99999_1|COMPLETED|0:0|00:01:00|cn003|',
    ].join('\n'), '12345')

    expect(parsed.get('1')?.state).toBe('completed')
    expect(parsed.get('2')?.state).toBe('failed')
    expect(parsed.get('2')?.exitCode).toBe('1:0')
    expect(parsed.has('2.batch')).toBe(false)
    expect(parsed.has('99999_1')).toBe(false)
  })

  it('merges biological split keys with concrete Slurm task ids', () => {
    const queue = parseExpandedQueue('12345_0|RUNNING|00:00:03|None|cn001').taskRows.get('12345') ?? new Map()
    const account = parseArrayAccounting('12345_1|COMPLETED|0:0|00:02:00|cn002|', '12345')
    const merged = mergeArrayTaskStatuses(
      [
        { taskId: '0', key: 'X', label: 'chr X', index: 0 },
        { taskId: '1', key: 'Y', label: 'chr Y', index: 1 },
      ],
      queue,
      account,
    )

    expect(merged['0']).toMatchObject({ key: 'X', state: 'running' })
    expect(merged['1']).toMatchObject({ key: 'Y', state: 'completed' })
  })

  it('normalizes common Slurm states', () => {
    expect(normalizeSlurmState('PD')).toBe('queued')
    expect(normalizeSlurmState('RUNNING')).toBe('running')
    expect(normalizeSlurmState('COMPLETED')).toBe('completed')
    expect(normalizeSlurmState('TIMEOUT')).toBe('timeout')
    expect(normalizeSlurmState('OUT_OF_MEMORY')).toBe('failed')
  })
})
