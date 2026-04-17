/**
 * JobTracker — per-connection Slurm poller.
 *
 * Batches a single `squeue` call across all watched jobs on the same
 * connection; falls back to `sacct` when a job disappears from squeue
 * (terminal state). Treats array jobs as a single logical job (all-or-nothing
 * success semantics for V1).
 */
import type { SshManager } from '../ssh/SshManager'

export type TerminalOutcome =
  | { kind: 'done'; exitCode: number; durationSec: number }
  | { kind: 'failed'; exitCode: number; reason: string; durationSec: number }
  | { kind: 'cancelled' }

export interface JobWatcher {
  jobId: string
  connectionId: string
  isArray: boolean
  onStart?: () => void
  onFinish: (outcome: TerminalOutcome) => void
  // internal
  started: boolean
  startedAt?: number
  submittedAt: number
}

export class JobTracker {
  private static instance: JobTracker | null = null
  static getInstance(ssh: SshManager): JobTracker {
    if (!this.instance) this.instance = new JobTracker(ssh)
    return this.instance
  }

  private watchers = new Map<string, JobWatcher>()     // jobId -> watcher
  private timers = new Map<string, ReturnType<typeof setInterval>>() // connectionId -> interval
  private readonly pollMs: number

  private constructor(private ssh: SshManager, pollMs = 10_000) {
    this.pollMs = pollMs
  }

  /** Begin polling a job. `isArray=true` treats status lookup as array-wide. */
  watch(args: {
    connectionId: string
    jobId: string
    isArray: boolean
    onStart?: () => void
    onFinish: (outcome: TerminalOutcome) => void
  }): void {
    if (this.watchers.has(args.jobId)) return
    this.watchers.set(args.jobId, {
      jobId: args.jobId,
      connectionId: args.connectionId,
      isArray: args.isArray,
      onStart: args.onStart,
      onFinish: args.onFinish,
      started: false,
      submittedAt: Date.now(),
    })
    this.ensureTimer(args.connectionId)
  }

  stopWatching(jobId: string): void {
    this.watchers.delete(jobId)
    // Timers are cleaned up lazily in the poll when no watchers remain on a connection.
  }

  async cancel(connectionId: string, jobId: string): Promise<void> {
    try {
      await this.ssh.exec(connectionId, `scancel ${shellInt(jobId)}`)
    } catch (err) {
      // Treat as fire-and-forget; the squeue poll will still resolve.
      console.error(`[JobTracker] scancel ${jobId} failed:`, err)
    }
  }

  private ensureTimer(connectionId: string): void {
    if (this.timers.has(connectionId)) return
    const t = setInterval(() => { void this.pollConnection(connectionId) }, this.pollMs)
    this.timers.set(connectionId, t)
  }

  private async pollConnection(connectionId: string): Promise<void> {
    const jobs = [...this.watchers.values()].filter((w) => w.connectionId === connectionId)
    if (jobs.length === 0) {
      const t = this.timers.get(connectionId)
      if (t) clearInterval(t)
      this.timers.delete(connectionId)
      return
    }

    const ids = jobs.map((j) => j.jobId).join(',')
    const { stdout } = await this.ssh.exec(connectionId, `squeue -h -j ${ids} -o "%i %T %M" 2>/dev/null || true`)
    const seen = new Map<string, { state: string; time: string }>()
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const [rawId, state, time] = trimmed.split(/\s+/)
      // Array task ids look like "12345_3" — reduce to parent id.
      const parent = rawId.includes('_') ? rawId.split('_')[0] : rawId
      // Keep the "least finished" state seen across all array tasks.
      const prev = seen.get(parent)
      if (!prev || statePriority(state) < statePriority(prev.state)) {
        seen.set(parent, { state, time })
      }
    }

    for (const w of jobs) {
      const cur = seen.get(w.jobId)
      if (cur) {
        if (!w.started && (cur.state === 'R' || cur.state === 'CG')) {
          w.started = true
          w.startedAt = Date.now()
          w.onStart?.()
        }
        continue
      }
      // Absent from squeue — look up terminal state via sacct
      try {
        const outcome = await this.resolveTerminal(w)
        w.onFinish(outcome)
      } catch (err) {
        w.onFinish({
          kind: 'failed',
          exitCode: -1,
          reason: err instanceof Error ? err.message : String(err),
          durationSec: Math.round((Date.now() - (w.startedAt ?? w.submittedAt)) / 1000),
        })
      } finally {
        this.watchers.delete(w.jobId)
      }
    }
  }

  private async resolveTerminal(w: JobWatcher): Promise<TerminalOutcome> {
    // sacct with parsable2; --jobs accepts parent id and returns all tasks for arrays.
    const { stdout } = await this.ssh.exec(
      w.connectionId,
      `sacct -j ${shellInt(w.jobId)} -o JobID,State,ExitCode --noheader --parsable2`,
    )
    const rows = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    const durationSec = Math.round((Date.now() - (w.startedAt ?? w.submittedAt)) / 1000)
    if (rows.length === 0) {
      return { kind: 'failed', exitCode: -1, reason: 'sacct returned no rows', durationSec }
    }

    let worstExit = 0
    let anyFail = false
    let anyCancel = false
    for (const row of rows) {
      const [jobIdField, state, exitStr] = row.split('|')
      // Skip .batch / .extern step lines; they duplicate overall status.
      if (jobIdField.includes('.')) continue
      const ec = parseExitCode(exitStr ?? '0:0')
      if (ec > worstExit) worstExit = ec
      if (state.startsWith('FAIL') || state.startsWith('NODE_FAIL') || state.startsWith('TIMEOUT') || state.startsWith('BOOT_FAIL') || state.startsWith('OUT_OF_ME')) anyFail = true
      if (state.startsWith('CANCEL')) anyCancel = true
    }

    if (anyCancel && !anyFail) return { kind: 'cancelled' }
    if (anyFail || worstExit !== 0) {
      return { kind: 'failed', exitCode: worstExit, reason: 'Slurm reported non-success', durationSec }
    }
    return { kind: 'done', exitCode: 0, durationSec }
  }
}

function statePriority(state: string): number {
  // Lower = earlier/less-final. "Least-finished" wins when merging array tasks.
  switch (state) {
    case 'PD': return 0
    case 'CF': return 1   // configuring
    case 'R': return 2
    case 'CG': return 3
    default: return 4
  }
}

function parseExitCode(s: string): number {
  // Slurm ExitCode format "status:signal" — we want max(status, signal)
  const [status, signal] = s.split(':').map((x) => parseInt(x, 10) || 0)
  return Math.max(status, signal)
}

function shellInt(s: string): string {
  // Defense: only allow digits / underscores / dots so we never interpolate user-controlled text into exec.
  if (!/^[0-9_.]+$/.test(s)) throw new Error(`Invalid job id: ${s}`)
  return s
}
