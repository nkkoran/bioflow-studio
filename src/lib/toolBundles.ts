import type { Edge } from '@xyflow/react'
import { getTool } from '@/lib/toolRegistry'
import type { BioflowNode } from '@/stores/pipelineStore'

type BundleNode = BioflowNode

export interface ToolBundle {
  id: string
  label: string
  description: string
  build: (position: { x: number; y: number }) => { nodes: BundleNode[]; edges: Edge[] }
}

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function defaultParamValues(toolId: string): Record<string, unknown> {
  const tool = getTool(toolId)
  if (!tool) return {}
  const values: Record<string, unknown> = {}
  for (const param of tool.params) {
    if (param.default !== undefined) values[param.name] = param.default
  }
  return values
}

export const TOOL_BUNDLES: ToolBundle[] = [
  {
    id: 'grs.withClumping',
    label: 'GRS with clumping',
    description: 'PLINK2 clumping followed by score calculation with clumped ranges wired into --extract.',
    build: (position) => {
      const clumpId = makeId('node')
      const scoreId = makeId('node')
      const clump = getTool('plink2.clump')
      const score = getTool('plink2.score')
      const nodes: BundleNode[] = [
        {
          id: clumpId,
          type: 'tool',
          position,
          data: {
            toolId: 'plink2.clump',
            label: clump?.name ?? 'PLINK2 Clump',
            paramValues: defaultParamValues('plink2.clump'),
            status: 'idle',
          },
        },
        {
          id: scoreId,
          type: 'tool',
          position: { x: position.x + 460, y: position.y + 20 },
          data: {
            toolId: 'plink2.score',
            label: score?.name ?? 'PLINK2 Score / GRS',
            paramValues: defaultParamValues('plink2.score'),
            status: 'idle',
          },
        },
      ]
      const edges: Edge[] = [
        {
          id: makeId('edge'),
          source: clumpId,
          sourceHandle: 'ranges',
          target: scoreId,
          targetHandle: 'extract',
          animated: false,
        },
      ]
      return { nodes, edges }
    },
  },
]

export function getToolBundle(id: string): ToolBundle | undefined {
  return TOOL_BUNDLES.find((bundle) => bundle.id === id)
}
