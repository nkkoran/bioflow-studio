/**
 * Note node — a sticky-note style annotation on the canvas.
 * Does not participate in data flow (no handles).
 */
import { memo } from 'react'
import { type NodeProps } from '@xyflow/react'
import { classNames } from '@/lib/utils'
import { StickyNote } from 'lucide-react'
import type { NoteNodeData } from '@/types/pipeline'

function NoteNodeInner({ data, selected }: NodeProps) {
  const nodeData = data as NoteNodeData

  return (
    <div
      className={classNames(
        'animate-fade-up rounded-lg px-3 py-2 min-w-[160px] max-w-[320px] text-xs transition-all duration-150 ease-out',
        selected && 'translate-y-[-2px] ring-2 ring-accent/45',
      )}
      style={{
        background: (nodeData.color ?? '#fbbf24') + '33', // 20% opacity
        boxShadow: selected ? 'var(--shadow-node-selected)' : 'var(--shadow-node)',
      }}
    >
      <div className="flex items-start gap-2">
        <StickyNote size={12} className="shrink-0 mt-0.5 text-amber-400" />
        <div className="text-wrap flex-1 whitespace-pre-wrap text-text-primary">
          {nodeData.text}
        </div>
      </div>
    </div>
  )
}

export const NoteNode = memo(NoteNodeInner)
