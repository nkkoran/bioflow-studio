import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type React from 'react'
import type { ToolDef } from '@/types/pipeline'
import { iconForCategory } from '@/lib/toolIcons'

interface Props {
  tool: ToolDef
  connectedPorts?: number
  disabled?: boolean
  children: React.ReactNode
}

export function ToolHoverCard({ tool, connectedPorts = 0, disabled = false, children }: Props) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const totalPorts = tool.inputs.length + tool.outputs.length
  const Icon = iconForCategory(tool.category)

  useEffect(() => {
    if (!disabled) return
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
    setOpen(false)
  }, [disabled])

  const show = (event: React.MouseEvent<HTMLDivElement>) => {
    if (disabled) return
    const rect = event.currentTarget.getBoundingClientRect()
    const width = 288
    const left = Math.min(window.innerWidth - width - 12, rect.right + 8)
    setPos({
      left: Math.max(12, left),
      top: Math.max(12, Math.min(window.innerHeight - 190, rect.top + 8)),
    })
    timer.current = setTimeout(() => setOpen(true), 400)
  }
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
    setOpen(false)
  }

  return (
    <div className="relative" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {open && createPortal(
        <div
          className="pointer-events-none fixed z-[90] w-72 rounded-md border border-border bg-bg-secondary p-3 text-xs shadow-xl"
          style={{ left: pos.left, top: pos.top }}
        >
          <div className="mb-1 flex items-center gap-2 text-text-primary">
            <Icon size={14} className="text-accent" />
            <span className="font-semibold">{tool.name}</span>
          </div>
          <div className="mb-2 leading-relaxed text-text-muted">{tool.description}</div>
          <div className="grid grid-cols-3 gap-2 rounded border border-border bg-bg-tertiary p-2 text-[10px] text-text-secondary">
            <div><span className="block text-text-muted">CPUs</span>{tool.slurm?.cpus ?? 1}</div>
            <div><span className="block text-text-muted">Memory</span>{tool.slurm?.memoryGB ?? 4}G</div>
            <div><span className="block text-text-muted">Time</span>{tool.slurm?.timeHours ?? 1}h</div>
          </div>
          <div className="mt-2 text-[10px] text-text-muted">
            {connectedPorts}/{totalPorts} ports connected
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
