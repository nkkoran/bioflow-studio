import { getAnalysisOptionDefs, normalizeAnalysisOptions, optionValue } from './analysisOptions'
import { getTool } from './toolRegistry'
import type { DryRunScript, PipelineSnapshot, RunState, ToolNodeData } from '../types/pipeline'
import type { WorkflowReadinessReport } from '../types/readiness'
import type { BioflowWorkspace, RunManifest } from '../types/workspace'

type SnapshotNode = PipelineSnapshot['nodes'][number]
type ValidationSummary = NonNullable<RunManifest['validation']>

interface BuildRunManifestOptions {
  scripts?: DryRunScript[]
  validation?: ValidationSummary | null | {
    errorCount: number
    warningCount: number
    infoCount: number
    issues: Array<{
      code: string
      severity: 'error' | 'warning' | 'info'
      message: string
      suggestion?: string
      nodeId?: string
    }>
  }
  readiness?: WorkflowReadinessReport | null
}

export function buildRunManifest(
  run: RunState,
  snapshot?: PipelineSnapshot,
  workspace?: BioflowWorkspace | RunState['workspace'] | null,
  options: BuildRunManifestOptions = {},
): RunManifest {
  const effectiveSnapshot = snapshot ?? run.snapshot
  const nodesById = new Map(effectiveSnapshot?.nodes.map((node) => [node.id, node]) ?? [])
  const scriptsByNodeId = new Map(options.scripts?.map((script) => [script.nodeId, script]) ?? [])
  const steps = (effectiveSnapshot?.nodes ?? [])
    .filter((node) => node.type === 'tool' || node.type === 'merge' || node.type === 'transform' || node.type === 'transfer')
    .map((node) => buildStep(node, run, effectiveSnapshot, scriptsByNodeId.get(node.id)))

  const runnableCount = steps.length
  const completedCount = steps.filter((step) => step.status === 'done').length
  const failedCount = steps.filter((step) => step.status === 'failed').length
  const summary = [
    `${run.pipelineName || effectiveSnapshot?.name || 'Pipeline'} has ${runnableCount} runnable step${runnableCount === 1 ? '' : 's'}.`,
    runnableCount > 0 ? `${completedCount} finished, ${failedCount} failed, and ${runnableCount - completedCount - failedCount} remain queued or in progress.` : 'No runnable steps are present yet.',
    run.workDir ? `Run folder: ${run.workDir}.` : '',
  ].filter(Boolean).join(' ')

  return {
    generatedAt: Date.now(),
    workspace: run.workspace ?? workspace ?? null,
    run,
    snapshot: effectiveSnapshot,
    summary,
    steps,
    commands: steps.map((step) => ({
      nodeId: step.nodeId,
      label: step.label,
      commands: step.commands,
    })),
    scripts: (options.scripts ?? steps.map((step) => ({
      nodeId: step.nodeId,
      label: step.label,
      mode: step.mode,
      script: step.script ?? '',
      outputPaths: step.outputs,
      arraySize: step.arraySize,
    }))).filter((script) => script.script),
    validation: options.validation ? {
      errorCount: options.validation.errorCount,
      warningCount: options.validation.warningCount,
      infoCount: options.validation.infoCount,
      issues: options.validation.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
        suggestion: issue.suggestion,
        nodeId: issue.nodeId,
      })),
    } : null,
    readiness: options.readiness ? {
      blockingCount: options.readiness.blockingCount,
      issueCount: options.readiness.issueCount,
      ok: options.readiness.ok,
      issues: options.readiness.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        category: issue.category,
        message: issue.message,
        suggestion: issue.suggestion,
        nodeId: issue.nodeId,
        path: issue.path,
      })),
    } : null,
    environment: {
      connectionId: run.connectionId,
      workDir: run.workDir,
      scriptsDir: run.scriptsDir,
      logsDir: run.logsDir,
      outputRoot: run.outputRoot,
      arrayChainMode: run.arrayChainMode,
      fileLifecyclePolicy: run.fileLifecyclePolicy,
      homeDir: run.homeDir,
    },
    outputs: Object.entries(run.nodes)
      .filter(([, node]) => (node.outputPaths?.length ?? 0) > 0)
      .map(([nodeId, node]) => ({
        nodeId,
        label: String(nodesById.get(nodeId)?.data?.label ?? nodeId),
        status: node.status ?? 'idle',
        paths: node.outputPaths ?? [],
      })),
  }
}

function buildStep(
  node: SnapshotNode,
  run: RunState,
  snapshot: PipelineSnapshot | undefined,
  script: DryRunScript | undefined,
): RunManifest['steps'][number] {
  const nodeRun = run.nodes[node.id]
  const label = String(node.data.label ?? node.id)
  const base = {
    nodeId: node.id,
    label,
    nodeType: node.type as 'tool' | 'merge' | 'transform' | 'transfer',
    mode: describeMode(script?.mode, script?.arraySize),
    outputs: script?.outputPaths ?? nodeRun?.outputPaths ?? [],
    commands: script?.commands ?? extractCommands(script?.script ?? ''),
    script: script?.script,
    arraySize: script?.arraySize,
    status: nodeRun?.status ?? ('status' in node.data ? String(node.data.status ?? 'idle') : 'idle'),
  }

  if (node.type === 'tool') {
    const data = node.data as ToolNodeData
    const tool = getTool(data.toolId)
    const selectedOptions = tool ? describeSelectedOptions(tool, data) : []
    const inputs = describeInputs(snapshot, node.id)
    const purpose = tool?.description || 'Runs a tool step.'
    return {
      ...base,
      toolId: data.toolId,
      toolName: tool?.name,
      plainLanguage: `${label} runs ${tool?.name ?? data.toolId}. ${purpose} ${base.mode ? `Execution: ${base.mode}.` : ''}`.trim(),
      inputs,
      selectedOptions,
    }
  }

  if (node.type === 'merge') {
    return {
      ...base,
      plainLanguage: `${label} merges multiple upstream outputs into one file.${base.mode ? ` Execution: ${base.mode}.` : ''}`,
      inputs: describeInputs(snapshot, node.id),
      selectedOptions: [],
    }
  }

  if (node.type === 'transfer') {
    const data = node.data as { from?: string; to?: string }
    return {
      ...base,
      plainLanguage: `${label} transfers data from ${data.from === 'dnx' ? 'DNAnexus' : 'Rorqual'} to ${data.to === 'dnx' ? 'DNAnexus' : 'Rorqual'}.${base.mode ? ` Execution: ${base.mode}.` : ''}`,
      inputs: describeInputs(snapshot, node.id),
      selectedOptions: [],
    }
  }

  return {
    ...base,
    plainLanguage: `${label} transforms tabular data into a new artifact.${base.mode ? ` Execution: ${base.mode}.` : ''}`,
    inputs: describeInputs(snapshot, node.id),
    selectedOptions: [],
  }
}

function describeInputs(snapshot: PipelineSnapshot | undefined, nodeId: string): string[] {
  if (!snapshot) return []
  return snapshot.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => {
      const source = snapshot.nodes.find((node) => node.id === edge.source)
      const sourceLabel = String(source?.data?.label ?? edge.source)
      const portLabel = edge.targetHandle ? ` -> ${edge.targetHandle}` : ''
      return `${sourceLabel}${portLabel}`
    })
}

function describeSelectedOptions(tool: NonNullable<ReturnType<typeof getTool>>, nodeData: ToolNodeData): string[] {
  const defsById = new Map(getAnalysisOptionDefs(tool).map((def) => [def.id, def]))
  return normalizeAnalysisOptions(tool, nodeData)
    .filter((option) => option.enabled)
    .map((option) => {
      const def = defsById.get(option.optionId)
      if (!def) {
        const flag = option.customFlag?.trim()
        const value = stringifyOptionValue(optionValue(option))
        return flag ? `${flag}${value ? ` ${value}` : ''}` : ''
      }
      if (def.kind === 'switch') return def.flag ?? def.label
      const value = stringifyOptionValue(optionValue(option))
      return value ? `${def.label}: ${value}` : def.label
    })
    .filter(Boolean)
}

function stringifyOptionValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ')
  if (value === undefined || value === null || value === '' || value === false) return ''
  return String(value)
}

function describeMode(mode: DryRunScript['mode'] | undefined, arraySize: number | undefined): string | undefined {
  if (!mode) return undefined
  if (mode === 'array') return `SLURM array job${arraySize ? ` with ${arraySize} task${arraySize === 1 ? '' : 's'}` : ''}`
  if (mode === 'fanIn' || mode === 'branchFanIn') return 'single fan-in job after upstream work finishes'
  if (mode === 'skip') return 'skipped'
  return 'single job'
}

export function extractCommands(script: string): string[] {
  if (!script.trim()) return []
  const commands: string[] = []
  let current = ''
  for (const rawLine of script.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#')) continue
    if (/^(set|cd|mkdir|module|declare|KEYS=|INPUT_|KEY=|i_|OUTPUT|INPUTS=|INPUT=|\{|\})\b/.test(line)) continue
    if (!current) {
      current = line.replace(/\\$/, '').trim()
    } else {
      current = `${current} ${line.replace(/\\$/, '').trim()}`
    }
    if (!line.endsWith('\\')) {
      commands.push(current.trim())
      current = ''
    }
  }
  if (current) commands.push(current.trim())
  return commands
}
