import { DnxBridgeManager } from '../dnx/DnxBridgeManager'
import type { DnxJobStatus } from '../../src/types/dnx'

export type DnxJobOutcome =
  | { kind: 'done'; status: DnxJobStatus }
  | { kind: 'failed'; status: DnxJobStatus; reason: string }
  | { kind: 'cancelled'; status: DnxJobStatus }

interface Watcher {
  jobId: string
  onUpdate?: (status: DnxJobStatus) => void
  onStart?: () => void
  resolve: (outcome: DnxJobOutcome) => void
  reject: (error: Error) => void
  started: boolean
}

const POLL_INTERVAL_MS = 10_000
const MIN_BACKOFF_MS = 15_000
const MAX_BACKOFF_MS = 5 * 60_000

const PRE_RUNNING = new Set(['idle', 'waiting_on_input', 'runnable'])
const RUNNING_LIKE = new Set(['running', 'in_progress'])
const TERMINAL_DONE = new Set(['done', 'finished'])
const TERMINAL_CANCELLED = new Set(['terminated', 'terminating', 'cancelled'])
const TERMINAL_FAILED = new Set(['failed', 'partially_failed', 'debug_hold'])

/**
 * Single-tick coordinator: every active watcher is described in one batched
 * `status_batch` call per poll interval, regardless of how many array tasks
 * are in flight. dxpy has no native batch-describe endpoint, so the bridge
 * fans out via ThreadPoolExecutor on the Python side.
 */
class DnxPollerCoordinator {
  private static instance: DnxPollerCoordinator | null = null
  private readonly bridge = DnxBridgeManager.getInstance()
  private readonly watchers = new Map<string, Watcher>()
  private timer: NodeJS.Timeout | null = null
  private backoffMs = POLL_INTERVAL_MS

  static getInstance(): DnxPollerCoordinator {
    if (!this.instance) this.instance = new DnxPollerCoordinator()
    return this.instance
  }

  watch(watcher: Watcher): void {
    this.watchers.set(watcher.jobId, watcher)
    if (!this.timer) this.scheduleTick(POLL_INTERVAL_MS)
  }

  unwatch(jobId: string): void {
    this.watchers.delete(jobId)
    if (this.watchers.size === 0 && this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleTick(delay: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.tick(), delay)
  }

  private async tick(): Promise<void> {
    this.timer = null
    const ids = [...this.watchers.keys()]
    if (ids.length === 0) return

    let response: { results: DnxJobStatus[]; errors: Array<{ jobId: string; message: string }> }
    try {
      response = await this.bridge.jobStatusBatch(ids)
      this.backoffMs = POLL_INTERVAL_MS
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/429|rate.?limit/i.test(message)) {
        this.backoffMs = Math.min(this.backoffMs * 2 || MIN_BACKOFF_MS, MAX_BACKOFF_MS)
        if (this.watchers.size > 0) this.scheduleTick(this.backoffMs)
        return
      }
      // Non-rate-limit failure: surface to all watchers and clear them.
      for (const watcher of this.watchers.values()) {
        watcher.reject(error instanceof Error ? error : new Error(message))
      }
      this.watchers.clear()
      return
    }

    const seen = new Set<string>()
    for (const status of response.results) {
      seen.add(status.jobId)
      this.handleStatus(status)
    }
    for (const err of response.errors) {
      seen.add(err.jobId)
      const watcher = this.watchers.get(err.jobId)
      if (watcher) {
        watcher.reject(new Error(`DNAnexus job describe failed: ${err.message}`))
        this.watchers.delete(err.jobId)
      }
    }

    if (this.watchers.size > 0) this.scheduleTick(POLL_INTERVAL_MS)
  }

  private handleStatus(status: DnxJobStatus): void {
    const watcher = this.watchers.get(status.jobId)
    if (!watcher) return
    watcher.onUpdate?.(status)
    const state = String(status.state || '').toLowerCase()

    if (!watcher.started && (RUNNING_LIKE.has(state) || state === 'waiting_on_output')) {
      watcher.started = true
      watcher.onStart?.()
    }

    if (TERMINAL_DONE.has(state)) {
      watcher.resolve({ kind: 'done', status })
      this.watchers.delete(status.jobId)
      return
    }
    if (TERMINAL_CANCELLED.has(state)) {
      watcher.resolve({ kind: 'cancelled', status })
      this.watchers.delete(status.jobId)
      return
    }
    if (TERMINAL_FAILED.has(state)) {
      const reason = state === 'debug_hold'
        ? 'DNAnexus job entered debug_hold (failed and paused for inspection).'
        : `DNAnexus job ended in state ${status.state}`
      watcher.resolve({ kind: 'failed', status, reason })
      this.watchers.delete(status.jobId)
      return
    }
    if (!PRE_RUNNING.has(state) && !RUNNING_LIKE.has(state) && state !== 'waiting_on_output') {
      // Unknown state — keep polling but don't loop forever silently.
    }
  }
}

export class DnxJobPoller {
  private readonly bridge = DnxBridgeManager.getInstance()
  private readonly coordinator = DnxPollerCoordinator.getInstance()

  async waitForJob(
    jobId: string,
    callbacks?: {
      onStart?: () => void
      onUpdate?: (status: DnxJobStatus) => void
    },
  ): Promise<DnxJobOutcome> {
    return new Promise((resolve, reject) => {
      this.coordinator.watch({
        jobId,
        onStart: callbacks?.onStart,
        onUpdate: callbacks?.onUpdate,
        resolve,
        reject,
        started: false,
      })
    })
  }

  cancelWatch(jobId: string): void {
    this.coordinator.unwatch(jobId)
  }

  async cancel(jobId: string): Promise<void> {
    await this.bridge.cancel({ jobId })
    this.coordinator.unwatch(jobId)
  }
}
