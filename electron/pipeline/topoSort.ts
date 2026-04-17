/**
 * Kahn's-algorithm topological sort for a pipeline snapshot.
 *
 * Returns layers of node ids: each layer is a set of nodes whose dependencies
 * all live in earlier layers, so nodes within a layer can be submitted in
 * parallel. `file` and `note` nodes are included in the layering so their
 * consumers can resolve upstream handles, but the runner will skip them.
 */
import type { PipelineSnapshot } from '../../src/types/pipeline'

export class CycleError extends Error {
  constructor(public cycleNodeIds: string[]) {
    super(`Pipeline contains a cycle involving: ${cycleNodeIds.join(' → ')}`)
    this.name = 'CycleError'
  }
}

export interface TopoResult {
  /** Layers ordered from sources to sinks. */
  layers: string[][]
  /** Flat topo order (layers flattened). */
  order: string[]
  /** Map nodeId → indegree at the start (useful for debugging). */
  indegree: Map<string, number>
}

export function topoSort(snapshot: PipelineSnapshot): TopoResult {
  const indegree = new Map<string, number>()
  const adj = new Map<string, string[]>()

  for (const n of snapshot.nodes) {
    indegree.set(n.id, 0)
    adj.set(n.id, [])
  }

  for (const e of snapshot.edges) {
    if (!indegree.has(e.source) || !indegree.has(e.target)) continue // dangling
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1)
    adj.get(e.source)!.push(e.target)
  }

  const liveIndegree = new Map(indegree) // mutated below
  const layers: string[][] = []
  let frontier = snapshot.nodes
    .filter((n) => (liveIndegree.get(n.id) ?? 0) === 0)
    .map((n) => n.id)

  let visited = 0
  while (frontier.length > 0) {
    layers.push(frontier)
    const nextFrontier: string[] = []
    for (const id of frontier) {
      visited++
      for (const succ of adj.get(id) ?? []) {
        const d = (liveIndegree.get(succ) ?? 0) - 1
        liveIndegree.set(succ, d)
        if (d === 0) nextFrontier.push(succ)
      }
    }
    frontier = nextFrontier
  }

  if (visited !== snapshot.nodes.length) {
    // Remaining nodes with indegree > 0 are in (or downstream of) a cycle.
    const stuck = snapshot.nodes.filter((n) => (liveIndegree.get(n.id) ?? 0) > 0).map((n) => n.id)
    throw new CycleError(stuck)
  }

  return {
    layers,
    order: layers.flat(),
    indegree,
  }
}
