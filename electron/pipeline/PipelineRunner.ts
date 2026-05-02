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
 * Runs are persisted in the settings store and can reattach to queued/running
 * Slurm jobs after the app restarts.
 */
import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fsPromises } from 'node:fs'
import { homedir as localHomedir } from 'node:os'

import { SshManager } from '../ssh/SshManager'
import { SftpPool } from '../ssh/SftpPool'
import { getSettingsStore } from '../store/settingsStore'
import { JobTracker } from './JobTracker'
import { DnxBackendAdapter } from './DnxBackendAdapter'
import { DnxJobPoller } from './DnxJobPoller'
import { topoSort } from './topoSort'
import { planAxes, resolveNodeOutputDir, type AxisPlan } from './axisPlanner'
import { generateToolScript, generateMergeScript, generateTransformScript, type ConnectionDefaults } from './ScriptGenerator'
import { getTool } from '../../src/lib/toolRegistry'
import { buildRunManifest, extractCommands } from '../../src/lib/runManifest'
import { planPipelineTransfers } from '../../src/lib/transferPlanner'
import { protectedPathsForFileData } from '../../src/lib/dataArtifacts'
import { LOCAL_CONNECTION_ID } from '../../src/constants/connections'
import type {
  PipelineSnapshot,
  RunState,
  RunStatus,
  NodeRunState,
  DryRunScript,
  ToolNodeData,
  MergeNodeData,
  TransferNodeData,
  TransferPlan,
  TransformNodeData,
  FileNodeData,
  NoteNodeData,
  NodeGroup,
} from '../../src/types/pipeline'
import type { RunReadinessReport } from '../../src/types/workspace'

export interface StartOptions {
  connectionId: string
  snapshot: PipelineSnapshot
  workDir?: string
  workspace?: RunState['workspace']
  runReadiness?: RunReadinessReport | null
}

/**
 * Default run directory, relative to the user's home on the remote host.
 * We resolve `$HOME` to an absolute path at run start so SFTP (which does NOT
 * shell-expand `~`) can write scripts successfully.
 */
const DEFAULT_WORKDIR_SUBPATH_PARENT = 'bioflow'
const MODULE_PREAMBLE = 'module --force purge && module load StdEnv/2023'

type NodeOutputOrigin = 'local' | 'ssh' | 'dnx'

interface ListedNodeOutput {
  name: string
  path: string
  size: number
  modified: number
  origin: NodeOutputOrigin
}

interface RunPathSettings {
  scriptsSubfolder: string
  outputsSubfolder: string
  logsSubfolder: string
  createSubfolders: boolean
  runFolderTemplate: string
}

interface RunDirs {
  workDir: string
  scriptsDir: string
  logsDir: string
  outputRoot: string
}

interface ExecutionDefaults {
  arrayChainMode: 'task-level' | 'job-level'
  fileLifecyclePolicy: 'keep-all' | 'keep-outputs-only' | 'delete-intermediates-on-success'
}

interface DnxContext {
  projectId: string
  outputRoot: string
}

export class PipelineRunner {
  private static instance: PipelineRunner | null = null
  static getInstance(): PipelineRunner {
    if (!this.instance) this.instance = new PipelineRunner()
    return this.instance
  }

  private runs = new Map<string, RunState>()
  private cancelledRuns = new Set<string>()
  private reattachedJobs = new Set<string>()
  private loginCancels = new Map<string, () => void>()
  private cancelledLoginNodes = new Set<string>()
  private homeCache = new Map<string, string>()
  private afterCorrSupport = new Map<string, boolean>()
  private shellCapabilities = new Map<string, { awk: boolean }>()

  private constructor() {
    this.loadPersistedRuns()
    setTimeout(() => void this.reattachPersistedJobs(), 500)
  }

  private get ssh() { return SshManager.getInstance() }
  private get sftp() { return SftpPool.getInstance() }
  private get tracker() { return JobTracker.getInstance(this.ssh) }
  private get dnx() { return new DnxBackendAdapter() }
  private get dnxPoller() { return new DnxJobPoller() }

  clearConnectionCache(connectionId: string): void {
    this.homeCache.delete(connectionId)
    this.afterCorrSupport.delete(connectionId)
    this.shellCapabilities.delete(connectionId)
  }

  private nodeRunsOnDnx(node: PipelineSnapshot['nodes'][number]): boolean {
    return node.type === 'tool' && (node.data as ToolNodeData).backend === 'dnx'
  }

  private nodeNeedsSsh(node: PipelineSnapshot['nodes'][number]): boolean {
    if (node.type === 'file' || node.type === 'note') return false
    if (node.type === 'transfer') return (node.data as TransferNodeData).from === 'ssh' || (node.data as TransferNodeData).to === 'ssh'
    if (node.type === 'merge' || node.type === 'transform') return true
    return !this.nodeRunsOnDnx(node)
  }

  async start(opts: StartOptions): Promise<{ runId: string }> {
    const { connectionId, snapshot } = opts
    const runId = randomUUID()

    const needsSsh = snapshot.nodes.some((node) => this.nodeNeedsSsh(node))
    const needsDnx = snapshot.nodes.some((node) =>
      this.nodeRunsOnDnx(node) ||
      (node.type === 'transfer' && ((node.data as TransferNodeData).from === 'dnx' || (node.data as TransferNodeData).to === 'dnx')) ||
      (node.type === 'file' && (node.data as FileNodeData).origin === 'dnx'),
    )
    const connectionDefaults = needsSsh ? await this.loadConnectionDefaults(connectionId) : {}
    const needsSlurm = snapshot.nodes.some((node) =>
      this.nodeNeedsSsh(node) &&
      (node.type === 'merge' ||
        node.type === 'transform' ||
        (node.type === 'tool' && (node.data as ToolNodeData).executionMode !== 'login')),
    )
    if (needsSlurm && !connectionDefaults.account) {
      throw new Error(
        'No Slurm account set. Click the connection name in the top bar → Slurm Settings to add one.',
      )
    }
    const analysisFolder = this.loadAnalysisFolder(connectionId)
    const executionDefaults = this.loadExecutionDefaults()
    const arrayChainMode = snapshot.execution?.arrayChainMode ?? executionDefaults.arrayChainMode
    const fileLifecyclePolicy = snapshot.execution?.fileLifecyclePolicy ?? executionDefaults.fileLifecyclePolicy

    // Resolve $HOME to an absolute path. SFTP does not shell-expand `~`, so
    // every path we hand to SftpPool.write must be absolute; SSH exec does
    // expand it, but keeping both paths consistent here avoids foot-guns.
    const home = needsSsh ? await this.resolveHome(connectionId) : ''

    // Human-readable run directory. Root is the user's configured default
    // analysis folder, or ~/bioflow; the tail comes from settings.
    const pathSettings = this.loadRunPathSettings()
    const dnxContext = needsDnx ? await this.dnx.authenticate() : null
    const dnxOutputRoot = dnxContext ? buildDnxOutputRoot(snapshot, pathSettings) : undefined
    const workRoot = needsSsh
      ? (analysisFolder
          ? expandHome(analysisFolder, home)
          : `${home}/${DEFAULT_WORKDIR_SUBPATH_PARENT}`)
      : ''
    const runDirs = needsSsh
      ? buildRunDirs(opts.workDir, workRoot, snapshot, pathSettings, home)
      : {
          workDir: dnxOutputRoot ?? `dnx:${runId}`,
          scriptsDir: '',
          logsDir: '',
          outputRoot: dnxOutputRoot ?? `/BioFlow/runs/${runId}/outputs`,
        }
    const { workDir, scriptsDir, logsDir, outputRoot } = runDirs

    // Pre-compute human-readable slugs for every node (label-based with a short
    // id tail for uniqueness). Same slug feeds the planner and the script
    // generator so output paths line up across both.
    const nodeSlugs = buildNodeSlugs(snapshot)

    // Plan axes (throws on cycles, unknown tools, ambiguous axes).
    topoSort(snapshot)
    const transferPlans = planPipelineTransfers(snapshot)
    const plans = planAxes(snapshot, {
      outputRoot,
      outputRootForNode: (node) => {
        if (!dnxOutputRoot) return outputRoot
        if (node.type === 'transfer') {
          return (node.data as TransferNodeData).to === 'dnx' ? dnxOutputRoot : outputRoot
        }
        return this.nodeRunsOnDnx(node) ? dnxOutputRoot : outputRoot
      },
      getTool,
      nodeSlug: (id) => nodeSlugs.get(id) ?? id,
      homeDir: home || undefined,
    })

    if (needsSsh) {
      await this.verifyPlinkSidecars(connectionId, snapshot, home)
    }

    const now = Date.now()
    const nodes: Record<string, NodeRunState> = {}
    for (const n of snapshot.nodes) {
      if (n.type === 'tool' || n.type === 'merge' || n.type === 'transform' || n.type === 'transfer') {
        nodes[n.id] = {
          nodeId: n.id,
          toolId: n.type === 'tool' ? (n.data as ToolNodeData).toolId : n.type,
          status: 'idle',
        }
      }
    }
    const runState: RunState = {
      runId,
      pipelineId: snapshot.id,
      pipelineName: snapshot.name,
      snapshot,
      workspace: opts.workspace ?? null,
      connectionId,
      arrayChainMode,
      fileLifecyclePolicy,
      workDir,
      scriptsDir,
      logsDir,
      outputRoot,
      homeDir: home,
      createdAt: now,
      updatedAt: now,
      status: 'running',
      nodes,
      transferPlans,
      runReadiness: opts.runReadiness ?? null,
    }
    this.runs.set(runId, runState)
    this.persistRuns()
    this.emitRunStatus(runId, 'running')

    // One exec creates scripts/, logs/, and per-node output dirs (default or
    // override). Overrides are already `~`-expanded by resolveNodeOutputDir.
    if (needsSsh) {
      const dirs = new Set<string>([scriptsDir, logsDir])
      for (const n of snapshot.nodes) {
        if (n.type === 'tool' || n.type === 'merge' || n.type === 'transform') {
          if (this.nodeRunsOnDnx(n)) continue
          const slug = nodeSlugs.get(n.id) ?? n.id
          const override = (n.data as ToolNodeData | MergeNodeData | TransformNodeData).outputDirOverride
          dirs.add(resolveNodeOutputDir(override, outputRoot, slug, home))
        }
      }
      for (const [nodeId, plan] of plans) {
        const node = snapshot.nodes.find((candidate) => candidate.id === nodeId)
        if (!node || this.nodeRunsOnDnx(node) || plan.nodeType === 'transfer') continue
        if (plan.nodeType !== 'tool' && plan.nodeType !== 'merge' && plan.nodeType !== 'transform') continue
        for (const path of collectOutputPaths(plan.outputs)) {
          dirs.add(pathDirname(path))
        }
      }
      const mkdirCmd = [...dirs].map((d) => `mkdir -p ${shellQuote(d)}`).join(' && ')
      await this.ssh.exec(connectionId, mkdirCmd)
    }

    // Persist the snapshot for audit/debug. Best-effort; failure doesn't abort.
    if (needsSsh) {
      try {
        await this.sftp.write(connectionId, `${workDir}/pipeline.json`, JSON.stringify(snapshot, null, 2))
      } catch (err) {
        console.error('[PipelineRunner] failed to write pipeline.json:', err)
      }
      try {
        const scripts = await this.generateScriptsDry({ connectionId, snapshot, workDir, workspace: opts.workspace })
        const manifest = buildRunManifest(runState, snapshot, opts.workspace ?? null, {
          scripts,
          transferPlans,
          runReadiness: opts.runReadiness ?? null,
        })
        await this.sftp.write(connectionId, `${workDir}/run.manifest.json`, JSON.stringify(manifest, null, 2))
      } catch (err) {
        console.error('[PipelineRunner] failed to write run.manifest.json:', err)
      }
    }

    // Kick off the run; the caller resumes as soon as start() returns the runId.
    void this.executeRun(runState, snapshot, plans, connectionDefaults, nodeSlugs)

    return { runId }
  }

  async generateScriptsDry(opts: StartOptions): Promise<DryRunScript[]> {
    const { connectionId, snapshot } = opts
    const needsSsh = snapshot.nodes.some((node) => this.nodeNeedsSsh(node))
    const needsDnx = snapshot.nodes.some((node) =>
      this.nodeRunsOnDnx(node) ||
      (node.type === 'transfer' && ((node.data as TransferNodeData).from === 'dnx' || (node.data as TransferNodeData).to === 'dnx')),
    )
    const connectionDefaults = needsSsh ? await this.loadConnectionDefaults(connectionId) : {}
    const analysisFolder = needsSsh ? this.loadAnalysisFolder(connectionId) : undefined
    const home = needsSsh ? await this.resolveHome(connectionId) : ''
    const pathSettings = this.loadRunPathSettings()
    const dnxOutputRoot = needsDnx ? buildDnxOutputRoot(snapshot, pathSettings) : undefined
    const workRoot = needsSsh
      ? (analysisFolder ? expandHome(analysisFolder, home) : `${home}/${DEFAULT_WORKDIR_SUBPATH_PARENT}`)
      : ''
    const runDirs = needsSsh
      ? buildRunDirs(opts.workDir, workRoot, snapshot, pathSettings, home)
      : {
          workDir: dnxOutputRoot ?? `dnx:preview`,
          scriptsDir: '',
          logsDir: '',
          outputRoot: dnxOutputRoot ?? '/BioFlow/runs/preview/outputs',
        }
    const { workDir, logsDir, outputRoot } = runDirs
    const nodeSlugs = buildNodeSlugs(snapshot)

    topoSort(snapshot)
    const plans = planAxes(snapshot, {
      outputRoot,
      outputRootForNode: (node) => {
        if (!dnxOutputRoot) return outputRoot
        if (node.type === 'transfer') return (node.data as TransferNodeData).to === 'dnx' ? dnxOutputRoot : outputRoot
        return this.nodeRunsOnDnx(node) ? dnxOutputRoot : outputRoot
      },
      getTool,
      nodeSlug: (id) => nodeSlugs.get(id) ?? id,
      homeDir: home || undefined,
    })

    const { order } = topoSort(snapshot)
    const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n]))
    const scripts: DryRunScript[] = []

    for (const nodeId of order) {
      const node = nodeById.get(nodeId)
      const plan = plans.get(nodeId)
      if (!node || !plan || (node.type !== 'tool' && node.type !== 'merge' && node.type !== 'transform' && node.type !== 'transfer')) continue

      const slug = nodeSlugs.get(nodeId) ?? nodeId
      const logDir = logsDir
      const override = (node.data as ToolNodeData | MergeNodeData | TransformNodeData).outputDirOverride
      const outputDir = resolveNodeOutputDir(override, this.nodeRunsOnDnx(node) && dnxOutputRoot ? dnxOutputRoot : outputRoot, slug, home || undefined)

      if (node.type === 'tool') {
        const toolData = node.data as ToolNodeData
        const tool = getTool(toolData.toolId)
        if (!tool) throw new Error(`Unknown tool ${toolData.toolId}`)
        const gen = generateToolScript({
          nodeId,
          nodeSlug: slug,
          tool,
          nodeData: toolData,
          axisPlan: plan,
          outputDir,
          logDir,
          connectionDefaults,
        })
        scripts.push({
          nodeId,
          label: toolData.label || tool.name,
          mode: plan.mode,
          summary: tool.description,
          commands: extractCommands(gen.script),
          script: gen.script,
          outputPaths: collectOutputPaths(plan.outputs),
          intermediatePaths: this.collectIntermediatePathsForNode(node, plan),
          arraySize: gen.arraySize,
        })
      } else if (node.type === 'merge') {
        const mergeData = node.data as MergeNodeData
        const inputVal = plan.inputs.input
        if (!inputVal) throw new Error(`Merge node ${nodeId} has no input`)
        const effective: MergeNodeData = {
          ...mergeData,
          strategy: plan.resolvedMergeStrategy ?? mergeData.strategy,
        }
        const gen = generateMergeScript({
          nodeId,
          nodeSlug: slug,
          mergeData: effective,
          resolvedInputs: inputVal,
          upstreamFileType: plan.upstreamFileType ?? 'any',
          outputPath: collectOutputPaths(plan.outputs)[0],
          outputDir,
          logDir,
          connectionDefaults,
        })
        scripts.push({
          nodeId,
          label: mergeData.label || 'Merge',
          mode: plan.mode,
          summary: 'Merge upstream outputs into one file.',
          commands: extractCommands(gen.script),
          script: gen.script,
          outputPaths: [gen.outputPath],
          intermediatePaths: this.collectIntermediatePathsForNode(node, plan),
        })
      } else if (node.type === 'transform') {
        const transformData = node.data as TransformNodeData
        const gen = generateTransformScript({
          nodeId,
          nodeSlug: slug,
          transformData,
          axisPlan: plan,
          outputDir,
          logDir,
          connectionDefaults,
        })
        scripts.push({
          nodeId,
          label: transformData.label || 'Transform',
          mode: plan.mode,
          summary: 'Transform tabular input into a derived artifact.',
          commands: extractCommands(gen.script),
          script: gen.script,
          outputPaths: collectOutputPaths(plan.outputs),
          intermediatePaths: this.collectIntermediatePathsForNode(node, plan),
          arraySize: gen.arraySize,
        })
      } else {
        scripts.push({
          nodeId,
          label: (node.data as TransferNodeData).label || 'Transfer',
          mode: plan.mode,
          summary: 'Transfer data between backends.',
          commands: [],
          script: '',
          outputPaths: collectOutputPaths(plan.outputs),
        })
      }
    }

    return scripts
  }

  /** Resolve `$HOME` on the remote host. SFTP paths need this expanded, while
   * dry script preview only needs it for planning; cache it so preview does not
   * open a new SSH channel every time. */
  private async resolveHome(connectionId: string): Promise<string> {
    const cached = this.homeCache.get(connectionId)
    if (cached) return cached
    const { stdout, exitCode, stderr } = await this.ssh.exec(connectionId, 'printf %s "$HOME"')
    if (exitCode !== 0 || !stdout.trim()) {
      throw new Error(`Could not resolve remote $HOME: ${(stderr || stdout).trim()}`)
    }
    const home = stdout.trim().replace(/\/+$/, '')
    this.homeCache.set(connectionId, home)
    return home
  }

  private async verifyPlinkSidecars(connectionId: string, snapshot: PipelineSnapshot, home: string): Promise<void> {
    const missing: string[] = []
    const plinkInputFileNodeIds = new Set<string>()
    for (const edge of snapshot.edges) {
      const target = snapshot.nodes.find((node) => node.id === edge.target)
      const source = snapshot.nodes.find((node) => node.id === edge.source)
      if (source?.type !== 'file' || target?.type !== 'tool') continue
      const tool = getTool((target.data as ToolNodeData).toolId)
      if ((tool?.command === 'plink2' || tool?.command === 'plink') && (edge.targetHandle ?? 'input') === 'input') {
        plinkInputFileNodeIds.add(source.id)
      }
    }
    const checkOne = async (path: string) => {
      const resolved = expandHome(path, home)
      const lower = resolved.toLowerCase()
      const expected = lower.endsWith('.pgen')
        ? [`${stripKnownExt(resolved)}.pvar`, `${stripKnownExt(resolved)}.psam`]
        : lower.endsWith('.bed')
          ? [`${stripKnownExt(resolved)}.bim`, `${stripKnownExt(resolved)}.fam`]
          : []
      for (const sidecar of expected) {
        try {
          const stat = await this.sftp.stat(connectionId, sidecar)
          if (stat.isDirectory) missing.push(sidecar)
        } catch {
          missing.push(sidecar)
        }
      }
    }

    for (const node of snapshot.nodes) {
      if (node.type !== 'file') continue
      const data = node.data as FileNodeData
      if (!plinkInputFileNodeIds.has(node.id)) continue
      if (!data.isInput || data.origin === 'dnx' || data.origin === 'local' || data.source === 'local') continue
      if (data.fileType !== 'plink' && data.fileType !== 'pgen' && data.fileType !== 'bed') continue
      const splitItems = (data.split as { items?: Array<{ path?: unknown }> } | undefined)?.items
      if (Array.isArray(splitItems) && splitItems.length > 0) {
        for (const item of splitItems) {
          if (typeof item.path === 'string') await checkOne(item.path)
        }
      } else if (data.path) {
        await checkOne(data.path)
      }
    }

    if (missing.length > 0) {
      const shown = [...new Set(missing)].slice(0, 12)
      const suffix = missing.length > shown.length ? `\n...and ${missing.length - shown.length} more.` : ''
      throw new Error(`PLINK fileset sidecar check failed. Missing:\n${shown.join('\n')}${suffix}`)
    }
  }

  /**
   * Route cancellation to the right backend based on the jobId shape.
   * DNAnexus jobs are `job-…` prefixed; Slurm ids are numeric. Local
   * "login-" jobs are an internal sentinel.
   */
  private async cancelOneJob(connectionId: string, runId: string, nodeId: string, jobId: string): Promise<void> {
    if (jobId.startsWith('login-')) {
      const key = `${runId}:${nodeId}`
      this.cancelledLoginNodes.add(key)
      this.loginCancels.get(key)?.()
      return
    }
    if (jobId.startsWith('transfer-')) {
      // Transfer nodes complete in-process; nothing to cancel on a backend.
      return
    }
    if (jobId.startsWith('job-')) {
      try {
        await this.dnxPoller.cancel(jobId)
      } catch (err) {
        console.error('[PipelineRunner] DNAnexus cancel failed:', err)
      }
      return
    }
    await this.tracker.cancel(connectionId, jobId)
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
        await this.cancelOneJob(run.connectionId, runId, ns.nodeId, ns.jobId)
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
    await this.cancelOneJob(run.connectionId, runId, nodeId, ns.jobId)
  }

  /**
   * Cancel a slurm job by id without requiring a runId/nodeId lookup. Used by
   * the Queue panel where the user sees raw squeue output and acts on a row.
   */
  async cancelJobId(connectionId: string, jobId: string): Promise<void> {
    await this.tracker.cancel(connectionId, jobId)
  }

  async rerunNode(runId: string, nodeId: string, snapshot: PipelineSnapshot): Promise<void> {
    const run = this.runs.get(runId)
    if (!run) throw new Error(`Run ${runId} not found`)
    if (run.pipelineId !== snapshot.id) {
      throw new Error('This run belongs to a different pipeline. Open that pipeline before rerunning a step.')
    }

    const connectionDefaults = await this.loadConnectionDefaults(run.connectionId)
    const nodeSlugs = buildNodeSlugs(snapshot)
    const outputRoot = run.outputRoot ?? `${run.workDir}/outputs`
    const scriptsDir = run.scriptsDir ?? `${run.workDir}/scripts`
    const logsDir = run.logsDir ?? `${run.workDir}/logs`
    topoSort(snapshot)
    const plans = planAxes(snapshot, {
      outputRoot,
      getTool,
      nodeSlug: (id) => nodeSlugs.get(id) ?? id,
      homeDir: run.homeDir,
    })

    const affected = downstreamOf(snapshot, nodeId)
    if (!affected.has(nodeId)) affected.add(nodeId)

    const dirs = new Set<string>([scriptsDir, logsDir])
    for (const id of affected) {
      const node = snapshot.nodes.find((candidate) => candidate.id === id)
      if (!node || (node.type !== 'tool' && node.type !== 'merge' && node.type !== 'transform')) continue
      const slug = nodeSlugs.get(id) ?? id
      const override = (node.data as ToolNodeData | MergeNodeData | TransformNodeData).outputDirOverride
      dirs.add(resolveNodeOutputDir(override, outputRoot, slug, run.homeDir))
      const plan = plans.get(id)
      if (plan) {
        for (const path of collectOutputPaths(plan.outputs)) dirs.add(pathDirname(path))
      }
    }
    await this.ssh.exec(run.connectionId, [...dirs].map((d) => `mkdir -p ${shellQuote(d)}`).join(' && '))

    run.status = 'running'
    run.updatedAt = Date.now()
    this.emitRunStatus(runId, 'running')
    for (const id of affected) {
      const snapshotNode = snapshot.nodes.find((node) => node.id === id)
      const existing = run.nodes[id] ?? {
        nodeId: id,
        toolId: snapshotNode?.type === 'tool'
          ? (snapshotNode.data as ToolNodeData).toolId
          : snapshotNode?.type,
        status: 'idle' as const,
      }
      if (existing.jobId && (existing.status === 'queued' || existing.status === 'running')) {
        await this.tracker.cancel(run.connectionId, existing.jobId)
      }
      run.nodes[id] = { nodeId: id, toolId: existing.toolId, status: 'idle' }
      this.emitNodeStatus(runId, id, 'idle')
    }

    void this.executeRunSubset(run, snapshot, plans, connectionDefaults, nodeSlugs, affected)
  }

  listRuns(): RunState[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  getRun(runId: string): RunState | null {
    return this.runs.get(runId) ?? null
  }

  async reattachPersistedJobs(): Promise<void> {
    const liveConnections = new Set(this.ssh.listConnections().filter((c) => c.connected).map((c) => c.id))
    for (const run of this.runs.values()) {
      if (!liveConnections.has(run.connectionId)) continue
      if (run.status !== 'running' && run.status !== 'queued') continue
      for (const ns of Object.values(run.nodes)) {
        if (!ns.jobId || (ns.status !== 'queued' && ns.status !== 'running')) continue
        const key = `${run.runId}:${ns.jobId}`
        if (this.reattachedJobs.has(key)) continue
        this.reattachedJobs.add(key)
        this.tracker.watch({
          connectionId: run.connectionId,
          jobId: ns.jobId,
          isArray: !!ns.isArray,
          onStart: () => {
            ns.status = 'running'
            ns.startedAt = ns.startedAt ?? Date.now()
            this.emitNodeStatus(run.runId, ns.nodeId, 'running', ns.jobId)
          },
          onFinish: (outcome) => {
            ns.finishedAt = Date.now()
            if (outcome.kind === 'done') {
              ns.status = 'done'
              ns.exitCode = outcome.exitCode
              this.emitNodeStatus(run.runId, ns.nodeId, 'done', ns.jobId)
            } else if (outcome.kind === 'cancelled') {
              ns.status = 'cancelled'
              this.emitNodeStatus(run.runId, ns.nodeId, 'cancelled', ns.jobId)
            } else {
              ns.status = 'failed'
              ns.exitCode = outcome.exitCode
              ns.error = outcome.reason
              this.emitNodeStatus(run.runId, ns.nodeId, 'failed', ns.jobId, outcome.reason)
            }
            const nodes = Object.values(run.nodes)
            if (nodes.every((node) => node.status === 'done')) run.status = 'done'
            else if (nodes.some((node) => node.status === 'failed')) run.status = 'failed'
            run.updatedAt = Date.now()
            this.emitRunStatus(run.runId, run.status)
          },
        })
      }
    }
  }

  /**
   * List the output directory for one node in a run. Remote outputs go through
   * SFTP; local transfer outputs use the local filesystem so the results view
   * does not accidentally probe local paths through SSH.
   */
  async listNodeOutputs(
    runId: string,
    nodeId: string,
    connectionIdOverride?: string,
  ): Promise<ListedNodeOutput[]> {
    const run = this.runs.get(runId)
    if (!run) return []
    const ns = run.nodes[nodeId]
    if (!ns?.outputDir && !ns?.outputPaths?.length) return []
    const outputOrigin = run.snapshot
      ? this.nodeOutputBackend(run.snapshot, nodeId) ?? (run.connectionId === LOCAL_CONNECTION_ID ? 'local' : 'ssh')
      : (run.connectionId === LOCAL_CONNECTION_ID ? 'local' : 'ssh')

    if (outputOrigin === 'dnx') {
      return (ns.outputPaths ?? []).map((path) => ({
        name: pathBasename(path),
        path,
        size: 0,
        modified: 0,
        origin: 'dnx',
      }))
    }

    if (outputOrigin === 'local') {
      const localOutputs: ListedNodeOutput[] = []
      for (const rawPath of ns.outputPaths ?? []) {
        const path = expandLocalHome(rawPath)
        try {
          const stat = await fsPromises.stat(path)
          if (!stat.isDirectory()) {
            localOutputs.push({
              name: pathBasename(path),
              path,
              size: stat.size,
              modified: stat.mtimeMs,
              origin: 'local',
            })
          }
        } catch {
          localOutputs.push({
            name: pathBasename(path),
            path,
            size: 0,
            modified: 0,
            origin: 'local',
          })
        }
      }
      return localOutputs
    }

    const connectionId = connectionIdOverride || run.connectionId
    if (!this.ssh.getClient(connectionId)) {
      return (ns.outputPaths ?? []).map((path) => ({
        name: pathBasename(path),
        path,
        size: 0,
        modified: 0,
        origin: 'ssh',
      }))
    }

    const byPath = new Map<string, ListedNodeOutput>()
    try {
      if (ns.outputDir) {
        const entries = await this.sftp.ls(connectionId, ns.outputDir)
        for (const e of entries.filter((entry) => !entry.isDirectory)) {
          byPath.set(e.path, { name: e.name, path: e.path, size: e.size, modified: e.modified, origin: 'ssh' })
        }
      }
    } catch (err: any) {
      const msg = String(err?.message ?? err)
      if (!msg.includes('No such file') && !msg.includes('code 2')) throw err
    }
    for (const path of ns.outputPaths ?? []) {
      if (byPath.has(path)) continue
      try {
        const stat = await this.sftp.stat(connectionId, path)
        if (!stat.isDirectory) {
          byPath.set(path, { name: pathBasename(path), path, size: stat.size, modified: stat.modified, origin: 'ssh' })
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
    const groupByNode = buildGroupByNode(snapshot)
    const submittedGroups = new Set<string>()

    try {
      for (const layer of layers) {
        if (this.cancelledRuns.has(run.runId)) return

        const pending: Promise<void>[] = []
        for (const nodeId of layer) {
          const node = nodeById.get(nodeId)!
          if (node.type === 'file' || node.type === 'note') continue
          const group = groupByNode.get(nodeId)
          if (group) {
            if (submittedGroups.has(group.id)) continue
            submittedGroups.add(group.id)
            pending.push(this.runGroup(run, group, snapshot, plans, connectionDefaults, nodeSlugs))
            continue
          }
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
      await this.finalizeRunArtifacts(run, snapshot, plans)
      this.emitRunStatus(run.runId, 'done')
    } catch (err) {
      run.status = 'failed'
      this.emitRunStatus(run.runId, 'failed')
      console.error(`[PipelineRunner] run ${run.runId} crashed:`, err)
    }
  }

  private async executeRunSubset(
    run: RunState,
    snapshot: PipelineSnapshot,
    plans: Map<string, AxisPlan>,
    connectionDefaults: ConnectionDefaults,
    nodeSlugs: Map<string, string>,
    affected: Set<string>,
  ): Promise<void> {
    const { layers } = topoSort(snapshot)
    const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n]))
    try {
      for (const layer of layers) {
        if (this.cancelledRuns.has(run.runId)) return
        const pending: Promise<void>[] = []
        for (const nodeId of layer) {
          if (!affected.has(nodeId)) continue
          const node = nodeById.get(nodeId)!
          if (node.type === 'file' || node.type === 'note') continue
          pending.push(this.runNode(run, node, plans, connectionDefaults, nodeSlugs))
        }
        await Promise.all(pending)
        if (layer.some((id) => affected.has(id) && run.nodes[id]?.status === 'failed')) {
          run.status = 'failed'
          this.emitRunStatus(run.runId, 'failed')
          return
        }
      }
      run.status = Object.values(run.nodes).some((node) => node.status === 'failed') ? 'failed' : 'done'
      if (run.status === 'done') {
        await this.finalizeRunArtifacts(run, snapshot, plans)
      }
      this.emitRunStatus(run.runId, run.status)
    } catch (err) {
      run.status = 'failed'
      this.emitRunStatus(run.runId, 'failed')
      console.error(`[PipelineRunner] rerun ${run.runId} crashed:`, err)
    }
  }

  private buildNodeScript(
    run: RunState,
    node: PipelineSnapshot['nodes'][number],
    plans: Map<string, AxisPlan>,
    connectionDefaults: ConnectionDefaults,
    nodeSlugs: Map<string, string>,
  ): { script: string; outputDir: string; outputPaths: string[]; arraySize?: number } | null {
    const plan = plans.get(node.id)
    if (!plan) throw new Error(`No axis plan for ${node.id}`)
    const slug = nodeSlugs.get(node.id) ?? node.id
    const logDir = run.logsDir ?? `${run.workDir}/logs`
    const override =
      node.type === 'tool'
        ? (node.data as ToolNodeData).outputDirOverride
        : node.type === 'merge'
          ? (node.data as MergeNodeData).outputDirOverride
          : node.type === 'transform'
            ? (node.data as TransformNodeData).outputDirOverride
            : undefined
    const outputDir = resolveNodeOutputDir(override, run.outputRoot ?? `${run.workDir}/outputs`, slug, run.homeDir)

    if (node.type === 'tool') {
      const toolData = node.data as ToolNodeData
      const tool = getTool(toolData.toolId)
      if (!tool) return null
      const gen = generateToolScript({
        nodeId: node.id, nodeSlug: slug, tool, nodeData: toolData, axisPlan: plan,
        outputDir, logDir, connectionDefaults,
      })
      return { script: gen.script, outputDir, outputPaths: collectOutputPaths(plan.outputs), arraySize: gen.arraySize }
    }

    if (node.type === 'merge') {
      const mergeData = node.data as MergeNodeData
      const inputVal = plan.inputs.input
      if (!inputVal) return null
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
        outputPath: collectOutputPaths(plan.outputs)[0],
        outputDir,
        logDir,
        connectionDefaults,
      })
      return { script: gen.script, outputDir, outputPaths: [gen.outputPath] }
    }

    if (node.type === 'transform') {
      const transformData = node.data as TransformNodeData
      const gen = generateTransformScript({
        nodeId: node.id,
        nodeSlug: slug,
        transformData,
        axisPlan: plan,
        outputDir,
        logDir,
        connectionDefaults,
      })
      return { script: gen.script, outputDir, outputPaths: collectOutputPaths(plan.outputs), arraySize: gen.arraySize }
    }

    return null
  }

  private async runGroup(
    run: RunState,
    group: NodeGroup,
    snapshot: PipelineSnapshot,
    plans: Map<string, AxisPlan>,
    connectionDefaults: ConnectionDefaults,
    nodeSlugs: Map<string, string>,
  ): Promise<void> {
    const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n]))
    const nodes = orderGroupNodes(group, snapshot).map((id) => nodeById.get(id)).filter(Boolean) as PipelineSnapshot['nodes']
    if (nodes.length === 0) return
    const loginNode = nodes.find((node) => node.type === 'tool' && (node.data as ToolNodeData).executionMode === 'login')
    if (loginNode) {
      this.failNode(run, run.nodes[loginNode.id], 'Login-node tools cannot be part of a grouped sbatch.')
      return
    }

    const firstPlan = plans.get(nodes[0].id)
    if (!firstPlan) throw new Error(`No axis plan for ${nodes[0].id}`)
    const groupSlug = slugify(group.label || 'group') + '-' + group.id.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toLowerCase()
    const scriptPath = `${run.scriptsDir ?? `${run.workDir}/scripts`}/${groupSlug}.sbatch`
    const built = nodes.map((node) => ({ node, built: this.buildNodeScript(run, node, plans, connectionDefaults, nodeSlugs) }))
    const missing = built.find((entry) => !entry.built)
    if (missing) {
      this.failNode(run, run.nodes[missing.node.id], `Could not build grouped script for ${missing.node.id}`)
      return
    }

    const logDir = run.logsDir ?? `${run.workDir}/logs`
    const script = mergeScriptsForGroup(
      group,
      groupSlug,
      logDir,
      built.map((entry) => ({ nodeId: entry.node.id, script: entry.built!.script })),
    )
    await this.sftp.write(run.connectionId, scriptPath, script)

    for (const entry of built) {
      const ns = run.nodes[entry.node.id]
      ns.scriptPath = scriptPath
      ns.outputDir = entry.built!.outputDir
      ns.outputPaths = entry.built!.outputPaths
      ns.submittedAt = Date.now()
      ns.isArray = firstPlan.mode === 'array'
      ns.arraySize = firstPlan.keys?.length
    }

    const depIds = groupDependencyJobIds(group, run, plans)
    const parts = ['sbatch']
    if (depIds.length > 0) parts.push(`--dependency=afterok:${depIds.join(':')}`)
    parts.push(shellQuote(scriptPath))
    const { stdout, stderr, exitCode } = await this.ssh.exec(run.connectionId, parts.join(' '))
    if (exitCode !== 0) {
      for (const entry of built) this.failNode(run, run.nodes[entry.node.id], `sbatch failed (${exitCode}): ${(stderr || stdout).trim()}`)
      return
    }
    const match = stdout.match(/Submitted batch job (\d+)/)
    if (!match) {
      for (const entry of built) this.failNode(run, run.nodes[entry.node.id], `Could not parse sbatch output: ${stdout.trim()}`)
      return
    }
    const jobId = match[1]
    const stdoutPath = firstPlan.mode === 'array'
      ? `${logDir}/${groupSlug}-${jobId}_%a.slurm.log`
      : `${logDir}/${groupSlug}-${jobId}.slurm.log`
    const stderrPath = stdoutPath
    for (const entry of built) {
      const ns = run.nodes[entry.node.id]
      ns.jobId = jobId
      ns.stdoutPath = stdoutPath
      ns.stderrPath = stderrPath
      ns.status = 'queued'
      this.emitNodeStatus(run.runId, entry.node.id, 'queued', jobId)
    }

    await new Promise<void>((resolve) => {
      let cancelTailOut: (() => void) | null = null

      this.tracker.watch({
        connectionId: run.connectionId,
        jobId,
        isArray: firstPlan.mode === 'array',
        onStart: () => {
          for (const entry of built) {
            const ns = run.nodes[entry.node.id]
            ns.status = 'running'
            ns.startedAt = Date.now()
            this.emitNodeStatus(run.runId, entry.node.id, 'running', jobId)
          }

          if (firstPlan.mode !== 'array') {
            const firstNodeId = built[0]?.node.id ?? group.nodeIds[0]
            const demuxOut = makeGroupLogDemuxer((nodeId, chunk) => this.emitJobLog(run.runId, nodeId, chunk, 'stdout'), firstNodeId)
            const { cancel: co } = this.ssh.execStream(
              run.connectionId,
              `tail -F -n +1 ${shellQuote(stdoutPath)} 2>/dev/null`,
              (chunk) => demuxOut(chunk),
            )
            cancelTailOut = co
          }
        },
        onFinish: (outcome) => {
          cancelTailOut?.()
          for (const entry of built) {
            const ns = run.nodes[entry.node.id]
            ns.finishedAt = Date.now()
            if (outcome.kind === 'done') {
              ns.status = 'done'
              ns.exitCode = outcome.exitCode
              this.emitNodeStatus(run.runId, entry.node.id, 'done', jobId)
            } else if (outcome.kind === 'cancelled') {
              ns.status = 'cancelled'
              this.emitNodeStatus(run.runId, entry.node.id, 'cancelled', jobId)
            } else {
              ns.status = 'failed'
              ns.exitCode = outcome.exitCode
              ns.error = outcome.reason
              this.emitNodeStatus(run.runId, entry.node.id, 'failed', jobId, outcome.reason)
            }
          }
          resolve()
        },
      })
    })
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

    if (node.type === 'transfer') {
      await this.runTransferNode(run, node, plan)
      return
    }
    if (this.nodeRunsOnDnx(node)) {
      await this.runDnxNode(run, node, plan, connectionDefaults, nodeSlugs)
      return
    }

    const slug = nodeSlugs.get(node.id) ?? node.id
    const logDir = run.logsDir ?? `${run.workDir}/logs`
    const override =
      node.type === 'tool'
        ? (node.data as ToolNodeData).outputDirOverride
        : node.type === 'merge'
          ? (node.data as MergeNodeData).outputDirOverride
          : node.type === 'transform'
            ? (node.data as TransformNodeData).outputDirOverride
            : undefined
    const outputDir = resolveNodeOutputDir(override, run.outputRoot ?? `${run.workDir}/outputs`, slug, run.homeDir)
    const scriptPath = `${run.scriptsDir ?? `${run.workDir}/scripts`}/${slug}.sbatch`
    const ns = run.nodes[node.id]

    let script: string
    let arraySize: number | undefined
    const localizedInputs: Record<string, AxisPlan['inputs'][string]> = {}
    for (const [portId, value] of Object.entries(plan.inputs)) {
      localizedInputs[portId] = await this.materializeInputValueForSsh(run, node, portId, value, outputDir)
    }
    const executionPlan: AxisPlan = {
      ...plan,
      inputs: localizedInputs,
    }

    if (node.type === 'tool') {
      const toolData = node.data as ToolNodeData
      const tool = getTool(toolData.toolId)
      if (!tool) {
        this.failNode(run, ns, `Unknown tool ${toolData.toolId}`)
        return
      }
      const gen = generateToolScript({
        nodeId: node.id, nodeSlug: slug, tool, nodeData: toolData, axisPlan: executionPlan,
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
        resolvedInputs: localizedInputs.input ?? inputVal,
        upstreamFileType: plan.upstreamFileType ?? 'any',
        outputPath: collectOutputPaths(plan.outputs)[0],
        outputDir, logDir, connectionDefaults,
      })
      script = gen.script
    } else if (node.type === 'transform') {
      const transformData = node.data as TransformNodeData
      const gen = generateTransformScript({
        nodeId: node.id,
        nodeSlug: slug,
        transformData,
        axisPlan: executionPlan,
        outputDir,
        logDir,
        connectionDefaults,
      })
      script = gen.script
      arraySize = gen.arraySize
    } else {
      return
    }

    await this.sftp.write(run.connectionId, scriptPath, script)
    ns.scriptPath = scriptPath
    ns.outputDir = outputDir
    ns.outputPaths = collectOutputPaths(plan.outputs)
    ns.submittedAt = Date.now()
    ns.isArray = Boolean(arraySize) || plan.mode === 'array'
    ns.arraySize = arraySize

    if (node.type === 'tool' && (node.data as ToolNodeData).executionMode === 'login') {
      await this.runLoginNode(run, node.id, ns, scriptPath, plan)
      return
    }

    const parts: string[] = ['sbatch']
    parts.push(...await this.buildDependencyArgs(run, plan))
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
    ns.stdoutPath = ns.isArray
      ? `${logDir}/${slug}-${jobId}_%a.slurm.log`
      : `${logDir}/${slug}-${jobId}.slurm.log`
    ns.stderrPath = ns.stdoutPath
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

    const outcome = await new Promise<any>((resolve) => {
      // Cancellers for the log tails — populated in onStart, called in onFinish.
      let cancelTailOut: (() => void) | null = null

      this.tracker.watch({
        connectionId: run.connectionId,
        jobId,
        isArray: Boolean(ns.isArray),
        onStart: () => {
          ns.status = 'running'
          ns.startedAt = Date.now()
          this.emitNodeStatus(run.runId, node.id, 'running', jobId)

          // Stream logs for single + fanIn jobs. Array jobs have per-task log
          // files (22+ for per-chrom pipelines) so we leave them on SFTP polling.
          if (!ns.isArray && ns.stdoutPath) {
            const { cancel: co } = this.ssh.execStream(
              run.connectionId,
              // -n +1 reads the file from the start; -F follows new lines and
              // waits for the file to appear if it doesn't exist yet.
              `tail -F -n +1 ${shellQuote(ns.stdoutPath)} 2>/dev/null`,
              (chunk) => this.emitJobLog(run.runId, node.id, chunk, 'stdout'),
            )
            cancelTailOut = co
          }
        },
        onFinish: (outcome) => {
          cancelTailOut?.()
          resolve(outcome)
        },
      })
    })
    ns.finishedAt = Date.now()
    if (outcome.kind === 'done' && plan.implicitMerges && Object.keys(plan.implicitMerges).length > 0) {
      try {
        await this.runImplicitMerges(run, node, plan, connectionDefaults, nodeSlugs)
        ns.status = 'done'
        ns.exitCode = outcome.exitCode
        this.emitNodeStatus(run.runId, node.id, 'done', ns.jobId)
      } catch (err) {
        ns.status = 'failed'
        ns.error = err instanceof Error ? err.message : String(err)
        this.emitNodeStatus(run.runId, node.id, 'failed', ns.jobId, ns.error)
      }
      return
    }
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
  }

  private async buildDependencyArgs(run: RunState, plan: AxisPlan): Promise<string[]> {
    const args: string[] = []
    const arrayDepIds = [...new Set((plan.dependsOnArrayNodeIds ?? []).flatMap((upId) => run.nodes[upId]?.jobId ? [run.nodes[upId].jobId!] : []))]
    const directDepIds = [...new Set((plan.dependsOnNodeIds ?? []).flatMap((upId) => run.nodes[upId]?.jobId ? [run.nodes[upId].jobId!] : []))]
    const taskLevel =
      run.arrayChainMode === 'task-level' &&
      plan.mode === 'array' &&
      arrayDepIds.length > 0 &&
      await this.supportsAfterCorr(run.connectionId)

    if (taskLevel) {
      args.push(`--dependency=aftercorr:${arrayDepIds.join(':')}`)
    } else if (arrayDepIds.length > 0) {
      directDepIds.push(...arrayDepIds)
    }

    const deduped = [...new Set(directDepIds)]
    if (deduped.length > 0) {
      args.push(`--dependency=afterok:${deduped.join(':')}`)
    }
    return args
  }

  private nodeOutputBackend(
    snapshot: PipelineSnapshot,
    nodeId: string,
  ): 'local' | 'ssh' | 'dnx' | null {
    const node = snapshot.nodes.find((candidate) => candidate.id === nodeId)
    if (!node) return null
    if (node.type === 'tool') return this.nodeRunsOnDnx(node) ? 'dnx' : 'ssh'
    if (node.type === 'transfer') return (node.data as TransferNodeData).to
    if (node.type === 'file') {
      const origin = (node.data as FileNodeData).origin
      if (origin === 'dnx') return 'dnx'
      if (origin === 'local') return 'local'
      if (origin === 'ssh') return 'ssh'
      return null
    }
    return 'ssh'
  }

  private async materializeInputValueForSsh(
    run: RunState,
    node: PipelineSnapshot['nodes'][number],
    portId: string,
    value: AxisPlan['inputs'][string],
    outputDir: string,
  ): Promise<AxisPlan['inputs'][string]> {
    const snapshot = run.snapshot
    if (!snapshot || !value) return value
    const incoming = snapshot.edges.filter((edge) => edge.target === node.id && (edge.targetHandle ?? 'input') === portId)
    if (incoming.length === 0) return value
    const backends = incoming.map((edge) => this.nodeOutputBackend(snapshot, edge.source))
    if (!backends.some((backend) => backend === 'dnx')) return value

    const remoteInputDir = `${outputDir}/inputs/${portId}`
    await this.ssh.exec(run.connectionId, `mkdir -p ${shellQuote(remoteInputDir)}`)
    const projectId = await this.ensureDnxProjectId()

    const rewritePath = async (path: string, index: number) => {
      const name = pathBasename(path) || `${portId}-${index + 1}`
      const remotePath = `${remoteInputDir}/${name}`
      await this.dnx.transferDnxToSsh(run.connectionId, projectId, path, remotePath)
      return remotePath
    }

    return await mapAxedValueAsync(value, rewritePath)
  }

  private async materializeInputValueForDnx(
    run: RunState,
    node: PipelineSnapshot['nodes'][number],
    portId: string,
    value: AxisPlan['inputs'][string],
    outputDir: string,
    projectId: string,
  ): Promise<AxisPlan['inputs'][string]> {
    const snapshot = run.snapshot
    if (!snapshot || !value) return value
    const incoming = snapshot.edges.filter((edge) => edge.target === node.id && (edge.targetHandle ?? 'input') === portId)
    if (incoming.length === 0) return value
    const backends = incoming.map((edge) => this.nodeOutputBackend(snapshot, edge.source))
    if (!backends.some((backend) => backend === 'ssh')) return value

    const dnxInputDir = `${outputDir}/inputs/${portId}`
    const rewritePath = async (path: string, index: number) => {
      const name = pathBasename(path) || `${portId}-${index + 1}`
      const uploaded = await this.dnx.transferSshToDnx(run.connectionId, path, projectId, dnxInputDir, name)
      return uploaded.path
    }

    return await mapAxedValueAsync(value, rewritePath)
  }

  private async runTransferNode(
    run: RunState,
    node: PipelineSnapshot['nodes'][number],
    plan: AxisPlan,
  ): Promise<void> {
    const data = node.data as TransferNodeData
    const ns = run.nodes[node.id]
    const projectId = (data.from === 'dnx' || data.to === 'dnx') ? await this.ensureDnxProjectId(data.dnxProjectId) : null
    const input = plan.inputs.input
    const outputs = collectOutputPaths(plan.outputs)
    ns.outputPaths = outputs
    ns.outputDir = outputs[0] ? pathDirname(outputs[0]) : undefined
    ns.jobId = `transfer-${randomUUID().slice(0, 8)}`
    ns.status = 'running'
    ns.startedAt = Date.now()
    this.updateTransferProgress(run, node.id, {
      status: 'running',
      bytesTransferred: 0,
    })
    this.emitNodeStatus(run.runId, node.id, 'running', ns.jobId)

    try {
      if (input && data.from === 'ssh' && data.to === 'dnx' && projectId) {
        const folder = outputs[0] ? pathDirname(outputs[0]) : '/BioFlow/transfers'
        const paths = await collectValuePaths(input)
        for (const [index, path] of paths.entries()) {
          const name = pathBasename(outputs[index] ?? path) || pathBasename(path)
          await this.dnx.transferSshToDnx(run.connectionId, path, projectId, folder, name)
        }
      } else if (input && data.from === 'dnx' && data.to === 'ssh' && projectId) {
        const paths = await collectValuePaths(input)
        for (const [index, path] of paths.entries()) {
          await this.dnx.transferDnxToSsh(run.connectionId, projectId, path, outputs[index] ?? path)
        }
      } else if (input && data.from === 'local' && data.to === 'ssh') {
        const paths = await collectValuePaths(input)
        for (const [index, path] of paths.entries()) {
          const target = outputs[index] ?? `${ns.outputDir ?? run.outputRoot ?? run.workDir}/${pathBasename(path)}`
          await this.sftp.mkdir(run.connectionId, pathDirname(target)).catch(() => undefined)
          await this.sftp.upload(run.connectionId, expandLocalHome(path), target, (bytesTransferred, totalBytes) => {
            this.updateTransferProgress(run, node.id, { status: 'running', bytesTransferred, totalBytes })
          })
        }
      } else if (input && data.from === 'ssh' && data.to === 'local') {
        const paths = await collectValuePaths(input)
        for (const [index, path] of paths.entries()) {
          const target = expandLocalHome(outputs[index] ?? `${data.localFolder || '~/BioFlow/transfers'}/${pathBasename(path)}`)
          const parent = pathDirname(target)
          if (parent) await fsPromises.mkdir(parent, { recursive: true }).catch(() => undefined)
          await this.sftp.download(run.connectionId, path, target, (bytesTransferred, totalBytes) => {
            this.updateTransferProgress(run, node.id, { status: 'running', bytesTransferred, totalBytes })
          })
          if (outputs[index]) outputs[index] = target
        }
      } else if (input && data.from === 'local' && data.to === 'dnx' && projectId) {
        const folder = outputs[0]?.startsWith('/') ? pathDirname(outputs[0]) : '/BioFlow/transfers'
        const paths = await collectValuePaths(input)
        for (const [index, path] of paths.entries()) {
          const name = pathBasename(outputs[index] ?? path) || pathBasename(path)
          await this.dnx.uploadLocalPath(projectId, expandLocalHome(path), folder, name)
        }
      } else if (input && data.from === 'dnx' && data.to === 'local' && projectId) {
        const paths = await collectValuePaths(input)
        for (const [index, path] of paths.entries()) {
          const target = expandLocalHome(outputs[index] ?? path)
          // mkdir-p the parent directory locally so the bridge download lands.
          const parent = pathDirname(target)
          if (parent) await fsPromises.mkdir(parent, { recursive: true }).catch(() => undefined)
          await this.dnx.downloadDnxToLocal(projectId, path, target)
          if (outputs[index]) outputs[index] = target
        }
      } else if (input && data.from === data.to) {
        // Same-backend transfer is handled by the validator (warning) and is
        // a no-op at runtime — flag it so the user notices.
        throw new Error(`Transfer node has from=${data.from}, to=${data.to}; configure a cross-backend route.`)
      } else if (input) {
        throw new Error(`Transfer ${data.from} -> ${data.to} is not yet implemented.`)
      }
      ns.outputPaths = outputs
      ns.outputDir = outputs[0] ? pathDirname(outputs[0]) : ns.outputDir
      ns.status = 'done'
      ns.finishedAt = Date.now()
      this.updateTransferProgress(run, node.id, { status: 'done' })
      this.emitNodeStatus(run.runId, node.id, 'done', ns.jobId)
    } catch (error) {
      ns.status = 'failed'
      ns.finishedAt = Date.now()
      ns.error = error instanceof Error ? error.message : String(error)
      this.updateTransferProgress(run, node.id, { status: 'failed' })
      this.emitNodeStatus(run.runId, node.id, 'failed', ns.jobId, ns.error)
    }
  }

  private updateTransferProgress(
    run: RunState,
    nodeId: string,
    progress: { status: TransferPlan['status']; bytesTransferred?: number; totalBytes?: number },
  ): void {
    const ns = run.nodes[nodeId]
    if (!ns) return
    const plan = run.transferPlans?.find((candidate) => candidate.nodeId === nodeId)
    if (plan) {
      plan.status = progress.status
      if (progress.bytesTransferred !== undefined) plan.bytesTransferred = progress.bytesTransferred
      if (progress.totalBytes !== undefined) plan.totalBytes = progress.totalBytes
    }
    ns.transferProgress = {
      route: plan?.route,
      status: progress.status,
      bytesTransferred: progress.bytesTransferred ?? plan?.bytesTransferred ?? ns.transferProgress?.bytesTransferred,
      totalBytes: progress.totalBytes ?? plan?.totalBytes ?? ns.transferProgress?.totalBytes,
      warnings: plan?.warnings,
    }
    this.emitNodeStatus(run.runId, nodeId, ns.status ?? 'idle', ns.jobId, ns.error)
  }

  private async runDnxNode(
    run: RunState,
    node: PipelineSnapshot['nodes'][number],
    plan: AxisPlan,
    connectionDefaults: ConnectionDefaults,
    nodeSlugs: Map<string, string>,
  ): Promise<void> {
    const ns = run.nodes[node.id]
    const { projectId } = await this.dnx.authenticate()
    const slug = nodeSlugs.get(node.id) ?? node.id
    const logicalOutputPaths = collectOutputPaths(plan.outputs)
    const logicalOutputDir = logicalOutputPaths[0] ? pathDirname(logicalOutputPaths[0]) : '/BioFlow/runs'
    const localizedInputs: Record<string, AxisPlan['inputs'][string]> = {}
    for (const [portId, value] of Object.entries(plan.inputs)) {
      localizedInputs[portId] = await this.materializeInputValueForDnx(run, node, portId, value, logicalOutputDir, projectId)
    }
    const executionPlan: AxisPlan = {
      ...plan,
      inputs: localizeAxedValues(localizedInputs),
      outputs: localizeOutputPaths(plan.outputs),
    }

    let script = ''
    if (node.type === 'tool') {
      const toolData = node.data as ToolNodeData
      const tool = getTool(toolData.toolId)
      if (!tool) {
        this.failNode(run, ns, `Unknown tool ${toolData.toolId}`)
        return
      }
      if (tool.id === 'ukb.spark-extract' && tool.dnxApplet?.name) {
        const ensure = await this.dnx.ensureApplet(projectId, { appletName: tool.dnxApplet.name })
        ns.status = 'queued'
        ns.outputDir = logicalOutputDir
        ns.outputPaths = logicalOutputPaths
        ns.submittedAt = Date.now()
        const { jobId } = await this.dnx.runSparkExtract({
          projectId,
          appletId: ensure.appletId,
          fields: Array.isArray(toolData.paramValues?.fields) ? toolData.paramValues.fields as unknown[] : [],
          renameMap: Object.fromEntries(
            (Array.isArray(toolData.paramValues?.fields) ? toolData.paramValues.fields as Array<{ fieldId?: unknown; label?: unknown }> : [])
              .filter((row) => typeof row.fieldId === 'string' && typeof row.label === 'string' && row.label.trim())
              .map((row) => [String(row.fieldId), String(row.label).trim()]),
          ),
          codingValues: String(toolData.paramValues?.codingValues ?? 'replace'),
          outputName: String(toolData.paramValues?.outputName ?? pathBasename(logicalOutputPaths[0] ?? 'ukb_extracted_traits.tsv')),
          outputFolder: String(toolData.paramValues?.outputFolder ?? logicalOutputDir),
          instanceType: toolData.dnxInstanceType,
        })
        ns.jobId = jobId
        this.emitNodeStatus(run.runId, node.id, 'queued', jobId)
        const outcome = await this.dnxPoller.waitForJob(jobId, {
          onStart: () => {
            ns.status = 'running'
            ns.startedAt = Date.now()
            this.emitNodeStatus(run.runId, node.id, 'running', jobId)
          },
        })
        ns.finishedAt = Date.now()
        if (outcome.kind === 'done') {
          ns.status = 'done'
          this.emitNodeStatus(run.runId, node.id, 'done', jobId)
          return
        }
        ns.status = outcome.kind === 'cancelled' ? 'cancelled' : 'failed'
        ns.error = outcome.kind === 'failed' ? outcome.reason : undefined
        this.emitNodeStatus(run.runId, node.id, ns.status, jobId, ns.error)
        return
      }
      const gen = generateToolScript({
        nodeId: node.id,
        nodeSlug: slug,
        tool,
        nodeData: { ...toolData, executionMode: 'sbatch' },
        axisPlan: executionPlan,
        outputDir: '.',
        logDir: '.',
        connectionDefaults: {
          ...connectionDefaults,
          modulePreamble: undefined,
        },
      })
      script = gen.script
    } else {
      this.failNode(run, ns, 'DNAnexus execution currently supports tool nodes only.')
      return
    }

    ns.status = 'queued'
    ns.outputDir = logicalOutputDir
    ns.outputPaths = logicalOutputPaths
    ns.submittedAt = Date.now()
    const { jobId } = await this.dnx.runSwissArmyKnife({
      projectId,
      outputFolder: logicalOutputDir,
      script,
      inputPaths: collectOutputPaths(localizedInputs),
      instanceType: (node.data as ToolNodeData).dnxInstanceType,
      name: slug,
    })
    ns.jobId = jobId
    this.emitNodeStatus(run.runId, node.id, 'queued', jobId)

    const outcome = await this.dnxPoller.waitForJob(jobId, {
      onStart: () => {
        ns.status = 'running'
        ns.startedAt = Date.now()
        this.emitNodeStatus(run.runId, node.id, 'running', jobId)
      },
    })
    ns.finishedAt = Date.now()
    if (outcome.kind === 'done') {
      ns.status = 'done'
      this.emitNodeStatus(run.runId, node.id, 'done', jobId)
      return
    }
    ns.status = outcome.kind === 'cancelled' ? 'cancelled' : 'failed'
    ns.error = outcome.kind === 'failed' ? outcome.reason : undefined
    this.emitNodeStatus(run.runId, node.id, ns.status, jobId, ns.error)
  }

  private async ensureDnxProjectId(explicitProjectId?: string): Promise<string> {
    const { projectId } = await this.dnx.authenticate(explicitProjectId)
    return projectId
  }

  private async supportsAfterCorr(connectionId: string): Promise<boolean> {
    if (this.afterCorrSupport.has(connectionId)) return this.afterCorrSupport.get(connectionId) ?? false
    try {
      const result = await this.ssh.exec(connectionId, `bash -lc ${shellQuote('sbatch --help 2>/dev/null | grep -q aftercorr')}`)
      const supported = result.exitCode === 0
      this.afterCorrSupport.set(connectionId, supported)
      return supported
    } catch {
      this.afterCorrSupport.set(connectionId, false)
      return false
    }
  }

  private async runImplicitMerges(
    run: RunState,
    node: PipelineSnapshot['nodes'][number],
    plan: AxisPlan,
    connectionDefaults: ConnectionDefaults,
    nodeSlugs: Map<string, string>,
  ): Promise<void> {
    const merges = Object.entries(plan.implicitMerges ?? {})
    if (merges.length === 0) return
    const slug = nodeSlugs.get(node.id) ?? node.id
    const ns = run.nodes[node.id]
    const logDir = run.logsDir ?? `${run.workDir}/logs`
    let dependencyJobId = ns.jobId
    if (ns.jobId && !ns.childJobs?.some((job) => job.jobId === ns.jobId)) {
      ns.childJobs = [
        ...(ns.childJobs ?? []),
        {
          kind: 'primary',
          jobId: ns.jobId,
          label: 'Primary array job',
          scriptPath: ns.scriptPath,
          stdoutPath: ns.stdoutPath,
          stderrPath: ns.stderrPath,
        },
      ]
    }

    for (const [portId, merge] of merges) {
      const mergeSlug = `${slug}-${portId}-auto-merge`
      const scriptPath = `${run.scriptsDir ?? `${run.workDir}/scripts`}/${mergeSlug}.sbatch`
      const outputDir = pathDirname(merge.outputPath) || (run.outputRoot ?? `${run.workDir}/outputs`)
      const gen = generateMergeScript({
        nodeId: `${node.id}.${portId}.merge`,
        nodeSlug: mergeSlug,
        mergeData: {
          label: `${slug} ${portId} auto merge`,
          strategy: merge.strategy,
          status: 'idle',
        },
        resolvedInputs: merge.input,
        upstreamFileType: merge.upstreamFileType,
        outputPath: merge.outputPath,
        outputDir,
        logDir,
        connectionDefaults,
      })
      await this.sftp.write(run.connectionId, scriptPath, gen.script)
      const cmd = ['sbatch']
      if (dependencyJobId) cmd.push(`--dependency=afterok:${dependencyJobId}`)
      cmd.push(shellQuote(scriptPath))
      const result = await this.ssh.exec(run.connectionId, cmd.join(' '))
      if (result.exitCode !== 0) {
        throw new Error((result.stderr || result.stdout || `Auto-merge submission failed for ${portId}`).trim())
      }
      const match = result.stdout.match(/Submitted batch job (\d+)/)
      if (!match) {
        throw new Error(`Could not parse auto-merge sbatch output for ${portId}: ${result.stdout.trim()}`)
      }
      const mergeJobId = match[1]
      dependencyJobId = mergeJobId
      ns.jobId = mergeJobId
      ns.scriptPath = scriptPath
      ns.stdoutPath = `${logDir}/${mergeSlug}-${mergeJobId}.slurm.log`
      ns.stderrPath = ns.stdoutPath
      ns.childJobs = [
        ...(ns.childJobs ?? []),
        {
          kind: 'auto-merge',
          jobId: mergeJobId,
          label: `${portId} auto-merge`,
          scriptPath,
          stdoutPath: ns.stdoutPath,
          stderrPath: ns.stderrPath,
        },
      ]
      this.emitNodeStatus(run.runId, node.id, 'running', mergeJobId)

      await new Promise<void>((resolve, reject) => {
        this.tracker.watch({
          connectionId: run.connectionId,
          jobId: mergeJobId,
          isArray: false,
          onStart: () => {
            ns.startedAt = Date.now()
          },
          onFinish: (outcome) => {
            if (outcome.kind === 'done') {
              resolve()
              return
            }
            reject(new Error(outcome.kind === 'cancelled' ? 'Auto-merge job cancelled' : outcome.reason || 'Auto-merge failed'))
          },
        })
      })
    }
  }

  private async finalizeRunArtifacts(
    run: RunState,
    snapshot: PipelineSnapshot,
    plans: Map<string, AxisPlan>,
  ): Promise<void> {
    if (run.scriptsDir) {
      try {
        let scripts: DryRunScript[] | undefined
        try {
          scripts = await this.generateScriptsDry({
            connectionId: run.connectionId,
            snapshot,
            workDir: run.workDir,
            workspace: run.workspace,
          })
        } catch (err) {
          console.error('[PipelineRunner] failed to refresh scripts for final run.manifest.json:', err)
        }
        const manifest = buildRunManifest(run, snapshot, run.workspace ?? null, {
          scripts,
          transferPlans: run.transferPlans,
        })
        await this.sftp.write(run.connectionId, `${run.workDir}/run.manifest.json`, JSON.stringify(manifest, null, 2))
      } catch (err) {
        console.error('[PipelineRunner] failed to write final run.manifest.json:', err)
      }
    }
    if (!run.scriptsDir) return

    const manifest = this.collectIntermediatePaths(snapshot, plans)
    const manifestPath = `${run.workDir}/intermediates.json`
    try {
      await this.sftp.write(run.connectionId, manifestPath, JSON.stringify({
        generatedAt: Date.now(),
        policy: run.fileLifecyclePolicy ?? 'keep-all',
        paths: manifest,
      }, null, 2))
    } catch (err) {
      console.error('[PipelineRunner] failed to write intermediate manifest:', err)
    }

    if ((run.fileLifecyclePolicy ?? 'keep-all') === 'keep-all') return
    for (const path of manifest) {
      try {
        await this.sftp.remove(run.connectionId, path)
      } catch {
        // Best effort; some tools emit sidecars or already-cleaned files.
      }
    }
  }

  private collectIntermediatePaths(snapshot: PipelineSnapshot, plans: Map<string, AxisPlan>): string[] {
    const seen = new Set<string>()
    const protectedInputs = new Set<string>()
    for (const node of snapshot.nodes) {
      if (node.type !== 'file') continue
      const data = node.data as FileNodeData
      if (!data.isInput) continue
      for (const path of protectedPathsForFileData(data, { includeSidecars: true })) protectedInputs.add(path)
    }

    for (const node of snapshot.nodes) {
      const plan = plans.get(node.id)
      if (!plan || (node.type !== 'tool' && node.type !== 'transform' && node.type !== 'merge')) continue
      for (const path of this.collectIntermediatePathsForNode(node, plan)) seen.add(path)
    }

    return [...seen].filter((path) => !protectedInputs.has(path))
  }

  private collectIntermediatePathsForNode(
    node: PipelineSnapshot['nodes'][number],
    plan: AxisPlan,
  ): string[] {
    const seen = new Set<string>()
    const addValuePaths = (value: AxisPlan['outputs'][string] | undefined) => {
      if (!value) return
      if (value.kind === 'single') seen.add(value.path)
      else for (const path of value.paths) seen.add(path)
    }

    if (node.type === 'tool') {
      const data = node.data as ToolNodeData
      const tool = getTool(data.toolId)
      if (!tool) return []
      for (const port of tool.outputs) {
        const flagged = data.outputIntermediate?.[port.id] ?? false
        if (!flagged) continue
        const implicit = plan.implicitMerges?.[port.id]
        if (implicit) {
          for (const path of implicit.input.paths) seen.add(path)
        } else {
          addValuePaths(plan.outputs[port.id])
        }
      }
      return [...seen]
    }

    if (node.type === 'transform') {
      const data = node.data as TransformNodeData
      if (!data.outputIntermediate?.output) return []
      const implicit = plan.implicitMerges?.output
      if (implicit) {
        for (const path of implicit.input.paths) seen.add(path)
      } else {
        addValuePaths(plan.outputs.output)
      }
      return [...seen]
    }

    if (node.type === 'merge') {
      const data = node.data as MergeNodeData
      if (data.outputIntermediate?.output) addValuePaths(plan.outputs.output)
    }
    return [...seen]
  }

  private async runLoginNode(
    run: RunState,
    nodeId: string,
    ns: NodeRunState,
    scriptPath: string,
    plan: AxisPlan,
  ): Promise<void> {
    if (plan.mode === 'array') {
      this.failNode(run, ns, 'Login-node array execution is not supported. Switch this node to Slurm job.')
      return
    }

    const jobId = `login-${randomUUID().slice(0, 8)}`
    const key = `${run.runId}:${nodeId}`
    ns.jobId = jobId
    ns.status = 'queued'
    this.emitNodeStatus(run.runId, nodeId, 'queued', jobId)

    await new Promise<void>((resolve) => {
      const command = `bash -lc ${shellQuote(`source ${shellQuote(scriptPath)}`)}`
      const { cancel } = this.ssh.execStream(
        run.connectionId,
        command,
        (chunk, stream) => this.emitJobLog(run.runId, nodeId, chunk, stream),
        (exitCode) => {
          this.loginCancels.delete(key)
          ns.finishedAt = Date.now()
          if (this.cancelledLoginNodes.has(key)) {
            this.cancelledLoginNodes.delete(key)
            ns.status = 'cancelled'
            this.emitNodeStatus(run.runId, nodeId, 'cancelled', jobId)
          } else if (exitCode === 0) {
            ns.status = 'done'
            ns.exitCode = 0
            this.emitNodeStatus(run.runId, nodeId, 'done', jobId)
          } else {
            const code = exitCode ?? -1
            ns.status = 'failed'
            ns.exitCode = code
            ns.error = `Login-node command failed (${code})`
            this.emitNodeStatus(run.runId, nodeId, 'failed', jobId, ns.error)
          }
          resolve()
        },
      )
      this.loginCancels.set(key, cancel)
      ns.status = 'running'
      ns.startedAt = Date.now()
      this.emitNodeStatus(run.runId, nodeId, 'running', jobId)
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
    this.persistRuns()
  }

  private emitRunStatus(runId: string, status: RunStatus): void {
    const win = BrowserWindow.getAllWindows()[0]
    const run = this.runs.get(runId)
    if (run) {
      run.updatedAt = Date.now()
      run.status = status
    }
    if (win) win.webContents.send('pipeline:run-status', { runId, status })
    this.persistRuns()
  }

  private loadPersistedRuns(): void {
    try {
      const store = getSettingsStore() as unknown as { get: (k: string) => unknown }
      const raw = store.get('pipeline:runs:v1')
      if (!Array.isArray(raw)) return
      for (const run of raw as RunState[]) {
        if (run?.runId) this.runs.set(run.runId, run)
      }
    } catch (err) {
      console.error('[PipelineRunner] loadPersistedRuns failed:', err)
    }
  }

  private persistRuns(): void {
    try {
      const store = getSettingsStore() as unknown as { set: (k: string, v: unknown) => void }
      const runs = [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50)
      store.set('pipeline:runs:v1', runs)
    } catch (err) {
      console.error('[PipelineRunner] persistRuns failed:', err)
    }
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
      const rawDefaultPartition = store.get('settings:defaultPartition')
      const str = (key: string): string | undefined => {
        const value = store.get(key)
        return typeof value === 'string' && value.trim() ? value.trim() : undefined
      }
      const account = typeof rawAccount === 'string' && rawAccount.trim() ? rawAccount.trim() : undefined
      const partition =
        typeof rawDefaultPartition === 'string' && rawDefaultPartition.trim() ? rawDefaultPartition.trim()
        : typeof rawPartition === 'string' && rawPartition.trim() ? rawPartition.trim()
        : undefined
      return {
        account,
        partition,
        modulePreamble: MODULE_PREAMBLE,
        toolsRoot: str('settings:toolsRoot'),
        annovarScriptsPath: str('settings:annovarScriptsPath'),
        annovarDbPath: str('settings:annovarDbPath'),
        vepPath: str('settings:vepPath'),
        vepCachePath: str('settings:vepCachePath'),
        shellCapabilities: await this.loadShellCapabilities(connectionId),
      }
    } catch (err) {
      console.error('[PipelineRunner] loadConnectionDefaults failed:', err)
      return { modulePreamble: MODULE_PREAMBLE }
    }
  }

  private async loadShellCapabilities(connectionId: string): Promise<{ awk: boolean }> {
    const cached = this.shellCapabilities.get(connectionId)
    if (cached) return cached

    try {
      const { stdout, exitCode } = await this.ssh.exec(
        connectionId,
        'command -v awk >/dev/null 2>&1 && printf yes || printf no',
      )
      const capabilities = { awk: exitCode === 0 && stdout.trim() === 'yes' }
      this.shellCapabilities.set(connectionId, capabilities)
      return capabilities
    } catch (err) {
      console.warn('[PipelineRunner] shell capability probe failed:', err)
      const capabilities = { awk: false }
      this.shellCapabilities.set(connectionId, capabilities)
      return capabilities
    }
  }

  private loadRunPathSettings(): RunPathSettings {
    try {
      const store = getSettingsStore() as unknown as { get: (k: string) => unknown }
      const str = (key: string, fallback: string) => {
        const value = store.get(key)
        return typeof value === 'string' && value.trim() ? value.trim() : fallback
      }
      const bool = (key: string, fallback: boolean) => {
        const value = store.get(key)
        return typeof value === 'boolean' ? value : fallback
      }
      return {
        scriptsSubfolder: str('settings:paths:scriptsSubfolder', 'scripts'),
        outputsSubfolder: str('settings:paths:outputsSubfolder', 'outputs'),
        logsSubfolder: str('settings:paths:logsSubfolder', 'logs'),
        createSubfolders: bool('settings:paths:createSubfolders', true),
        runFolderTemplate: str('settings:paths:runFolderTemplate', 'runs/{pipelineSlug}-{timestamp}'),
      }
    } catch (err) {
      console.error('[PipelineRunner] loadRunPathSettings failed:', err)
      return {
        scriptsSubfolder: 'scripts',
        outputsSubfolder: 'outputs',
        logsSubfolder: 'logs',
        createSubfolders: true,
        runFolderTemplate: 'runs/{pipelineSlug}-{timestamp}',
      }
    }
  }

  private loadExecutionDefaults(): ExecutionDefaults {
    try {
      const store = getSettingsStore() as unknown as { get: (k: string) => unknown }
      const arrayChainMode = store.get('settings:execution:arrayChainMode')
      const fileLifecyclePolicy = store.get('settings:fileLifecyclePolicy')
      return {
        arrayChainMode: arrayChainMode === 'job-level' ? 'job-level' : 'task-level',
        fileLifecyclePolicy:
          fileLifecyclePolicy === 'keep-outputs-only' || fileLifecyclePolicy === 'delete-intermediates-on-success'
            ? fileLifecyclePolicy
            : 'keep-all',
      }
    } catch (err) {
      console.error('[PipelineRunner] loadExecutionDefaults failed:', err)
      return {
        arrayChainMode: 'task-level',
        fileLifecyclePolicy: 'keep-all',
      }
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

function buildRunDirs(
  explicitWorkDir: string | undefined,
  workRoot: string,
  snapshot: PipelineSnapshot,
  settings: RunPathSettings,
  home: string,
): RunDirs {
  const workDir = (explicitWorkDir ?? resolveRunFolder(workRoot, snapshot, settings.runFolderTemplate, home)).replace(/\/+$/, '')
  if (!settings.createSubfolders) {
    return { workDir, scriptsDir: workDir, logsDir: workDir, outputRoot: workDir }
  }
  return {
    workDir,
    scriptsDir: `${workDir}/${cleanPathSegment(settings.scriptsSubfolder || 'scripts')}`,
    logsDir: `${workDir}/${cleanPathSegment(settings.logsSubfolder || 'logs')}`,
    outputRoot: `${workDir}/${cleanPathSegment(settings.outputsSubfolder || 'outputs')}`,
  }
}

function buildGroupByNode(snapshot: PipelineSnapshot): Map<string, NodeGroup> {
  const out = new Map<string, NodeGroup>()
  for (const group of snapshot.groups ?? []) {
    for (const nodeId of group.nodeIds) out.set(nodeId, group)
  }
  return out
}

function orderGroupNodes(group: NodeGroup, snapshot: PipelineSnapshot): string[] {
  const ids = new Set(group.nodeIds)
  const incoming = new Map<string, number>()
  for (const id of ids) incoming.set(id, 0)
  for (const edge of snapshot.edges) {
    if (ids.has(edge.source) && ids.has(edge.target)) {
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
    }
  }
  const start = [...incoming.entries()].find(([, count]) => count === 0)?.[0] ?? group.nodeIds[0]
  const ordered: string[] = []
  let current: string | undefined = start
  while (current && ids.has(current) && !ordered.includes(current)) {
    ordered.push(current)
    current = snapshot.edges.find((edge) => edge.source === current && ids.has(edge.target))?.target
  }
  return ordered.length === group.nodeIds.length ? ordered : group.nodeIds
}

function mergeScriptsForGroup(
  group: NodeGroup,
  groupSlug: string,
  logDir: string,
  scripts: Array<{ nodeId: string; script: string }>,
): string {
  if (scripts.length === 0) return ''
  const firstHeader = scripts[0].script.split('\n').filter((line) => line.startsWith('#!') || line.startsWith('#SBATCH'))
  const isArray = firstHeader.some((line) => line.startsWith('#SBATCH --array='))
  const maxResources = maxScriptResources(scripts.map((entry) => entry.script))
  const header = firstHeader.map((line) => {
    if (line.startsWith('#SBATCH --job-name=')) return `#SBATCH --job-name=bioflow-${groupSlug}`
    if (line.startsWith('#SBATCH --output=')) return isArray ? `#SBATCH --output=${logDir}/${groupSlug}-%A_%a.slurm.log` : `#SBATCH --output=${logDir}/${groupSlug}-%j.slurm.log`
    if (line.startsWith('#SBATCH --error=')) return isArray ? `#SBATCH --error=${logDir}/${groupSlug}-%A_%a.slurm.log` : `#SBATCH --error=${logDir}/${groupSlug}-%j.slurm.log`
    if (line.startsWith('#SBATCH --cpus-per-task=')) return `#SBATCH --cpus-per-task=${group.sharedResources?.cpus ?? maxResources.cpus}`
    if (line.startsWith('#SBATCH --mem=')) return `#SBATCH --mem=${group.sharedResources?.memoryGB ?? maxResources.memoryGB}G`
    if (line.startsWith('#SBATCH --time=')) return `#SBATCH --time=${formatTime(group.sharedResources?.timeHours ?? maxResources.timeHours)}`
    if (group.sharedResources?.partition && line.startsWith('#SBATCH --partition=')) return `#SBATCH --partition=${group.sharedResources.partition}`
    return line
  })
  const seenModules = new Set<string>()
  const bodies = scripts.flatMap(({ nodeId, script }) => {
    const markerId = shellQuote(nodeId)
    return [
      `echo "::bioflow-step:${nodeId}:start"`,
      stripScriptHeader(script, seenModules),
      `echo "::bioflow-step:${nodeId}:end"`,
      '',
      `# Finished grouped node ${markerId}`,
    ]
  })
  return [...header, '', 'set -euo pipefail', '', ...bodies].join('\n')
}

function makeGroupLogDemuxer(
  emit: (nodeId: string, chunk: string) => void,
  fallbackNodeId: string,
): (chunk: string) => void {
  let activeNodeId: string | null = null
  let buffer = ''
  return (chunk: string) => {
    buffer += chunk
    const lines = buffer.split(/\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const start = line.match(/^::bioflow-step:(.+):start\r?$/)
      if (start) {
        activeNodeId = start[1]
        continue
      }
      const end = line.match(/^::bioflow-step:(.+):end\r?$/)
      if (end) {
        activeNodeId = null
        continue
      }
      emit(activeNodeId ?? fallbackNodeId, `${line}\n`)
    }
  }
}

function maxScriptResources(scripts: string[]): { cpus: number; memoryGB: number; timeHours: number } {
  let cpus = 1
  let memoryGB = 4
  let timeHours = 1
  for (const script of scripts) {
    for (const line of script.split('\n')) {
      const cpu = line.match(/^#SBATCH --cpus-per-task=(\d+)/)
      if (cpu) cpus = Math.max(cpus, Number(cpu[1]))
      const mem = line.match(/^#SBATCH --mem=(\d+)G/)
      if (mem) memoryGB = Math.max(memoryGB, Number(mem[1]))
      const time = line.match(/^#SBATCH --time=(\d+):(\d+):/)
      if (time) timeHours = Math.max(timeHours, Number(time[1]) + Number(time[2]) / 60)
    }
  }
  return { cpus, memoryGB, timeHours }
}

function stripScriptHeader(script: string, seenModules: Set<string>): string {
  const lines = script.split('\n')
  const firstBody = lines.findIndex((line) => line.trim() === 'set -euo pipefail')
  const body = lines.slice(firstBody >= 0 ? firstBody + 1 : 0)
  return body
    .filter((line) => {
      if (line.trim() === 'set -euo pipefail') return false
      if (line.startsWith('module ')) {
        if (seenModules.has(line)) return false
        seenModules.add(line)
      }
      return true
    })
    .join('\n')
}

function groupDependencyJobIds(group: NodeGroup, run: RunState, plans: Map<string, AxisPlan>): string[] {
  const groupNodes = new Set(group.nodeIds)
  const ids = new Set<string>()
  for (const nodeId of group.nodeIds) {
    const plan = plans.get(nodeId)
    for (const upstream of plan?.dependsOnArrayNodeIds ?? []) {
      if (groupNodes.has(upstream)) continue
      const jobId = run.nodes[upstream]?.jobId
      if (jobId) ids.add(jobId)
    }
  }
  return [...ids]
}

function formatTime(hours: number): string {
  const h = Math.max(0, Math.floor(hours))
  const m = Math.max(0, Math.round((hours - h) * 60))
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`
}

function resolveRunFolder(
  workRoot: string,
  snapshot: PipelineSnapshot,
  template: string,
  home: string,
): string {
  const rendered = renderRunTemplate(template || 'runs/{pipelineSlug}-{timestamp}', snapshot, home)
  if (rendered.startsWith('/') || rendered === '~' || rendered.startsWith('~/')) {
    return expandHome(rendered, home)
  }
  return `${workRoot.replace(/\/+$/, '')}/${rendered.replace(/^\/+/, '')}`
}

function buildDnxOutputRoot(
  snapshot: PipelineSnapshot,
  settings: RunPathSettings,
): string {
  const rendered = renderRunTemplate(settings.runFolderTemplate || 'runs/{pipelineSlug}-{timestamp}', snapshot, '/user')
  const runFolder = rendered.replace(/^\/+/, '')
  if (!settings.createSubfolders) return `/BioFlow/${runFolder}`
  return `/BioFlow/${runFolder}/${cleanPathSegment(settings.outputsSubfolder || 'outputs')}`
}

function renderRunTemplate(template: string, snapshot: PipelineSnapshot, home: string): string {
  const pipelineName = snapshot.name || 'pipeline'
  const timestamp = timestampStamp()
  const date = timestamp.slice(0, 8)
  const user = pathBasename(home) || 'user'
  return template
    .replaceAll('{pipelineSlug}', slugify(pipelineName))
    .replaceAll('{pipelineName}', slugify(pipelineName))
    .replaceAll('{timestamp}', timestamp)
    .replaceAll('{date}', date)
    .replaceAll('{user}', slugify(user))
}

function cleanPathSegment(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, '') || 'outputs'
}

function collectOutputPaths(outputs: Record<string, { kind: string; path?: string; paths?: string[] }>): string[] {
  const paths: string[] = []
  for (const output of Object.values(outputs)) {
    if (output.kind === 'single' && output.path) paths.push(output.path)
    else if ((output.kind === 'array' || output.kind === 'multi') && output.paths) paths.push(...output.paths)
  }
  return paths
}

async function mapAxedValueAsync(
  value: AxisPlan['inputs'][string],
  mapPath: (path: string, index: number) => Promise<string>,
): Promise<AxisPlan['inputs'][string]> {
  if (value.kind === 'single') {
    return { kind: 'single', path: await mapPath(value.path, 0) }
  }
  if (value.kind === 'multi') {
    const paths = await Promise.all(value.paths.map((path, index) => mapPath(path, index)))
    return { kind: 'multi', paths }
  }
  const paths = await Promise.all(value.paths.map((path, index) => mapPath(path, index)))
  return {
    kind: 'array',
    axis: value.axis,
    keys: value.keys,
    paths,
    pathTemplate: value.pathTemplate,
  }
}

function localizeAxedValues(
  inputs: Record<string, AxisPlan['inputs'][string]>,
): Record<string, AxisPlan['inputs'][string]> {
  return Object.fromEntries(Object.entries(inputs).map(([portId, value]) => [portId, localizeAxedValue(value)]))
}

function localizeAxedValue(value: AxisPlan['inputs'][string]): AxisPlan['inputs'][string] {
  if (value.kind === 'single') {
    return { kind: 'single', path: pathBasename(value.path) || value.path }
  }
  if (value.kind === 'multi') {
    return { kind: 'multi', paths: value.paths.map((path) => pathBasename(path) || path) }
  }
  return {
    kind: 'array',
    axis: value.axis,
    keys: value.keys,
    paths: value.paths.map((path) => pathBasename(path) || path),
    pathTemplate: value.pathTemplate,
  }
}

function localizeOutputPaths(outputs: AxisPlan['outputs']): AxisPlan['outputs'] {
  return Object.fromEntries(Object.entries(outputs).map(([portId, value]) => [portId, localizeAxedValue(value)]))
}

async function collectValuePaths(value: AxisPlan['inputs'][string]): Promise<string[]> {
  if (value.kind === 'single') return [value.path]
  return value.paths
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

function stripKnownExt(path: string): string {
  return path.replace(/\.(pgen|pvar|psam|bed|bim|fam)$/i, '')
}

function expandLocalHome(path: string): string {
  if (path === '~') return localHomedir()
  if (path.startsWith('~/')) return `${localHomedir()}/${path.slice(2)}`
  return path
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
    else if (n.type === 'transform') label = (n.data as TransformNodeData).label || 'transform'
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

function downstreamOf(snapshot: PipelineSnapshot, nodeId: string): Set<string> {
  const out = new Set<string>()
  const queue = [nodeId]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (out.has(current)) continue
    out.add(current)
    for (const edge of snapshot.edges) {
      if (edge.source === current) queue.push(edge.target)
    }
  }
  return out
}
