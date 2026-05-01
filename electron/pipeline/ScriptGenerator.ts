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
  ToolFlagBlock,
  AnalysisOptionState,
} from '../../src/types/pipeline'
import { activeFlagBlocks, blockFlag, getFlagDef, toolUsesFlagBuilder, CUSTOM_FLAG_ID } from '../../src/lib/flagRegistry'
import { getActiveToolInputs, getAnalysisOptionDefs, normalizeAnalysisOptions } from '../../src/lib/analysisOptions'
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
  shellCapabilities?: {
    awk: boolean
  }
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

function buildSlurmHeader(args: {
  slug: string
  logDir: string
  cpus: number
  memGB: number
  timeH: number
  account?: string
  partition?: string
  arraySpec?: string
  jobSuffix?: string
}): string[] {
  const lines: string[] = ['#!/bin/bash']
  const jobName = args.jobSuffix ? `bioflow-${args.slug}-${args.jobSuffix}` : `bioflow-${args.slug}`
  lines.push(`#SBATCH --job-name=${jobName}`)
  if (args.arraySpec) {
    const logPath = `${args.logDir}/${args.slug}-%A_%a.slurm.log`
    lines.push(`#SBATCH --array=${args.arraySpec}`)
    lines.push(`#SBATCH --output=${logPath}`)
    lines.push(`#SBATCH --error=${logPath}`)
  } else {
    const logPath = `${args.logDir}/${args.slug}-%j.slurm.log`
    lines.push(`#SBATCH --output=${logPath}`)
    lines.push(`#SBATCH --error=${logPath}`)
  }
  lines.push(`#SBATCH --cpus-per-task=${args.cpus}`)
  lines.push(`#SBATCH --mem=${args.memGB}G`)
  lines.push(`#SBATCH --time=${formatTime(args.timeH)}`)
  if (args.account) lines.push(`#SBATCH --account=${args.account}`)
  if (args.partition) lines.push(`#SBATCH --partition=${args.partition}`)
  return lines
}

export function generateToolScript(opts: ToolScriptOpts): ToolScriptResult {
  const { nodeId, tool, nodeData, axisPlan, outputDir, logDir, connectionDefaults } = opts
  const slug = opts.nodeSlug ?? nodeId
  const phewasArray = tool.id === 'plink2.phewas' ? typedPhenotypeList(nodeData).filter(Boolean) : []
  const assocArray = tool.id === 'plink2.assoc' ? typedAssocPhenotypeList(nodeData).filter(Boolean) : []
  const usePhewasArray = tool.id === 'plink2.phewas'
    && axisPlan.mode !== 'array'
    && stringParam(nodeData, 'array-mode') !== 'single-job-loop'
    && phewasArray.length > 1
    && !axisPlan.inputs.phenoList
  const useAssocArray = tool.id === 'plink2.assoc'
    && axisPlan.mode !== 'array'
    && assocArray.length > 1
    && Boolean(axisPlan.inputs.pheno)
  const isArray = axisPlan.mode === 'array' || usePhewasArray || useAssocArray
  const arraySize = axisPlan.mode === 'array' ? axisPlan.keys!.length : usePhewasArray ? phewasArray.length : useAssocArray ? assocArray.length : undefined
  const arrayRuntime = axisPlan.mode === 'array' ? buildArrayRuntime(axisPlan) : null

  const slurm = { ...(tool.slurm ?? {}), ...(nodeData.slurmOverride ?? {}) }
  const cpus = slurm.cpus ?? 1
  const memGB = slurm.memoryGB ?? 4
  const timeH = slurm.timeHours ?? 1
  const partition = slurm.partition ?? connectionDefaults?.partition
  const account = connectionDefaults?.account

  const lines: string[] = buildSlurmHeader({
    slug,
    logDir,
    cpus,
    memGB,
    timeH,
    account,
    partition,
    arraySpec: axisPlan.mode === 'array'
      ? arrayRuntime!.arraySpec
      : usePhewasArray
        ? `0-${phewasArray.length - 1}`
        : useAssocArray
          ? `0-${assocArray.length - 1}`
          : undefined,
  })
  lines.push('')
  lines.push('set -euo pipefail')
  lines.push('')
  if (connectionDefaults?.modulePreamble) lines.push(connectionDefaults.modulePreamble)
  if (nodeData.moduleOverride?.trim()) lines.push(`module load ${nodeData.moduleOverride.trim()}`)
  else if (tool.module) lines.push(`module load ${tool.module}`)
  lines.push('')
  lines.push(`mkdir -p ${shellQuote(outputDir)}`)
  lines.push(`cd ${shellQuote(outputDir)}`)
  lines.push('')

  // For array jobs, prefer using the biological key directly as the Slurm
  // task id (e.g. chromosomes 1-22) and infer path templates when possible.
  // Fall back to a lookup table only for irregular/non-numeric keys.
  if (axisPlan.mode === 'array') {
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

  if (tool.id === 'plink2.assoc' && useAssocArray) {
    lines.push(...renderPlinkAssociationBatchScript({
      tool,
      nodeData,
      axisPlan,
      outputDir,
      slug,
      typedPhenotypes: assocArray,
    }))
    lines.push('')
    return { script: lines.join('\n'), outputs: axisPlan.outputs, arraySize }
  }

  if (tool.id === 'plink2.phewas') {
    lines.push(...renderPlinkPhewasScript({
      tool,
      nodeData,
      axisPlan,
      outputDir,
      slug,
      typedPhenotypes: phewasArray,
      useSlurmArray: usePhewasArray,
    }))
    lines.push('')
    return { script: lines.join('\n'), outputs: axisPlan.outputs, arraySize }
  }

  if (tool.id === 'crossmap.liftover') {
    lines.push(renderCrossMapCommand({ nodeData, axisPlan, outputDir, slug, isArray: axisPlan.mode === 'array' }))
    lines.push('')
    return { script: lines.join('\n'), outputs: axisPlan.outputs, arraySize }
  }

  if (tool.id === 'bwa.mem') {
    lines.push(renderBwaMemCommand({ nodeData, axisPlan, outputDir, slug, isArray: axisPlan.mode === 'array' }))
    lines.push('')
    return { script: lines.join('\n'), outputs: axisPlan.outputs, arraySize }
  }

  if (tool.id === 'fastqc') {
    lines.push(renderFastqcCommand({ nodeData, axisPlan, outputDir }))
    lines.push('')
    return { script: lines.join('\n'), outputs: axisPlan.outputs, arraySize }
  }

  if (tool.id === 'multiqc') {
    lines.push(renderMultiqcCommand({ nodeData, axisPlan, outputDir, slug }))
    lines.push('')
    return { script: lines.join('\n'), outputs: axisPlan.outputs, arraySize }
  }

  if (tool.id === 'bcftools.view') {
    lines.push(renderBcftoolsViewCommand({ nodeData, axisPlan, outputDir, slug, isArray: axisPlan.mode === 'array' }))
    lines.push('')
    return { script: lines.join('\n'), outputs: axisPlan.outputs, arraySize }
  }

  if (tool.id === 'bcftools.merge') {
    lines.push(renderBcftoolsMergeCommand({ nodeData, axisPlan, outputDir, slug }))
    lines.push('')
    return { script: lines.join('\n'), outputs: axisPlan.outputs, arraySize }
  }

  if (tool.id === 'samtools.sort') {
    lines.push(renderSamtoolsSortCommand({ nodeData, axisPlan, outputDir, slug, isArray: axisPlan.mode === 'array' }))
    lines.push('')
    return { script: lines.join('\n'), outputs: axisPlan.outputs, arraySize }
  }

  if (tool.id === 'samtools.index') {
    lines.push(renderSamtoolsIndexCommand({ nodeData, axisPlan, outputDir, slug, isArray: axisPlan.mode === 'array' }))
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

  const customTemplate = typeof (tool as ToolDef & { customCommandTemplate?: unknown }).customCommandTemplate === 'string'
    ? String((tool as ToolDef & { customCommandTemplate?: unknown }).customCommandTemplate)
    : ''
  if (customTemplate.trim()) {
    lines.push(renderCommandTemplate(customTemplate, nodeData, axisPlan, outputDir, slug, isArray))
    lines.push('')
    return { script: lines.join('\n'), outputs: axisPlan.outputs, arraySize }
  }

  if (nodeData.commandOverride?.trim()) {
    lines.push(nodeData.commandOverride.trim())
    lines.push('')
    return { script: lines.join('\n'), outputs: axisPlan.outputs, arraySize }
  }

  // Compose the command invocation.
  const cmdParts: string[] = [tool.command]
  const commandNodeData: ToolNodeData = {
    ...nodeData,
    analysisOptions: normalizeAnalysisOptions(tool, nodeData, { connectedPortIds: Object.keys(axisPlan.inputs) }),
  }
  const activeInputs = getActiveToolInputs(tool, commandNodeData)
  const optionDefs = getAnalysisOptionDefs(tool)
  const optionFilePorts = new Set(optionDefs.filter((def) => def.flag && (def.kind === 'file' || def.kind === 'compound')).map((def) => def.filePortId).filter(Boolean))

  for (const port of activeInputs) {
    if (optionFilePorts.has(port.id) || port.id.startsWith('custom_')) continue
    const val = axisPlan.inputs[port.id]
    if (!val) continue
    const flag = portFlag(tool, port)
    if (axisPlan.mode === 'array' && val.kind === 'array' && arrayInputAlignedWithPlan(axisPlan, val)) {
      if (isPlinkInputPort(tool, port)) {
        const firstPath = val.kind === 'array' ? val.paths[0] ?? '' : ''
        cmdParts.push(`${plinkInputFlag(firstPath)} ${plinkShellPrefixExpr(`i_${port.id}`, firstPath)}`)
      } else if (tool.command.toLowerCase() === 'regenie' && port.id === 'input') {
        const firstPath = val.kind === 'array' ? val.paths[0] ?? '' : ''
        const regenFlag = regenieGenotypeFlag(firstPath, port.fileType)
        const regenArg = regenFlag === '--bgen'
          ? `"$i_${port.id}"`
          : regenieShellPrefixExpr(`i_${port.id}`, firstPath)
        cmdParts.push(`${regenFlag} ${regenArg}`)
      } else {
        cmdParts.push(flag ? `${flag} "$i_${port.id}"` : `"$i_${port.id}"`)
      }
      continue
    }
    renderPortArgs(tool, port, val, cmdParts)
  }
  cmdParts.push(...emitAnalysisOptions(tool, commandNodeData, axisPlan, axisPlan.mode === 'array'))

  // Output paths — one output flag if present.
  // Convention: many tools use --out <prefix>; we fall back to `-o` then plain.
  // For V1, only emit an --out prefix for tools that declare a specific output
  // flag via a param named 'out'/'output'/'o'. Otherwise we rely on tool default.
  const outputSpec = buildOutputSpec(tool, axisPlan, slug, outputDir, axisPlan.mode === 'array')
  if (outputSpec) cmdParts.push(...outputSpec)

  lines.push(formatCommand(cmdParts))
  lines.push('')

  const outputs: Record<string, AxedValue> = axisPlan.outputs
  return { script: lines.join('\n'), outputs, arraySize }
}

function renderCommandTemplate(
  template: string,
  nodeData: ToolNodeData,
  axisPlan: AxisPlan,
  outputDir: string,
  slug: string,
  isArray: boolean,
): string {
  const firstInput = Object.values(axisPlan.inputs)[0]
  const input =
    !firstInput ? ''
    : isArray && firstInput.kind === 'array' ? '$i_input'
    : firstInput.kind === 'single' ? firstInput.path
    : firstInput.paths[0] ?? ''
  const output = resolveShellOutputPath(axisPlan, outputDir, slug, isArray) ?? `${outputDir}/${slug}.output`
  return template
    .replaceAll('{{input}}', shellQuote(input))
    .replaceAll('{{output}}', shellQuote(output))
    .replace(/\{\{param:([^}]+)\}\}/g, (_match, name) => {
      const value = nodeData.paramValues?.[String(name).trim()]
      return value == null || value === '' ? '' : shellQuote(String(value))
    })
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

function typedPhenotypeList(nodeData: ToolNodeData): string[] {
  return splitPlinkListValue(nodeData.paramValues?.phenotypes)
}

function typedAssocPhenotypeList(nodeData: ToolNodeData): string[] {
  return splitPlinkListValue(nodeData.paramValues?.['pheno-name'])
}

function renderPlinkAssociationBatchScript(opts: {
  tool: ToolDef
  nodeData: ToolNodeData
  axisPlan: AxisPlan
  outputDir: string
  slug: string
  typedPhenotypes: string[]
}): string[] {
  const { tool, nodeData, axisPlan, outputDir, slug, typedPhenotypes } = opts
  const genoPath = resolveSingleInput(axisPlan, 'input', false)
  const output = resolveFirstOutput(axisPlan, 'output', outputDir, slug, 'tsv', false)
  const genoFlag = plinkInputFlag(genoPath)
  const genoPrefix = plinkPrefixPath(genoPath)
  const commandNodeData: ToolNodeData = {
    ...nodeData,
    analysisOptions: normalizeAnalysisOptions(tool, nodeData, { connectedPortIds: Object.keys(axisPlan.inputs) }),
  }
  const commonArgs = [
    genoFlag,
    shellQuote(genoPrefix),
    ...emitAnalysisOptions(tool, commandNodeData, axisPlan, false)
      .filter((arg) => !arg.startsWith('--pheno-name')),
  ]

  const lines: string[] = []
  lines.push('# --- PLINK2 association phenotype array ---')
  lines.push(`SUMMARY=${shellQuote(output)}`)
  lines.push(`SUMMARY_LOCK=${shellQuote(`${output}.lock`)}`)
  lines.push(`mkdir -p ${shellQuote(outputDir)}`)
  lines.push(`PHENOS=(${typedPhenotypes.map(shellArg).join(' ')})`)
  lines.push('if [ "${#PHENOS[@]}" -eq 0 ]; then echo "No phenotypes selected" >&2; exit 1; fi')
  lines.push('')
  lines.push('run_one_pheno() {')
  lines.push('  local pheno="$1"')
  lines.push(`  local safe="$(printf '%s' "$pheno" | tr -c 'A-Za-z0-9_.-' '_')"`)
  lines.push(`  local prefix=${shellQuote(`${outputDir}/${slug}`)}."$safe"`)
  lines.push(`  ${tool.command} ${commonArgs.join(' ')} --pheno-name "$pheno" --out "$prefix"`)
  lines.push('  for result in "$prefix".*.glm.*; do')
  lines.push('    [ -s "$result" ] || continue')
  lines.push('    {')
  lines.push('      flock 9')
  lines.push('      if [ ! -s "$SUMMARY" ]; then')
  lines.push(`        awk -v pheno="$pheno" 'BEGIN{OFS="\\t"} NR==1{print "PHENO",$0; next} {print pheno,$0}' "$result" > "$SUMMARY"`)
  lines.push('      else')
  lines.push(`        awk -v pheno="$pheno" 'BEGIN{OFS="\\t"} NR>1{print pheno,$0}' "$result" >> "$SUMMARY"`)
  lines.push('      fi')
  lines.push('    } 9>"$SUMMARY_LOCK"')
  lines.push('  done')
  lines.push('}')
  lines.push('')
  lines.push('PHENO="${PHENOS[$SLURM_ARRAY_TASK_ID]}"')
  lines.push('run_one_pheno "$PHENO"')
  return lines
}

function renderPlinkPhewasScript(opts: {
  tool: ToolDef
  nodeData: ToolNodeData
  axisPlan: AxisPlan
  outputDir: string
  slug: string
  typedPhenotypes: string[]
  useSlurmArray: boolean
}): string[] {
  const { tool, nodeData, axisPlan, outputDir, slug, typedPhenotypes, useSlurmArray } = opts
  const genoPath = resolveSingleInput(axisPlan, 'input', false)
  const phenoPath = resolveSingleInput(axisPlan, 'pheno', false)
  const covarPath = resolveSingleInput(axisPlan, 'covar', false)
  const keepPath = resolveSingleInput(axisPlan, 'keep', false)
  const phenoListPath = resolveSingleInput(axisPlan, 'phenoList', false)
  const output = resolveFirstOutput(axisPlan, 'output', outputDir, slug, 'tsv', false)
  const genoFlag = plinkInputFlag(genoPath)
  const genoPrefix = plinkPrefixPath(genoPath)
  const commonArgs: string[] = [
    genoFlag, shellQuote(genoPrefix),
    '--pheno',
  ]
  if (booleanParam(nodeData, 'pheno-iid-only', false)) commonArgs.push('iid-only')
  commonArgs.push(shellQuote(phenoPath))
  if (covarPath) {
    commonArgs.push('--covar')
    if (booleanParam(nodeData, 'covar-iid-only', false)) commonArgs.push('iid-only')
    commonArgs.push(shellQuote(covarPath))
  }
  if (keepPath) commonArgs.push('--keep', shellQuote(keepPath))
  for (const paramName of ['one', 'glm', 'maf', 'geno', 'hwe', 'chr', 'covar-name']) {
    const param = tool.params.find((candidate) => candidate.name === paramName)
    if (!param) continue
    if (param.name === 'glm') {
      const values = plinkGlmValuesFromParams(nodeData)
      commonArgs.push(values.length > 0 ? `--glm ${values.map(shellQuote).join(' ')}` : '--glm')
      continue
    }
    appendParamArgs(tool, param, nodeData.paramValues?.[paramName], commonArgs)
  }
  for (const paramName of ['neg9-pheno-really-missing', 'no-input-missing-phenotype', 'input-missing-phenotype']) {
    const param = tool.params.find((candidate) => candidate.name === paramName)
    if (param) appendParamArgs(tool, param, nodeData.paramValues?.[paramName], commonArgs)
  }

  const lines: string[] = []
  lines.push('# --- PLINK2 PheWAS phenotype loop ---')
  lines.push(`SUMMARY=${shellQuote(output)}`)
  lines.push(`SUMMARY_LOCK=${shellQuote(`${output}.lock`)}`)
  lines.push(`mkdir -p ${shellQuote(outputDir)}`)
  if (phenoListPath) {
    lines.push(`mapfile -t PHENOS < ${shellQuote(phenoListPath)}`)
    lines.push('PHENOS=("${PHENOS[@]/%$\'\\r\'/}")')
    lines.push('PHENOS=("${PHENOS[@]//#*/}")')
    lines.push('FILTERED_PHENOS=()')
    lines.push('for pheno in "${PHENOS[@]}"; do')
    lines.push('  pheno="${pheno//,/ }"')
    lines.push('  for token in $pheno; do [ -n "$token" ] && FILTERED_PHENOS+=("$token"); done')
    lines.push('done')
    lines.push('PHENOS=("${FILTERED_PHENOS[@]}")')
  } else {
    lines.push(`PHENOS=(${typedPhenotypes.map(shellArg).join(' ')})`)
  }
  lines.push('if [ "${#PHENOS[@]}" -eq 0 ]; then echo "No phenotypes selected" >&2; exit 1; fi')
  lines.push('')
  lines.push('run_one_pheno() {')
  lines.push('  local pheno="$1"')
  lines.push(`  local safe="$(printf '%s' "$pheno" | tr -c 'A-Za-z0-9_.-' '_')"`)
  lines.push(`  local prefix=${shellQuote(`${outputDir}/${slug}`)}."$safe"`)
  lines.push(`  ${tool.command} ${commonArgs.join(' ')} --pheno-name "$pheno" --out "$prefix"`)
  lines.push('  for result in "$prefix".*.glm.*; do')
  lines.push('    [ -s "$result" ] || continue')
  lines.push('    {')
  lines.push('      flock 9')
  lines.push('      if [ ! -s "$SUMMARY" ]; then')
  lines.push(`        awk -v pheno="$pheno" 'BEGIN{OFS="\\t"} NR==1{print "PHENO",$0; next} {print pheno,$0}' "$result" > "$SUMMARY"`)
  lines.push('      else')
  lines.push(`        awk -v pheno="$pheno" 'BEGIN{OFS="\\t"} NR>1{print pheno,$0}' "$result" >> "$SUMMARY"`)
  lines.push('      fi')
  lines.push('    } 9>"$SUMMARY_LOCK"')
  lines.push('  done')
  lines.push('}')
  lines.push('')
  if (useSlurmArray) {
    lines.push('PHENO="${PHENOS[$SLURM_ARRAY_TASK_ID]}"')
    lines.push('run_one_pheno "$PHENO"')
  } else {
    lines.push('for PHENO in "${PHENOS[@]}"; do')
    lines.push('  run_one_pheno "$PHENO"')
    lines.push('done')
  }
  return lines
}

function renderCrossMapCommand(opts: {
  nodeData: ToolNodeData
  axisPlan: AxisPlan
  outputDir: string
  slug: string
  isArray: boolean
}): string {
  const { nodeData, axisPlan, outputDir, slug, isArray } = opts
  const input = resolveSingleInput(axisPlan, 'input', isArray)
  const chain = resolveSingleInput(axisPlan, 'chain', false)
  const reference = resolveSingleInput(axisPlan, 'reference', false)
  const output = resolveFirstOutput(axisPlan, 'output', outputDir, slug, 'any', isArray)
  const format = normalizeCrossMapFormat(stringParam(nodeData, 'format'), input)
  const parts = ['CrossMap', format]
  const chromid = stringParam(nodeData, 'chromid')
  if (chromid && ['bam', 'cram', 'sam'].includes(format)) parts.push('--chromid', shellQuote(chromid))
  parts.push(shellExpr(chain), shellExpr(input))
  if (format === 'vcf' || format === 'gvcf') {
    if (reference) parts.push(shellExpr(reference))
    parts.push(shellExpr(output))
  } else {
    parts.push(shellExpr(output))
  }
  if ((format === 'vcf' || format === 'gvcf') && nodeData.paramValues?.compress === true && output.endsWith('.gz')) {
    return `${parts.join(' \\\n  ')}\nif command -v tabix >/dev/null 2>&1; then tabix -f -p vcf ${shellExpr(output)}; fi`
  }
  return parts.join(' \\\n  ')
}

function normalizeCrossMapFormat(rawFormat: string, inputPath: string): string {
  if (rawFormat && rawFormat !== 'auto') return rawFormat.toLowerCase()
  const lower = inputPath.toLowerCase()
  if (lower.endsWith('.vcf') || lower.endsWith('.vcf.gz')) return 'vcf'
  if (lower.endsWith('.gvcf') || lower.endsWith('.gvcf.gz')) return 'gvcf'
  if (lower.endsWith('.bed') || lower.endsWith('.bed.gz')) return 'bed'
  if (lower.endsWith('.bam')) return 'bam'
  if (lower.endsWith('.cram')) return 'cram'
  if (lower.endsWith('.sam')) return 'sam'
  if (lower.endsWith('.gff') || lower.endsWith('.gff.gz')) return 'gff'
  if (lower.endsWith('.gtf') || lower.endsWith('.gtf.gz')) return 'gtf'
  return 'bed'
}

function renderBwaMemCommand(opts: {
  nodeData: ToolNodeData
  axisPlan: AxisPlan
  outputDir: string
  slug: string
  isArray: boolean
}): string {
  const { nodeData, axisPlan, outputDir, slug, isArray } = opts
  const reference = resolveSingleInput(axisPlan, 'reference', false)
  const reads1 = resolveSingleInput(axisPlan, 'reads1', isArray)
  const reads2 = resolveSingleInput(axisPlan, 'reads2', isArray)
  const output = resolveFirstOutput(axisPlan, 'output', outputDir, slug, 'sam', isArray)
  const parts = ['bwa mem']
  const threads = stringParam(nodeData, 'threads')
  if (threads) parts.push('-t', shellQuote(threads))
  const readGroup = stringParam(nodeData, 'read-group')
  if (readGroup) parts.push('-R', shellQuote(readGroup))
  if (booleanParam(nodeData, 'mark-short', true)) parts.push('-M')
  const minSeed = stringParam(nodeData, 'min-seed-length')
  if (minSeed) parts.push('-k', shellQuote(minSeed))
  parts.push(shellExpr(reference), shellExpr(reads1))
  if (reads2) parts.push(shellExpr(reads2))
  return `${parts.join(' \\\n  ')} \\\n  > ${shellExpr(output)}`
}

function renderFastqcCommand(opts: {
  nodeData: ToolNodeData
  axisPlan: AxisPlan
  outputDir: string
}): string {
  const { nodeData, axisPlan, outputDir } = opts
  const input = axisPlan.inputs.input
  const paths = input?.kind === 'multi' || input?.kind === 'array' ? input.paths : input ? [input.path] : []
  const parts = ['fastqc']
  const threads = stringParam(nodeData, 'threads')
  if (threads) parts.push('-t', shellQuote(threads))
  if (booleanParam(nodeData, 'nogroup', false)) parts.push('--nogroup')
  if (booleanParam(nodeData, 'extract', false)) parts.push('--extract')
  parts.push('-o', shellQuote(outputDir), ...paths.map(shellExpr))
  return parts.join(' \\\n  ')
}

function renderMultiqcCommand(opts: {
  nodeData: ToolNodeData
  axisPlan: AxisPlan
  outputDir: string
  slug: string
}): string {
  const { nodeData, axisPlan, outputDir, slug } = opts
  const input = axisPlan.inputs.input
  const paths = input?.kind === 'multi' || input?.kind === 'array' ? input.paths : input ? [input.path] : []
  const parts = ['multiqc']
  if (booleanParam(nodeData, 'force', true)) parts.push('-f')
  const title = stringParam(nodeData, 'title')
  if (title) parts.push('--title', shellQuote(title))
  const filename = stringParam(nodeData, 'filename') || `${slug}.multiqc_report.html`
  parts.push('--filename', shellQuote(filename), '-o', shellQuote(outputDir), ...(paths.length ? paths.map(shellExpr) : ['.']))
  return parts.join(' \\\n  ')
}

function renderBcftoolsViewCommand(opts: {
  nodeData: ToolNodeData
  axisPlan: AxisPlan
  outputDir: string
  slug: string
  isArray: boolean
}): string {
  const { nodeData, axisPlan, outputDir, slug, isArray } = opts
  const input = resolveSingleInput(axisPlan, 'input', isArray)
  const output = resolveFirstOutput(axisPlan, 'output', outputDir, slug, 'vcf', isArray)
  const parts = ['bcftools view']
  const outputType = stringParam(nodeData, 'output-type') || 'z'
  parts.push('-O', shellQuote(outputType), '-o', shellExpr(output))
  for (const [name, flag] of [
    ['regions', '-r'],
    ['targets', '-t'],
    ['samples', '-s'],
    ['types', '--types'],
    ['exclude', '-e'],
    ['include', '-i'],
  ] as const) {
    const value = stringParam(nodeData, name)
    if (value) parts.push(flag, shellQuote(value))
  }
  parts.push(shellExpr(input))
  return parts.join(' \\\n  ')
}

function renderBcftoolsMergeCommand(opts: {
  nodeData: ToolNodeData
  axisPlan: AxisPlan
  outputDir: string
  slug: string
}): string {
  const { nodeData, axisPlan, outputDir, slug } = opts
  const input = axisPlan.inputs.input
  const paths = input?.kind === 'multi' || input?.kind === 'array' ? input.paths : input ? [input.path] : []
  const output = resolveFirstOutput(axisPlan, 'output', outputDir, slug, 'vcf', false)
  const parts = ['bcftools merge']
  const outputType = stringParam(nodeData, 'output-type') || 'z'
  const merge = stringParam(nodeData, 'merge') || 'both'
  parts.push('-O', shellQuote(outputType), '-o', shellExpr(output), '-m', shellQuote(merge))
  if (booleanParam(nodeData, 'force-samples', false)) parts.push('--force-samples')
  if (booleanParam(nodeData, 'missing-to-ref', false)) parts.push('--missing-to-ref')
  parts.push(...paths.map(shellExpr))
  return parts.join(' \\\n  ')
}

function renderSamtoolsSortCommand(opts: {
  nodeData: ToolNodeData
  axisPlan: AxisPlan
  outputDir: string
  slug: string
  isArray: boolean
}): string {
  const { nodeData, axisPlan, outputDir, slug, isArray } = opts
  const input = resolveSingleInput(axisPlan, 'input', isArray)
  const output = resolveFirstOutput(axisPlan, 'output', outputDir, slug, 'bam', isArray)
  const parts = ['samtools sort']
  const threads = stringParam(nodeData, 'threads') || '4'
  const memory = stringParam(nodeData, 'memory') || '2G'
  parts.push(`-@ ${shellQuote(threads)}`, `-m ${shellQuote(memory)}`)
  if (booleanParam(nodeData, 'by-name', false)) parts.push('-n')
  parts.push(`-o ${shellExpr(output)}`, shellExpr(input))
  return parts.join(' \\\n  ')
}

function renderSamtoolsIndexCommand(opts: {
  nodeData: ToolNodeData
  axisPlan: AxisPlan
  outputDir: string
  slug: string
  isArray: boolean
}): string {
  const { nodeData, axisPlan, outputDir, slug, isArray } = opts
  const input = resolveSingleInput(axisPlan, 'input', isArray)
  const output = resolveFirstOutput(axisPlan, 'output', outputDir, slug, 'any', isArray) || `${input}.${booleanParam(nodeData, 'csi', false) ? 'csi' : 'bai'}`
  const parts = ['samtools index']
  const threads = stringParam(nodeData, 'threads') || '2'
  parts.push(`-@ ${shellQuote(threads)}`)
  if (booleanParam(nodeData, 'csi', false)) parts.push('-c')
  parts.push(shellExpr(input), shellExpr(output))
  return parts.join(' \\\n  ')
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
  const protocol = stringParam(nodeData, 'protocol') || 'refGeneWithVer,avsnp151'
  const operation = stringParam(nodeData, 'operation') || 'g,f'
  const arg = stringParam(nodeData, 'arg')
  const xref = stringParam(nodeData, 'xref')
  const nastring = stringParam(nodeData, 'nastring') || '.'
  const intronhgvs = stringParam(nodeData, 'intronhgvs')
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
  if (arg) parts.push('--arg', shellQuote(arg))
  if (xref) parts.push('--xref', shellQuote(xref))
  if (booleanParam(nodeData, 'polish', true)) parts.push('--polish')
  if (intronhgvs) parts.push('--intronhgvs', shellQuote(intronhgvs))
  if (booleanParam(nodeData, 'otherinfo', false)) parts.push('--otherinfo')
  if (nodeData.paramValues?.remove === true) parts.push('--remove')
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
  const species = stringParam(nodeData, 'species') || 'homo_sapiens'
  const assembly = stringParam(nodeData, 'assembly') || 'GRCh38'
  const fasta = stringParam(nodeData, 'fasta')
  const fork = stringParam(nodeData, 'fork') || '4'
  const bufferSize = stringParam(nodeData, 'buffer_size')

  const parts = [
    shellQuote(command),
    '--input_file', shellExpr(input),
    '--output_file', shellExpr(output),
    '--species', shellQuote(species),
    '--assembly', shellQuote(assembly),
    '--dir_cache', shellQuote(cache),
    '--fork', shellQuote(fork),
    '--force_overwrite',
  ]
  if (fasta) parts.push('--fasta', shellQuote(fasta))
  if (bufferSize) parts.push('--buffer_size', shellQuote(bufferSize))
  if (nodeData.paramValues?.cache !== false) parts.push('--cache')
  if (nodeData.paramValues?.offline !== false) parts.push('--offline')
  if (nodeData.paramValues?.everything === true) parts.push('--everything')
  if (nodeData.paramValues?.check_existing === true) parts.push('--check_existing')
  if (nodeData.paramValues?.af_gnomad === true) parts.push('--af_gnomad')
  if (booleanParam(nodeData, 'symbol', false)) parts.push('--symbol')
  if (booleanParam(nodeData, 'canonical', false)) parts.push('--canonical')
  if (booleanParam(nodeData, 'mane', false)) parts.push('--mane')
  if (booleanParam(nodeData, 'tsl', false)) parts.push('--tsl')
  if (booleanParam(nodeData, 'appris', false)) parts.push('--appris')
  if (booleanParam(nodeData, 'hgvs', false)) parts.push('--hgvs')
  if (booleanParam(nodeData, 'protein', false)) parts.push('--protein')
  if (booleanParam(nodeData, 'biotype', false)) parts.push('--biotype')
  if (booleanParam(nodeData, 'variant_class', false)) parts.push('--variant_class')
  if (booleanParam(nodeData, 'numbers', false)) parts.push('--numbers')
  if (booleanParam(nodeData, 'domains', false)) parts.push('--domains')
  if (booleanParam(nodeData, 'gene_phenotype', false)) parts.push('--gene_phenotype')
  if (booleanParam(nodeData, 'pubmed', false)) parts.push('--pubmed')
  const sift = stringParam(nodeData, 'sift')
  if (sift) parts.push('--sift', shellQuote(sift))
  const polyphen = stringParam(nodeData, 'polyphen')
  if (polyphen) parts.push('--polyphen', shellQuote(polyphen))
  if (booleanParam(nodeData, 'pick', false)) parts.push('--pick')
  if (booleanParam(nodeData, 'pick_allele', false)) parts.push('--pick_allele')
  const pickOrder = stringParam(nodeData, 'pick_order')
  if (pickOrder) parts.push('--pick_order', shellQuote(pickOrder))
  const nearest = stringParam(nodeData, 'nearest')
  if (nearest) parts.push('--nearest', shellQuote(nearest))
  if (booleanParam(nodeData, 'coding_only', false)) parts.push('--coding_only')
  if (booleanParam(nodeData, 'no_intergenic', false)) parts.push('--no_intergenic')
  if (booleanParam(nodeData, 'check_ref', false)) parts.push('--check_ref')
  if (booleanParam(nodeData, 'safe', false)) parts.push('--safe')
  if (booleanParam(nodeData, 'no_stats', false)) parts.push('--no_stats')
  const plugin = stringParam(nodeData, 'plugin')
  if (plugin) parts.push('--plugin', shellQuote(plugin))
  return parts.join(' \\\n  ')
}

function stringParam(nodeData: ToolNodeData, name: string): string {
  const value = nodeData.paramValues?.[name]
  return value === undefined || value === null ? '' : String(value).trim()
}

function booleanParam(nodeData: ToolNodeData, name: string, fallback = false): boolean {
  const value = nodeData.paramValues?.[name]
  return value === undefined ? fallback : Boolean(value)
}

interface ArrayRuntime {
  arraySpec: string
  setupLines: string[]
}

function buildArrayRuntime(axisPlan: AxisPlan): ArrayRuntime {
  const keys = axisPlan.keys ?? []
  const axedPortId = axisPlan.arrayPortId!
  const runtimeInputs = Object.entries(axisPlan.inputs)
    .filter((entry): entry is [string, Extract<AxedValue, { kind: 'array' }>] => {
      const value = entry[1]
      return value.kind === 'array' && arrayInputAlignedWithPlan(axisPlan, value)
    })
  const axedInput = runtimeInputs.find(([portId]) => portId === axedPortId)?.[1]
  if (!axedInput) {
    throw new Error(`axisPlan says array but input on port ${axedPortId} is not array`)
  }

  if (keysAreSlurmTaskIds(keys)) {
    const lines = [`KEY="$SLURM_ARRAY_TASK_ID"`]
    for (const [portId, input] of runtimeInputs) {
      const template = templateMatchesPaths(input.pathTemplate, input.paths, keys)
        ? input.pathTemplate
        : inferKeyedPathTemplate(input.paths, keys)
      if (template) {
        lines.push(`i_${portId}=${shellTemplateExpr(template)}`)
      } else {
        lines.push(`declare -A INPUT_${portId}=(`)
        for (let i = 0; i < keys.length; i++) {
          lines.push(`  [${keys[i]}]=${shellArg(input.paths[i])}`)
        }
        lines.push(')')
        lines.push(`i_${portId}="\${INPUT_${portId}[$KEY]}"`)
      }
    }
    return { arraySpec: compactNumericArraySpec(keys), setupLines: lines }
  }

  const setupLines = [`KEYS=(${keys.map(shellArg).join(' ')})`, `KEY="\${KEYS[$SLURM_ARRAY_TASK_ID]}"`]
  for (const [portId, input] of runtimeInputs) {
    setupLines.push(`INPUT_${portId}=(${input.paths.map(shellArg).join(' ')})`)
    setupLines.push(`i_${portId}="\${INPUT_${portId}[$SLURM_ARRAY_TASK_ID]}"`)
  }
  return {
    arraySpec: `0-${keys.length - 1}`,
    setupLines,
  }
}

function arrayInputAlignedWithPlan(axisPlan: AxisPlan, value: Extract<AxedValue, { kind: 'array' }>): boolean {
  if (axisPlan.mode !== 'array') return false
  const keys = axisPlan.keys ?? []
  return value.axis === axisPlan.axis
    && value.keys.length === keys.length
    && value.keys.every((key, index) => key === keys[index])
}

function shellTemplateExpr(template: string): string {
  return `"${template.replace(/["\\`]/g, '\\$&')}"`
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
  if (cmdId === 'plink2' || cmdId === 'plink' || cmdId === 'regenie') {
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

  if (param.flag && isRegenieListParam(tool, param.name)) {
    const values = splitPlinkListValue(raw)
    if (values.length > 0) out.push(`${param.flag} ${shellQuote(values.join(','))}`)
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

function isRegenieListParam(tool: ToolDef, name: string): boolean {
  return tool.command.toLowerCase() === 'regenie' && (name === 'phenoColList' || name === 'covarColList')
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

function plinkGlmValuesFromParams(nodeData: ToolNodeData): string[] {
  const values = normalizePlinkGlmValue(nodeData.paramValues?.glm)
  for (const modifier of ['allow-no-covars', 'omit-ref', 'skip-invalid-pheno']) {
    if (nodeData.paramValues?.[modifier] === true && !values.includes(modifier)) values.push(modifier)
  }
  if (!values.includes('hide-covar')) values.push('hide-covar')
  return values
}

function splitPlinkListValue(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((value) => value.trim()).filter(Boolean)
  return String(raw)
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean)
}

function emitAnalysisOptions(
  tool: ToolDef,
  nodeData: ToolNodeData,
  axisPlan: AxisPlan,
  isArray: boolean,
): string[] {
  const parts: string[] = []
  const defs = getAnalysisOptionDefs(tool)
  const defsById = new Map(defs.map((def) => [def.id, def]))
  const options = normalizeAnalysisOptions(tool, nodeData).filter((option) => option.enabled)

  for (const option of options) {
    const def = defsById.get(option.optionId)
    if (!def) {
      const flag = option.customFlag?.trim()
      if (!flag) continue
      if (option.customInputKind === 'file') {
        const emitted = emitFileInputFlag(flag, option.source ?? option.value, undefined, axisPlan, isArray)
        if (emitted) parts.push(emitted)
      } else {
        const emitted = emitValueFlag(flag, option.value, false, true)
        if (emitted) parts.push(emitted)
      }
      continue
    }
    if (!def.flag) continue

    if (tool.id === 'plink2.assoc' && (def.id === 'pheno-iid-only' || def.id === 'covar-iid-only')) {
      continue
    }
    if (tool.id === 'plink2.assoc' && def.id === 'glm') {
      parts.push(emitAnalysisGlmFlag(option))
      continue
    }
    if (tool.id === 'plink2.score' && def.id === 'score') {
      const emitted = emitAnalysisScoreFlag(def.flag, option, axisPlan, isArray)
      if (emitted) parts.push(emitted)
      continue
    }

    if (def.kind === 'switch') {
      parts.push(def.flag)
      continue
    }
    if (def.kind === 'file') {
      const flag = plinkAssocFileInputFlag(def.id, def.flag, options)
      const emitted = emitFileInputFlag(flag, option.source ?? option.value, def.filePortId ?? def.sourcePortId, axisPlan, isArray)
      if (emitted) parts.push(emitted)
      continue
    }
    if (def.kind === 'list' || def.multiValue) {
      const emitted = emitValueFlag(def.flag, option.source ?? option.value, true)
      if (emitted) parts.push(emitted)
      continue
    }
    const emitted = emitValueFlag(def.flag, option.source ?? option.value)
    if (emitted) parts.push(emitted)
  }

  return parts
}

function analysisOptionEnabled(options: AnalysisOptionState[], id: string): boolean {
  return options.some((option) => option.optionId === id || option.subOptions?.[id]?.enabled)
}

function plinkAssocFileInputFlag(id: string, flag: string, options: AnalysisOptionState[]): string {
  if (id === 'pheno' && analysisOptionEnabled(options, 'pheno-iid-only')) return `${flag} iid-only`
  if (id === 'covar' && analysisOptionEnabled(options, 'covar-iid-only')) return `${flag} iid-only`
  return flag
}

function emitAnalysisGlmFlag(option: AnalysisOptionState): string {
  const mode = typeof option.value === 'string' && option.value.trim() ? option.value.trim() : 'hide-covar'
  const extras = mode === 'hide-covar' ? ['hide-covar'] : [mode]
  for (const id of ['hide-covar', 'allow-no-covars', 'omit-ref', 'skip-invalid-pheno']) {
    if (option.subOptions?.[id]?.enabled) extras.push(id)
  }
  return `--glm ${[...new Set(extras)].join(' ')}`
}

function emitAnalysisScoreFlag(
  flag: string,
  option: AnalysisOptionState,
  axisPlan: AxisPlan,
  isArray: boolean,
): string | null {
  const fileArg = resolveFileInputArg(option.source ?? option.value, 'score', axisPlan, isArray)
  if (!fileArg) return null
  const extras: string[] = []
  const scoreCols = emitValueFlag('', option.subOptions?.['score-col-nums']?.value, true)?.trim()
  if (scoreCols) extras.push(scoreCols)
  for (const id of ['header', 'center', 'variance-standardize', 'no-mean-imputation', 'ignore-dup-ids']) {
    if (option.subOptions?.[id]?.enabled) extras.push(id)
  }
  return `${flag} ${fileArg}${extras.length ? ` ${extras.join(' ')}` : ''}`
}

function emitFlagBlocks(
  tool: ToolDef,
  nodeData: ToolNodeData,
  axisPlan: AxisPlan,
  isArray: boolean,
): string[] {
  const parts: string[] = []
  const blocks = activeFlagBlocks(tool.id, nodeData.flagBlocks)
  const byId = new Map(blocks.map((block) => [block.flagId, block]))

  for (const block of blocks) {
    const def = getFlagDef(tool.id, block.flagId)
    if (!def) continue
    const renderedFlag = blockFlag(tool.id, block)
    if (!renderedFlag) continue

    if (tool.id === 'plink2.assoc' && ['hide-covar', 'allow-no-covars', 'omit-ref', 'skip-invalid-pheno'].includes(def.id)) {
      continue
    }

    if (tool.id === 'plink2.assoc' && ['pheno-iid-only', 'covar-iid-only'].includes(def.id)) {
      continue
    }

    if (tool.id === 'plink2.score' && ['score-col-nums', 'header', 'center', 'variance-standardize', 'no-mean-imputation', 'ignore-dup-ids'].includes(def.id)) {
      continue
    }

    if (tool.id === 'plink2.assoc' && def.id === 'glm') {
      const emitted = emitAssocGlmFlag(block.value, byId)
      if (emitted) parts.push(emitted)
      continue
    }

    if (tool.id === 'plink2.score' && def.id === 'score') {
      const emitted = emitScoreFlag(def, block.value, axisPlan, isArray, byId)
      if (emitted) parts.push(emitted)
      continue
    }

    if (def.kind === 'toggle') {
      parts.push(renderedFlag)
      continue
    }

    if (def.kind === 'fileInput') {
      const flag = tool.id === 'plink2.assoc'
        ? plinkAssocFileInputFlagFromBlocks(def.id, renderedFlag, byId)
        : renderedFlag
      const emitted = emitFileInputFlag(flag, block.value, def.sourcePortId, axisPlan, isArray)
      if (emitted) parts.push(emitted)
      continue
    }

    if (block.flagId === CUSTOM_FLAG_ID) {
      const emitted = block.customInputKind === 'file'
        ? emitFileInputFlag(renderedFlag, block.value, undefined, axisPlan, isArray)
        : emitValueFlag(renderedFlag, block.value, false, true)
      if (emitted) parts.push(emitted)
      else parts.push(renderedFlag)
      continue
    }

    const emitted = emitValueFlag(renderedFlag, block.value, def.multiValue)
    if (emitted) parts.push(emitted)
  }

  return parts
}

function plinkAssocFileInputFlagFromBlocks(id: string, flag: string, byId: Map<string, ToolFlagBlock>): string {
  if (id === 'pheno' && byId.get('pheno-iid-only')?.enabled) return `${flag} iid-only`
  if (id === 'covar' && byId.get('covar-iid-only')?.enabled) return `${flag} iid-only`
  return flag
}

function emitAssocGlmFlag(
  value: unknown,
  byId: Map<string, ToolFlagBlock>,
): string | null {
  const extras: string[] = []
  const mode = typeof value === 'string' && value.trim()
    ? value.trim()
    : 'hide-covar'
  if (mode === 'hide-covar') extras.push('hide-covar')
  else extras.push(mode)
  for (const modifier of ['hide-covar', 'allow-no-covars', 'omit-ref', 'skip-invalid-pheno']) {
    if (byId.get(modifier)?.enabled) extras.push(modifier)
  }
  return `--glm${extras.length ? ` ${[...new Set(extras)].join(' ')}` : ''}`
}

function emitScoreFlag(
  def: NonNullable<ReturnType<typeof getFlagDef>>,
  value: unknown,
  axisPlan: AxisPlan,
  isArray: boolean,
  byId: Map<string, ToolFlagBlock>,
): string | null {
  const fileArg = resolveFileInputArg(value, def.sourcePortId, axisPlan, isArray)
  if (!fileArg) return null
  const extras: string[] = []
  const scoreCols = emitValueFlag('', byId.get('score-col-nums')?.value, true)?.trim()
  if (scoreCols) extras.push(scoreCols)
  for (const modifier of ['header', 'center', 'variance-standardize', 'no-mean-imputation', 'ignore-dup-ids']) {
    if (byId.get(modifier)?.enabled) extras.push(modifier)
  }
  return `${def.flag} ${fileArg}${extras.length ? ` ${extras.join(' ')}` : ''}`
}

function emitFileInputFlag(
  flag: string,
  value: unknown,
  sourcePortId: string | undefined,
  axisPlan: AxisPlan,
  isArray: boolean,
): string | null {
  const arg = resolveFileInputArg(value, sourcePortId, axisPlan, isArray)
  return arg ? `${flag} ${arg}` : null
}

function resolveFileInputArg(
  value: unknown,
  sourcePortId: string | undefined,
  axisPlan: AxisPlan,
  isArray: boolean,
): string | null {
  if (value && typeof value === 'object' && 'kind' in (value as Record<string, unknown>)) {
    const source = value as { kind?: string; value?: string; portId?: string }
    if (source.kind === 'upstream-file') {
      const portId = sourcePortId ?? source.portId ?? 'input'
      const upstream = axisPlan.inputs[portId]
      if (!upstream) return null
      if (isArray && upstream.kind === 'array' && arrayInputAlignedWithPlan(axisPlan, upstream)) return `"${`$i_${portId}`}"`
      if (upstream.kind === 'single') return shellQuote(upstream.path)
      return upstream.paths[0] ? shellQuote(upstream.paths[0]) : null
    }
    if (source.value?.trim()) return shellQuote(source.value.trim())
    return null
  }
  if (value === undefined || value === null || value === '') return null
  return shellQuote(String(value))
}

function emitValueFlag(flag: string, value: unknown, multiValue = false, allowBareFlag = false): string | null {
  if (value && typeof value === 'object' && 'kind' in (value as Record<string, unknown>)) {
    const source = value as { value?: string }
    if (!source.value?.trim()) return allowBareFlag ? flag : null
    const rendered = multiValue
      ? splitPlinkListValue(source.value).map(shellQuote).join(' ')
      : shellQuote(source.value.trim())
    return flag ? `${flag} ${rendered}` : rendered
  }
  if (value === undefined || value === null || value === '') return allowBareFlag ? flag : null
  if (multiValue) {
    const rendered = splitPlinkListValue(value).map(shellQuote).join(' ')
    return rendered ? (flag ? `${flag} ${rendered}` : rendered) : null
  }
  return flag ? `${flag} ${shellQuote(String(value))}` : shellQuote(String(value))
}

function renderPortArgs(tool: ToolDef, port: ToolPort, val: AxedValue, out: string[]): void {
  if (tool.command.toLowerCase() === 'regenie') {
    const paths: string[] = val.kind === 'single' ? [val.path]
      : val.kind === 'multi' ? val.paths
      : val.paths
    for (const path of paths) {
      if (port.id === 'input') {
        const flag = regenieGenotypeFlag(path, port.fileType)
        out.push(`${flag} ${shellQuote(regenieGenotypeArg(path, flag))}`)
      } else if (port.id === 'pheno') {
        out.push(`--phenoFile ${shellQuote(path)}`)
      } else if (port.id === 'covar') {
        out.push(`--covarFile ${shellQuote(path)}`)
      } else if (port.id === 'pred') {
        out.push(`--pred ${shellQuote(path)}`)
      } else {
        const flag = portFlag(tool, port)
        out.push(flag ? `${flag} ${shellQuote(path)}` : shellQuote(path))
      }
    }
    return
  }

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

function regenieGenotypeFlag(path: string, fileType: FileType): '--bed' | '--pgen' | '--bgen' {
  if (fileType === 'bgen' || /\.bgen$/i.test(path)) return '--bgen'
  if (fileType === 'pgen' || /\.(pgen|pvar|psam)$/i.test(path)) return '--pgen'
  return '--bed'
}

function regenieGenotypeArg(path: string, flag: '--bed' | '--pgen' | '--bgen'): string {
  if (flag === '--bgen') return path
  if (/\.(bed|bim|fam|pgen|pvar|psam)$/i.test(path)) return stripExt(path)
  return path
}

function regenieShellPrefixExpr(variableName: string, samplePath: string): string {
  if (/\.bed$/i.test(samplePath)) return `"${'${'}${variableName}%.bed}"`
  if (/\.(pgen|pvar|psam)$/i.test(samplePath)) return `"${'${'}${variableName}%.*}"`
  return `"$${variableName}"`
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

  const lines: string[] = buildSlurmHeader({
    slug,
    logDir,
    cpus,
    memGB,
    timeH,
    account,
    partition,
    arraySpec: isArray ? `0-${arraySize! - 1}` : undefined,
    jobSuffix: 'transform',
  })
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
  if (canUseAwkTransformFastPath(transformData, inputPaths, connectionDefaults)) {
    lines.push(...renderTransformAwkScript(transformData))
  } else {
    lines.push(...renderTransformPythonScript(transformData))
  }
  lines.push('')
  return { script: lines.join('\n'), outputs: axisPlan.outputs, arraySize }
}

function canUseAwkTransformFastPath(
  transformData: TransformNodeData,
  inputPaths: string[],
  connectionDefaults?: ConnectionDefaults,
): boolean {
  if (!connectionDefaults?.shellCapabilities?.awk) return false
  if (transformData.preset) return false
  if (transformData.fileType === 'csv') return false
  if (inputPaths.some((path) => path.toLowerCase().endsWith('.csv'))) return false
  return (transformData.filters ?? []).every((rule) => rule.op !== 'regex')
}

function renderTransformAwkScript(transformData: TransformNodeData): string[] {
  const selectedColumns = transformData.selectedColumns ?? []
  const filters = transformData.filters ?? []
  const renames = transformData.renames ?? []

  const lines: string[] = []
  lines.push('# Fast path: awk handles simple TSV/TXT projection and filtering.')
  lines.push(`awk -F '\\t' -v OFS='\\t' -f - "$IN" > "$OUT" <<'AWK'`)
  lines.push('BEGIN {')
  lines.push(`  selectedCount = ${selectedColumns.length}`)
  selectedColumns.forEach((column, idx) => {
    lines.push(`  selectedNames[${idx + 1}] = ${awkStringLiteral(column)}`)
  })
  lines.push(`  renameCount = ${renames.length}`)
  renames.forEach((rename, idx) => {
    lines.push(`  renameFrom[${idx + 1}] = ${awkStringLiteral(rename.from)}`)
    lines.push(`  renameTo[${idx + 1}] = ${awkStringLiteral(rename.to || rename.from)}`)
  })
  lines.push(`  filterCount = ${filters.length}`)
  filters.forEach((filter, idx) => {
    lines.push(`  filterColumn[${idx + 1}] = ${awkStringLiteral(filter.column)}`)
    lines.push(`  filterOp[${idx + 1}] = ${awkStringLiteral(filter.op)}`)
    lines.push(`  filterValue[${idx + 1}] = ${awkStringLiteral(filter.value ?? '')}`)
    lines.push(`  filterJoin[${idx + 1}] = ${awkStringLiteral(filter.join ?? 'and')}`)
  })
  lines.push('}')
  lines.push('function trim(value) {')
  lines.push('  gsub(/^[ \\t\\r\\n]+|[ \\t\\r\\n]+$/, "", value)')
  lines.push('  return value')
  lines.push('}')
  lines.push('function is_number(value) {')
  lines.push('  return value ~ /^[-+]?(([0-9]+(\\.[0-9]*)?)|(\\.[0-9]+))([eE][-+]?[0-9]+)?$/')
  lines.push('}')
  lines.push('function matches_rule(raw, op, value, lhs, rhs) {')
  lines.push('  if (op == "contains") return index(tolower(raw), tolower(value)) > 0')
  lines.push('  if (op == "equals") return raw == value')
  lines.push('  if (op == "notEquals") return raw != value')
  lines.push('  if (op == "notEmpty") return trim(raw) != ""')
  lines.push('  if (!is_number(raw) || !is_number(value)) return 0')
  lines.push('  lhs = raw + 0')
  lines.push('  rhs = value + 0')
  lines.push('  if (op == "gt") return lhs > rhs')
  lines.push('  if (op == "gte") return lhs >= rhs')
  lines.push('  if (op == "lt") return lhs < rhs')
  lines.push('  if (op == "lte") return lhs <= rhs')
  lines.push('  return 0')
  lines.push('}')
  lines.push('function row_matches(   idx, raw, current, result, joiner, i) {')
  lines.push('  if (filterCount == 0) return 1')
  lines.push('  idx = colIndex[filterColumn[1]]')
  lines.push('  raw = (idx > 0 && idx <= NF) ? $idx : ""')
  lines.push('  result = matches_rule(raw, filterOp[1], filterValue[1])')
  lines.push('  for (i = 2; i <= filterCount; i++) {')
  lines.push('    idx = colIndex[filterColumn[i]]')
  lines.push('    raw = (idx > 0 && idx <= NF) ? $idx : ""')
  lines.push('    current = matches_rule(raw, filterOp[i], filterValue[i])')
  lines.push('    joiner = filterJoin[i]')
  lines.push('    if (joiner == "or") result = result || current')
  lines.push('    else result = result && current')
  lines.push('  }')
  lines.push('  return result')
  lines.push('}')
  lines.push('NR == 1 {')
  lines.push('  sourceCount = NF')
  lines.push('  for (i = 1; i <= NF; i++) {')
  lines.push('    sourceField[i] = $i')
  lines.push('    colIndex[$i] = i')
  lines.push('  }')
  lines.push('  for (i = 1; i <= renameCount; i++) renameMap[renameFrom[i]] = renameTo[i]')
  lines.push('  activeCount = 0')
  lines.push('  if (selectedCount > 0) {')
  lines.push('    for (i = 1; i <= selectedCount; i++) {')
  lines.push('      idx = colIndex[selectedNames[i]]')
  lines.push('      if (idx > 0) {')
  lines.push('        activeCount++')
  lines.push('        activeIndex[activeCount] = idx')
  lines.push('        activeName[activeCount] = selectedNames[i]')
  lines.push('      }')
  lines.push('    }')
  lines.push('  }')
  lines.push('  if (activeCount == 0) {')
  lines.push('    for (i = 1; i <= sourceCount; i++) {')
  lines.push('      activeCount++')
  lines.push('      activeIndex[activeCount] = i')
  lines.push('      activeName[activeCount] = sourceField[i]')
  lines.push('    }')
  lines.push('  }')
  lines.push('  for (i = 1; i <= activeCount; i++) {')
  lines.push('    header = activeName[i]')
  lines.push('    outName = (header in renameMap) ? renameMap[header] : header')
  lines.push('    printf "%s%s", outName, (i < activeCount ? OFS : ORS)')
  lines.push('  }')
  lines.push('  next')
  lines.push('}')
  lines.push('{')
  lines.push('  if (!row_matches()) next')
  lines.push('  for (i = 1; i <= activeCount; i++) {')
  lines.push('    idx = activeIndex[i]')
  lines.push('    value = (idx > 0 && idx <= NF) ? $idx : ""')
  lines.push('    printf "%s%s", value, (i < activeCount ? OFS : ORS)')
  lines.push('  }')
  lines.push('}')
  lines.push('AWK')
  return lines
}

function renderTransformPythonScript(transformData: TransformNodeData): string[] {
  if (transformData.preset) return renderPresetTransformPythonScript(transformData)
  const lines: string[] = []
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
  lines.push('def matches_filters(row, rules):')
  lines.push('    if not rules: return True')
  lines.push('    result = match(row, rules[0])')
  lines.push('    for rule in rules[1:]:')
  lines.push('        current = match(row, rule)')
  lines.push('        if rule.get("join", "and") == "or":')
  lines.push('            result = result or current')
  lines.push('        else:')
  lines.push('            result = result and current')
  lines.push('    return result')
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
  lines.push('        if matches_filters(row, config.get("filters", [])):')
  lines.push('            writer.writerow({rename.get(c, c): row.get(c, "") for c in fields})')
  lines.push('PY')
  return lines
}

function renderPresetTransformPythonScript(transformData: TransformNodeData): string[] {
  const lines: string[] = []
  lines.push(`python3 - <<'PY' "$IN" "$OUT"`)
  lines.push('import csv, json, math, sys')
  lines.push('in_path, out_path = sys.argv[1], sys.argv[2]')
  lines.push(`config = json.loads(${JSON.stringify(JSON.stringify({
    preset: transformData.preset,
    presetConfig: transformData.presetConfig ?? {},
    roleMappings: transformData.roleMappings ?? {},
    selectedColumns: transformData.selectedColumns ?? [],
    renames: transformData.renames ?? [],
    fileType: transformData.fileType,
  }))})`)
  lines.push('def delimiter(path, preferred):')
  lines.push('    if preferred == "csv" or path.lower().endswith(".csv"): return ","')
  lines.push('    return "\\t"')
  lines.push('def mapped(role_key):')
  lines.push('    mapping = (config.get("roleMappings") or {}).get(role_key) or {}')
  lines.push('    return mapping.get("column") or ""')
  lines.push('def selected_fields(source_fields):')
  lines.push('    requested = [c for c in config.get("selectedColumns", []) if c in source_fields]')
  lines.push('    return requested or list(source_fields)')
  lines.push('def rename_map():')
  lines.push('    return {r.get("from"): (r.get("to") or r.get("from")) for r in config.get("renames", [])}')
  lines.push('preset = config.get("preset")')
  lines.push('in_delim = delimiter(in_path, "")')
  lines.push('out_delim = delimiter(out_path, config.get("fileType", ""))')
  lines.push('with open(in_path, newline="") as src, open(out_path, "w", newline="") as dst:')
  lines.push('    reader = csv.DictReader(src, delimiter=in_delim)')
  lines.push('    source_fields = reader.fieldnames or []')
  lines.push('    rename = rename_map()')
  lines.push('    if preset == "cohort-filter":')
  lines.push('        sample_col = mapped("sample_id")')
  lines.push('        family_col = mapped("family_id")')
  lines.push('        cohort_col = mapped("cohort")')
  lines.push('        match_value = str((config.get("presetConfig") or {}).get("matchValue", ""))')
  lines.push('        artifact_mode = str((config.get("presetConfig") or {}).get("artifactMode", "filtered-table"))')
  lines.push('        if artifact_mode == "keep-file":')
  lines.push('            writer = csv.writer(dst, delimiter="\\t", lineterminator="\\n")')
  lines.push('            for row in reader:')
  lines.push('                if row.get(cohort_col, "") != match_value:')
  lines.push('                    continue')
  lines.push('                iid = row.get(sample_col, "").strip()')
  lines.push('                if not iid:')
  lines.push('                    continue')
  lines.push('                fid = row.get(family_col, "").strip() or iid')
  lines.push('                writer.writerow([fid, iid])')
  lines.push('        else:')
  lines.push('            fields = selected_fields(source_fields)')
  lines.push('            out_fields = [rename.get(c, c) for c in fields]')
  lines.push('            writer = csv.DictWriter(dst, fieldnames=out_fields, delimiter=out_delim, extrasaction="ignore", lineterminator="\\n")')
  lines.push('            writer.writeheader()')
  lines.push('            for row in reader:')
  lines.push('                if row.get(cohort_col, "") != match_value:')
  lines.push('                    continue')
  lines.push('                writer.writerow({rename.get(c, c): row.get(c, "") for c in fields})')
  lines.push('    elif preset == "gwas-pval-filter":')
  lines.push('        p_col = mapped("p_value")')
  lines.push('        threshold = float((config.get("presetConfig") or {}).get("threshold", 5e-8))')
  lines.push('        fields = selected_fields(source_fields)')
  lines.push('        out_fields = [rename.get(c, c) for c in fields]')
  lines.push('        writer = csv.DictWriter(dst, fieldnames=out_fields, delimiter=out_delim, extrasaction="ignore", lineterminator="\\n")')
  lines.push('        writer.writeheader()')
  lines.push('        for row in reader:')
  lines.push('            try:')
  lines.push('                value = float(row.get(p_col, ""))')
  lines.push('            except ValueError:')
  lines.push('                continue')
  lines.push('            if value <= threshold:')
  lines.push('                writer.writerow({rename.get(c, c): row.get(c, "") for c in fields})')
  lines.push('    elif preset == "clump-lead-list":')
  lines.push('        variant_col = mapped("variant_id")')
  lines.push('        for row in reader:')
  lines.push('            value = row.get(variant_col, "").strip()')
  lines.push('            if value:')
  lines.push('                dst.write(value + "\\n")')
  lines.push('    elif preset == "plink-score-file":')
  lines.push('        variant_col = mapped("variant_id")')
  lines.push('        allele_col = mapped("effect_allele")')
  lines.push('        weight_col = mapped("weight")')
  lines.push('        weight_transform = str((config.get("presetConfig") or {}).get("weightTransform", "identity"))')
  lines.push('        writer = csv.writer(dst, delimiter="\\t", lineterminator="\\n")')
  lines.push('        writer.writerow(["ID", "A1", "SCORE"])')
  lines.push('        for row in reader:')
  lines.push('            variant = row.get(variant_col, "").strip()')
  lines.push('            allele = row.get(allele_col, "").strip()')
  lines.push('            weight_raw = row.get(weight_col, "").strip()')
  lines.push('            if not variant or not allele or not weight_raw:')
  lines.push('                continue')
  lines.push('            weight = weight_raw')
  lines.push('            if weight_transform == "log":')
  lines.push('                numeric = float(weight_raw)')
  lines.push('                if numeric <= 0:')
  lines.push('                    continue')
  lines.push('                weight = str(math.log(numeric))')
  lines.push('            writer.writerow([variant, allele, weight])')
  lines.push('    else:')
  lines.push('        raise SystemExit(f"Unsupported preset transform: {preset}")')
  lines.push('PY')
  return lines
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
    : strategy === 'tabular-inner' || strategy === 'tabular-outer' || strategy === 'tabular-left' ? '.tsv'
    : strategy === 'tsv-concat-header' ? '.tsv'
    : '.txt'
  const outPath = opts.outputPath ?? `${outputDir}/${slug}.output${outExt}`

  const lines: string[] = buildSlurmHeader({
    slug,
    logDir,
    cpus,
    memGB,
    timeH,
    account,
    partition,
    jobSuffix: 'merge',
  })
  lines.push('')
  lines.push('set -euo pipefail')
  lines.push('')
  if (connectionDefaults?.modulePreamble) lines.push(connectionDefaults.modulePreamble)
  if (mergeData.moduleOverride?.trim()) lines.push(`module load ${mergeData.moduleOverride.trim()}`)
  else if (strategy === 'bcftools-concat') lines.push('module load bcftools/1.19')
  else if (strategy === 'plink-pmerge-list') lines.push('module load plink/2.00a3')
  lines.push('')
  lines.push(`mkdir -p ${shellQuote(outputDir)}`)
  lines.push('')
  lines.push(`INPUTS=(${inputs.map(shellArg).join(' ')})`)
  lines.push('if [ "${#INPUTS[@]}" -eq 0 ]; then echo "No merge inputs were provided" >&2; exit 1; fi')
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
      lines.push(`: > ${shellQuote(listFile)}`)
      lines.push('for input in "${INPUTS[@]}"; do')
      lines.push(`  case "$input" in`)
      lines.push(`    *.pgen|*.pvar|*.psam|*.bed|*.bim|*.fam) printf '%s\\n' "\${input%.*}" >> ${shellQuote(listFile)} ;;`)
      lines.push(`    *) printf '%s\\n' "$input" >> ${shellQuote(listFile)} ;;`)
      lines.push('  esac')
      lines.push('done')
      lines.push(`plink2 --pmerge-list ${shellQuote(listFile)} --make-pgen --out ${shellQuote(outPath)}`)
      break
    }
    case 'cat':
      lines.push(`cat "\${INPUTS[@]}" > ${shellQuote(outPath)}`)
      break
    case 'tabular-inner':
    case 'tabular-outer':
    case 'tabular-left':
      lines.push(`python3 - <<'PY'`)
      lines.push(`import csv`)
      lines.push(`inputs = ${JSON.stringify(inputs)}`)
      lines.push(`out = ${JSON.stringify(outPath)}`)
      lines.push(`strategy = ${JSON.stringify(strategy.replace('tabular-', ''))}`)
      lines.push(`tables = []`)
      lines.push(`for path in inputs:`)
      lines.push(`    with open(path, newline='') as fh:`)
      lines.push(`        sample = fh.read(4096); fh.seek(0)`)
      lines.push(`        dialect = csv.Sniffer().sniff(sample, delimiters='\\t,') if sample else csv.excel_tab`)
      lines.push(`        rows = list(csv.DictReader(fh, dialect=dialect))`)
      lines.push(`        tables.append((path, rows, rows[0].keys() if rows else []))`)
      lines.push(`shared = set(tables[0][2]) if tables else set()`)
      lines.push(`for _, _, cols in tables[1:]: shared &= set(cols)`)
      lines.push(`key = next((c for c in ['eid','sample','sample_id','id','IID','FID'] if c in shared), None)`)
      lines.push(`if not key:`)
      lines.push(`    key = next(iter(shared), None)`)
      lines.push(`all_cols = []`)
      lines.push(`for _, _, cols in tables:`)
      lines.push(`    for col in cols:`)
      lines.push(`        if col not in all_cols: all_cols.append(col)`)
      lines.push(`if not key:`)
      lines.push(`    with open(out, 'w', newline='') as fh:`)
      lines.push(`        writer = csv.DictWriter(fh, fieldnames=all_cols, delimiter='\\t', extrasaction='ignore')`)
      lines.push(`        writer.writeheader()`)
      lines.push(`        for _, rows, _ in tables:`)
      lines.push(`            writer.writerows(rows)`)
      lines.push(`    raise SystemExit`)
      lines.push(`indexed = []`)
      lines.push(`for _, rows, _ in tables:`)
      lines.push(`    indexed.append({row.get(key, ''): row for row in rows if row.get(key, '')})`)
      lines.push(`keys = set(indexed[0])`)
      lines.push(`if strategy == 'inner':`)
      lines.push(`    for item in indexed[1:]: keys &= set(item)`)
      lines.push(`elif strategy == 'outer':`)
      lines.push(`    for item in indexed[1:]: keys |= set(item)`)
      lines.push(`with open(out, 'w', newline='') as fh:`)
      lines.push(`    writer = csv.DictWriter(fh, fieldnames=all_cols, delimiter='\\t', extrasaction='ignore')`)
      lines.push(`    writer.writeheader()`)
      lines.push(`    for k in sorted(keys):`)
      lines.push(`        merged = {key: k}`)
      lines.push(`        for item in indexed:`)
      lines.push(`            merged.update(item.get(k, {}))`)
      lines.push(`        writer.writerow(merged)`)
      lines.push(`PY`)
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
  if (s === '~') return '"$HOME"'
  if (s.startsWith('~/')) return `"${'${HOME}'}/${s.slice(2).replace(/["\\`$]/g, '\\$&')}"`
  if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'"'"'`)}'`
}

function shellArg(s: string): string {
  return shellQuote(s)
}

function awkStringLiteral(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`
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
