/**
 * Axis planner — decides per-node execution mode (single / array / fan-in),
 * resolves input paths by walking edges in topological order, and computes
 * the output paths downstream consumers will see.
 *
 * Pure function. No SSH, no filesystem. Testable in isolation.
 */
import type {
  PipelineSnapshot,
  ToolNodeData,
  FileNodeData,
  MergeNodeData,
  TransformNodeData,
  ToolDef,
  FileType,
  MergeStrategy,
} from '../../src/types/pipeline'
import { topoSort } from './topoSort'

export type AxedValue =
  | { kind: 'single'; path: string }
  | { kind: 'multi'; paths: string[] }
  | { kind: 'array'; axis: string; keys: string[]; paths: string[]; pathTemplate?: string }

export type NodeMode = 'single' | 'array' | 'fanIn' | 'skip'

export interface AxisPlan {
  nodeId: string
  nodeType: 'tool' | 'merge' | 'transform' | 'file' | 'note'
  mode: NodeMode
  /** For 'array': the axis being looped over. */
  axis?: string
  /** For 'array': ordered task keys (length = array size). */
  keys?: string[]
  /** For 'array': which input port's axis drives the fan-out. */
  arrayPortId?: string
  /** Upstream array producers whose jobIds we depend on (afterok). */
  dependsOnArrayNodeIds: string[]
  /** Resolved input paths per port (keyed by portId). */
  inputs: Record<string, AxedValue>
  /** What downstream consumers see for each output port. */
  outputs: Record<string, AxedValue>
  /** For merge nodes: inferred upstream file type (drives the `auto` strategy). */
  upstreamFileType?: FileType
  /** For merge nodes: the strategy resolved from `auto`. */
  resolvedMergeStrategy?: Exclude<MergeStrategy, 'auto'>
}

export class AxisPlanError extends Error {
  constructor(public code: string, public nodeId: string | null, message: string) {
    super(message)
    this.name = 'AxisPlanError'
  }
}

/** Extension to append to an output file for a given FileType. */
function extForFileType(ft: string): string {
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
    // PLINK filesets are prefix-based (no extension — plink2 appends .pgen/.pvar/.psam).
    case 'plink': return ''
    case 'pgen': return ''
    case 'bgen': return '.bgen'
    default: return ''
  }
}

/**
 * Resolve the per-node output directory. When an override is set, the node's
 * files land at `<override>/<slug>` so concurrent nodes don't collide on
 * shared names. Leading `~` / `~/` is expanded against the passed home so
 * downstream SFTP writes (which do NOT shell-expand) still work.
 */
export function resolveNodeOutputDir(
  override: string | undefined,
  defaultOutputRoot: string,
  slug: string,
  homeDir?: string,
): string {
  if (override && override.trim()) {
    const raw = override.trim().replace(/\/+$/, '')
    const absolute =
      homeDir && raw === '~' ? homeDir :
      homeDir && raw.startsWith('~/') ? `${homeDir}/${raw.slice(2)}` :
      raw
    return `${absolute}/${slug}`
  }
  return `${defaultOutputRoot}/${slug}`
}

/** Output path convention: <outputDir>/<slug>.<portId>[.<key>]<ext>. */
function outputPath(outputDir: string, slug: string, portId: string, key: string | null, ft: string): string {
  const ext = extForFileType(ft)
  const keyPart = key !== null ? `.${key}` : ''
  return `${outputDir}/${slug}.${portId}${keyPart}${ext}`
}

function outputPathFromTemplate(template: string, key: string | null): string {
  if (key === null) return template
  const slashIdx = template.lastIndexOf('/')
  const dotIdx = template.lastIndexOf('.')
  const insertIdx = dotIdx > slashIdx ? dotIdx : template.length
  return `${template.slice(0, insertIdx)}.${key}${template.slice(insertIdx)}`
}

function splitPathTemplate(split: NonNullable<FileNodeData['split']>): string | undefined {
  const pattern = split.pattern
  if (!pattern) return undefined
  if (pattern.kind === 'brace') {
    return pattern.template.replace(/\{[^{}]*\}/, '${KEY}')
  }
  if (pattern.kind === 'glob') {
    return pattern.template.includes('*') ? pattern.template.replace('*', '${KEY}') : undefined
  }
  if (pattern.kind === 'crossFolder') {
    if (!pattern.parentDir.trim() || !pattern.childGlob.trim() || !pattern.file.trim()) return undefined
    const child = pattern.childGlob.replace('*', '${KEY}').replace(/^\/+|\/+$/g, '')
    const file = pattern.file.replace(/^\/+/, '')
    return `${pattern.parentDir.replace(/\/+$/, '')}/${child}/${file}`
  }
  return undefined
}

function connectedOutputSink(
  snapshot: PipelineSnapshot,
  nodeId: string,
  portId: string,
): FileNodeData | null {
  const edge = snapshot.edges.find(
    (e) => e.source === nodeId && (e.sourceHandle ?? 'output') === portId,
  )
  if (!edge) return null
  const target = snapshot.nodes.find((n) => n.id === edge.target)
  if (!target || target.type !== 'file') return null
  const data = target.data as FileNodeData
  if (data.isInput) return null
  return data
}

function resolveSinkPath(sink: FileNodeData | null, fallbackDir: string, fallbackPath: string, homeDir?: string): string {
  if (!sink) return fallbackPath
  const legacyPath = sink.path?.trim() ?? ''
  const filename = sink.outputFilename?.trim() || pathBasename(legacyPath) || pathBasename(fallbackPath)
  const rawFolder = (sink.outputDir?.trim() || pathDirname(legacyPath) || fallbackDir).replace(/\/+$/, '')
  const folder =
    homeDir && rawFolder === '~' ? homeDir :
    homeDir && rawFolder.startsWith('~/') ? `${homeDir}/${rawFolder.slice(2)}` :
    rawFolder
  return `${folder}/${filename}`
}

function pathDirname(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return ''
  return path.slice(0, idx)
}

function pathBasename(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? path : path.slice(idx + 1)
}

export interface PlannerContext {
  /** Absolute remote output directory for the run (used for output path convention). */
  outputRoot: string
  /** Looks up a tool definition by id. */
  getTool: (toolId: string) => ToolDef | undefined
  /**
   * Optional human-readable slug for a node — used in output folder/file names
   * in place of the raw nodeId (e.g., "plink2-assoc-abc123" instead of
   * "node_abc12345"). If omitted, nodeId is used as-is.
   */
  nodeSlug?: (nodeId: string) => string
  /**
   * Resolved `$HOME` on the remote. Used to expand `~` / `~/…` in user-provided
   * outputDirOverride values before they cross the SFTP boundary.
   */
  homeDir?: string
}

export function planAxes(snapshot: PipelineSnapshot, ctx: PlannerContext): Map<string, AxisPlan> {
  const { order } = topoSort(snapshot)
  const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n]))

  // incoming[nodeId][targetHandle] = [{ source, sourceHandle }]
  const incoming = new Map<string, Map<string, Array<{ source: string; sourceHandle: string }>>>()
  for (const n of snapshot.nodes) incoming.set(n.id, new Map())
  for (const e of snapshot.edges) {
    const targetMap = incoming.get(e.target)
    if (!targetMap) continue
    const targetHandle = e.targetHandle ?? 'input'
    if (!targetMap.has(targetHandle)) targetMap.set(targetHandle, [])
    targetMap.get(targetHandle)!.push({ source: e.source, sourceHandle: e.sourceHandle ?? 'output' })
  }

  const plans = new Map<string, AxisPlan>()

  for (const nodeId of order) {
    const node = nodeById.get(nodeId)!
    const inEdges = incoming.get(nodeId)!

    if (node.type === 'note') {
      plans.set(nodeId, {
        nodeId, nodeType: 'note', mode: 'skip', dependsOnArrayNodeIds: [],
        inputs: {}, outputs: {},
      })
      continue
    }

    if (node.type === 'file') {
      const data = node.data as FileNodeData
      const plan: AxisPlan = {
        nodeId, nodeType: 'file', mode: 'skip', dependsOnArrayNodeIds: [],
        inputs: {}, outputs: {},
      }
      if (data.split && data.split.items.length > 0) {
        plan.outputs.output = {
          kind: 'array',
          axis: data.split.axis,
          keys: data.split.items.map((i) => i.key),
          paths: data.split.items.map((i) => i.path),
          pathTemplate: splitPathTemplate(data.split),
        }
      } else if (data.split && data.split.items.length === 0) {
        throw new AxisPlanError('EMPTY_SPLIT', nodeId, `File node "${data.label}" has split with zero items`)
      } else {
        plan.outputs.output = { kind: 'single', path: data.path }
      }
      plans.set(nodeId, plan)
      continue
    }

    // ----- runnable node (tool, transform, or merge) -----
    const dependsOnArrayNodeIds = new Set<string>()
    const resolvedInputs: Record<string, AxedValue> = {}

    // Helper — collapse one upstream AxedValue into a list of paths.
    const flattenUpstream = (upstream: AxedValue): { paths: string[]; producedByArrayNode?: string } => {
      if (upstream.kind === 'single') return { paths: [upstream.path] }
      if (upstream.kind === 'multi') return { paths: upstream.paths }
      return { paths: upstream.paths }
    }

    // Resolve each target port
    for (const [portId, edges] of inEdges) {
      // Gather upstream values
      const upstreams = edges.map((e) => {
        const upstreamPlan = plans.get(e.source)
        if (!upstreamPlan) throw new AxisPlanError('MISSING_UPSTREAM', nodeId, `Missing upstream plan for ${e.source}`)
        const val = upstreamPlan.outputs[e.sourceHandle]
        if (!val) throw new AxisPlanError('MISSING_UPSTREAM_PORT', nodeId, `Upstream ${e.source}.${e.sourceHandle} has no output value`)
        return { source: e.source, sourceHandle: e.sourceHandle, val, upstreamPlan }
      })

      // Determine whether the target port is multi
      const isMulti = portIsMulti(node, portId, ctx)

      if (!isMulti) {
        if (upstreams.length !== 1) {
          throw new AxisPlanError(
            'NON_MULTI_MULTIPLE_EDGES',
            nodeId,
            `Non-multi port "${portId}" on node ${nodeId} has ${upstreams.length} incoming edges`,
          )
        }
        const u = upstreams[0]
        resolvedInputs[portId] = u.val
        // Track dependency if upstream produced an array from this port
        if (u.val.kind === 'array') dependsOnArrayNodeIds.add(u.source)
      } else {
        // Multi port — flatten all upstreams into a single list. Any array upstream is collapsed.
        const allPaths: string[] = []
        for (const u of upstreams) {
          if (u.val.kind === 'array') {
            dependsOnArrayNodeIds.add(u.source)
            allPaths.push(...u.val.paths)
          } else if (u.val.kind === 'multi') {
            allPaths.push(...u.val.paths)
          } else {
            allPaths.push(u.val.path)
          }
        }
        resolvedInputs[portId] = { kind: 'multi', paths: allPaths }
      }
    }

    // Decide mode based on resolved inputs
    if (node.type === 'transform') {
      const data = node.data as TransformNodeData
      const input = resolvedInputs.input
      const slug = ctx.nodeSlug?.(nodeId) ?? nodeId
      const outputDir = resolveNodeOutputDir(data.outputDirOverride, ctx.outputRoot, slug, ctx.homeDir)
      const sink = connectedOutputSink(snapshot, nodeId, 'output')
      const fallbackOut = outputPath(outputDir, slug, 'output', null, data.fileType)
      if (input?.kind === 'array') {
        plans.set(nodeId, {
          nodeId,
          nodeType: 'transform',
          mode: 'array',
          axis: input.axis,
          keys: input.keys,
          arrayPortId: 'input',
          dependsOnArrayNodeIds: [...dependsOnArrayNodeIds],
          inputs: resolvedInputs,
          outputs: {
            output: {
              kind: 'array',
              axis: input.axis,
              keys: input.keys,
              paths: input.keys.map((key) =>
                outputPathFromTemplate(resolveSinkPath(sink, outputDir, fallbackOut, ctx.homeDir), key),
              ),
            },
          },
        })
      } else {
        plans.set(nodeId, {
          nodeId,
          nodeType: 'transform',
          mode: dependsOnArrayNodeIds.size > 0 ? 'fanIn' : 'single',
          dependsOnArrayNodeIds: [...dependsOnArrayNodeIds],
          inputs: resolvedInputs,
          outputs: {
            output: {
              kind: 'single',
              path: resolveSinkPath(sink, outputDir, fallbackOut, ctx.homeDir),
            },
          },
        })
      }
      continue
    }

    if (node.type === 'merge') {
      // Merge always collapses. If its input port is kind 'array', it's a fanIn.
      // Otherwise it's a trivial single job.
      const data = node.data as MergeNodeData
      const mode: NodeMode = dependsOnArrayNodeIds.size > 0 ? 'fanIn' : 'single'
      const upstreamFt = (inferMergeOutputType(node, resolvedInputs, snapshot, ctx) ?? 'any') as FileType
      const resolvedStrategy = resolveMergeStrategyStatic(data.strategy, upstreamFt)
      const outExt = mergeOutputExt(resolvedStrategy)
      const slug = ctx.nodeSlug?.(nodeId) ?? nodeId
      const mergeOutDir = resolveNodeOutputDir(data.outputDirOverride, ctx.outputRoot, slug, ctx.homeDir)
      const sink = connectedOutputSink(snapshot, nodeId, 'output')
      const fallbackOut = `${mergeOutDir}/${slug}.output${outExt}`
      const outPath = resolveSinkPath(sink, mergeOutDir, fallbackOut, ctx.homeDir)
      plans.set(nodeId, {
        nodeId,
        nodeType: 'merge',
        mode,
        dependsOnArrayNodeIds: [...dependsOnArrayNodeIds],
        inputs: resolvedInputs,
        outputs: { output: { kind: 'single', path: outPath } },
        upstreamFileType: upstreamFt,
        resolvedMergeStrategy: resolvedStrategy,
      })
      continue
    }

    // Tool node
    const toolData = node.data as ToolNodeData
    const tool = ctx.getTool(toolData.toolId)
    if (!tool) {
      throw new AxisPlanError('UNKNOWN_TOOL', nodeId, `Tool "${toolData.toolId}" not found in registry`)
    }

    // Find candidate axed ports: a non-multi port whose resolvedInput kind === 'array'
    const axedCandidates: Array<{ portId: string; axis: string; keys: string[]; paths: string[] }> = []
    for (const [portId, val] of Object.entries(resolvedInputs)) {
      const portDef = tool.inputs.find((p) => p.id === portId)
      if (!portDef) continue
      if (portDef.multi) continue // multi ports absorb axis (fanIn)
      if (portDef.arrayable === false) continue
      if (val.kind === 'array') {
        axedCandidates.push({ portId, axis: val.axis, keys: val.keys, paths: val.paths })
      }
    }

    let mode: NodeMode = 'single'
    let axis: string | undefined
    let keys: string[] | undefined
    let arrayPortId: string | undefined

    if (toolData.arrayOver === null) {
      // Explicit opt-out. If any axed candidate exists, it's ambiguous.
      if (axedCandidates.length > 0) {
        throw new AxisPlanError(
          'ARRAY_OVER_NULL_WITH_AXED',
          nodeId,
          `Node ${nodeId} has arrayOver=null but an axed input is connected; remove the split or change arrayOver`,
        )
      }
      mode = dependsOnArrayNodeIds.size > 0 ? 'fanIn' : 'single'
    } else if (toolData.arrayOver) {
      // Explicit port
      const picked = axedCandidates.find((c) => c.portId === toolData.arrayOver)
      if (!picked) {
        throw new AxisPlanError(
          'ARRAY_OVER_INVALID',
          nodeId,
          `arrayOver=${toolData.arrayOver} but no axed input on that port`,
        )
      }
      mode = 'array'
      axis = picked.axis
      keys = picked.keys
      arrayPortId = picked.portId
    } else {
      // Auto-detect
      if (axedCandidates.length === 0) {
        mode = dependsOnArrayNodeIds.size > 0 ? 'fanIn' : 'single'
      } else if (axedCandidates.length === 1) {
        const c = axedCandidates[0]
        mode = 'array'
        axis = c.axis
        keys = c.keys
        arrayPortId = c.portId
      } else {
        throw new AxisPlanError(
          'MULTIPLE_AXES_NO_CHOICE',
          nodeId,
          `Node ${nodeId} has ${axedCandidates.length} axed inputs; set arrayOver to pick one`,
        )
      }
    }

    // Compute outputs
    const outputs: Record<string, AxedValue> = {}
    const slug = ctx.nodeSlug?.(nodeId) ?? nodeId
    const perNodeOutputDir = resolveNodeOutputDir(toolData.outputDirOverride, ctx.outputRoot, slug, ctx.homeDir)
    for (const outPort of tool.outputs) {
      const sink = connectedOutputSink(snapshot, nodeId, outPort.id)
      const fallbackOut = outputPath(perNodeOutputDir, slug, outPort.id, null, outPort.fileType)
      if (mode === 'array' && keys) {
        outputs[outPort.id] = {
          kind: 'array',
          axis: axis!,
          keys,
          paths: keys.map((k) =>
            outputPathFromTemplate(resolveSinkPath(sink, perNodeOutputDir, fallbackOut, ctx.homeDir), k),
          ),
        }
      } else {
        outputs[outPort.id] = {
          kind: 'single',
          path: resolveSinkPath(sink, perNodeOutputDir, fallbackOut, ctx.homeDir),
        }
      }
    }

    plans.set(nodeId, {
      nodeId,
      nodeType: 'tool',
      mode,
      axis,
      keys,
      arrayPortId,
      dependsOnArrayNodeIds: [...dependsOnArrayNodeIds],
      inputs: resolvedInputs,
      outputs,
    })
  }

  return plans
}

function portIsMulti(
  node: PipelineSnapshot['nodes'][number],
  portId: string,
  ctx: PlannerContext,
): boolean {
  if (node.type === 'merge') {
    // Merge has a single, implicitly multi input port.
    return portId === 'input'
  }
  if (node.type === 'tool') {
    const toolData = node.data as ToolNodeData
    const tool = ctx.getTool(toolData.toolId)
    const portDef = tool?.inputs.find((p) => p.id === portId)
    return Boolean(portDef?.multi)
  }
  if (node.type === 'transform') {
    return false
  }
  return false
}

function resolveMergeStrategyStatic(strategy: MergeStrategy, ft: FileType): Exclude<MergeStrategy, 'auto'> {
  if (strategy !== 'auto') return strategy
  if (ft === 'tsv' || ft === 'csv') return 'tsv-concat-header'
  if (ft === 'vcf' || ft === 'bcf') return 'bcftools-concat'
  if (ft === 'plink' || ft === 'pgen') return 'plink-pmerge-list'
  return 'cat'
}

function mergeOutputExt(strategy: Exclude<MergeStrategy, 'auto'>): string {
  switch (strategy) {
    case 'bcftools-concat': return '.vcf.gz'
    case 'plink-pmerge-list': return ''
    case 'tsv-concat-header': return '.tsv'
    default: return '.txt'
  }
}

function inferMergeOutputType(
  _node: PipelineSnapshot['nodes'][number],
  _resolvedInputs: Record<string, AxedValue>,
  snapshot: PipelineSnapshot,
  ctx: PlannerContext,
): string | null {
  // Peek at the incoming edge's source port file type.
  const incomingEdge = snapshot.edges.find((e) => e.target === _node.id)
  if (!incomingEdge) return null
  const srcNode = snapshot.nodes.find((n) => n.id === incomingEdge.source)
  if (!srcNode) return null
  if (srcNode.type === 'file') {
    return (srcNode.data as FileNodeData).fileType
  }
  if (srcNode.type === 'tool') {
    const tool = ctx.getTool((srcNode.data as ToolNodeData).toolId)
    const port = tool?.outputs.find((p) => p.id === (incomingEdge.sourceHandle ?? 'output'))
    return port?.fileType ?? null
  }
  if (srcNode.type === 'transform') {
    return (srcNode.data as TransformNodeData).fileType
  }
  return null
}
