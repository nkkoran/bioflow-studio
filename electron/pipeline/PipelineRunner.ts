/**
 * PipelineRunner — orchestrates a pipeline run on a remote HPC cluster.
 *
 * For each run:
 *   1. Compute topo order + per-node axis plan from the snapshot.
 *   2. Create remote dirs (scripts/, outputs/<nodeId>/, logs/) via one SSH exec.
 *   3. Layer-by-layer, generate sbatch scripts → SFTP-write → sbatch submit.
 *      Nodes within a layer run in parallel; layers are serial.
 *   4. Track each job via JobTracker; emit IPC events on every transition.
 *
 * Runs live only in memory for this step — persistence across app reloads
 * lands in a later substep.
 */
import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'

import { SshManager } from '../ssh/SshManager'
import { SftpPool } from '../ssh/SftpPool'
import { getSettingsStore } from '../store/settingsStore'
import { JobTracker } from './JobTracker'
import { topoSort } from './topoSort'
import { planAxes, resolveNodeOutputDir, type AxisPlan } from './axisPlanner'
import { generateToolScript, generateMergeScript, type ConnectionDefaults } from './ScriptGenerator'
import { getTool } from '../../src/lib/toolRegistry'
import type {
  PipelineSnapshot,
  RunState,
  RunStatus,
  NodeRunState,
  ToolNodeData,
  MergeNodeData,
  FileNodeData,
  NoteNodeData,
} from '../../src/types/pipeline'

export interface StartOptions {
  connectionId: string
  snapshot: PipelineSnapshot
  workDir?: string
}

/**
 * Default run directory, relative to the user's home on the remote host.
 * We resolve `$HOME` to an absolute path at run start so SFTP (which does NOT
 * shell-expand `~`) can write scripts successfully.
 */
const DEFAULT_WORKDIR_SUBPATH_PARENT = 'bioflow'
const MODULE_PREAMBLE = 'module --force purge && module load StdEnv/2023'

export class PipelineRunner {
  private static instance: PipelineRunner | null = null
  static getInstance(): PipelineRunner {
    if (!this.instance) this.instance = new PipelineRunner()
    return this.instance
  }

  private runs = new Map<string, RunState>()
  private cancelledRuns = new Set<string>()

  private get ssh() { return SshManager.getInstance() }
  private get sftp() { return SftpPool.getInstance() }
  private get tracker() { return JobTracker.getInstance(this.ssh) }

  async start(opts: StartOptions): Promise<{ runId: string }> {
    const { connectionId, snapshot } = opts
    const runId = randomUUID()

    const connectionDefaults = await this.loadConnectionDefaults(connectionId)
    if (!connectionDefaults.account) {
      throw new Error(
        'No Slurm account set. Click the connection name in the top bar → Slurm Settings to add one.',
      )
    }
    const analysisFolder = this.loadAnalysisFolder(connectionId)

    // Resolve $HOME to an absolute path. SFTP does not shell-expand `~`, so
    // every path we hand to SftpPool.write must be absolute; SSH exec does
    // expand it, but keeping both paths consistent here avoids foot-guns.
    const home = await this.resolveHome(connectionId)

    // Human-readable run directory: <root>/runs/<pipeline-slug>-<YYYYMMDD-HHmmss>
    // Root is the user's configured default analysis folder, or ~/bioflow.
    const runFolder = `${slugify(snapshot.name || 'pipeline')}-${timestampStamp()}`
    const workRoot = analysisFolder
      ? expandHome(analysisFolder, home)
      : `${home}/${DEFAULT_WORKDIR_SUBPATH_PARENT}`
    const workDir = (opts.workDir ?? `${workRoot}/runs/${runFolder}`).replace(/\/+$/, '')

    // Pre-compute human-readable slugs for every node (label-based with a short
    // id tail for uniqueness). Same slug feeds the planner and the script
    // generator so output paths line up across both.
    const nodeSlugs = buildNodeSlugs(snapshot)

    // Plan axes (throws on cycles, unknown tools, ambiguous axes).
    topoSort(snapshot)
    const plans = planAxes(snapshot, {
      outputRoot: `${workDir}/outputs`,
      getTool,
      nodeSlug: (id) => nodeSlugs.get(id) ?? id,
      homeDir: home,
    })

    const now = Date.now()
    const nodes: Record<string, NodeRunState> = {}
    for (const n of snapshot.nodes) {
      if (n.type === 'tool' || n.type === 'merge') {
        nodes[n.id] = { nodeId: n.id, status: 'idle' }
      }
    }
    const runState: RunState = {
      runId,
      pipelineId: snapshot.id,
      connectionId,
      workDir,
      homeDir: home,
      createdAt: now,
      updatedAt: now,
      status: 'running',
      nodes,
    }
    this.runs.set(runId, runState)
    this.emitRunStatus(runId, 'running')

    // One exec creates scripts/, logs/, and per-node output dirs (default or
    // override). Overrides are already `~`-expanded by resolveNodeOutputDir.
    const dirs = new Set<string>([`${workDir}/scripts`, `${workDir}/logs`])
    for (const n of snapshot.nodes) {
      if (n.type === 'tool' || n.type === 'merge') {
        const slug = nodeSlugs.get(n.id) ?? n.id
        const override = (n.data as ToolNodeData | MergeNodeData).outputDirOverride
        dirs.add(resolveNodeOutputDir(override, `${workDir}/outputs`, slug, home))
      }
    }
    for (const plan of plans.values()) {
      if (plan.nodeType !== 'tool' && plan.nodeType !== 'merge') continue
      for (const path of collectOutputPaths(plan.outputs)) {
        dirs.add(pathDirname(path))
      }
    }
    const mkdirCmd = [...dirs].map((d) => `mkdir -p ${shellQuote(d)}`).join(' && ')
    await this.ssh.exec(connectionId, mkdirCmd)

    // Persist the snapshot for audit/debug. Best-effort; failure doesn't abort.
    try {
      await this.sftp.write(connectionId, `${workDir}/pipeline.json`, JSON.stringify(snapshot, null, 2))
    } catch (err) {
      console.error('[PipelineRunner] failed to write pipeline.json:', err)
    }

    // Kick off the run; the caller resumes as soon as start() returns the runId.
    void this.executeRun(runState, snapshot, plans, connectionDefaults, nodeSlugs)

    return { runId }
  }

  /** Resolve `$HOME` on the remote host. Cached per-connection is overkill for
   * the V1 runtime; one exec per run start is cheap. */
  private async resolveHome(connectionId: string): Promise<string> {
    const { stdout, exitCode, stderr } = await this.ssh.exec(connectionId, 'printf %s "$HOME"')
    if (exitCode !== 0 || !stdout.trim()) {
      throw new Error(`Could not resolve remote $HOME: ${(stderr || stdout).trim()}`)
    }
    return stdout.trim().replace(/\/+$/, '')
  }

  async cancel(runId: string): Promise<void> {
    const run = this.runs.get(runId)
    if (!run) return
    if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') return

    const nodes = Object.values(run.nodes)
    const hasPendingWork = nodes.some((ns) => ns.status === 'idle' || ns.status === 'queued' || ns.status === 'running')
    if (!hasPendingWork) return

    this.cancelledRuns.add(runId)
    for (const ns of nodes) {
      if (ns.jobId && (ns.status === 'queued' || ns.status === 'running')) {
        await this.tracker.cancel(run.connectionId, ns.jobId)
      }
    }
    run.status = 'cancelled'
    this.emitRunStatus(runId, 'cancelled')
  }

  async cancelNode(runId: string, nodeId: string): Promise<void> {
    const run = this.runs.get(runId)
    if (!run) return
    const ns = run.nodes[nodeId]
    if (!ns?.jobId) return
    await this.tracker.cancel(run.connectionId, ns.jobId)
  }

  listRuns(): RunState[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  getRun(runId: string): RunState | null {
    return this.runs.get(runId) ?? null
  }

  /**
   * SFTP-list the output directory for one node in a run. Returns an empty
   * array if the node hasn't recorded an outputDir yet (not submitted) or the
   * dir doesn't exist. Intended for the Jobs panel summary card.
   */
  async listNodeOutputs(
    runId: string,
    nodeId: string,
  ): Promise<Array<{ name: string; path: string; size: number; modified: number }>> {
    const run = this.runs.get(runId)
    if (!run) return []
    const ns = run.nodes[nodeId]
    if (!ns?.outputDir && !ns?.outputPaths?.length) return []
    const byPath = new Map<string, { name: string; path: string; size: number; modified: number }>()
    try {
      if (ns.outputDir) {
        const entries = await this.sftp.ls(run.connectionId, ns.outputDir)
        for (const e of entries.filter((entry) => !entry.isDirectory)) {
          byPath.set(e.path, { name: e.name, path: e.path, size: e.size, modified: e.modified })
        }
      }
    } catch (err: any) {
      const msg = String(err?.message ?? err)
      if (!msg.includes('No such file') && !msg.includes('code 2')) throw err
    }
    for (const path of ns.outputPaths ?? []) {
      if (byPath.has(path)) continue
      try {
        const stat = await this.sftp.stat(run.connectionId, path)
        if (!stat.isDirectory) {
          byPath.set(path, { name: pathBasename(path), path, size: stat.size, modified: stat.modified })
        }
      } catch (err: any) {
        const msg = String(err?.message ?? err)
        if (!msg.includes('No such file') && !msg.includes('code 2')) throw err
      }
    }
    return [...byPath.values()]
  }

  // ---- internals --------------------------------------------------------

  private async executeRun(
    run: RunState,
    snapshot: PipelineSnapshot,
    plans: Map<string, AxisPlan>,
    connectionDefaults: ConnectionDefaults,
    nodeSlugs: Map<string, string>,
  ): Promise<void> {
    const { layers } = topoSort(snapshot)
    const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n]))

    try {
      for (const layer of layers) {
        if (this.cancelledRuns.has(run.runId)) return

        const pending: Promise<void>[] = []
        for (const nodeId of layer) {
          const node = nodeById.get(nodeId)!
          if (node.type === 'file' || node.type === 'note') continue
          pending.push(this.runNode(run, node, plans, connectionDefaults, nodeSlugs))
        }
        await Promise.all(pending)

        if (this.cancelledRuns.has(run.runId)) return

        const anyFailed = layer.some((id) => run.nodes[id]?.status === 'failed')
        if (anyFailed) {
          run.status = 'failed'
          this.emitRunStatus(run.runId, 'failed')
          return
        }
      }

      run.status = 'done'
      this.emitRunStatus(run.runId, 'done')
    } catch (err) {
      run.status = 'failed'
      this.emitRunStatus(run.runId, 'failed')
      console.error(`[PipelineRunner] run ${run.runId} crashed:`, err)
    }
  }

  private async runNode(
    run: RunState,
    node: PipelineSnapshot['nodes'][number],
    plans: Map<string, AxisPlan>,
    connectionDefaults: ConnectionDefaults,
    nodeSlugs: Map<string, string>,
  ): Promise<void> {
    const plan = plans.get(node.id)
    if (!plan) throw new Error(`No axis plan for ${node.id}`)

    const slug = nodeSlugs.get(node.id) ?? node.id
    const logDir = `${run.workDir}/logs`
    const override =
      node.type === 'tool'
        ? (node.data as ToolNodeData).outputDirOverride
        : node.type === 'merge'
          ? (node.data as MergeNodeData).outputDirOverride
          : undefined
    const outputDir = resolveNodeOutputDir(override, `${run.workDir}/outputs`, slug, run.homeDir)
    const scriptPath = `${run.workDir}/scripts/${slug}.sbatch`
    const ns = run.nodes[node.id]

    let script: string
    let arraySize: number | undefined

    if (node.type === 'tool') {
      const toolData = node.data as ToolNodeData
      const tool = getTool(toolData.toolId)
      if (!tool) {
        this.failNode(run, ns, `Unknown tool ${toolData.toolId}`)
        return
      }
      const gen = generateToolScript({
        nodeId: node.id, nodeSlug: slug, tool, nodeData: toolData, axisPlan: plan,
        outputDir, logDir, connectionDefaults,
      })
      script = gen.script
      arraySize = gen.arraySize
    } else if (node.type === 'merge') {
      const mergeData = node.data as MergeNodeData
      const inputVal = plan.inputs.input
      if (!inputVal) {
        this.failNode(run, ns, `Merge node ${node.id} has no input`)
        return
      }
      // Use the strategy resolved during planning (so 'auto' becomes concrete).
      const effective: MergeNodeData = {
        ...mergeData,
        strategy: plan.resolvedMergeStrategy ?? mergeData.strategy,
      }
      const gen = generateMergeScript({
        nodeId: node.id,
        nodeSlug: slug,
        mergeData: effective,
        resolvedInputs: inputVal,
        upstreamFileType: plan.upstreamFileType ?? 'any',
        outputDir, logDir, connectionDefaults,
      })
      script = gen.script
    } else {
      return
    }

    await this.sftp.write(run.connectionId, scriptPath, script)
    ns.scriptPath = scriptPath
    ns.outputDir = outputDir
    ns.outputPaths = collectOutputPaths(plan.outputs)
    ns.submittedAt = Date.now()
    ns.isArray = plan.mode === 'array'
    ns.arraySize = arraySize

    const parts: string[] = ['sbatch']
    if (plan.dependsOnArrayNodeIds.length > 0) {
      const depIds: string[] = []
      for (const upId of plan.dependsOnArrayNodeIds) {
        const up = run.nodes[upId]
        if (up?.jobId) depIds.push(up.jobId)
      }
      if (depIds.length > 0) parts.push(`--dependency=afterok:${depIds.join(':')}`)
    }
    parts.push(shellQuote(scriptPath))

    const { stdout, stderr, exitCode } = await this.ssh.exec(run.connectionId, parts.join(' '))
    if (exitCode !== 0) {
      this.failNode(run, ns, `sbatch failed (${exitCode}): ${(stderr || stdout).trim()}`)
      return
    }
    const m = stdout.match(/Submitted batch job (\d+)/)
    if (!m) {
      this.failNode(run, ns, `Could not parse sbatch output: ${stdout.trim()}`)
      return
    }
    const jobId = m[1]
    ns.jobId = jobId
    ns.status = 'queued'
    ns.stdoutPath = plan.mode === 'array'
      ? `${logDir}/${slug}-${jobId}_%a.out`
      : `${logDir}/${slug}-${jobId}.out`
    ns.stderrPath = plan.mode === 'array'
      ? `${logDir}/${slug}-${jobId}_%a.err`
      : `${logDir}/${slug}-${jobId}.err`
    console.debug('[PipelineRunner] submitted node', {
      runId: run.runId,
      nodeId: node.id,
      slug,
      jobId,
      isArray: ns.isArray,
      stdoutPath: ns.stdoutPath,
      stderrPath: ns.stderrPath,
    })
    this.emitNodeStatus(run.runId, node.id, 'queued', jobId)

    await new Promise<void>((resolve) => {
      // Cancellers for the log tails — populated in onStart, called in onFinish.
      let cancelTailOut: (() => void) | null = null
      let cancelTailErr: (() => void) | null = null

      this.tracker.watch({
        connectionId: run.connectionId,
        jobId,
        isArray: plan.mode === 'array',
        onStart: () => {
          ns.status = 'running'
          ns.startedAt = Date.now()
          this.emitNodeStatus(run.runId, node.id, 'running', jobId)

          // Stream logs for single + fanIn jobs. Array jobs have per-task log
          // files (22+ for per-chrom pipelines) so we leave them on SFTP polling.
          if (plan.mode !== 'array' && ns.stdoutPath && ns.stderrPath) {
            const { cancel: co } = this.ssh.execStream(
              run.connectionId,
              // -n +1 reads the file from the start; -F follows new lines and
              // waits for the file to appear if it doesn't exist yet.
              `tail -F -n +1 ${shellQuote(ns.stdoutPath)} 2>/dev/null`,
              (chunk) => this.emitJobLog(run.runId, node.id, chunk, 'stdout'),
            )
            const { cancel: ce } = this.ssh.execStream(
              run.connectionId,
              `tail -F -n +1 ${shellQuote(ns.stderrPath)} 2>/dev/null`,
              (chunk) => this.emitJobLog(run.runId, node.id, chunk, 'stderr'),
            )
            cancelTailOut = co
            cancelTailErr = ce
          }
        },
        onFinish: (outcome) => {
          cancelTailOut?.()
          cancelTailErr?.()
          ns.finishedAt = Date.now()
          if (outcome.kind === 'done') {
            ns.status = 'done'
            ns.exitCode = outcome.exitCode
            this.emitNodeStatus(run.runId, node.id, 'done', jobId)
          } else if (outcome.kind === 'cancelled') {
            ns.status = 'cancelled'
            this.emitNodeStatus(run.runId, node.id, 'cancelled', jobId)
          } else {
            ns.status = 'failed'
            ns.exitCode = outcome.exitCode
            ns.error = outcome.reason
            this.emitNodeStatus(run.runId, node.id, 'failed', jobId, outcome.reason)
          }
          resolve()
        },
      })
    })
  }

  private failNode(run: RunState, ns: NodeRunState, error: string): void {
    ns.status = 'failed'
    ns.error = error
    this.emitNodeStatus(run.runId, ns.nodeId, 'failed', ns.jobId, error)
  }

  private emitJobLog(runId: string, nodeId: string, chunk: string, stream: 'stdout' | 'stderr'): void {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      win.webContents.send('pipeline:job-log', { runId, nodeId, chunk, stream })
    }
  }

  private emitNodeStatus(runId: string, nodeId: string, status: RunStatus | 'idle', jobId?: string, error?: string): void {
    const run = this.runs.get(runId)
    if (run) run.updatedAt = Date.now()
    const node = run?.nodes[nodeId] ? { ...run.nodes[nodeId] } : undefined
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      win.webContents.send('pipeline:node-status', { runId, nodeId, status, jobId, error, node })
    }
  }

  private emitRunStatus(runId: string, status: RunStatus): void {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    win.webContents.send('pipeline:run-status', { runId, status })
  }

  private loadAnalysisFolder(connectionId: string): string | undefined {
    try {
      const store = getSettingsStore() as unknown as { get: (k: string) => unknown }
      const raw = store.get(`connection:${connectionId}:defaultAnalysisFolder`)
      return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
    } catch (err) {
      console.error('[PipelineRunner] loadAnalysisFolder failed:', err)
      return undefined
    }
  }

  private async loadConnectionDefaults(connectionId: string): Promise<ConnectionDefaults> {
    try {
      // Must use the same named store as the renderer IPC path
      // (electron/store/settingsStore.ts: name='bioflow-settings'), otherwise
      // values saved from the Slurm Settings UI land in a different file.
      const store = getSettingsStore() as unknown as { get: (k: string) => unknown }
      const rawAccount = store.get(`connection:${connectionId}:slurmAccount`)
      const rawPartition = store.get(`connection:${connectionId}:slurmPartition`)
      const account = typeof rawAccount === 'string' && rawAccount.trim() ? rawAccount.trim() : undefined
      const partition = typeof rawPartition === 'string' && rawPartition.trim() ? rawPartition.trim() : undefined
      return { account, partition, modulePreamble: MODULE_PREAMBLE }
    } catch (err) {
      console.error('[PipelineRunner] loadConnectionDefaults failed:', err)
      return { modulePreamble: MODULE_PREAMBLE }
    }
  }
}

/**
 * Expand a leading `~` or `~/` in a user-configured path using the resolved
 * remote $HOME. Absolute paths pass through unchanged. SFTP does not expand
 * `~`, so every path that crosses the SFTP boundary must be absolute.
 */
function expandHome(path: string, home: string): string {
  const p = path.trim().replace(/\/+$/, '')
  if (p === '~') return home
  if (p.startsWith('~/')) return `${home}/${p.slice(2)}`
  return p
}

function collectOutputPaths(outputs: Record<string, { kind: string; path?: string; paths?: string[] }>): string[] {
  const paths: string[] = []
  for (const output of Object.values(outputs)) {
    if (output.kind === 'single' && output.path) paths.push(output.path)
    else if ((output.kind === 'array' || output.kind === 'multi') && output.paths) paths.push(...output.paths)
  }
  return paths
}

function pathDirname(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return '/'
  return path.slice(0, idx)
}

function pathBasename(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? path : path.slice(idx + 1)
}

function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_\-./~]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'"'"'`)}'`
}

/**
 * Slugify a display string for use in a shell path. Keeps it filesystem-safe
 * and human-readable: lowercase, ASCII alnum + dashes only, collapsed runs,
 * trimmed to 40 chars. Returns 'node' for empty input.
 */
function slugify(raw: string): string {
  const s = (raw ?? '')
    .toString()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s || 'node'
}

/** YYYYMMDD-HHmmss in local time. Human-scannable and sortable. */
function timestampStamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

/**
 * Build a per-node slug map: `<slugified-label>-<short-id>`. The short-id tail
 * (last 6 chars of the node id) keeps slugs unique even when two nodes share a
 * label. If two nodes still collide (same label + same tail), we append a
 * numeric suffix.
 */
function buildNodeSlugs(snapshot: PipelineSnapshot): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const n of snapshot.nodes) {
    if (n.type === 'note') continue
    let label: string
    if (n.type === 'tool') label = (n.data as ToolNodeData).label || (n.data as ToolNodeData).toolId
    else if (n.type === 'merge') label = (n.data as MergeNodeData).label || 'merge'
    else if (n.type === 'file') label = (n.data as FileNodeData).label || 'file'
    else label = (n.data as NoteNodeData).text?.slice(0, 20) || 'node'

    const base = slugify(label)
    const tail = n.id.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toLowerCase() || 'x'
    let candidate = `${base}-${tail}`
    let i = 2
    while (used.has(candidate)) {
      candidate = `${base}-${tail}-${i++}`
    }
    used.add(candidate)
    out.set(n.id, candidate)
  }
  return out
}
