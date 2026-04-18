import { ViewportPortal } from '@xyflow/react'
import type React from 'react'
import type { BioflowNode } from '@/stores/pipelineStore'
import type { NodeGroup } from '@/types/pipeline'

const STATUS_COLORS: Record<string, string> = {
  idle: 'border-text-muted/50',
  queued: 'border-yellow-400/70',
  running: 'border-blue-400/70',
  done: 'border-green-400/70',
  failed: 'border-red-400/70',
  cancelled: 'border-text-muted/60',
}

export function GroupOverlay({
  groups,
  nodes,
  onContextMenu,
}: {
  groups: NodeGroup[]
  nodes: BioflowNode[]
  onContextMenu: (event: React.MouseEvent, group: NodeGroup) => void
}) {
  if (groups.length === 0) return null
  return (
    <ViewportPortal>
      {groups.map((group) => {
        const members = group.nodeIds.map((id) => nodes.find((node) => node.id === id)).filter(Boolean) as BioflowNode[]
        if (members.length === 0) return null
        const minX = Math.min(...members.map((node) => node.position.x)) - 18
        const minY = Math.min(...members.map((node) => node.position.y)) - 32
        const maxX = Math.max(...members.map((node) => node.position.x + (node.width ?? 220))) + 18
        const maxY = Math.max(...members.map((node) => node.position.y + (node.height ?? 150))) + 18
        const status = String((members[0]?.data as any)?.status ?? 'idle')
        return (
          <div
            key={group.id}
            className={`pointer-events-auto absolute rounded border-2 border-dashed bg-bg-secondary/10 ${STATUS_COLORS[status] ?? STATUS_COLORS.idle}`}
            style={{ left: minX, top: minY, width: maxX - minX, height: maxY - minY }}
            onContextMenu={(event) => onContextMenu(event, group)}
          >
            <div className="absolute -top-5 left-2 rounded border border-border bg-bg-secondary px-2 py-0.5 text-[10px] text-text-secondary shadow">
              {group.label}
            </div>
          </div>
        )
      })}
    </ViewportPortal>
  )
}
