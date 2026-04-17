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
  MergeStrategy,
  FileType,
} from '../../src/types/pipeline'
import type { AxedValue, AxisPlan } from './axisPlanner'

export interface ConnectionDefaults {
  account?: string            // --account
  partition?: string          // --partition
  modulePreamble?: string     // e.g., "module --force purge && module load StdEnv/2023"
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
  if (tool.module) lines.push(`module load ${tool.module}`)
  lines.push('')
  lines.push(`mkdir -p ${shellQuote(outputDir)}`)
  lines.push(`cd ${shellQuote(outputDir)}`)
  lines.push('')

  // For array jobs: emit KEYS and INPUT_<portId> arrays, then pick current.
  if (isArray) {
    lines.push(`# --- Array fan-out over axis "${axisPlan.axis}" ---`)
    lines.push(`KEYS=(${axisPlan.keys!.map(shellArg).join(' ')})`)
    // Emit the axed input port's path array
    const axedPortId = axisPlan.arrayPortId!
    const axedInput = axisPlan.inputs[axedPortId]
    if (axedInput.kind !== 'array') {
      throw new Error(`axisPlan says array but input on port ${axedPortId} is not array`)
    }
    lines.push(`INPUT_${axedPortId}=(${axedInput.paths.map(shellArg).join(' ')})`)
    lines.push(`KEY="\${KEYS[$SLURM_ARRAY_TASK_ID]}"`)
    lines.push(`i_${axedPortId}="\${INPUT_${axedPortId}[$SLURM_ARRAY_TASK_ID]}"`)
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

  // Compose the command invocation.
  const cmdParts: string[] = [tool.command]

  // Params first (in registry order for stability)
  for (const p of tool.params) {
    const raw = nodeData.paramValues?.[p.name]
    if (raw === undefined || raw === null || raw === '') continue
    if (p.type === 'boolean') {
      if (raw === true && p.flag) cmdParts.push(p.flag)
      continue
    }
    if (p.flag) {
      cmdParts.push(p.flag, shellQuote(String(raw)))
    } else {
      // No flag → treat the value as a positional (used e.g. by custom.shell)
      cmdParts.push(shellQuote(String(raw)))
    }
  }

  // Inputs, in the order the tool declares them
  for (const port of tool.inputs) {
    const val = axisPlan.inputs[port.id]
    if (!val) continue
    const flag = portFlag(port)
    if (isArray && port.id === axisPlan.arrayPortId) {
      // One value per task, read from the pre-declared array variable
      if (flag) cmdParts.push(flag)
      cmdParts.push(`"$i_${port.id}"`)
      continue
    }
    renderPortArgs(port, val, cmdParts)
  }

  // Output paths — one output flag if present.
  // Convention: many tools use --out <prefix>; we fall back to `-o` then plain.
  // For V1, only emit an --out prefix for tools that declare a specific output
  // flag via a param named 'out'/'output'/'o'. Otherwise we rely on tool default.
  const outputSpec = buildOutputSpec(tool, axisPlan, slug, outputDir, isArray)
  if (outputSpec) cmdParts.push(...outputSpec)

  lines.push(cmdParts.join(' \\\n  '))
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

function shellArrayValue(value: string): string {
  if (value.startsWith('$')) return `"${value}"`
  return shellQuote(value)
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
    return ['--out', shellQuote(prefix)]
  }
  // Default: -o <path>
  return ['-o', shellQuote(path)]
}

function pickPathExpr(portId: string, outputDir: string, slug: string, ft: FileType): string {
  const ext = extForFileType(ft)
  return `${outputDir}/${slug}.${portId}.\${KEY}${ext}`
}

function renderPortArgs(port: ToolPort, val: AxedValue, out: string[]): void {
  const flag = portFlag(port)
  const paths: string[] = val.kind === 'single' ? [val.path]
    : val.kind === 'multi' ? val.paths
    : val.paths

  if (paths.length === 0) return

  const format = port.multiFormat ?? 'repeat'
  if (paths.length === 1 || format === 'repeat') {
    for (const p of paths) {
      if (flag) out.push(flag)
      out.push(shellQuote(p))
    }
    return
  }
  if (format === 'comma') {
    if (flag) out.push(flag)
    out.push(shellQuote(paths.join(',')))
    return
  }
  if (format === 'space') {
    if (flag) out.push(flag)
    for (const p of paths) out.push(shellQuote(p))
    return
  }
}

function portFlag(port: ToolPort): string | null {
  // Ports don't currently carry their own flag, so we derive from id.
  // Convention: 'input' → no flag (positional), 'reference' → --reference,
  // 'pheno' → --pheno, 'covar' → --covar, etc. Specific tools whose inputs
  // need different flags can be handled via a future ToolPort.flag field.
  if (port.id === 'input') return null
  return `--${port.id}`
}

// --- Merge scripts --------------------------------------------------------

export interface MergeScriptOpts {
  nodeId: string
  /** Optional human-readable slug; falls back to nodeId. See ToolScriptOpts. */
  nodeSlug?: string
  mergeData: MergeNodeData
  resolvedInputs: AxedValue     // merge has a single 'input' port
  upstreamFileType: FileType
  outputDir: string
  logDir: string
  connectionDefaults?: ConnectionDefaults
}

export interface MergeScriptResult {
  script: string
  outputPath: string
  strategy: Exclude<MergeStrategy, 'auto'>
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
  const outPath = `${outputDir}/${slug}.output${outExt}`

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
