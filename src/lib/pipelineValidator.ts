/**
 * Pure pipeline validator — runs synchronously against a PipelineSnapshot and
 * returns a list of issues. No I/O, no async. Safe to run on every edit via
 * a useMemo selector.
 *
 * The execution runtime (electron/pipeline/PipelineRunner) re-validates at
 * submit time via its own axis planner, but we surface problems here first so
 * users see them before they click Run.
 */
import type { FileType, PipelineSnapshot, ToolPort } from '@/types/pipeline'
import type {
  ToolNodeData,
  FileNodeData,
  MergeNodeData,
  TransferNodeData,
  TransformNodeData,
} from '@/types/pipeline'
import { getTool, areTypesCompatible } from '@/lib/toolRegistry'
import { blockHasValue, getFlagDef, toolUsesFlagBuilder, CUSTOM_FLAG_ID } from '@/lib/flagRegistry'
import { connectedInputSchema, toolColumnWarnings, transformInputWarnings, type SchemaCache } from '@/lib/schemaResolver'
import { getActiveToolInputs, validateAnalysisOptions } from '@/lib/analysisOptions'

export type ValidationSeverity = 'error' | 'warning' | 'info'

export interface ValidationIssue {
  severity: ValidationSeverity
  /** Optional — pipeline-level issues have no nodeId. */
  nodeId?: string
  edgeId?: string
  portId?: string
  /** Machine-readable code; UI uses this for "jump to node" grouping. */
  code: string
  message: string
  suggestion?: string
  details?: Record<string, string | number | boolean | null>
}

export interface ValidationResult {
  /** True iff no `error`-severity issues. */
  ok: boolean
  issues: ValidationIssue[]
  errorCount: number
  warningCount: number
  infoCount: number
}

export function validatePipeline(snapshot: PipelineSnapshot, opts?: {
  schemas?: SchemaCache
  annotationDefaults?: {
    annovarDbPath?: string
    annovarScriptsPath?: string
    vepCachePath?: string
    vepPath?: string
  }
  dnx?: {
    defaultProjectId?: string | null
    authenticated?: boolean
  }
}): ValidationResult {
  const issues: ValidationIssue[] = []
  const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n]))
  const schemas = opts?.schemas ?? {}

  // ---------- Pipeline-level ----------
  const runnable = snapshot.nodes.filter((n) => n.type === 'tool' || n.type === 'merge' || n.type === 'transform' || n.type === 'transfer')
  if (runnable.length === 0) {
    issues.push({
      severity: 'error',
      code: 'EMPTY_PIPELINE',
      message: 'Pipeline has no tool or merge nodes.',
      suggestion: 'Drag a tool from the left palette onto the canvas.',
    })
  }

  // Cycle detection — Kahn's algorithm. If we can't topo-sort, the graph has a cycle.
  const incoming = new Map<string, number>()
  for (const n of snapshot.nodes) incoming.set(n.id, 0)
  for (const e of snapshot.edges) {
    incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1)
  }
  const q: string[] = []
  for (const [id, n] of incoming) if (n === 0) q.push(id)
  let processed = 0
  const inLocal = new Map(incoming)
  while (q.length > 0) {
    const id = q.shift()!
    processed++
    for (const e of snapshot.edges) {
      if (e.source !== id) continue
      const next = (inLocal.get(e.target) ?? 0) - 1
      inLocal.set(e.target, next)
      if (next === 0) q.push(e.target)
    }
  }
  if (processed < snapshot.nodes.length) {
    issues.push({
      severity: 'error',
      code: 'CYCLE',
      message: 'Pipeline contains a cycle.',
      suggestion: 'Remove an edge that creates the loop.',
    })
  }

  // ---------- Per-node ----------
  // Build an incoming-edges index by target + targetHandle.
  const incomingByPort = new Map<string, Map<string, typeof snapshot.edges>>()
  for (const n of snapshot.nodes) incomingByPort.set(n.id, new Map())
  for (const e of snapshot.edges) {
    const m = incomingByPort.get(e.target)!
    const handle = e.targetHandle ?? 'input'
    if (!m.has(handle)) m.set(handle, [])
    m.get(handle)!.push(e)
  }

  // Outgoing-edges index for ORPHAN_OUTPUT check.
  const hasOutgoing = new Set<string>() // `${nodeId}:${portId}`
  for (const e of snapshot.edges) {
    hasOutgoing.add(`${e.source}:${e.sourceHandle ?? 'output'}`)
  }

  const usesDnx = snapshot.nodes.some((node) => {
    if (node.type === 'tool') return (node.data as ToolNodeData).backend === 'dnx'
    if (node.type === 'file') return (node.data as FileNodeData).origin === 'dnx'
    if (node.type === 'transfer') {
      const data = node.data as TransferNodeData
      return data.from === 'dnx' || data.to === 'dnx'
    }
    return false
  })
  if (usesDnx && !opts?.dnx?.defaultProjectId) {
    issues.push({
      severity: 'error',
      code: 'DNX_NO_PROJECT',
      message: 'DNAnexus-backed steps need a default project before they can run.',
      suggestion: 'Open Settings -> DNAnexus and choose the project that should receive runs and transferred files.',
    })
  }
  if (usesDnx && !opts?.dnx?.authenticated) {
    issues.push({
      severity: 'error',
      code: 'DNX_NOT_AUTHENTICATED',
      message: 'DNAnexus-backed steps are present, but DNAnexus is not authenticated.',
      suggestion: 'Open Settings -> DNAnexus, save a token, then test the connection.',
    })
  }

  for (const edge of snapshot.edges) {
    const sourceNode = nodeById.get(edge.source)
    const targetNode = nodeById.get(edge.target)
    if (!sourceNode || !targetNode) continue
    const sourceBackend = nodeBackend(sourceNode, 'output')
    const targetBackend = nodeBackend(targetNode, 'input')
    if (targetBackend === 'dnx' && sourceBackend && sourceBackend !== 'dnx' && targetNode.type !== 'transfer') {
      const sourceType = sourcePortType(sourceNode, edge.sourceHandle ?? 'output')
      const largeLabel = isLargeGenomicFileType(sourceType) ? ' large genomic data' : ' input files'
      issues.push({
        severity: 'warning',
        edgeId: edge.id,
        nodeId: edge.target,
        code: 'DNX_UPLOAD_ADVISORY',
        message: `Running this DNAnexus/RAP step will stage${largeLabel} from ${backendLabel(sourceBackend)} to RAP.`,
        suggestion: 'If the file already exists on RAP, replace this input with a DNAnexus file node or add an explicit Transfer node and review it before running.',
      })
    }
    if (sourceNode.type !== 'transfer' && targetNode.type !== 'transfer' && sourceBackend && targetBackend && sourceBackend !== targetBackend) {
      issues.push({
        severity: 'warning',
        edgeId: edge.id,
        nodeId: edge.target,
        code: 'BACKEND_MISMATCH_NEEDS_TRANSFER',
        message: `This edge crosses backends (${backendLabel(sourceBackend)} -> ${backendLabel(targetBackend)}) without a Transfer node.`,
        suggestion: 'Insert a Transfer node so the cross-backend copy is explicit and editable.',
      })
    }

    const sourceBuild = nodeOutputBuild(sourceNode, edge.sourceHandle ?? 'output')
    const expectedBuild = nodeInputExpectedBuild(targetNode, edge.targetHandle ?? 'input')
    if (sourceBuild && expectedBuild) {
      const normalizedSource = normalizeGenomeBuild(sourceBuild)
      const normalizedExpected = normalizeGenomeBuild(expectedBuild)
      if (normalizedSource && normalizedExpected && normalizedSource !== normalizedExpected) {
        issues.push({
          severity: 'warning',
          edgeId: edge.id,
          nodeId: edge.target,
          portId: edge.targetHandle ?? 'input',
          code: 'GENOME_BUILD_MISMATCH',
          message: `This connection appears to mix genomic builds (${sourceBuild} -> ${expectedBuild}).`,
          suggestion: 'Insert a CrossMap Liftover node, or update the build metadata if the files already match.',
          details: { sourceBuild, targetBuild: expectedBuild },
        })
      }
    }
  }

  const labelCounts = new Map<string, number>()

  for (const node of snapshot.nodes) {
    if (node.type === 'note') continue

    // FILE
    if (node.type === 'file') {
      const d = node.data as FileNodeData
      const split = d.split
      if (split) {
        const splitItems = Array.isArray((split as { items?: unknown }).items) ? split.items : []
        if (d.isInput && (d.origin === 'local' || d.source === 'local')) {
          issues.push({
            severity: 'error', nodeId: node.id,
            code: 'LOCAL_SPLIT_NOT_UPLOADED',
            message: `Split input "${d.label}" is still local and must be transferred before running on Rorqual.`,
            suggestion: 'Add an explicit Local -> Rorqual Transfer node, or upload the split files and point this node at the remote paths.',
          })
        }
        if (!split.axis || !split.axis.trim()) {
          issues.push({
            severity: 'error', nodeId: node.id,
            code: 'SPLIT_NO_AXIS',
            message: `File "${d.label}" has split enabled but no axis name.`,
            suggestion: 'Set an axis name (e.g., "chrom") in the Split section.',
          })
        }
        if (splitItems.length === 0) {
          issues.push({
            severity: 'error', nodeId: node.id,
            code: 'EMPTY_SPLIT',
            message: `File "${d.label}" has split enabled but zero items.`,
            suggestion: 'Add items via the "Pick from glob" helper or enter manually.',
          })
        } else {
          for (const item of splitItems) {
            if (typeof item.path !== 'string' || !item.path.trim()) {
              issues.push({
                severity: 'error', nodeId: node.id,
                code: 'SPLIT_ITEM_NO_PATH',
                message: `Split item "${item.key}" on "${d.label}" has no path.`,
              })
              break
            }
          }
        }
      } else {
        if (d.source === 'local') {
          issues.push({
            severity: 'error', nodeId: node.id,
            code: 'LOCAL_FILE_NOT_UPLOADED',
            message: `Input file "${d.label}" is still local and must be uploaded before running.`,
            suggestion: 'Open the file node inspector and use "Upload to cluster".',
          })
        }
        if (d.isInput && !d.path.trim()) {
          issues.push({
            severity: 'error', nodeId: node.id,
            code: 'FILE_NODE_NO_PATH',
            message: `Input file "${d.label}" has no path.`,
            suggestion: 'Enter a remote path or use the file browser "Pick..." button.',
          })
        }
      }
      if (d.isInput && (d.fileType === 'pgen' || d.fileType === 'plink') && /\.(pgen|bed)$/i.test(d.path)) {
        issues.push({
          severity: 'info', nodeId: node.id,
          code: 'PLINK_SIDECAR_CHECK',
          message: `PLINK input "${d.label}" uses a prefix-based fileset; matching sidecar files will be checked when the run starts.`,
          suggestion: d.path.toLowerCase().endsWith('.pgen')
            ? 'Keep the matching .pvar and .psam next to this .pgen file.'
            : 'Keep the matching .bim and .fam next to this .bed file.',
        })
      }
      continue
    }

    // TOOL
    if (node.type === 'tool') {
      const d = node.data as ToolNodeData
      labelCounts.set(d.label, (labelCounts.get(d.label) ?? 0) + 1)

      const tool = getTool(d.toolId)
      if (!tool) {
        issues.push({
          severity: 'error', nodeId: node.id,
          code: 'UNKNOWN_TOOL',
          message: `Tool "${d.toolId}" is not in the registry.`,
          suggestion: 'Delete and recreate this node, or import a newer pipeline.',
        })
        continue
      }

      const inMap = incomingByPort.get(node.id)!

      // Required inputs
      const connectedPortIds = snapshot.edges
        .filter((edge) => edge.target === node.id)
        .map((edge) => edge.targetHandle ?? 'input')
      const activeInputs = getActiveToolInputs(tool, d, { connectedPortIds })
      const activeInputIds = new Set(activeInputs.map((port) => port.id))
      for (const port of activeInputs) {
        const edges = inMap.get(port.id)
        const satisfiesFileBlock = toolUsesFlagBuilder(d.toolId) && blockProvidesInput(d, port.id, Boolean(edges?.length))
        if (port.required && (!edges || edges.length === 0) && !satisfiesFileBlock) {
          issues.push({
            severity: 'error', nodeId: node.id, portId: port.id,
            code: 'MISSING_INPUT',
            message: `Tool "${d.label}" is missing required input "${port.label}".`,
            suggestion: `Connect a ${port.fileType} source to the "${port.label}" port.`,
          })
        }
        // Type compatibility — defensive; canvas usually blocks this.
        if (edges) {
          if (edges.length > 1 && !port.multi) {
            issues.push({
              severity: 'error', nodeId: node.id, portId: port.id,
              code: 'MULTI_INPUT_NO_CONVERGE',
              message: `Input "${port.label}" has multiple upstream files but is not a merge input.`,
              suggestion: 'Connect those branches to a Merge node first, or use a multi-input tool port.',
            })
          }
          for (const e of edges) {
            const srcNode = nodeById.get(e.source)
            if (!srcNode) continue
            const srcType = sourcePortType(srcNode, e.sourceHandle ?? 'output')
            if (srcType && !areTypesCompatible(srcType, port.fileType)) {
              issues.push({
                severity: 'error', nodeId: node.id, edgeId: e.id, portId: port.id,
                code: 'TYPE_MISMATCH',
                message: `Edge into "${port.label}" expects ${port.fileType} but receives ${srcType}.`,
              })
            }
          }
        }
      }

      for (const [portId, edges] of inMap) {
        if (activeInputIds.has(portId)) continue
        if (edges.length === 0) continue
        issues.push({
          severity: 'warning', nodeId: node.id, portId,
          code: 'INACTIVE_INPUT_CONNECTED',
          message: `Input "${portId}" is connected but its analysis option is disabled.`,
          suggestion: 'Enable the matching option or remove this connection.',
        })
      }

      for (const issue of validateToolAxisChoices(snapshot, node.id, activeInputs, d, inMap, nodeById)) {
        issues.push(issue)
      }

      for (const issue of validateAnalysisOptions(tool, d, [...inMap.keys()])) {
        issues.push({
          severity: 'error', nodeId: node.id,
          code: issue.code,
          message: issue.message,
        })
      }

      if (!d.analysisOptions && toolUsesFlagBuilder(d.toolId) && (d.flagBlocks?.length ?? 0) > 0) {
        for (const block of d.flagBlocks ?? []) {
          const def = getFlagDef(d.toolId, block.flagId)
          if (!def || !block.enabled) continue
          if (block.flagId === CUSTOM_FLAG_ID && !block.customFlag?.trim()) {
            issues.push({
              severity: 'error', nodeId: node.id,
              code: 'FLAG_NAME_MISSING',
              message: `Custom flag on "${d.label}" does not have a flag name yet.`,
              suggestion: 'Enter the flag exactly as the tool expects it, including the leading dashes.',
            })
          }
          if (block.flagId === CUSTOM_FLAG_ID && block.customInputKind === 'file' && !blockHasFileSource(block, false)) {
            issues.push({
              severity: 'error', nodeId: node.id,
              code: 'FLAG_VALUE_MISSING',
              message: `Custom file flag on "${d.label}" does not have a selected file path.`,
              suggestion: 'Choose a remote or local file for this custom flag.',
            })
          }
          if (def.requiredValue && !blockHasValue(block.value)) {
            issues.push({
              severity: 'error', nodeId: node.id,
              code: 'FLAG_VALUE_MISSING',
              message: `Flag "${def.label}" on "${d.label}" needs a value.`,
              suggestion: 'Fill in the block value or disable the block.',
            })
          }
          for (const requiredFlagId of def.requires ?? []) {
            const requiredBlock = d.flagBlocks?.find((candidate) => candidate.flagId === requiredFlagId && candidate.enabled)
            if (!requiredBlock || !blockHasValue(requiredBlock.value)) {
              issues.push({
                severity: 'error', nodeId: node.id,
                code: 'FLAG_REQUIRED',
                message: `Flag "${def.label}" on "${d.label}" requires "${getFlagDef(d.toolId, requiredFlagId)?.label ?? requiredFlagId}".`,
                suggestion: 'Enable the required flag block and provide a value.',
              })
            }
          }
          for (const conflictFlagId of def.conflicts ?? []) {
            const conflict = d.flagBlocks?.find((candidate) => candidate.flagId === conflictFlagId && candidate.enabled)
            if (conflict) {
              issues.push({
                severity: 'error', nodeId: node.id,
                code: 'FLAG_CONFLICT',
                message: `Flag "${def.label}" on "${d.label}" conflicts with "${getFlagDef(d.toolId, conflictFlagId)?.label ?? conflictFlagId}".`,
                suggestion: 'Disable one of the conflicting flag blocks.',
              })
            }
          }
          if (def.kind === 'fileInput' && !blockHasFileSource(block, Boolean(inMap.get(def.sourcePortId ?? 'input')?.length))) {
            issues.push({
              severity: 'error', nodeId: node.id,
              code: 'FLAG_VALUE_MISSING',
              message: `Flag "${def.label}" on "${d.label}" does not have a connected or typed file source.`,
              suggestion: 'Connect an upstream file or enter a path in the block.',
            })
          }
        }
      }

      // Required params
      for (const p of tool.params) {
        if (!p.required) continue
        const v = d.paramValues?.[p.name]
        const unset = v === undefined || v === null || v === ''
        if (unset) {
          issues.push({
            severity: 'error', nodeId: node.id,
            code: 'MISSING_REQUIRED_PARAM',
            message: `Tool "${d.label}" is missing required parameter "${p.label}".`,
            suggestion: `Set "${p.label}" in the node inspector.`,
          })
        }
      }

      for (const warning of toolColumnWarnings(snapshot, node.id, schemas)) {
        const param = tool.params.find((p) => p.name === warning.paramName)
        issues.push({
          severity: 'error', nodeId: node.id,
          code: 'SCHEMA_COLUMN_MISMATCH',
          message: `Parameter "${param?.label ?? warning.paramName}" references missing column${warning.missing.length === 1 ? '' : 's'}: ${warning.missing.join(', ')}.`,
          suggestion: 'Pick from the connected input columns or update the upstream transform.',
        })
      }

      if (tool.requiresDatabase) {
        const defaultPath = d.toolId === 'annovar.table_annovar'
          ? opts?.annotationDefaults?.annovarDbPath
          : d.toolId === 'vep'
            ? opts?.annotationDefaults?.vepCachePath
            : ''
        const dbPath = String(d.paramValues?.annotationDbPath ?? defaultPath ?? '').trim()
        if (!dbPath) {
          issues.push({
            severity: 'warning', nodeId: node.id,
            code: 'ANNOT_DATABASE_MISSING',
            message: `${tool.name} needs ${tool.requiresDatabase.name}, but no database path is set.`,
            suggestion: 'Open the dataset guide from the node inspector, download the database, then set the database path.',
          })
        }
      }

      if (d.toolId === 'annovar.table_annovar') {
        const toolPath = String(d.paramValues?.annovarPath ?? d.paramValues?.toolPath ?? opts?.annotationDefaults?.annovarScriptsPath ?? '').trim()
        if (!toolPath) {
          issues.push({
            severity: 'error', nodeId: node.id,
            code: 'ANNOVAR_PATH_MISSING',
            message: 'ANNOVAR needs the folder containing table_annovar.pl before it can run.',
            suggestion: 'Set the ANNOVAR scripts folder in Settings or on this node, or use the setup button to install it under your tools folder.',
          })
        }
      }

      if (d.toolId === 'vep') {
        const toolPath = String(d.paramValues?.vepPath ?? d.paramValues?.toolPath ?? opts?.annotationDefaults?.vepPath ?? '').trim()
        if (!toolPath && !tool.module) {
          issues.push({
            severity: 'error', nodeId: node.id,
            code: 'VEP_PATH_MISSING',
            message: 'VEP needs either a module or the path to a VEP executable before it can run.',
            suggestion: 'Set the VEP executable path in Settings or on this node, or use the setup button to install it under your tools folder.',
          })
        }
      }

      if (d.toolId === 'crossmap.liftover') {
        const selectedFormat = String(d.paramValues?.format ?? 'auto').trim().toLowerCase()
        const inputTypes = (inMap.get('input') ?? [])
          .map((edge) => {
            const source = nodeById.get(edge.source)
            return source ? sourcePortType(source, edge.sourceHandle ?? 'output') : null
          })
          .filter(Boolean)
        const needsReference = selectedFormat === 'vcf' || selectedFormat === 'gvcf' || (
          selectedFormat === 'auto' && inputTypes.some((type) => type === 'vcf' || type === 'bcf')
        )
        if (needsReference && !(inMap.get('reference')?.length)) {
          issues.push({
            severity: 'error', nodeId: node.id, portId: 'reference',
            code: 'LIFTOVER_REFERENCE_REQUIRED',
            message: 'CrossMap VCF/gVCF liftover needs the target reference FASTA.',
            suggestion: 'Connect the target-build FASTA to the Target FASTA input before running.',
          })
        }
        const sourceBuild = normalizeGenomeBuild(String(d.paramValues?.['source-build'] ?? ''))
        const targetBuild = normalizeGenomeBuild(String(d.paramValues?.['target-build'] ?? ''))
        if (sourceBuild && targetBuild && sourceBuild === targetBuild) {
          issues.push({
            severity: 'warning', nodeId: node.id,
            code: 'LIFTOVER_SAME_BUILD',
            message: 'CrossMap source and target builds are the same.',
            suggestion: 'Remove the liftover node unless you only need chromosome-name conversion.',
          })
        }
      }

      if (d.toolId === 'plink2.phewas') {
        const typedPhenotypes = splitListValue(d.paramValues?.phenotypes)
        const hasPhenotypeList = Boolean(inMap.get('phenoList')?.length)
        if (typedPhenotypes.length === 0 && !hasPhenotypeList) {
          issues.push({
            severity: 'error', nodeId: node.id, portId: 'phenoList',
            code: 'PHEWAS_NO_PHENOTYPES',
            message: 'PLINK2 PheWAS needs either phenotype columns or a phenotype-list file.',
            suggestion: 'Choose phenotype columns from the phenotype table, type a list, or connect a one-column phenotype-list file.',
          })
        }
      }

      // Overprovisioned Slurm — informational
      const defCpus = tool.slurm?.cpus ?? 1
      const defMem = tool.slurm?.memoryGB ?? 4
      const overCpus = (d.slurmOverride?.cpus ?? defCpus) > defCpus * 4
      const overMem = (d.slurmOverride?.memoryGB ?? defMem) > defMem * 4
      if (overCpus || overMem) {
        issues.push({
          severity: 'info', nodeId: node.id,
          code: 'OVERPROVISIONED_SLURM',
          message: `Tool "${d.label}" is requesting >4× the recommended ${overCpus ? 'CPUs' : 'memory'}.`,
          suggestion: 'Reduce the override unless you have a specific reason.',
        })
      }

      const effectiveCpus = d.slurmOverride?.cpus ?? tool.slurm?.cpus ?? 1
      const effectiveMem = d.slurmOverride?.memoryGB ?? tool.slurm?.memoryGB ?? 4
      if (d.executionMode === 'login' && (effectiveCpus > 4 || effectiveMem > 16 || hasAxedInput(snapshot, node.id))) {
        issues.push({
          severity: 'warning', nodeId: node.id,
          code: 'LOGIN_NODE_HEAVY',
          message: 'Running an array or heavy job on the login node will likely be killed by cluster admins. Consider sbatch.',
          suggestion: 'Switch this node back to Slurm job unless it is a quick command.',
        })
      }

      // Orphan outputs — warning
      for (const port of tool.outputs) {
        const mergeConfig = d.outputMerge?.[port.id]
        const autoMergeEnabled = mergeConfig ? mergeConfig.mode === 'auto-merge' : Boolean(port.autoMergeDefault)
        const mergeStrategy = mergeConfig?.strategy ?? port.autoMergeDefault
        if (autoMergeEnabled && !mergeStrategy) {
          issues.push({
            severity: 'error', nodeId: node.id, portId: port.id,
            code: 'AUTO_MERGE_STRATEGY_MISSING',
            message: `Output "${port.label}" on "${d.label}" is set to auto-merge but no merge strategy is defined.`,
            suggestion: 'Pick a merge strategy or switch the output back to fan-out.',
          })
        }
        if (!hasOutgoing.has(`${node.id}:${port.id}`)) {
          issues.push({
            severity: 'warning', nodeId: node.id, portId: port.id,
            code: 'ORPHAN_OUTPUT',
            message: `Output "${port.label}" from "${d.label}" is not connected downstream.`,
            suggestion: 'Results will still land on disk, but nothing consumes them.',
          })
        }
      }
      continue
    }

    // TRANSFORM
    if (node.type === 'transform') {
      const d = node.data as TransformNodeData
      labelCounts.set(d.label, (labelCounts.get(d.label) ?? 0) + 1)
      const inMap = incomingByPort.get(node.id)!
      const edges = inMap.get('input')
      if (!edges || edges.length === 0) {
        issues.push({
          severity: 'error', nodeId: node.id,
          code: 'TRANSFORM_NO_INPUT',
          message: `Transform "${d.label}" has no input connected.`,
          suggestion: 'Connect a tabular file or upstream transform to its input.',
        })
      }
      if (edges && edges.length > 0) {
        const fileTypes = edges
          .map((edge) => {
            const source = nodeById.get(edge.source)
            return source ? sourcePortType(source, edge.sourceHandle ?? 'output') : null
          })
          .filter(Boolean) as string[]
        const uniqueTypes = new Set(fileTypes.filter((type) => type !== 'any'))
        if (uniqueTypes.size > 1) {
          issues.push({
            severity: 'warning', nodeId: node.id,
            code: 'TRANSFORM_MIXED_INPUT_TYPES',
            message: `Transform "${d.label}" receives multiple input file types: ${[...uniqueTypes].join(', ')}.`,
            suggestion: 'Transforms work best on one consistent tabular schema; align upstream outputs if this looks accidental.',
          })
        }
      }
      if (!hasOutgoing.has(`${node.id}:output`)) {
        issues.push({
          severity: 'warning', nodeId: node.id,
          code: 'ORPHAN_OUTPUT',
          message: `Transform "${d.label}" output is not connected downstream.`,
          suggestion: 'The transformed file will still be written to disk.',
        })
      }
      const schema = connectedInputSchema(snapshot, node.id, 'input', schemas)
      if (schema) {
        const missing = transformInputWarnings(snapshot, node.id, schemas)
        if (missing.length > 0) {
          issues.push({
            severity: 'error', nodeId: node.id,
            code: 'TRANSFORM_UNKNOWN_COLUMN',
            message: `Transform "${d.label}" references missing column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`,
            suggestion: 'Update selected columns, filters, or rename rules from the inspector.',
          })
        }
      } else if (edges && edges.length > 0 && ((d.selectedColumns?.length ?? 0) > 0 || (d.filters?.length ?? 0) > 0 || (d.renames?.length ?? 0) > 0)) {
        issues.push({
          severity: 'warning', nodeId: node.id,
          code: 'SCHEMA_NOT_LOADED',
          message: `Transform "${d.label}" has column rules, but the upstream header is not loaded yet.`,
          suggestion: 'Open the input in Data Preview or keep the typed column names if you are sure.',
        })
      }
      continue
    }

    // TRANSFER
    if (node.type === 'transfer') {
      const d = node.data as TransferNodeData
      labelCounts.set(d.label, (labelCounts.get(d.label) ?? 0) + 1)
      const inMap = incomingByPort.get(node.id)!
      const edges = inMap.get('input')
      if (!edges || edges.length === 0) {
        issues.push({
          severity: 'error', nodeId: node.id,
          code: 'TRANSFER_NO_INPUT',
          message: `Transfer "${d.label}" has no input connected.`,
          suggestion: 'Connect an upstream file or tool output into the transfer.',
        })
      }
      if (!hasOutgoing.has(`${node.id}:output`)) {
        issues.push({
          severity: 'warning', nodeId: node.id,
          code: 'ORPHAN_OUTPUT',
          message: `Transfer "${d.label}" output is not connected downstream.`,
        })
      }
      if (d.from === d.to) {
        issues.push({
          severity: 'warning', nodeId: node.id,
          code: 'TRANSFER_SAME_BACKEND',
          message: `Transfer "${d.label}" copies data within the same backend.`,
          suggestion: 'Remove it unless you need the explicit relocation step.',
        })
      }
      if (d.to === 'dnx' && d.from !== 'dnx') {
        const sourceTypes = (edges ?? [])
          .map((edge) => {
            const source = nodeById.get(edge.source)
            return source ? sourcePortType(source, edge.sourceHandle ?? 'output') : null
          })
          .filter(Boolean)
        const largeLabel = sourceTypes.some(isLargeGenomicFileType) ? ' large genomic files' : ' files'
        issues.push({
          severity: 'warning', nodeId: node.id,
          code: 'DNX_UPLOAD_ADVISORY',
          message: `Transfer "${d.label}" will upload${largeLabel} to DNAnexus/RAP.`,
          suggestion: 'If these already exist on RAP, use DNAnexus file references instead, or review this transfer before running.',
        })
      }
      continue
    }

    // MERGE
    if (node.type === 'merge') {
      const d = node.data as MergeNodeData
      labelCounts.set(d.label, (labelCounts.get(d.label) ?? 0) + 1)
      const inMap = incomingByPort.get(node.id)!
      const edges = inMap.get('input')
      if (!edges || edges.length === 0) {
        issues.push({
          severity: 'error', nodeId: node.id,
          code: 'MERGE_NO_INPUT',
          message: `Merge "${d.label}" has no input connected.`,
          suggestion: 'Connect an upstream tool output or file node into the merge.',
        })
      }
      if (!hasOutgoing.has(`${node.id}:output`)) {
        issues.push({
          severity: 'warning', nodeId: node.id,
          code: 'ORPHAN_OUTPUT',
          message: `Merge "${d.label}" output is not connected downstream.`,
        })
      }
      for (const edge of snapshot.edges.filter((candidate) => candidate.target === node.id)) {
        const source = nodeById.get(edge.source)
        if (!source) continue
        const fileType = sourcePortType(source, edge.sourceHandle ?? 'output')
        if (fileType && fileType !== 'any' && !mergeStrategyCompatible(d.strategy, fileType)) {
          issues.push({
            severity: 'error', nodeId: node.id, edgeId: edge.id,
            code: 'MERGE_STRATEGY_TYPE_MISMATCH',
            message: `Merge "${d.label}" strategy ${d.strategy} is not compatible with ${fileType} input.`,
            suggestion: 'Use auto, cat, or a merge strategy matching the upstream file type.',
          })
        }
      }
      continue
    }
  }

  for (const edge of snapshot.edges) {
    const sourceNode = nodeById.get(edge.source)
    const targetNode = nodeById.get(edge.target)
    if (!sourceNode || !targetNode || targetNode.type !== 'file') continue
    const targetData = targetNode.data as FileNodeData
    if (targetData.isInput || targetData.origin !== 'local') continue
    if (sourceNode.type === 'transfer') continue
    issues.push({
      severity: 'error',
      nodeId: targetNode.id,
      edgeId: edge.id,
      code: 'LOCAL_OUTPUT_NEEDS_TRANSFER',
      message: `Output "${targetData.label}" points to a local path, but upstream jobs run on Rorqual.`,
      suggestion: 'Insert a Rorqual -> Local Transfer node and set the local destination there.',
    })
  }

  // Duplicate labels (informational)
  for (const [label, count] of labelCounts) {
    if (count > 1) {
      issues.push({
        severity: 'info',
        code: 'DUPLICATE_NODE_LABEL',
        message: `${count} nodes share the label "${label}".`,
        suggestion: 'Rename one for easier log identification.',
      })
    }
  }

  for (const group of snapshot.groups ?? []) {
    if (group.kind === 'visual') continue
    const groupNodeIds = new Set(group.nodeIds)
    const members = group.nodeIds.map((id) => nodeById.get(id)).filter(Boolean) as PipelineSnapshot['nodes']
    if (members.length !== group.nodeIds.length || members.length < 2) {
      issues.push({
        severity: 'error',
        code: 'GROUP_NON_LINEAR',
        message: `Group "${group.label}" must contain at least two existing nodes.`,
      })
      continue
    }
    const nonRunnable = members.find((node) => node.type === 'file' || node.type === 'note')
    if (nonRunnable) {
      issues.push({
        severity: 'error',
        nodeId: nonRunnable.id,
        code: 'GROUP_NON_LINEAR',
        message: `Group "${group.label}" contains a non-runnable node.`,
        suggestion: 'Only tool, transform, and merge nodes can be grouped into one sbatch.',
      })
      continue
    }
    const loginMember = members.find((node) => node.type === 'tool' && (node.data as ToolNodeData).executionMode === 'login')
    if (loginMember) {
      issues.push({
        severity: 'error',
        nodeId: loginMember.id,
        code: 'GROUP_MIXED_EXECUTION',
        message: `Group "${group.label}" contains a login-node tool.`,
        suggestion: 'Login-node tools cannot be merged into one sbatch group.',
      })
      continue
    }
    const dnxMember = members.find((node) =>
      node.type === 'transfer' ||
      (node.type === 'tool' && (node.data as ToolNodeData).backend === 'dnx'),
    )
    if (dnxMember) {
      issues.push({
        severity: 'error',
        nodeId: dnxMember.id,
        code: 'GROUP_MIXED_EXECUTION',
        message: `Group "${group.label}" contains a DNAnexus-backed step or Transfer node.`,
        suggestion: 'Grouped execution currently supports SSH-backed tool, merge, and transform nodes only.',
      })
      continue
    }

    const internalEdges = snapshot.edges.filter((edge) => groupNodeIds.has(edge.source) && groupNodeIds.has(edge.target))
    const counts = new Map<string, { in: number; out: number }>()
    for (const id of group.nodeIds) counts.set(id, { in: 0, out: 0 })
    for (const edge of internalEdges) {
      counts.get(edge.source)!.out++
      counts.get(edge.target)!.in++
    }
    const starts = [...counts.values()].filter((count) => count.in === 0 && count.out === 1).length
    const ends = [...counts.values()].filter((count) => count.in === 1 && count.out === 0).length
    const middlesOk = [...counts.values()].every((count) => count.in <= 1 && count.out <= 1)
    if (internalEdges.length !== members.length - 1 || starts !== 1 || ends !== 1 || !middlesOk) {
      issues.push({
        severity: 'error',
        code: 'GROUP_NON_LINEAR',
        message: `Group "${group.label}" is not a single connected linear chain.`,
        suggestion: 'Remove branches, fan-in, or disconnected nodes before grouping.',
      })
    }

    const axes = new Set(members.map((node) => axisForNode(snapshot, node.id)).filter((axis) => axis !== undefined))
    if (axes.size > 1) {
      issues.push({
        severity: 'error',
        code: 'GROUP_DIFFERENT_AXIS',
        message: `Group "${group.label}" mixes nodes with different axes.`,
        suggestion: 'Group only nodes that run over the same split, or only non-axed nodes.',
      })
    }
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length
  const warningCount = issues.filter((i) => i.severity === 'warning').length
  const infoCount = issues.filter((i) => i.severity === 'info').length
  return {
    ok: errorCount === 0,
    issues,
    errorCount,
    warningCount,
    infoCount,
  }
}

function axisForNode(snapshot: PipelineSnapshot, nodeId: string, seen = new Set<string>()): string | undefined {
  if (seen.has(nodeId)) return undefined
  seen.add(nodeId)
  const node = snapshot.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return undefined
  if (node.type === 'file') {
    const split = (node.data as FileNodeData).split
    const items = (split as { items?: unknown } | undefined)?.items
    return Array.isArray(items) && items.length > 0 ? split?.axis || undefined : undefined
  }
  if (node.type === 'transfer') {
    const input = snapshot.edges.find((edge) => edge.target === nodeId && (edge.targetHandle ?? 'input') === 'input')
    return input ? axisForNode(snapshot, input.source, seen) : undefined
  }
  if (node.type === 'merge') return undefined
  const incoming = snapshot.edges.filter((edge) => edge.target === nodeId)
  const axes = new Set<string>()
  for (const edge of incoming) {
    const axis = axisForNode(snapshot, edge.source, seen)
    if (axis) axes.add(axis)
  }
  if (axes.size === 0) return undefined
  if (axes.size === 1) return [...axes][0]
  return '__mixed__'
}

function hasAxedInput(snapshot: PipelineSnapshot, nodeId: string): boolean {
  return snapshot.edges.some((edge) => {
    if (edge.target !== nodeId) return false
    const source = snapshot.nodes.find((node) => node.id === edge.source)
    const split = source?.type === 'file' ? (source.data as FileNodeData).split : undefined
    const items = (split as { items?: unknown } | undefined)?.items
    return Array.isArray(items) && items.length > 0
  })
}

function nodeOutputBuild(node: PipelineSnapshot['nodes'][number], portId: string): string | null {
  if (node.type === 'file') {
    const data = node.data as FileNodeData
    return stringValue(data.genomeBuild) || buildFromText(`${data.label} ${data.path}`)
  }
  if (node.type === 'tool') {
    const data = node.data as ToolNodeData
    if (data.toolId === 'crossmap.liftover') return stringValue(data.paramValues?.['target-build']) || stringValue(data.genomeBuild)
    if (data.toolId === 'annovar.table_annovar') return normalizeAnnotationBuild(stringValue(data.paramValues?.buildver)) || stringValue(data.genomeBuild)
    if (data.toolId === 'vep') return stringValue(data.paramValues?.assembly) || stringValue(data.genomeBuild)
    return stringValue(data.genomeBuild) || paramBuild(data) || buildFromText(`${data.label} ${portId}`)
  }
  if (node.type === 'transform') return null
  if (node.type === 'merge') return null
  if (node.type === 'transfer') return null
  return null
}

function nodeInputExpectedBuild(node: PipelineSnapshot['nodes'][number], portId: string): string | null {
  if (node.type === 'file') {
    const data = node.data as FileNodeData
    return stringValue(data.genomeBuild) || buildFromText(`${data.label} ${data.path}`)
  }
  if (node.type !== 'tool') return null
  const data = node.data as ToolNodeData
  if (data.toolId === 'crossmap.liftover') {
    if (portId !== 'input') return null
    return stringValue(data.paramValues?.['source-build'])
  }
  if (data.toolId === 'annovar.table_annovar') return normalizeAnnotationBuild(stringValue(data.paramValues?.buildver))
  if (data.toolId === 'vep') return stringValue(data.paramValues?.assembly)
  return stringValue(data.genomeBuild) || paramBuild(data)
}

function paramBuild(data: ToolNodeData): string | null {
  return stringValue(data.paramValues?.['target-build'])
    || stringValue(data.paramValues?.['source-build'])
    || normalizeAnnotationBuild(stringValue(data.paramValues?.buildver))
    || stringValue(data.paramValues?.assembly)
}

function normalizeGenomeBuild(raw: string | null | undefined): string | null {
  const value = stringValue(raw)?.toLowerCase()
  if (!value) return null
  if (value === 'hg19' || value === 'grch37' || value === 'b37') return 'GRCh37'
  if (value === 'hg38' || value === 'grch38' || value === 'b38') return 'GRCh38'
  return value.toUpperCase()
}

function normalizeAnnotationBuild(value: string | null): string | null {
  if (!value) return null
  return value === 'hg19' ? 'GRCh37' : value === 'hg38' ? 'GRCh38' : value
}

function buildFromText(text: string): string | null {
  const lower = text.toLowerCase()
  if (/(^|[^a-z0-9])(grch37|hg19|b37)([^a-z0-9]|$)/.test(lower)) return 'GRCh37'
  if (/(^|[^a-z0-9])(grch38|hg38|b38)([^a-z0-9]|$)/.test(lower)) return 'GRCh38'
  return null
}

function stringValue(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const rendered = String(value).trim()
  return rendered ? rendered : null
}

function splitListValue(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((value) => value.trim()).filter(Boolean)
  if (raw === undefined || raw === null) return []
  return String(raw).split(/[,\s]+/).map((value) => value.trim()).filter(Boolean)
}

function isLargeGenomicFileType(fileType: string | null | undefined): fileType is FileType {
  return fileType === 'plink'
    || fileType === 'pgen'
    || fileType === 'bgen'
    || fileType === 'vcf'
    || fileType === 'bcf'
    || fileType === 'bam'
    || fileType === 'cram'
}

/**
 * Resolve the output file type for a given source-node port. Used by the
 * TYPE_MISMATCH check. Returns null when the type can't be determined (e.g.,
 * upstream is a note).
 */
function sourcePortType(
  node: PipelineSnapshot['nodes'][number],
  portId: string,
): string | null {
  if (node.type === 'file') {
    return (node.data as FileNodeData).fileType
  }
  if (node.type === 'tool') {
    const tool = getTool((node.data as ToolNodeData).toolId)
    const port = tool?.outputs.find((p) => p.id === portId)
    return port?.fileType ?? null
  }
  if (node.type === 'merge') {
    // Merge output type is inferred at run time from its upstream; we can't
    // know it here without walking the graph, so skip strict checking.
    return 'any'
  }
  if (node.type === 'transfer') {
    return 'any'
  }
  if (node.type === 'transform') {
    return (node.data as TransformNodeData).fileType
  }
  return null
}

function nodeBackend(
  node: PipelineSnapshot['nodes'][number],
  direction: 'input' | 'output',
): 'local' | 'ssh' | 'dnx' | null {
  if (node.type === 'tool') {
    return (node.data as ToolNodeData).backend === 'dnx' ? 'dnx' : 'ssh'
  }
  if (node.type === 'file') {
    const origin = (node.data as FileNodeData).origin
    if (origin === 'dnx') return 'dnx'
    if (origin === 'local') return 'local'
    if (origin === 'ssh') return 'ssh'
    return null
  }
  if (node.type === 'transfer') {
    const data = node.data as TransferNodeData
    return direction === 'input' ? data.from : data.to
  }
  return 'ssh'
}

function backendLabel(value: 'local' | 'ssh' | 'dnx'): string {
  if (value === 'dnx') return 'DNAnexus'
  if (value === 'local') return 'Local'
  return 'Rorqual'
}

function mergeStrategyCompatible(strategy: MergeNodeData['strategy'], fileType: string): boolean {
  if (strategy === 'auto' || strategy === 'cat') return true
  if (strategy === 'tsv-concat-header') return fileType === 'tsv' || fileType === 'csv' || fileType === 'txt'
  if (strategy === 'bcftools-concat') return fileType === 'vcf' || fileType === 'bcf'
  if (strategy === 'plink-pmerge-list') return fileType === 'plink' || fileType === 'pgen'
  return true
}

function validateToolAxisChoices(
  snapshot: PipelineSnapshot,
  nodeId: string,
  activeInputs: ToolPort[],
  data: ToolNodeData,
  inMap: Map<string, typeof snapshot.edges>,
  nodeById: Map<string, PipelineSnapshot['nodes'][number]>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const candidates: Array<{ portId: string; axis: string; keys: string[] }> = []
  for (const port of activeInputs) {
    if (port.multi || port.arrayable === false) continue
    const edges = inMap.get(port.id) ?? []
    if (edges.length !== 1) continue
    const source = nodeById.get(edges[0].source)
    const split = source?.type === 'file' ? (source.data as FileNodeData).split : undefined
    const items = (split as { items?: Array<{ key?: unknown }> } | undefined)?.items
    if (!split || !Array.isArray(items) || items.length === 0) continue
    candidates.push({
      portId: port.id,
      axis: split.axis || 'item',
      keys: items.map((item, index) => typeof item.key === 'string' && item.key ? item.key : String(index + 1)),
    })
  }
  if (candidates.length === 0) return issues
  if (data.arrayOver === null) {
    issues.push({
      severity: 'error',
      nodeId,
      code: 'ARRAY_OVER_NULL_WITH_AXED',
      message: `"${data.label}" is set to a single job, but receives split input files.`,
      suggestion: 'Choose a split input to array over, or remove the split before running.',
    })
    return issues
  }
  if (data.arrayOver && !candidates.some((candidate) => candidate.portId === data.arrayOver)) {
    issues.push({
      severity: 'error',
      nodeId,
      portId: data.arrayOver,
      code: 'ARRAY_OVER_INVALID',
      message: `"${data.label}" is configured to array over "${data.arrayOver}", but that port is not a split input.`,
      suggestion: 'Pick a connected split input in the node inspector.',
    })
    return issues
  }
  if (candidates.length <= 1) return issues
  const reference = data.arrayOver
    ? candidates.find((candidate) => candidate.portId === data.arrayOver) ?? candidates[0]
    : candidates[0]
  const aligned = candidates.every((candidate) =>
    candidate.axis === reference.axis &&
    candidate.keys.length === reference.keys.length &&
    candidate.keys.every((key, index) => key === reference.keys[index]),
  )
  if (!aligned) {
    issues.push({
      severity: 'error',
      nodeId,
      code: 'MULTIPLE_AXES_NO_CHOICE',
      message: `"${data.label}" has multiple split inputs whose axes or keys do not match.`,
      suggestion: 'Use split inputs with the same keys, or choose one array-over input and collapse/merge the other input first.',
    })
  }
  return issues
}

function blockProvidesInput(data: ToolNodeData, portId: string, hasConnectedEdge: boolean): boolean {
  const block = data.flagBlocks?.find((candidate) => {
    const def = getFlagDef(data.toolId, candidate.flagId)
    return def?.kind === 'fileInput' && def.sourcePortId === portId && candidate.enabled
  })
  if (!block) return false
  return blockHasFileSource(block, hasConnectedEdge)
}

function blockHasFileSource(block: NonNullable<ToolNodeData['flagBlocks']>[number], hasConnectedEdge: boolean): boolean {
  const value = block.value as { kind?: string; value?: string } | undefined
  if (value?.kind === 'upstream-file') return hasConnectedEdge
  return blockHasValue(block.value)
}

/** Filter a validation result down to issues attached to one node. */
export function issuesForNode(result: ValidationResult, nodeId: string): ValidationIssue[] {
  return result.issues.filter((i) => i.nodeId === nodeId)
}
