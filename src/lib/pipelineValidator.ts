/**
 * Pure pipeline validator — runs synchronously against a PipelineSnapshot and
 * returns a list of issues. No I/O, no async. Safe to run on every edit via
 * a useMemo selector.
 *
 * The execution runtime (electron/pipeline/PipelineRunner) re-validates at
 * submit time via its own axis planner, but we surface problems here first so
 * users see them before they click Run.
 */
import type { PipelineSnapshot } from '@/types/pipeline'
import type {
  ToolNodeData,
  FileNodeData,
  MergeNodeData,
  TransformNodeData,
} from '@/types/pipeline'
import { getTool, areTypesCompatible } from '@/lib/toolRegistry'
import { connectedInputSchema, toolColumnWarnings, transformInputWarnings, type SchemaCache } from '@/lib/schemaResolver'

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
}): ValidationResult {
  const issues: ValidationIssue[] = []
  const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n]))
  const schemas = opts?.schemas ?? {}

  // ---------- Pipeline-level ----------
  const runnable = snapshot.nodes.filter((n) => n.type === 'tool' || n.type === 'merge' || n.type === 'transform')
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

  const labelCounts = new Map<string, number>()

  for (const node of snapshot.nodes) {
    if (node.type === 'note') continue

    // FILE
    if (node.type === 'file') {
      const d = node.data as FileNodeData
      const split = d.split
      if (split) {
        if (!split.axis || !split.axis.trim()) {
          issues.push({
            severity: 'error', nodeId: node.id,
            code: 'SPLIT_NO_AXIS',
            message: `File "${d.label}" has split enabled but no axis name.`,
            suggestion: 'Set an axis name (e.g., "chrom") in the Split section.',
          })
        }
        if (split.items.length === 0) {
          issues.push({
            severity: 'error', nodeId: node.id,
            code: 'EMPTY_SPLIT',
            message: `File "${d.label}" has split enabled but zero items.`,
            suggestion: 'Add items via the "Pick from glob" helper or enter manually.',
          })
        } else {
          for (const item of split.items) {
            if (!item.path.trim()) {
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
        if (d.isInput && !d.path.trim()) {
          issues.push({
            severity: 'error', nodeId: node.id,
            code: 'FILE_NODE_NO_PATH',
            message: `Input file "${d.label}" has no path.`,
            suggestion: 'Enter a remote path or use the file browser "Pick..." button.',
          })
        }
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
      for (const port of tool.inputs) {
        const edges = inMap.get(port.id)
        if (port.required && (!edges || edges.length === 0)) {
          issues.push({
            severity: 'error', nodeId: node.id, portId: port.id,
            code: 'MISSING_INPUT',
            message: `Tool "${d.label}" is missing required input "${port.label}".`,
            suggestion: `Connect a ${port.fileType} source to the "${port.label}" port.`,
          })
        }
        // Type compatibility — defensive; canvas usually blocks this.
        if (edges) {
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
      continue
    }
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
    return split?.axis || undefined
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
    return source?.type === 'file' && Boolean((source.data as FileNodeData).split?.items.length)
  })
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
  if (node.type === 'transform') {
    return (node.data as TransformNodeData).fileType
  }
  return null
}

/** Filter a validation result down to issues attached to one node. */
export function issuesForNode(result: ValidationResult, nodeId: string): ValidationIssue[] {
  return result.issues.filter((i) => i.nodeId === nodeId)
}
