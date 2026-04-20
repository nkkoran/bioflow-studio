/**
 * ScriptGenerator — pure functions that turn a node's resolved inputs +
 * axis plan into an sbatch script string.
 *
 * Two entry points:
 *   - generateToolScript: for tool nodes, including SLURM array fan-out.
 *   - generateMergeScript: for merge nodes (4 preset strategies + 'auto').
 */
import type {
  ToolDef,
  ToolNodeData,
  ToolPort,
  MergeNodeData,
  TransformNodeData,
  MergeStrategy,
  FileType,
} from '../../src/types/pipeline'
import type { AxedValue, AxisPlan } from './axisPlanner'

export interface ConnectionDefaults {
  account?: string            // --account
  partition?: string          // --partition
  modulePreamble?: string     // e.g., "module --force purge && module load StdEnv/2023"
  toolsRoot?: string
  annovarScriptsPath?: string
  annovarDbPath?: string
  vepPath?: string
  vepCachePath?: string
}

export interface ToolScriptOpts {
  nodeId: string
  /**
   * Optional human-readable slug — used in job-name, log filenames, and output
   * path expressions in place of the raw nodeId. Falls back to nodeId when
   * omitted. Keep this in sync with the slug passed to the axis planner so
   * output paths line up between the two.
   */
  nodeSlug?: string
  tool: ToolDef
  nodeData: ToolNodeData
  axisPlan: AxisPlan
  outputDir: string           // <workDir>/outputs/<slug>
  logDir: string              // <workDir>/logs
  connectionDefaults?: ConnectionDefaults
}

export interface ToolScriptResult {
  script: string
  /** Output paths for each output port, axed or not. */
  outputs: Record<string, AxedValue>
  arraySize?: number          // present when SLURM --array was emitted
}

export function generateToolScript(opts: ToolScriptOpts): ToolScriptResult {
  const { nodeId, tool, nodeData, axisPlan, outputDir, logDir, connectionDefaults } = opts
  const slug = opts.nodeSlug ?? nodeId
  const isArray = axisPlan.mode === 'array'
  const arraySize = isArray ? axisPlan.keys!.length : undefined
  const arrayRuntime = isArray ? buildArrayRuntime(axisPlan) : null

  const slurm = { ...(tool.slurm ?? {}), ...(nodeData.slurmOverride ?? {}) }
  const cpus = slurm.cpus ?? 1
  const memGB = slurm.memoryGB ?? 4
  const timeH = slurm.timeHours ?? 1
  const partition = slurm.partition ?? connectionDefaults?.partition
  const account = connectionDefaults?.account

  const lines: string[] = []
  lines.push('#!/bin/bash')
  lines.push(`#SBATCH --job-name=bioflow-${slug}`)
  if (isArray) {
    lines.push(`#SBATCH --array=${arrayRuntime!.arraySpec}`)
    lines.push(`#SBATCH --output=${logDir}/${slug}-%A_%a.out`)
    lines.push(`#SBATCH --error=${logDir}/${slug}-%A_%a.err`)
  } else {
    lines.push(`#SBATCH --output=${logDir}/${slug}-%j.out`)
    lines.push(`#SBATCH --error=${logDir}/${slug}-%j.err`)
  }
  lines.push(`#SBATCH --cpus-per-task=${cpus}`)
  lines.push(`#SBATCH --mem=${memGB}G`)
  lines.push(`#SBATCH --time=${formatTime(timeH)}`)
  if (account) lines.push(`#SBATCH --account=${account}`)
  if (partition) lines.push(`#SBATCH --partition=${partition}`)
  lines.push('')
  lines.push('set -euo pipefail')
  lines.push('')
  if (connectionDefaults?.modulePreamble) lines.push(connectionDefaults.modulePreamble)
  if (tool.module) lines.push(`module load ${tool.module}`)
  lines.push('')
  lines.push(`mkdir -p ${shellQuote(outputDir)}`)
  lines.push(`cd ${shellQuote(outputDir)}`)
  lines.push('')

  // For array jobs, prefer using the biological key directly as the Slurm
  // task id (e.g. chromosomes 1-22) and infer path templates when possible.
  // Fall back to a lookup table only for irregular/non-numeric keys.
  if (isArray) {
    lines.push(`# --- Array fan-out over axis "${axisPlan.axis}" ---`)
    lines.push(...arrayRuntime!.setupLines)
    lines.push('')
  }

  if (tool.id === 'custom.shell') {
    lines.push(...renderCustomShellScript({
      nodeData,
      axisPlan,
      outputDir,
      slug,
      isArray,
    }))
    lines.push('')
    return { script: lines.join('\n'), outputs: axisPlan.outputs, arraySize }
  }

  if (tool.id === 'annovar.table_annovar') {
    lines.push(renderAnnovarCommand({ nodeData, axisPlan, outputDir, slug, isArray, connectionDefaults }))
    lines.push('')
    return { script: lines.join('\n'), outputs: axisPlan.outputs, arraySize }
  }

  if (tool.id === 'vep') {
    lines.push(renderVepCommand({ nodeData, axisPlan, outputDir, slug, isArray, connectionDefaults }))
    lines.push('')
    return { script: lines.join('\n'), outputs: axisPlan.outputs, arraySize }
  }

  // Compose the command invocation.
  const cmdParts: string[] = [tool.command]

  // Params first (in registry order for stability)
  for (const p of tool.params) {
    const raw = nodeData.paramValues?.[p.name]
    appendParamArgs(tool, p, raw, cmdParts)
  }

  // Inputs, in the order the tool declares them
  for (const port of tool.inputs) {
    const val = axisPlan.inputs[port.id]
    if (!val) continue
    const flag = portFlag(tool, port)
    if (isArray && port.id === axisPlan.arrayPortId) {
      // One value per task, read from the pre-declared array variable
      if (isPlinkInputPort(tool, port)) {
        const firstPath = val.kind === 'array' ? val.paths[0] ?? '' : ''
        cmdParts.push(`${plinkInputFlag(firstPath)} ${plinkShellPrefixExpr(`i_${port.id}`, firstPath)}`)
      } else {
        cmdParts.push(flag ? `${flag} "$i_${port.id}"` : `"$i_${port.id}"`)
      }
      continue
    }
    renderPortArgs(tool, port, val, cmdParts)
  }

  // Output paths — one output flag if present.
  // Convention: many tools use --out <prefix>; we fall back to `-o` then plain.
  // For V1, only emit an --out prefix for tools that declare a specific output
  // flag via a param named 'out'/'output'/'o'. Otherwise we rely on tool default.
  const outputSpec = buildOutputSpec(tool, axisPlan, slug, outputDir, isArray)
  if (outputSpec) cmdParts.push(...outputSpec)

  lines.push(formatCommand(cmdParts))
  lines.push('')

  const outputs: Record<string, AxedValue> = axisPlan.outputs
  return { script: lines.join('\n'), outputs, arraySize }
}

function renderCustomShellScript(opts: {
  nodeData: ToolNodeData
  axisPlan: AxisPlan
  outputDir: string
  slug: string
  isArray: boolean
}): string[] {
  const { nodeData, axisPlan, outputDir, slug, isArray } = opts
  const script = String(nodeData.paramValues?.script ?? '').trim()
  const input = axisPlan.inputs.input
  const inputPaths =
    !input ? []
    : isArray && input.kind === 'array' ? [`$i_input`]
    : input.kind === 'single' ? [input.path]
    : input.paths
  const output = resolveShellOutputPath(axisPlan, outputDir, slug, isArray)

  const lines: string[] = []
  lines.push('# --- BioFlow shell I/O ---')
  lines.push(`OUTPUT_DIR=${shellQuote(outputDir)}`)
  if (output) {
    lines.push(`OUTPUT=${shellQuote(output)}`)
  }
  lines.push(`INPUTS=(${inputPaths.map(shellArrayValue).join(' ')})`)
  lines.push('INPUT="${INPUTS[0]:-}"')
  inputPaths.forEach((path, idx) => {
    lines.push(`INPUT_${idx + 1}=${shellArrayValue(path)}`)
  })
  lines.push('set -- "${INPUTS[@]}"')
  lines.push('')
  lines.push('# Use $INPUT for the first connected file, "${INPUTS[@]}" for all inputs,')
  lines.push('# and $OUTPUT for the node output file. Stdout is saved to $OUTPUT.')
  if (output) {
    lines.push('{')
    lines.push(script || ':')
    lines.push(`} > "$OUTPUT"`)
  } else {
    lines.push(script || ':')
  }
  return lines
}

function resolveShellOutputPath(
  axisPlan: AxisPlan,
  outputDir: string,
  slug: string,
  isArray: boolean,
): string | null {
  const outVal = axisPlan.outputs.output
  if (!outVal) return null
  if (isArray && outVal.kind === 'array') {
    return pickPathExpr('output', outputDir, slug, 'any')
  }
  if (outVal.kind === 'single') return outVal.path
  return outVal.paths[0] ?? null
}

function renderAnnovarCommand(opts: {
  nodeData: ToolNodeData
  axisPlan: AxisPlan
  outputDir: string
  slug: string
  isArray: boolean
  connectionDefaults?: ConnectionDefaults
}): string {
  const { nodeData, axisPlan, outputDir, slug, isArray, connectionDefaults } = opts
  const input = resolveSingleInput(axisPlan, 'input', isArray)
  const output = resolveFirstOutput(axisPlan, 'output', outputDir, slug, 'tsv', isArray)
  const scriptDir = stringParam(nodeData, 'toolPath') || connectionDefaults?.annovarScriptsPath || ''
  const script = scriptDir ? `${scriptDir.replace(/\/+$/, '')}/table_annovar.pl` : 'table_annovar.pl'
  const humandb = stringParam(nodeData, 'annotationDbPath') || connectionDefaults?.annovarDbPath || `${connectionDefaults?.toolsRoot ?? '~/bioflow/tools'}/annovar/humandb`
  const build = stringParam(nodeData, 'buildver') || 'hg38'
  const protocol = stringParam(nodeData, 'protocol') || 'refGene,avsnp150'
  const operation = stringParam(nodeData, 'operation') || 'g,f'
  const nastring = stringParam(nodeData, 'nastring') || '.'
  const prefix = stripExt(output)

  const parts = [
    'perl',
    shellQuote(script),
    shellExpr(input),
    shellQuote(humandb),
    '--buildver', shellQuote(build),
    '--out', shellExpr(prefix),
    '--protocol', shellQuote(protocol),
    '--operation', shellQuote(operation),
    '--nastring', shellQuote(nastring),
  ]
  if (nodeData.paramValues?.remove !== false) parts.push('--remove')
  if (nodeData.paramValues?.vcfinput !== false) parts.push('--vcfinput')
  return parts.join(' \\\n  ')
}

function renderVepCommand(opts: {
  nodeData: ToolNodeData
  axisPlan: AxisPlan
  outputDir: string
  slug: string
  isArray: boolean
  connectionDefaults?: ConnectionDefaults
}): string {
  const { nodeData, axisPlan, outputDir, slug, isArray, connectionDefaults } = opts
  const input = resolveSingleInput(axisPlan, 'input', isArray)
  const output = resolveFirstOutput(axisPlan, 'output', outputDir, slug, 'vcf', isArray)
  const rawToolPath = stringParam(nodeData, 'toolPath') || connectionDefaults?.vepPath || 'vep'
  const command = rawToolPath.endsWith('/') ? `${rawToolPath}vep` : rawToolPath
  const cache = stringParam(nodeData, 'annotationDbPath') || connectionDefaults?.vepCachePath || `${connectionDefaults?.toolsRoot ?? '~/bioflow/tools'}/vep/cache`
  const assembly = stringParam(nodeData, 'assembly') || 'GRCh38'
  const fork = stringParam(nodeData, 'fork') || '4'

  const parts = [
    shellQuote(command),
    '--input_file', shellExpr(input),
    '--output_file', shellExpr(output),
    '--assembly', shellQuote(assembly),
    '--dir_cache', shellQuote(cache),
    '--fork', shellQuote(fork),
    '--force_overwrite',
  ]
  if (nodeData.paramValues?.cache !== false) parts.push('--cache')
  if (nodeData.paramValues?.offline !== false) parts.push('--offline')
  if (nodeData.paramValues?.everything === true) parts.push('--everything')
  if (nodeData.paramValues?.check_existing === true) parts.push('--check_existing')
  if (nodeData.paramValues?.af_gnomad === true) parts.push('--af_gnomad')
  const nearest = stringParam(nodeData, 'nearest')
  if (nearest) parts.push('--nearest', shellQuote(nearest))
  const plugin = stringParam(nodeData, 'plugin')
  if (plugin) parts.push('--plugin', shellQuote(plugin))
  return parts.join(' \\\n  ')
}

function stringParam(nodeData: ToolNodeData, name: string): string {
  const value = nodeData.paramValues?.[name]
  return value === undefined || value === null ? '' : String(value).trim()
}

interface ArrayRuntime {
  arraySpec: string
  setupLines: string[]
}

function buildArrayRuntime(axisPlan: AxisPlan): ArrayRuntime {
  const keys = axisPlan.keys ?? []
  const axedPortId = axisPlan.arrayPortId!
  const axedInput = axisPlan.inputs[axedPortId]
  if (!axedInput || axedInput.kind !== 'array') {
    throw new Error(`axisPlan says array but input on port ${axedPortId} is not array`)
  }

  if (keysAreSlurmTaskIds(keys)) {
    const template = templateMatchesPaths(axedInput.pathTemplate, axedInput.paths, keys)
      ? axedInput.pathTemplate
      : inferKeyedPathTemplate(axedInput.paths, keys)
    const lines = [`KEY="$SLURM_ARRAY_TASK_ID"`]
    if (template) {
      lines.push(`i_${axedPortId}="${template}"`)
    } else {
      lines.push(`declare -A INPUT_${axedPortId}=(`)
      for (let i = 0; i < keys.length; i++) {
        lines.push(`  [${keys[i]}]=${shellArg(axedInput.paths[i])}`)
      }
      lines.push(')')
      lines.push(`i_${axedPortId}="\${INPUT_${axedPortId}[$KEY]}"`)
    }
    return { arraySpec: compactNumericArraySpec(keys), setupLines: lines }
  }

  return {
    arraySpec: `0-${keys.length - 1}`,
    setupLines: [
      `KEYS=(${keys.map(shellArg).join(' ')})`,
      `INPUT_${axedPortId}=(${axedInput.paths.map(shellArg).join(' ')})`,
      `KEY="\${KEYS[$SLURM_ARRAY_TASK_ID]}"`,
      `i_${axedPortId}="\${INPUT_${axedPortId}[$SLURM_ARRAY_TASK_ID]}"`,
    ],
  }
}

function templateMatchesPaths(template: string | undefined, paths: string[], keys: string[]): template is string {
  if (!template || !template.includes('${KEY}')) return false
  return paths.every((path, idx) => template.replaceAll('${KEY}', keys[idx]) === path)
}

function keysAreSlurmTaskIds(keys: string[]): boolean {
  return keys.length > 0 && keys.every((key) => /^\d+$/.test(key) && Number(key) >= 0)
}

function compactNumericArraySpec(keys: string[]): string {
  const nums = [...new Set(keys.map(Number))].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < nums.length; i++) {
    const start = nums[i]
    let end = start
    while (i + 1 < nums.length && nums[i + 1] === end + 1) {
      end = nums[i + 1]
      i++
    }
    parts.push(start === end ? String(start) : `${start}-${end}`)
  }
  return parts.join(',')
}

function inferKeyedPathTemplate(paths: string[], keys: string[]): string | null {
  let possible: Set<string> | null = null
  for (let i = 0; i < paths.length; i++) {
    const candidates = keyedTemplateCandidates(paths[i], keys[i])
    if (candidates.size === 0) return null
    possible = possible
      ? new Set((Array.from(possible) as string[]).filter((candidate) => candidates.has(candidate)))
      : candidates
    if (possible.size === 0) return null
  }

  const template = [...(possible ?? [])].sort((a, b) => templateScore(b) - templateScore(a) || a.length - b.length)[0]
  return template ? template.replaceAll('__BIOFLOW_KEY__', '${KEY}') : null
}

function keyedTemplateCandidates(path: string, key: string): Set<string> {
  const out = new Set<string>()
  if (!key) return out
  const indices: number[] = []
  let idx = path.indexOf(key)
  while (idx !== -1 && indices.length < 8) {
    indices.push(idx)
    idx = path.indexOf(key, idx + 1)
  }
  const subsetCount = 1 << indices.length
  for (let mask = 1; mask < subsetCount; mask++) {
    let next = ''
    let cursor = 0
    for (let i = 0; i < indices.length; i++) {
      if ((mask & (1 << i)) === 0) continue
      const start = indices[i]
      if (start < cursor) continue
      next += path.slice(cursor, start)
      next += '__BIOFLOW_KEY__'
      cursor = start + key.length
    }
    next += path.slice(cursor)
    out.add(next)
  }
  return out
}

function templateScore(template: string): number {
  const idx = template.indexOf('__BIOFLOW_KEY__')
  if (idx < 0) return 0
  const before = idx > 0 ? template[idx - 1] : ''
  const after = template[idx + '__BIOFLOW_KEY__'.length] ?? ''
  let score = 0
  if (!/[A-Za-z0-9_]/.test(before)) score += 2
  if (!/[A-Za-z0-9_]/.test(after)) score += 2
  if (before === '/' || after === '/') score += 2
  if (/chr__BIOFLOW_KEY__/i.test(template)) score += 1
  return score
}

function resolveSingleInput(axisPlan: AxisPlan, portId: string, isArray: boolean): string {
  const val = axisPlan.inputs[portId]
  if (!val) return ''
  if (isArray && val.kind === 'array') return `$i_${portId}`
  if (val.kind === 'single') return val.path
  return val.paths[0] ?? ''
}

function resolveFirstOutput(axisPlan: AxisPlan, portId: string, outputDir: string, slug: string, ft: FileType, isArray: boolean): string {
  const outVal = axisPlan.outputs[portId]
  if (!outVal) return `${outputDir}/${slug}.${portId}${extForFileType(ft)}`
  if (isArray && outVal.kind === 'array') return pickPathExpr(portId, outputDir, slug, ft)
  if (outVal.kind === 'single') return outVal.path
  return outVal.paths[0] ?? `${outputDir}/${slug}.${portId}${extForFileType(ft)}`
}

function shellArrayValue(value: string): string {
  if (value.startsWith('$')) return `"${value}"`
  return shellQuote(value)
}

function shellExpr(value: string): string {
  if (value.includes('$')) return `"${value.replace(/"/g, '\\"')}"`
  return shellQuote(value)
}

function formatCommand(parts: string[]): string {
  return parts.filter(Boolean).join(' \\\n  ')
}

/** Build the --out / -o section. Uses the first output port's path. */
function buildOutputSpec(
  tool: ToolDef,
  axisPlan: AxisPlan,
  slug: string,
  outputDir: string,
  isArray: boolean,
): string[] | null {
  const firstOut = tool.outputs[0]
  if (!firstOut) return null
  // If the tool is `bash` (custom.shell), don't force an --out flag.
  if (tool.command === 'bash') return null

  // Most bioinfo tools: plink2 uses --out prefix; bcftools uses -o path; samtools varies.
  // Heuristic: plink → --out prefix; everything else → -o absolute path.
  const outVal = axisPlan.outputs[firstOut.id]
  if (!outVal) return null
  const path = isArray
    ? outVal.kind === 'array'
      ? pickPathExpr(firstOut.id, outputDir, slug, firstOut.fileType)
      : (outVal as { path: string }).path
    : (outVal as { path: string }).path

  const cmdId = tool.command.toLowerCase()
  if (cmdId === 'plink2' || cmdId === 'plink') {
    // plink uses --out <prefix>, no extension.
    const prefix = stripExt(path)
    return [`--out ${shellExpr(prefix)}`]
  }
  // Default: -o <path>
  return [`-o ${shellExpr(path)}`]
}

function pickPathExpr(portId: string, outputDir: string, slug: string, ft: FileType): string {
  const ext = extForFileType(ft)
  return `${outputDir}/${slug}.${portId}.\${KEY}${ext}`
}

function appendParamArgs(tool: ToolDef, param: ToolDef['params'][number], raw: unknown, out: string[]): void {
  if (raw === undefined || raw === null || raw === '') return
  if (param.type === 'boolean') {
    if (raw === true && param.flag) out.push(param.flag)
    return
  }

  if (param.flag && isPlinkGlmParam(tool, param.name)) {
    const values = normalizePlinkGlmValue(raw)
    out.push(values.length > 0 ? `${param.flag} ${values.map(shellQuote).join(' ')}` : param.flag)
    return
  }

  if (param.flag && isPlinkListParam(tool, param.name)) {
    const values = splitPlinkListValue(raw)
    if (values.length > 0) out.push(`${param.flag} ${values.map(shellQuote).join(' ')}`)
    return
  }

  if (param.flag) {
    out.push(`${param.flag} ${shellQuote(String(raw))}`)
  } else {
    // No flag → treat the value as a positional (used e.g. by custom.shell)
    out.push(shellQuote(String(raw)))
  }
}

function isPlinkListParam(tool: ToolDef, name: string): boolean {
  const cmd = tool.command.toLowerCase()
  return (cmd === 'plink2' || cmd === 'plink') && new Set([
    'covar-name',
    'phenoColList',
    'covarColList',
    'score-col-nums',
  ]).has(name)
}

function isPlinkGlmParam(tool: ToolDef, name: string): boolean {
  const cmd = tool.command.toLowerCase()
  return (cmd === 'plink2' || cmd === 'plink') && name === 'glm'
}

function normalizePlinkGlmValue(raw: unknown): string[] {
  const values = splitPlinkListValue(raw)
  const normalized = values.filter((value) => value !== 'none')
  if (normalized.length === 0) return []
  if (normalized.some((value) => value === 'linear' || value === 'logistic')) {
    return ['hide-covar']
  }
  return normalized
}

function splitPlinkListValue(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((value) => value.trim()).filter(Boolean)
  return String(raw)
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean)
}

function renderPortArgs(tool: ToolDef, port: ToolPort, val: AxedValue, out: string[]): void {
  if (isPlinkInputPort(tool, port)) {
    const paths: string[] = val.kind === 'single' ? [val.path]
      : val.kind === 'multi' ? val.paths
      : val.paths
    for (const path of paths) {
      out.push(`${plinkInputFlag(path)} ${shellQuote(plinkPrefixPath(path))}`)
    }
    return
  }

  const flag = portFlag(tool, port)
  const paths: string[] = val.kind === 'single' ? [val.path]
    : val.kind === 'multi' ? val.paths
    : val.paths

  if (paths.length === 0) return

  const format = port.multiFormat ?? 'repeat'
  if (paths.length === 1 || format === 'repeat') {
    for (const p of paths) {
      out.push(flag ? `${flag} ${shellQuote(p)}` : shellQuote(p))
    }
    return
  }
  if (format === 'comma') {
    out.push(flag ? `${flag} ${shellQuote(paths.join(','))}` : shellQuote(paths.join(',')))
    return
  }
  if (format === 'space') {
    out.push(flag ? `${flag} ${paths.map(shellQuote).join(' ')}` : paths.map(shellQuote).join(' '))
    return
  }
}

function portFlag(tool: ToolDef, port: ToolPort): string | null {
  if (isPlinkInputPort(tool, port)) return '--pfile'
  // Ports don't currently carry their own flag, so we derive from id.
  // Convention: 'input' → no flag (positional), 'reference' → --reference,
  // 'pheno' → --pheno, 'covar' → --covar, etc. Specific tools whose inputs
  // need different flags can be handled via a future ToolPort.flag field.
  if (port.id === 'input') return null
  return `--${port.id}`
}

function isPlinkInputPort(tool: ToolDef, port: ToolPort): boolean {
  const cmd = tool.command.toLowerCase()
  return (cmd === 'plink2' || cmd === 'plink') && port.id === 'input' && (port.fileType === 'plink' || port.fileType === 'pgen')
}

function plinkInputFlag(path: string): string {
  return /\.bed$/i.test(path) ? '--bfile' : '--pfile'
}

function plinkPrefixPath(path: string): string {
  if (/\.(pgen|pvar|psam|bed|bim|fam)$/i.test(path)) return stripExt(path)
  return path
}

function plinkShellPrefixExpr(variableName: string, samplePath: string): string {
  if (/\.bed$/i.test(samplePath)) return `"${'${'}${variableName}%.bed}"`
  if (/\.(pgen|pvar|psam)$/i.test(samplePath)) return `"${'${'}${variableName}%.*}"`
  return `"$${variableName}"`
}

// --- Merge scripts --------------------------------------------------------

export interface MergeScriptOpts {
  nodeId: string
  /** Optional human-readable slug; falls back to nodeId. See ToolScriptOpts. */
  nodeSlug?: string
  mergeData: MergeNodeData
  resolvedInputs: AxedValue     // merge has a single 'input' port
  upstreamFileType: FileType
  outputPath?: string
  outputDir: string
  logDir: string
  connectionDefaults?: ConnectionDefaults
}

export interface MergeScriptResult {
  script: string
  outputPath: string
  strategy: Exclude<MergeStrategy, 'auto'>
}

export interface TransformScriptOpts {
  nodeId: string
  nodeSlug?: string
  transformData: TransformNodeData
  axisPlan: AxisPlan
  outputDir: string
  logDir: string
  connectionDefaults?: ConnectionDefaults
}

export interface TransformScriptResult {
  script: string
  outputs: Record<string, AxedValue>
  arraySize?: number
}

export function generateTransformScript(opts: TransformScriptOpts): TransformScriptResult {
  const { nodeId, transformData, axisPlan, outputDir, logDir, connectionDefaults } = opts
  const slug = opts.nodeSlug ?? nodeId
  const isArray = axisPlan.mode === 'array'
  const arraySize = isArray ? axisPlan.keys!.length : undefined
  const slurm = transformData.slurmOverride ?? {}
  const cpus = slurm.cpus ?? 1
  const memGB = slurm.memoryGB ?? 4
  const timeH = slurm.timeHours ?? 1
  const partition = slurm.partition ?? connectionDefaults?.partition
  const account = connectionDefaults?.account
  const input = axisPlan.inputs.input
  const output = axisPlan.outputs.output
  const inputPaths = input?.kind === 'array' ? input.paths : input?.kind === 'multi' ? input.paths : input ? [input.path] : []
  const outputPaths = output?.kind === 'array' ? output.paths : output?.kind === 'multi' ? output.paths : output ? [output.path] : []

  const lines: string[] = []
  lines.push('#!/bin/bash')
  lines.push(`#SBATCH --job-name=bioflow-${slug}-transform`)
  if (isArray) {
    lines.push(`#SBATCH --array=0-${arraySize! - 1}`)
    lines.push(`#SBATCH --output=${logDir}/${slug}-%A_%a.out`)
    lines.push(`#SBATCH --error=${logDir}/${slug}-%A_%a.err`)
  } else {
    lines.push(`#SBATCH --output=${logDir}/${slug}-%j.out`)
    lines.push(`#SBATCH --error=${logDir}/${slug}-%j.err`)
  }
  lines.push(`#SBATCH --cpus-per-task=${cpus}`)
  lines.push(`#SBATCH --mem=${memGB}G`)
  lines.push(`#SBATCH --time=${formatTime(timeH)}`)
  if (account) lines.push(`#SBATCH --account=${account}`)
  if (partition) lines.push(`#SBATCH --partition=${partition}`)
  lines.push('')
  lines.push('set -euo pipefail')
  lines.push('')
  if (connectionDefaults?.modulePreamble) lines.push(connectionDefaults.modulePreamble)
  lines.push(`mkdir -p ${shellQuote(outputDir)}`)
  lines.push('')
  lines.push(`INPUTS=(${inputPaths.map(shellArg).join(' ')})`)
  lines.push(`OUTPUTS=(${outputPaths.map(shellArg).join(' ')})`)
  if (isArray) {
    lines.push('IN="${INPUTS[$SLURM_ARRAY_TASK_ID]}"')
    lines.push('OUT="${OUTPUTS[$SLURM_ARRAY_TASK_ID]}"')
  } else {
    lines.push('IN="${INPUTS[0]}"')
    lines.push('OUT="${OUTPUTS[0]}"')
  }
  lines.push('')
  lines.push(`python3 - <<'PY' "$IN" "$OUT"`)
  lines.push('import csv, json, re, sys')
  lines.push('in_path, out_path = sys.argv[1], sys.argv[2]')
  lines.push(`config = json.loads(${JSON.stringify(JSON.stringify({
    selectedColumns: transformData.selectedColumns ?? [],
    filters: transformData.filters ?? [],
    renames: transformData.renames ?? [],
    fileType: transformData.fileType,
  }))})`)
  lines.push('def delimiter(path, preferred):')
  lines.push('    if preferred == "csv" or path.lower().endswith(".csv"): return ","')
  lines.push('    return "\\t"')
  lines.push('def match(row, rule):')
  lines.push('    raw = row.get(rule.get("column", ""), "")')
  lines.push('    value = str(rule.get("value", ""))')
  lines.push('    op = rule.get("op")')
  lines.push('    if op == "contains": return value.lower() in raw.lower()')
  lines.push('    if op == "regex":')
  lines.push('        try: return re.search(value, raw, re.IGNORECASE) is not None')
  lines.push('        except re.error: return False')
  lines.push('    if op == "equals": return raw == value')
  lines.push('    if op == "notEquals": return raw != value')
  lines.push('    if op == "notEmpty": return raw.strip() != ""')
  lines.push('    try:')
  lines.push('        a, b = float(raw), float(value)')
  lines.push('    except ValueError:')
  lines.push('        return False')
  lines.push('    return (op == "gt" and a > b) or (op == "gte" and a >= b) or (op == "lt" and a < b) or (op == "lte" and a <= b)')
  lines.push('in_delim = delimiter(in_path, "")')
  lines.push('out_delim = delimiter(out_path, config.get("fileType", ""))')
  lines.push('with open(in_path, newline="") as src, open(out_path, "w", newline="") as dst:')
  lines.push('    reader = csv.DictReader(src, delimiter=in_delim)')
  lines.push('    source_fields = reader.fieldnames or []')
  lines.push('    requested = [c for c in config.get("selectedColumns", []) if c in source_fields]')
  lines.push('    fields = requested or source_fields')
  lines.push('    rename = {r.get("from"): (r.get("to") or r.get("from")) for r in config.get("renames", [])}')
  lines.push('    out_fields = [rename.get(c, c) for c in fields]')
  lines.push('    writer = csv.DictWriter(dst, fieldnames=out_fields, delimiter=out_delim, extrasaction="ignore", lineterminator="\\n")')
  lines.push('    writer.writeheader()')
  lines.push('    for row in reader:')
  lines.push('        if all(match(row, rule) for rule in config.get("filters", [])):')
  lines.push('            writer.writerow({rename.get(c, c): row.get(c, "") for c in fields})')
  lines.push('PY')
  lines.push('')
  return { script: lines.join('\n'), outputs: axisPlan.outputs, arraySize }
}

export function generateMergeScript(opts: MergeScriptOpts): MergeScriptResult {
  const { nodeId, mergeData, resolvedInputs, upstreamFileType, outputDir, logDir, connectionDefaults } = opts
  const slug = opts.nodeSlug ?? nodeId
  const inputs = resolvedInputs.kind === 'single' ? [resolvedInputs.path]
    : resolvedInputs.kind === 'multi' ? resolvedInputs.paths
    : resolvedInputs.paths

  const strategy = resolveMergeStrategy(mergeData.strategy, upstreamFileType)
  const slurm = mergeData.slurmOverride ?? {}
  const cpus = slurm.cpus ?? 2
  const memGB = slurm.memoryGB ?? 8
  const timeH = slurm.timeHours ?? 1
  const partition = slurm.partition ?? connectionDefaults?.partition
  const account = connectionDefaults?.account

  // Output path — extension dictated by strategy
  const outExt =
    strategy === 'bcftools-concat' ? '.vcf.gz'
    : strategy === 'plink-pmerge-list' ? ''
    : strategy === 'tsv-concat-header' ? '.tsv'
    : '.txt'
  const outPath = opts.outputPath ?? `${outputDir}/${slug}.output${outExt}`

  const lines: string[] = []
  lines.push('#!/bin/bash')
  lines.push(`#SBATCH --job-name=bioflow-${slug}-merge`)
  lines.push(`#SBATCH --output=${logDir}/${slug}-%j.out`)
  lines.push(`#SBATCH --error=${logDir}/${slug}-%j.err`)
  lines.push(`#SBATCH --cpus-per-task=${cpus}`)
  lines.push(`#SBATCH --mem=${memGB}G`)
  lines.push(`#SBATCH --time=${formatTime(timeH)}`)
  if (account) lines.push(`#SBATCH --account=${account}`)
  if (partition) lines.push(`#SBATCH --partition=${partition}`)
  lines.push('')
  lines.push('set -euo pipefail')
  lines.push('')
  if (connectionDefaults?.modulePreamble) lines.push(connectionDefaults.modulePreamble)
  if (strategy === 'bcftools-concat') lines.push('module load bcftools/1.19')
  if (strategy === 'plink-pmerge-list') lines.push('module load plink/2.00a3')
  lines.push('')
  lines.push(`mkdir -p ${shellQuote(outputDir)}`)
  lines.push('')
  lines.push(`INPUTS=(${inputs.map(shellArg).join(' ')})`)
  lines.push('')

  switch (strategy) {
    case 'tsv-concat-header':
      lines.push(`head -n 1 "\${INPUTS[0]}" > ${shellQuote(outPath)}`)
      lines.push(`tail -qn +2 "\${INPUTS[@]}" >> ${shellQuote(outPath)}`)
      break
    case 'bcftools-concat':
      lines.push(`bcftools concat -Oz -o ${shellQuote(outPath)} "\${INPUTS[@]}"`)
      lines.push(`bcftools index -t ${shellQuote(outPath)}`)
      break
    case 'plink-pmerge-list': {
      const listFile = `${outputDir}/${slug}.pmerge-list.txt`
      lines.push(`printf '%s\\n' "\${INPUTS[@]}" > ${shellQuote(listFile)}`)
      lines.push(`plink2 --pmerge-list ${shellQuote(listFile)} --make-pgen --out ${shellQuote(outPath)}`)
      break
    }
    case 'cat':
      lines.push(`cat "\${INPUTS[@]}" > ${shellQuote(outPath)}`)
      break
  }

  lines.push('')
  return { script: lines.join('\n'), outputPath: outPath, strategy }
}

export function resolveMergeStrategy(strategy: MergeStrategy, ft: FileType): Exclude<MergeStrategy, 'auto'> {
  if (strategy !== 'auto') return strategy
  if (ft === 'tsv' || ft === 'csv') return 'tsv-concat-header'
  if (ft === 'vcf' || ft === 'bcf') return 'bcftools-concat'
  if (ft === 'plink' || ft === 'pgen') return 'plink-pmerge-list'
  return 'cat'
}

// --- utilities ------------------------------------------------------------

function formatTime(hours: number): string {
  const h = Math.max(0, Math.floor(hours))
  const m = Math.max(0, Math.round((hours - h) * 60))
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`
}

function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'"'"'`)}'`
}

function shellArg(s: string): string {
  return shellQuote(s)
}

function stripExt(p: string): string {
  // Strip a single or .vcf.gz-style dotted extension. For prefix-based tools.
  if (p.endsWith('.vcf.gz')) return p.slice(0, -7)
  if (p.endsWith('.fastq.gz')) return p.slice(0, -9)
  const idx = p.lastIndexOf('.')
  if (idx <= 0) return p
  return p.slice(0, idx)
}

function extForFileType(ft: FileType): string {
  switch (ft) {
    case 'vcf': return '.vcf.gz'
    case 'bcf': return '.bcf'
    case 'bam': return '.bam'
    case 'sam': return '.sam'
    case 'cram': return '.cram'
    case 'fastq': return '.fastq.gz'
    case 'fasta': return '.fasta'
    case 'bed': return '.bed'
    case 'gff': return '.gff'
    case 'gtf': return '.gtf'
    case 'tsv': return '.tsv'
    case 'csv': return '.csv'
    case 'txt': return '.txt'
    case 'json': return '.json'
    case 'yaml': return '.yaml'
    case 'plink': return ''
    case 'pgen': return ''
    case 'bgen': return '.bgen'
    default: return ''
  }
}
