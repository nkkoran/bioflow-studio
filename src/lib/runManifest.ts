import { getAnalysisOptionDefs, normalizeAnalysisOptions, optionValue } from './analysisOptions'
import { getTool } from './toolRegistry'
import type { ArtifactRef, DryRunScript, PipelineSnapshot, RunState, ToolNodeData, TransferPlan } from '../types/pipeline'
import type { WorkflowReadinessReport } from '../types/readiness'
import type { BioflowWorkspace, ClusterDoctorReport, RunManifest, RunReadinessReport } from '../types/workspace'
import { buildRunReadinessReport } from './runReadiness'

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
  runReadiness?: RunReadinessReport | null
  clusterDoctor?: ClusterDoctorReport | null
  transferPlans?: TransferPlan[]
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
  const transferPlans = options.transferPlans ?? run.transferPlans ?? []
  const runReadiness = options.runReadiness ?? run.runReadiness ?? buildRunReadinessReport({
    validation: options.validation,
    readiness: options.readiness,
    clusterDoctor: options.clusterDoctor,
    transferPlans,
  })
  const resultCards = buildResultCards(run, effectiveSnapshot)

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
    runReadiness,
    clusterDoctor: options.clusterDoctor ?? null,
    transferPlans,
    observedResources: Object.entries(run.nodes).map(([nodeId, node]) => ({
      nodeId,
      runtimeSeconds: node.startedAt && node.finishedAt ? Math.max(0, Math.round((node.finishedAt - node.startedAt) / 1000)) : undefined,
      exitCode: node.exitCode,
    })),
    failureDiagnostics: Object.entries(run.nodes)
      .filter(([, node]) => node.status === 'failed' && node.error)
      .map(([nodeId, node]) => ({
        nodeId,
        cause: node.error ?? 'Step failed',
        suggestion: 'Open the Jobs panel, inspect stderr, then rerun this step after adjusting settings.',
      })),
    resultCards,
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

export function renderRunManifestMarkdown(report: RunManifest): string {
  const lines: string[] = [
    `# ${report.run.pipelineName || report.snapshot?.name || 'BioFlow Run'} Dossier`,
    '',
    report.summary,
    '',
    '## Run',
    '',
    `- Run ID: ${report.run.runId}`,
    `- Status: ${report.run.status}`,
    `- Work directory: ${report.environment.workDir}`,
    `- Generated: ${new Date(report.generatedAt).toISOString()}`,
    '',
    '## Readiness',
    '',
    ...(report.runReadiness?.issues.length
      ? report.runReadiness.issues.map((issue) => `- [${issue.severity}] ${issue.category}: ${issue.message}${issue.suggestion ? ` (${issue.suggestion})` : ''}`)
      : ['- No readiness issues captured.']),
    '',
    '## Transfer Plan',
    '',
    ...(report.transferPlans?.length
      ? report.transferPlans.map((plan) => `- ${plan.mode} ${plan.route}: ${plan.source.origin}:${plan.source.path} -> ${plan.target.origin}:${plan.target.path} (${plan.status})`)
      : ['- No cross-backend transfers planned.']),
    '',
    '## Steps',
    '',
    ...report.steps.flatMap((step) => [
      `### ${step.label}`,
      '',
      `- Type: ${step.nodeType}`,
      `- Status: ${step.status ?? 'idle'}`,
      `- Mode: ${step.mode ?? 'single'}`,
      '',
      step.plainLanguage,
      '',
      'Inputs:',
      ...(step.inputs.length ? step.inputs.map((input) => `- ${input}`) : ['- None']),
      '',
      'Outputs:',
      ...(step.outputs.length ? step.outputs.map((output) => `- ${output}`) : ['- None']),
      '',
    ]),
    '## Results',
    '',
    ...(report.resultCards?.length
      ? report.resultCards.flatMap((card) => [
          `### ${card.label}`,
          '',
          `- Kind: ${card.kind}`,
          `- Class: ${card.primary ? 'primary' : 'intermediate'}`,
          ...card.artifacts.map((artifact) => `- ${artifact.origin}:${artifact.path}`),
          '',
        ])
      : ['- No result cards generated.']),
  ]
  return lines.join('\n')
}

export function renderRunManifestHtml(report: RunManifest): string {
  const markdown = renderRunManifestMarkdown(report)
  const body = markdown
    .split('\n')
    .map((line) => {
      if (line.startsWith('# ')) return `<h1>${escapeHtml(line.slice(2))}</h1>`
      if (line.startsWith('## ')) return `<h2>${escapeHtml(line.slice(3))}</h2>`
      if (line.startsWith('### ')) return `<h3>${escapeHtml(line.slice(4))}</h3>`
      if (line.startsWith('- ')) return `<li>${escapeHtml(line.slice(2))}</li>`
      if (!line.trim()) return ''
      return `<p>${escapeHtml(line)}</p>`
    })
    .join('\n')
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    `<title>${escapeHtml(report.run.pipelineName || report.snapshot?.name || 'BioFlow Run')} Dossier</title>`,
    '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:960px;margin:40px auto;padding:0 24px;line-height:1.45;color:#172033}h1,h2,h3{color:#111827}li{margin:4px 0}code,pre{background:#f3f4f6;padding:2px 4px;border-radius:4px}</style>',
    '</head><body>',
    body,
    '</body></html>',
  ].join('\n')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildResultCards(
  run: RunState,
  snapshot: PipelineSnapshot | undefined,
): NonNullable<RunManifest['resultCards']> {
  const nodes = snapshot?.nodes ?? []
  const edges = snapshot?.edges ?? []
  return Object.entries(run.nodes)
    .filter(([, node]) => (node.outputPaths?.length ?? 0) > 0)
    .map(([nodeId, node]) => {
      const snapshotNode = nodes.find((candidate) => candidate.id === nodeId)
      const label = String(snapshotNode?.data?.label ?? nodeId)
      const terminal = !edges.some((edge) => {
        if (edge.source !== nodeId) return false
        const target = nodes.find((candidate) => candidate.id === edge.target)
        return target?.type === 'tool' || target?.type === 'merge' || target?.type === 'transform' || target?.type === 'transfer'
      })
      const artifacts: ArtifactRef[] = (node.outputPaths ?? []).map((path) => ({
        origin: outputOrigin(snapshotNode),
        path,
        fileType: fileTypeFromPath(path),
      }))
      const explicitlyIntermediate = isExplicitIntermediate(snapshotNode)
      return {
        nodeId,
        label,
        kind: resultKind(label, artifacts.map((artifact) => artifact.path)),
        primary: terminal && !explicitlyIntermediate,
        artifacts,
      }
    })
}

function isExplicitIntermediate(node: PipelineSnapshot['nodes'][number] | undefined): boolean {
  const values = (node?.data as { outputIntermediate?: Record<string, boolean> } | undefined)?.outputIntermediate
  return values ? Object.values(values).some(Boolean) : false
}

function outputOrigin(node: PipelineSnapshot['nodes'][number] | undefined): ArtifactRef['origin'] {
  if (!node) return 'ssh'
  if (node.type === 'tool') return (node.data as ToolNodeData).backend === 'dnx' ? 'dnx' : 'ssh'
  if (node.type === 'transfer') return String((node.data as { to?: string }).to ?? 'ssh') as ArtifactRef['origin']
  if (node.type === 'file') return String((node.data as { origin?: string }).origin ?? 'ssh') as ArtifactRef['origin']
  return 'ssh'
}

function resultKind(label: string, paths: string[]): NonNullable<RunManifest['resultCards']>[number]['kind'] {
  const text = `${label} ${paths.join(' ')}`.toLowerCase()
  if (text.includes('multiqc') || text.endsWith('.html')) return 'multiqc-report'
  if (text.includes('gwas') || text.includes('glm') || text.includes('assoc')) return 'gwas-summary'
  if (text.includes('profile') || text.includes('score') || text.includes('prs') || text.includes('grs')) return 'prs-profile'
  if (text.includes('annovar') || text.includes('vep') || text.includes('annotation')) return 'variant-annotation'
  if (/\.(png|pdf)$/.test(text) || text.includes('plot')) return 'generic'
  if (text.endsWith('.log') || text.endsWith('.out') || text.endsWith('.err')) return 'log'
  if (/\.(tsv|csv|txt)(\.gz)?$/.test(text)) return 'tabular'
  return 'generic'
}

function fileTypeFromPath(path: string): ArtifactRef['fileType'] {
  const lower = path.toLowerCase()
  if (lower.endsWith('.vcf.gz') || lower.endsWith('.vcf')) return 'vcf'
  if (lower.endsWith('.bcf')) return 'bcf'
  if (lower.endsWith('.bam')) return 'bam'
  if (lower.endsWith('.cram')) return 'cram'
  if (lower.endsWith('.tsv') || lower.endsWith('.tsv.gz')) return 'tsv'
  if (lower.endsWith('.csv')) return 'csv'
  if (lower.endsWith('.xlsx')) return 'xlsx'
  if (lower.endsWith('.txt') || lower.endsWith('.log') || lower.endsWith('.out') || lower.endsWith('.err')) return 'txt'
  return 'any'
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
