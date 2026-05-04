/**
 * JobTracker — per-connection Slurm poller.
 *
 * Batches a single `squeue` call across all watched jobs on the same
 * connection; falls back to `sacct` when a job disappears from squeue
 * (terminal state). Treats array jobs as a single logical job (all-or-nothing
 * success semantics for V1).
 */
import type { SshManager } from '../ssh/SshManager'
import type { ArrayTaskMapEntry, ArrayTaskState, ArrayTaskStatus } from '../../src/types/pipeline'

export type TerminalOutcome =
  | { kind: 'done'; exitCode: number; durationSec: number }
  | { kind: 'failed'; exitCode: number; reason: string; durationSec: number }
  | { kind: 'cancelled' }

export interface JobWatcher {
  jobId: string
  connectionId: string
  isArray: boolean
  arrayTaskMap?: ArrayTaskMapEntry[]
  arrayTasks?: Record<string, ArrayTaskStatus>
  onStart?: () => void
  onTaskUpdate?: (tasks: Record<string, ArrayTaskStatus>) => void
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
    arrayTaskMap?: ArrayTaskMapEntry[]
    previousArrayTasks?: Record<string, ArrayTaskStatus>
    onStart?: () => void
    onTaskUpdate?: (tasks: Record<string, ArrayTaskStatus>) => void
    onFinish: (outcome: TerminalOutcome) => void
  }): void {
    if (this.watchers.has(args.jobId)) return
    this.watchers.set(args.jobId, {
      jobId: args.jobId,
      connectionId: args.connectionId,
      isArray: args.isArray,
      arrayTaskMap: args.arrayTaskMap,
      arrayTasks: args.previousArrayTasks,
      onStart: args.onStart,
      onTaskUpdate: args.onTaskUpdate,
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

  async refreshArrayJob(args: {
    connectionId: string
    jobId: string
    taskMap?: ArrayTaskMapEntry[]
    previous?: Record<string, ArrayTaskStatus>
  }): Promise<Record<string, ArrayTaskStatus>> {
    const expandedQueue = await this.fetchExpandedQueue(args.connectionId, [args.jobId])
    const queueTasks = expandedQueue.taskRows.get(args.jobId) ?? new Map()
    const accountTasks = await this.fetchArrayAccounting(args.connectionId, args.jobId).catch(() => new Map<string, Partial<ArrayTaskStatus>>())
    return mergeArrayTaskStatuses(args.taskMap, queueTasks, accountTasks, args.previous)
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

    const ids = jobs.map((j) => j.jobId)
    const expandedQueue = await this.fetchExpandedQueue(connectionId, ids)
    const seen = expandedQueue.parentRows

    for (const w of jobs) {
      if (w.isArray) {
        try {
          const tasks = await this.refreshArrayWatcher(w, expandedQueue.taskRows.get(w.jobId))
          w.arrayTasks = tasks
          w.onTaskUpdate?.(tasks)
        } catch (err) {
          console.error(`[JobTracker] array task refresh failed for ${w.jobId}:`, err)
        }
      }

      const cur = seen.get(w.jobId)
      if (cur) {
        const normalized = normalizeSlurmState(cur.state)
        if (!w.started && (normalized === 'running' || cur.state === 'CG' || cur.state === 'COMPLETING')) {
          w.started = true
          w.startedAt = Date.now()
          w.onStart?.()
        }
        continue
      }
      // Absent from squeue — look up terminal state via sacct
      try {
        if (w.isArray) {
          const tasks = await this.refreshArrayWatcher(w, expandedQueue.taskRows.get(w.jobId))
          w.arrayTasks = tasks
          w.onTaskUpdate?.(tasks)
        }
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

  private async fetchExpandedQueue(connectionId: string, jobIds: string[]): Promise<{
    parentRows: Map<string, { state: string; time: string }>
    taskRows: Map<string, Map<string, Partial<ArrayTaskStatus>>>
  }> {
    const ids = jobIds.map(shellInt).join(',')
    const { stdout } = await this.ssh.exec(connectionId, `squeue -r -h -j ${ids} -o "%i|%T|%M|%R|%N" 2>/dev/null || true`)
    return parseExpandedQueue(stdout)
  }

  private async refreshArrayWatcher(
    watcher: JobWatcher,
    queueTasks?: Map<string, Partial<ArrayTaskStatus>>,
  ): Promise<Record<string, ArrayTaskStatus>> {
    const accountTasks = await this.fetchArrayAccounting(watcher.connectionId, watcher.jobId).catch(() => new Map<string, Partial<ArrayTaskStatus>>())
    return mergeArrayTaskStatuses(watcher.arrayTaskMap, queueTasks ?? new Map(), accountTasks, watcher.arrayTasks)
  }

  private async fetchArrayAccounting(connectionId: string, jobId: string): Promise<Map<string, Partial<ArrayTaskStatus>>> {
    const { stdout } = await this.ssh.exec(
      connectionId,
      `sacct -n -P -j ${shellInt(jobId)} --format=JobIDRaw,State,ExitCode,Elapsed,NodeList,Reason 2>/dev/null || true`,
    )
    return parseArrayAccounting(stdout, jobId)
  }
}

function statePriority(state: string): number {
  // Lower = earlier/less-final. "Least-finished" wins when merging array tasks.
  switch (normalizeSlurmState(state)) {
    case 'queued': return 0
    case 'running': return 1
    case 'unknown': return 2
    case 'timeout': return 3
    case 'failed': return 4
    case 'cancelled': return 5
    case 'completed': return 6
  }
}

export function parseExitCode(s: string): number {
  // Slurm ExitCode format "status:signal" — we want max(status, signal)
  const [status, signal] = s.split(':').map((x) => parseInt(x, 10) || 0)
  return Math.max(status, signal)
}

export function parseExpandedQueue(stdout: string): {
  parentRows: Map<string, { state: string; time: string }>
  taskRows: Map<string, Map<string, Partial<ArrayTaskStatus>>>
} {
  const parentRows = new Map<string, { state: string; time: string }>()
  const taskRows = new Map<string, Map<string, Partial<ArrayTaskStatus>>>()
  const now = Date.now()
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [rawId = '', state = '', elapsed = '', reason = '', nodeList = ''] = trimmed.split('|')
    const { parent, taskId } = splitSlurmTaskId(rawId)
    if (!parent) continue
    const prev = parentRows.get(parent)
    if (!prev || statePriority(state) < statePriority(prev.state)) {
      parentRows.set(parent, { state, time: elapsed })
    }
    if (taskId !== null) {
      const byTask = taskRows.get(parent) ?? new Map<string, Partial<ArrayTaskStatus>>()
      byTask.set(taskId, {
        taskId,
        state: normalizeSlurmState(state),
        slurmState: state,
        elapsed,
        reason: reason || undefined,
        nodeList: nodeList || undefined,
        updatedAt: now,
      })
      taskRows.set(parent, byTask)
    }
  }
  return { parentRows, taskRows }
}

export function parseArrayAccounting(stdout: string, parentJobId: string): Map<string, Partial<ArrayTaskStatus>> {
  const tasks = new Map<string, Partial<ArrayTaskStatus>>()
  const now = Date.now()
  for (const row of stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    const [jobIdField = '', state = '', exitCode = '', elapsed = '', nodeList = '', reason = ''] = row.split('|')
    if (!jobIdField || jobIdField.includes('.')) continue
    const { parent, taskId } = splitSlurmTaskId(jobIdField)
    if (parent !== parentJobId || taskId === null) continue
    tasks.set(taskId, {
      taskId,
      state: normalizeSlurmState(state),
      slurmState: state,
      exitCode: exitCode || undefined,
      elapsed: elapsed || undefined,
      nodeList: nodeList || undefined,
      reason: reason || undefined,
      updatedAt: now,
    })
  }
  return tasks
}

export function mergeArrayTaskStatuses(
  taskMap: ArrayTaskMapEntry[] | undefined,
  queueTasks: Map<string, Partial<ArrayTaskStatus>>,
  accountTasks: Map<string, Partial<ArrayTaskStatus>>,
  previous?: Record<string, ArrayTaskStatus>,
): Record<string, ArrayTaskStatus> {
  const now = Date.now()
  const entries = taskMap?.length
    ? taskMap
    : [...new Set([...queueTasks.keys(), ...accountTasks.keys(), ...Object.keys(previous ?? {})])]
      .sort(naturalTaskSort)
      .map((taskId, index) => ({ taskId, key: taskId, label: `task ${taskId}`, index }))
  const merged: Record<string, ArrayTaskStatus> = {}
  for (const entry of entries) {
    const prev = previous?.[entry.taskId]
    const account = accountTasks.get(entry.taskId)
    const queue = queueTasks.get(entry.taskId)
    const source = queue ?? account ?? prev
    merged[entry.taskId] = {
      taskId: entry.taskId,
      key: entry.key,
      state: source?.state ?? 'queued',
      slurmState: source?.slurmState ?? prev?.slurmState,
      elapsed: source?.elapsed ?? prev?.elapsed,
      exitCode: source?.exitCode ?? prev?.exitCode,
      reason: source?.reason ?? prev?.reason,
      nodeList: source?.nodeList ?? prev?.nodeList,
      updatedAt: now,
    }
  }
  return merged
}

export function normalizeSlurmState(state: string): ArrayTaskState {
  const normalized = state.trim().toUpperCase()
  if (!normalized) return 'unknown'
  if (normalized === 'PD' || normalized === 'PENDING' || normalized === 'CF' || normalized === 'CONFIGURING') return 'queued'
  if (normalized === 'R' || normalized === 'RUNNING' || normalized === 'CG' || normalized === 'COMPLETING' || normalized === 'S' || normalized === 'SUSPENDED') return 'running'
  if (normalized === 'CD' || normalized.startsWith('COMPLETED')) return 'completed'
  if (normalized === 'CA' || normalized.startsWith('CANCELLED')) return 'cancelled'
  if (normalized === 'TO' || normalized.startsWith('TIMEOUT')) return 'timeout'
  if (
    normalized === 'F' ||
    normalized.startsWith('FAILED') ||
    normalized === 'NF' ||
    normalized.startsWith('NODE_FAIL') ||
    normalized === 'BF' ||
    normalized.startsWith('BOOT_FAIL') ||
    normalized === 'OOM' ||
    normalized.startsWith('OUT_OF_MEMORY') ||
    normalized === 'DL' ||
    normalized.startsWith('DEADLINE') ||
    normalized === 'PR' ||
    normalized.startsWith('PREEMPTED')
  ) return 'failed'
  return 'unknown'
}

function splitSlurmTaskId(rawId: string): { parent: string; taskId: string | null } {
  const clean = rawId.trim()
  if (!clean) return { parent: '', taskId: null }
  const underscore = clean.indexOf('_')
  if (underscore === -1) return { parent: clean, taskId: null }
  return { parent: clean.slice(0, underscore), taskId: clean.slice(underscore + 1) }
}

function naturalTaskSort(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

function shellInt(s: string): string {
  // Defense: only allow digits / underscores / dots so we never interpolate user-controlled text into exec.
  if (!/^[0-9_.]+$/.test(s)) throw new Error(`Invalid job id: ${s}`)
  return s
}
