/**
 * Run store — renderer-side view of the main-process PipelineRunner state.
 *
 * The main process is authoritative; this store just mirrors events for the
 * canvas and the Jobs panel. On a node-status event it also forwards to
 * pipelineStore.setNodeStatus so the canvas badges update live.
 *
 * Log buffering:
 *   `logs[nodeId].stdout` / `logs[nodeId].stderr` are 500-line ring buffers
 *   populated by `pipeline:job-log` streaming events (non-array jobs) and by
 *   the SFTP-refresh path in LogViewer (array jobs / manual reload).
 */
import { create } from 'zustand'
import type { PipelineSnapshot, RunState, RunStatus, ToolNodeData } from '@/types/pipeline'
import type { RunReadinessReport } from '@/types/workspace'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { ToolFlagBlock } from '@/types/pipeline'

const LOG_RING_SIZE = 500

export interface NodeLogBuffer { stdout: string[]; stderr: string[] }
export interface FailureDiagnostic {
  tail: string[]
  cause: string
  suggestion: string
  fix?:
    | { kind: 'memory' | 'time'; multiplier: number }
    | { kind: 'flags'; blocks: Array<Pick<ToolFlagBlock, 'flagId' | 'value' | 'customFlag' | 'customLabel'>> }
}

interface RunStoreState {
  activeRunId: string | null
  /** Which node the Jobs panel is focused on (for log view). */
  selectedNodeId: string | null
  runs: Record<string, RunState>
  /** Per-node log ring buffers. Keyed by nodeId. */
  logs: Record<string, NodeLogBuffer>
  diagnostics: Record<string, FailureDiagnostic>

  startRun: (connectionId: string, snapshot: PipelineSnapshot, runReadiness?: RunReadinessReport | null) => Promise<string>
  cancelRun: (runId: string) => Promise<void>
  cancelNode: (runId: string, nodeId: string) => Promise<void>
  rerunNode: (runId: string, nodeId: string, snapshot: PipelineSnapshot) => Promise<void>
  setActiveRun: (runId: string | null) => void
  setSelectedNode: (nodeId: string | null) => void
  refreshRuns: () => Promise<void>

  /** Append streaming log chunks (called by subscribeToEvents). Ring-capped at 500 lines. */
  appendLog: (nodeId: string, chunk: string, stream: 'stdout' | 'stderr') => void
  /** Merge a node's log buffer with fetched SFTP content (used by LogViewer Refresh). */
  setLog: (nodeId: string, stream: 'stdout' | 'stderr', lines: string[]) => void
  /** Replace a node's log buffer without merging — used when switching array tasks. */
  replaceLog: (nodeId: string, stream: 'stdout' | 'stderr', lines: string[]) => void
  setDiagnostic: (nodeId: string, diagnostic: FailureDiagnostic) => void
  /** Clear log buffers — called on new run start to avoid stale output. */
  clearLogs: () => void

  subscribeToEvents: () => () => void
}

export const useRunStore = create<RunStoreState>((set, get) => ({
  activeRunId: null,
  selectedNodeId: null,
  runs: {},
  logs: {},
  diagnostics: {},

  startRun: async (connectionId, snapshot, runReadiness) => {
    const workspaceStore = useWorkspaceStore.getState()
    const activeWorkspace = workspaceStore.activeWorkspaceId
      ? workspaceStore.workspaces.find((workspace) => workspace.id === workspaceStore.activeWorkspaceId) ?? null
      : null
    const { runId } = await window.api.pipeline.run(connectionId, snapshot, undefined, activeWorkspace ? {
      id: activeWorkspace.id,
      name: activeWorkspace.name,
      connectionName: activeWorkspace.connectionName,
      analysisRoot: activeWorkspace.analysisRoot,
      slurmAccount: activeWorkspace.slurmAccount,
      slurmPartition: activeWorkspace.slurmPartition,
      toolsRoot: activeWorkspace.toolsRoot,
      annovarScriptsPath: activeWorkspace.annovarScriptsPath,
      annovarDbPath: activeWorkspace.annovarDbPath,
      vepPath: activeWorkspace.vepPath,
      vepCachePath: activeWorkspace.vepCachePath,
      recommendedTemplateId: activeWorkspace.recommendedTemplateId,
      notes: activeWorkspace.notes,
    } : null, runReadiness ?? null)
    // Clear old logs before a new run so stale output doesn't bleed through.
    get().clearLogs()
    set({ activeRunId: runId, selectedNodeId: null })
    // Reset statuses on runnable nodes to 'idle' locally for instant feedback;
    // authoritative state arrives via the node-status event channel moments later.
    const pipelineStore = usePipelineStore.getState()
    for (const n of pipelineStore.nodes) {
      if (n.type === 'tool' || n.type === 'merge' || n.type === 'transform' || n.type === 'transfer') {
        pipelineStore.setNodeStatus(n.id, 'idle')
      }
    }
    await get().refreshRuns()
    // Auto-reveal the Jobs panel so the user sees live progress + logs.
    useUIStore.getState().setBottomPanelMode('jobs')
    return runId
  },

  cancelRun: async (runId) => {
    await window.api.pipeline.cancel(runId)
  },

  cancelNode: async (runId, nodeId) => {
    await window.api.pipeline.cancelNode(runId, nodeId)
  },

  rerunNode: async (runId, nodeId, snapshot) => {
    await window.api.pipeline.rerunNode(runId, nodeId, snapshot)
    await get().refreshRuns()
  },

  setActiveRun: (runId) => {
    set({ activeRunId: runId, selectedNodeId: null })
    const run = runId ? get().runs[runId] : null
    if (run) applyCanvasStatuses(run)
  },

  setSelectedNode: (nodeId) => set({ selectedNodeId: nodeId }),

  refreshRuns: async () => {
    const list = await window.api.pipeline.listRuns()
    const byId: Record<string, RunState> = {}
    for (const r of list) byId[r.runId] = r
    set({ runs: byId })
    const active = get().activeRunId ? byId[get().activeRunId!] : null
    if (active) applyCanvasStatuses(active)
  },

  appendLog: (nodeId, chunk, stream) => {
    set((state) => {
      const existing = state.logs[nodeId] ?? { stdout: [], stderr: [] }
      const prev = existing[stream]
      // Split the incoming chunk on newlines. The last element may be a partial
      // line (if the chunk doesn't end with \n) — we keep it as-is; the next
      // chunk will continue from there.
      const incoming = chunk.split('\n')
      const merged = [...prev, ...incoming]
      const trimmed = merged.length > LOG_RING_SIZE ? merged.slice(merged.length - LOG_RING_SIZE) : merged
      return { logs: { ...state.logs, [nodeId]: { ...existing, [stream]: trimmed } } }
    })
  },

  setLog: (nodeId, stream, lines) => {
    set((state) => {
      const existing = state.logs[nodeId] ?? { stdout: [], stderr: [] }
      const merged = mergeFetchedLog(existing[stream], lines)
      const trimmed = merged.length > LOG_RING_SIZE ? merged.slice(merged.length - LOG_RING_SIZE) : merged
      return { logs: { ...state.logs, [nodeId]: { ...existing, [stream]: trimmed } } }
    })
  },

  replaceLog: (nodeId, stream, lines) => {
    set((state) => {
      const existing = state.logs[nodeId] ?? { stdout: [], stderr: [] }
      const trimmed = lines.length > LOG_RING_SIZE ? lines.slice(lines.length - LOG_RING_SIZE) : lines
      return { logs: { ...state.logs, [nodeId]: { ...existing, [stream]: trimmed } } }
    })
  },

  setDiagnostic: (nodeId, diagnostic) =>
    set((state) => ({ diagnostics: { ...state.diagnostics, [nodeId]: diagnostic } })),

  clearLogs: () => set({ logs: {} }),

  subscribeToEvents: () => {
    // Defensive: if the preload bundle is older than the renderer (e.g., dev
    // reload happened for the renderer but not for the preload), some listener
    // functions may be undefined. Guarding each one individually prevents a
    // single missing function from taking down the whole subscription — and
    // therefore the whole React tree, since this runs in a mount effect.
    const noop = () => {}
    const api = window.api?.pipeline
    if (!api) {
      console.error('[runStore] window.api.pipeline is unavailable — preload did not load')
      return noop
    }

    const offNode = api.onNodeStatus
      ? api.onNodeStatus(({ runId, nodeId, status, jobId, error, node }) => {
          // Mirror into the pipeline store so the canvas badge updates.
          const current = get()
          const pipelineStore = usePipelineStore.getState()
          const cachedRun = current.runs[runId]
          if (
            current.activeRunId === runId &&
            cachedRun?.pipelineId === pipelineStore.pipelineId
          ) {
            pipelineStore.setNodeStatus(
              nodeId,
              (node?.status ?? status) as any,
              node?.jobId ?? jobId,
              node ? node.error : error,
            )
          }
          // Update local run cache.
          set((state) => {
            const run = state.runs[runId]
            if (!run) return state
            const previous = run.nodes[nodeId] ?? { nodeId, status: 'idle' }
            const nextNode = {
              ...previous,
              ...(node ?? {}),
              nodeId,
              status: (node?.status ?? status) as any,
              jobId: node?.jobId ?? jobId ?? previous.jobId,
              error: node ? node.error : error,
            }
            if (nextNode.status === 'failed') {
              void fetchFailureDiagnostic(run, nodeId, nextNode.stderrPath).then((diagnostic) => {
                if (diagnostic) get().setDiagnostic(nodeId, diagnostic)
              })
            }
            const nodes = {
              ...run.nodes,
              [nodeId]: nextNode,
            }
            const nextRun = { ...run, nodes, updatedAt: Date.now() }
            if (state.activeRunId === runId && nextRun.pipelineId === usePipelineStore.getState().pipelineId) {
              applyCanvasStatuses(nextRun)
            }
            return { runs: { ...state.runs, [runId]: nextRun } }
          })
        })
      : noop

    const offRun = api.onRunStatus
      ? api.onRunStatus(({ runId, status }) => {
          set((state) => {
            const run = state.runs[runId]
            if (!run) return state
            if (status === 'done' || status === 'failed' || status === 'cancelled') {
              notifyRunFinished(runId, status, run.pipelineName)
              if (status === 'done' && state.activeRunId === runId) {
                useUIStore.getState().setBottomPanelMode('results')
              }
            }
            return { runs: { ...state.runs, [runId]: { ...run, status: status as RunStatus, updatedAt: Date.now() } } }
          })
        })
      : noop

    const offLog = api.onJobLog
      ? api.onJobLog(({ nodeId, chunk, stream }) => {
          get().appendLog(nodeId, chunk, stream)
        })
      : noop

    return () => { offNode(); offRun(); offLog() }
  },
}))

function applyCanvasStatuses(run: RunState): void {
  const pipelineStore = usePipelineStore.getState()
  if (run.pipelineId !== pipelineStore.pipelineId) return
  for (const node of pipelineStore.nodes) {
    if (node.type !== 'tool' && node.type !== 'merge' && node.type !== 'transform' && node.type !== 'transfer') continue
    const ns = run.nodes[node.id]
    pipelineStore.setNodeStatus(
      node.id,
      (ns?.status ?? 'idle') as any,
      ns?.jobId,
      ns?.error,
    )
  }
}

function mergeFetchedLog(existing: string[], fetched: string[]): string[] {
  const existingText = existing.join('\n')
  const fetchedText = fetched.join('\n')

  if (!existingText) return fetched
  if (!fetchedText) return existing
  if (fetchedText.includes(existingText)) return fetched
  if (existingText.includes(fetchedText)) return existing
  return [...existing, ...fetched]
}

function notifyRunFinished(runId: string, status: RunStatus, pipelineName?: string): void {
  if (typeof window === 'undefined') return
  const settings = useSettingsStore.getState().settings
  if ((status === 'done' && !settings.notifyOnRunFinish) || (status === 'failed' && !settings.notifyOnRunFail)) return
  const name = pipelineName?.trim() || `Run ${runId.slice(0, 8)}`
  const title = status === 'done'
    ? `${name} finished`
    : status === 'failed'
      ? `${name} failed`
      : `${name} cancelled`
  const body = `Pipeline run is ${status}.`
  if (settings.notifySoundEnabled) playNotificationSound(status)
  if (!('Notification' in window)) return
  if (Notification.permission === 'granted') {
    new Notification(title, { body })
    return
  }
  if (Notification.permission === 'default') {
    void Notification.requestPermission().then((permission) => {
      if (permission === 'granted') new Notification(title, { body })
    })
  }
}

async function fetchFailureDiagnostic(
  run: RunState,
  nodeId: string,
  stderrPath?: string,
): Promise<FailureDiagnostic | null> {
  const path = stderrPath || run.nodes[nodeId]?.stderrPath
  if (!path || path.includes('%')) return null
  try {
    const text = (await window.api.ssh.exec(run.connectionId, `tail -n 50 ${shellQuote(path)} 2>/dev/null || true`)).stdout
    const tail = text.split(/\r?\n/).slice(-50)
    const toolNode = run.snapshot?.nodes.find((candidate) => candidate.id === nodeId && candidate.type === 'tool')
    const toolId = toolNode?.type === 'tool' ? (toolNode.data as ToolNodeData).toolId : undefined
    return diagnoseTail(tail, toolId)
  } catch {
    return null
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function diagnoseTail(tail: string[], toolId?: string): FailureDiagnostic {
  const text = tail.join('\n')
  if (/out of memory|oom-kill|oom killed|MemoryError/i.test(text)) {
    return { tail, cause: 'Likely out of memory', suggestion: 'Increase memory and rerun this step.', fix: { kind: 'memory', multiplier: 2 } }
  }
  if (/TIMEOUT|time limit|CANCELLED.*time/i.test(text)) {
    return { tail, cause: 'Likely hit the Slurm time limit', suggestion: 'Increase wall time and rerun this step.', fix: { kind: 'time', multiplier: 1.5 } }
  }
  if (/invalid account|invalid qos|association.*does not exist|account.*not.*valid|Job violates accounting/i.test(text)) {
    return { tail, cause: 'Slurm account or QOS was rejected', suggestion: 'Open Settings and choose an account/partition that is valid for this cluster allocation.' }
  }
  if (/invalid partition|requested partition configuration not available|partition.*not.*available|QOSMaxWallDurationPerJobLimit/i.test(text)) {
    return { tail, cause: 'Partition or walltime policy rejected the job', suggestion: 'Use a compatible partition or reduce the requested wall time before rerunning.' }
  }
  if (/DependencyNeverSatisfied|dependency.*failed|afterok.*failed/i.test(text)) {
    return { tail, cause: 'An upstream dependency failed', suggestion: 'Fix and rerun the failed upstream step, then retry downstream from that point.' }
  }
  if (/cannot stat|No such file or directory|No input file|failed to open|Could not open/i.test(text)) {
    return { tail, cause: 'A required input file was not found', suggestion: 'Run Check, preview the input paths, and insert an explicit Transfer node if the file is on another backend.' }
  }
  if (/module: command not found|Unable to locate a modulefile|unknown module|module.*not found/i.test(text)) {
    return { tail, cause: 'Environment module was not available', suggestion: 'Check the module name in the node or workspace settings, then rerun this step.' }
  }
  if (/command not found|No such file or directory: .*plink|No such file or directory: .*regenie|No such file or directory: .*bcftools/i.test(text)) {
    return { tail, cause: 'Tool or module was not found', suggestion: 'Check the module name or tool path in the node/settings.' }
  }
  if (toolId?.startsWith('plink2.')) {
    const plinkDiagnostic = diagnosePlinkTail(tail, text)
    if (plinkDiagnostic) return plinkDiagnostic
  }
  if (/Invalid chromosome|No variants remaining/i.test(text)) {
    return { tail, cause: 'Input/filter removed the expected variants', suggestion: 'Check chromosome labels and filter thresholds for this input.' }
  }
  return { tail, cause: 'The job failed', suggestion: 'Review the last stderr lines and adjust the node settings before rerunning.' }
}

function diagnosePlinkTail(tail: string[], text: string): FailureDiagnostic | null {
  if (/ambiguous sex|missing sex|allow-no-sex/i.test(text)) {
    return {
      tail,
      cause: 'PLINK dropped phenotypes because some samples have missing or ambiguous sex values.',
      suggestion: 'If that is expected for this cohort, rerun with --allow-no-sex.',
      fix: { kind: 'flags', blocks: [{ flagId: 'allow-no-sex', value: true }] },
    }
  }
  if (/duplicate-id variant|duplicate variant id|rmdup\.mismatch|duplicate ids?/i.test(text)) {
    return {
      tail,
      cause: 'PLINK found duplicate variant IDs that need to be resolved before the analysis can continue.',
      suggestion: 'Try --rm-dup exclude-mismatch to drop conflicting duplicates, or review the mismatch report if you need a less aggressive fix.',
      fix: { kind: 'flags', blocks: [{ flagId: 'rm-dup', value: 'exclude-mismatch' }] },
    }
  }
  if (/duplicate allele/i.test(text)) {
    return {
      tail,
      cause: 'PLINK reported duplicate allele definitions in the input.',
      suggestion: 'Start by deduplicating conflicting records with --rm-dup exclude-mismatch. If this is really a multiallelic-site issue, add --max-alleles 2 as well.',
      fix: { kind: 'flags', blocks: [{ flagId: 'rm-dup', value: 'exclude-mismatch' }] },
    }
  }
  if (/split multiallelic variant under a single id|must have unique variant ids|non-unique variant ids?|duplicate variant IDs/i.test(text)) {
    return {
      tail,
      cause: 'PLINK needs unique variant IDs for this step.',
      suggestion: 'Rerun with --set-all-var-ids, such as @:#$r,$a, to assign stable chromosome/position/allele-based IDs.',
      fix: { kind: 'flags', blocks: [{ flagId: 'set-all-var-ids', value: '@:#$r,$a' }] },
    }
  }
  if (/more than 2 alleles|multiallelic|must be biallelic/i.test(text)) {
    return {
      tail,
      cause: 'PLINK hit multiallelic variants that this step does not handle cleanly.',
      suggestion: 'Try restricting the run to biallelic variants with --max-alleles 2. If you only want SNPs, add --snps-only just-acgt as well.',
      fix: { kind: 'flags', blocks: [{ flagId: 'max-alleles', value: 2 }] },
    }
  }
  if (/invalid chromosome code|extra chromosome|unrecognized chromosome/i.test(text)) {
    return {
      tail,
      cause: 'PLINK rejected nonstandard chromosome labels in the input.',
      suggestion: 'If these contig names are expected for your dataset, rerun with --allow-extra-chr.',
      fix: { kind: 'flags', blocks: [{ flagId: 'allow-extra-chr', value: true }] },
    }
  }
  return null
}

function playNotificationSound(status: RunStatus): void {
  const audioContextClass = window.AudioContext || (window as any).webkitAudioContext
  if (!audioContextClass) return
  const ctx = new audioContextClass()
  const oscillator = ctx.createOscillator()
  const gain = ctx.createGain()
  oscillator.type = status === 'failed' ? 'sawtooth' : 'sine'
  oscillator.frequency.value = status === 'failed' ? 220 : 660
  gain.gain.value = 0.05
  oscillator.connect(gain)
  gain.connect(ctx.destination)
  oscillator.start()
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25)
  oscillator.stop(ctx.currentTime + 0.3)
}
