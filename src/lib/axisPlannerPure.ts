import { getTool } from '@/lib/toolRegistry'
import { getActiveToolInputs } from '@/lib/analysisOptions'
import type { FileNodeData, PipelineSnapshot, ToolNodeData, TransformNodeData } from '@/types/pipeline'

export interface EdgeAxisChip {
  axis: string
  count: number
  label: string
}

interface AxisState {
  axis: string
  keys: string[]
}

/**
 * Renderer-safe subset of the axis planner for canvas decoration only.
 * It mirrors the runtime's fan-out/fan-in decision enough to show which edges
 * carry an axis, but does not compute paths or submit-time dependencies.
 */
export function edgeAxisChips(snapshot: PipelineSnapshot): Record<string, EdgeAxisChip> {
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]))
  const incoming = new Map<string, PipelineSnapshot['edges']>()
  for (const node of snapshot.nodes) incoming.set(node.id, [])
  for (const edge of snapshot.edges) {
    incoming.get(edge.target)?.push(edge)
  }

  const outputsByNode = new Map<string, Record<string, AxisState | null>>()

  for (const nodeId of topoOrder(snapshot)) {
    const node = nodeById.get(nodeId)
    if (!node) continue

    if (node.type === 'file') {
      const data = node.data as FileNodeData
      const split = data.split
      const rawSplitItems = (split as { items?: unknown } | undefined)?.items
      const splitItems = Array.isArray(rawSplitItems) ? rawSplitItems : []
      outputsByNode.set(nodeId, {
        output: split && splitItems.length > 0
          ? { axis: split.axis, keys: splitItems.map((item) => item.key) }
          : null,
      })
      continue
    }

    if (node.type === 'transform') {
      const data = node.data as TransformNodeData
      const inputAxis = inputAxisFor(nodeId, 'input', incoming, outputsByNode)
      outputsByNode.set(nodeId, {
        output: outputCarriesAxis(data, 'output') ? inputAxis : null,
      })
      continue
    }

    if (node.type === 'transfer') {
      outputsByNode.set(nodeId, {
        output: inputAxisFor(nodeId, 'input', incoming, outputsByNode),
      })
      continue
    }

    if (node.type === 'tool') {
      const data = node.data as ToolNodeData
      const tool = getTool(data.toolId)
      if (!tool) {
        outputsByNode.set(nodeId, {})
        continue
      }

      const candidates = getActiveToolInputs(tool, data).flatMap((port) => {
        if (port.multi || port.arrayable === false) return []
        const axis = inputAxisFor(nodeId, port.id, incoming, outputsByNode)
        return axis ? [{ portId: port.id, axis }] : []
      })

      let picked: AxisState | null = null
      if (data.arrayOver === null) {
        picked = null
      } else if (data.arrayOver) {
        picked = candidates.find((candidate) => candidate.portId === data.arrayOver)?.axis ?? null
      } else if (candidates.length === 1) {
        picked = candidates[0].axis
      }

      outputsByNode.set(
        nodeId,
        Object.fromEntries(tool.outputs.map((port) => [port.id, outputCarriesAxis(data, port.id, port.autoMergeDefault) ? picked : null])),
      )
      continue
    }

    // Merge, note, and output-only sinks do not emit an axis.
    outputsByNode.set(nodeId, {})
  }

  const chips: Record<string, EdgeAxisChip> = {}
  for (const edge of snapshot.edges) {
    const axis = outputAxisFor(edge.source, edge.sourceHandle ?? 'output', outputsByNode)
    if (!axis || axis.keys.length === 0) continue
    chips[edge.id] = {
      axis: axis.axis,
      count: axis.keys.length,
      label: `${axis.axis}×${axis.keys.length}`,
    }
  }
  return chips
}

function inputAxisFor(
  nodeId: string,
  portId: string,
  incoming: Map<string, PipelineSnapshot['edges']>,
  outputsByNode: Map<string, Record<string, AxisState | null>>,
): AxisState | null {
  const matches = (incoming.get(nodeId) ?? []).filter((edge) => (edge.targetHandle ?? 'input') === portId)
  if (matches.length !== 1) return null
  return outputAxisFor(matches[0].source, matches[0].sourceHandle ?? 'output', outputsByNode)
}

function outputAxisFor(
  nodeId: string,
  portId: string,
  outputsByNode: Map<string, Record<string, AxisState | null>>,
): AxisState | null {
  return outputsByNode.get(nodeId)?.[portId] ?? null
}

function outputCarriesAxis(
  data: Pick<ToolNodeData | TransformNodeData, 'outputMerge'>,
  portId: string,
  autoMergeDefault?: unknown,
): boolean {
  const explicit = data.outputMerge?.[portId]
  if (explicit) return explicit.mode !== 'auto-merge'
  return !autoMergeDefault
}

function topoOrder(snapshot: PipelineSnapshot): string[] {
  const indegree = new Map<string, number>()
  const adj = new Map<string, string[]>()

  for (const node of snapshot.nodes) {
    indegree.set(node.id, 0)
    adj.set(node.id, [])
  }

  for (const edge of snapshot.edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    adj.get(edge.source)?.push(edge.target)
  }

  const order: string[] = []
  const frontier = snapshot.nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id)

  for (let i = 0; i < frontier.length; i++) {
    const id = frontier[i]
    order.push(id)
    for (const next of adj.get(id) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1
      indegree.set(next, degree)
      if (degree === 0) frontier.push(next)
    }
  }

  // Cycles are validator territory. Preserve stable rendering by appending any
  // unvisited nodes without axis propagation instead of throwing during paint.
  if (order.length !== snapshot.nodes.length) {
    const seen = new Set(order)
    for (const node of snapshot.nodes) {
      if (!seen.has(node.id)) order.push(node.id)
    }
  }

  return order
}
