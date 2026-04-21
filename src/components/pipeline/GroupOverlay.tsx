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
  onToggleCollapse,
}: {
  groups: NodeGroup[]
  nodes: BioflowNode[]
  onContextMenu: (event: React.MouseEvent, group: NodeGroup) => void
  onToggleCollapse: (group: NodeGroup) => void
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
        const status = groupStatus(members)
        const axisSummary = group.axisSummary ?? summarizeGroupAxis(members)
        if (group.kind === 'visual' && group.collapsed) {
          return (
            <div
              key={group.id}
              className={`pointer-events-auto absolute w-[210px] rounded border bg-bg-secondary/95 shadow-lg ${STATUS_COLORS[status] ?? STATUS_COLORS.idle}`}
              style={{ left: minX, top: minY, minHeight: 56 }}
              onContextMenu={(event) => onContextMenu(event, group)}
            >
              <button
                type="button"
                className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left"
                onClick={() => onToggleCollapse(group)}
              >
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-text-primary">{group.label}</div>
                  <div className="mt-0.5 text-[10px] text-text-muted">
                    {members.length} node{members.length === 1 ? '' : 's'}{axisSummary ? ` · ${axisSummary}` : ''}
                  </div>
                </div>
                <span className="text-[10px] text-accent">Expand</span>
              </button>
            </div>
          )
        }
        return (
          <div
            key={group.id}
            className={`pointer-events-auto absolute rounded border-2 border-dashed bg-bg-secondary/10 ${STATUS_COLORS[status] ?? STATUS_COLORS.idle}`}
            style={{ left: minX, top: minY, width: maxX - minX, height: maxY - minY }}
            onContextMenu={(event) => onContextMenu(event, group)}
          >
            <div className="absolute -top-6 left-2 flex items-center gap-2 rounded border border-border bg-bg-secondary px-2 py-0.5 text-[10px] text-text-secondary shadow">
              <span>{group.label}</span>
              <span>{members.length}</span>
              {axisSummary && <span className="text-accent">{axisSummary}</span>}
              {group.kind === 'visual' && (
                <button type="button" className="text-accent hover:underline" onClick={() => onToggleCollapse(group)}>
                  Collapse
                </button>
              )}
            </div>
          </div>
        )
      })}
    </ViewportPortal>
  )
}

function groupStatus(members: BioflowNode[]): string {
  const statuses = members.map((member) => String((member.data as { status?: string }).status ?? 'idle'))
  if (statuses.some((status) => status === 'failed')) return 'failed'
  if (statuses.some((status) => status === 'running')) return 'running'
  if (statuses.some((status) => status === 'queued')) return 'queued'
  if (statuses.every((status) => status === 'done')) return 'done'
  if (statuses.some((status) => status === 'cancelled')) return 'cancelled'
  return 'idle'
}

function summarizeGroupAxis(members: BioflowNode[]): string {
  const axis = members
    .filter((member) => member.type === 'file')
    .map((member) => (member.data as { split?: { axis?: string; items?: Array<unknown> } }).split)
    .find((split) => split?.axis && (split.items?.length ?? 0) > 1)
  if (!axis?.axis) return ''
  return `${axis.axis}×${axis.items?.length ?? 0}`
}
