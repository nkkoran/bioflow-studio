import { useEffect, useRef } from 'react'
import type { ToolPort, FileType } from '@/types/pipeline'
import { areTypesCompatible } from '@/lib/toolRegistry'

export interface PortPickerState {
  x: number
  y: number
  ports: ToolPort[]
  droppedType: FileType | 'any'
  /** Ports that are already connected and not multi — shown but disabled. */
  occupiedPortIds: Set<string>
  onPick: (portId: string) => void
  onDismiss: () => void
}

export function PortPickerPopover({ state }: { state: PortPickerState }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') state.onDismiss()
    }
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) state.onDismiss()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [state])

  return (
    <div
      ref={ref}
      className="fixed z-50 w-64 bg-bg-secondary border border-border rounded-lg shadow-xl p-1"
      style={{ left: state.x, top: state.y }}
    >
      <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-text-muted border-b border-border mb-1">
        Connect to input
      </div>
      {state.ports.length === 0 && (
        <div className="px-3 py-2 text-xs text-text-muted">No input ports</div>
      )}
      {state.ports.map((port) => {
        const typeOk = areTypesCompatible(state.droppedType, port.fileType)
        const occupied = state.occupiedPortIds.has(port.id) && !port.multi
        const disabled = !typeOk || occupied
        const reason = !typeOk
          ? `expects ${port.fileType}`
          : occupied
            ? 'already connected'
            : null
        return (
          <button
            key={port.id}
            disabled={disabled}
            onClick={() => {
              if (disabled) return
              state.onPick(port.id)
            }}
            className={`w-full text-left px-3 py-1.5 rounded text-sm flex items-center justify-between gap-2 ${
              disabled
                ? 'text-text-muted cursor-not-allowed opacity-60'
                : 'text-text-primary hover:bg-bg-hover'
            }`}
          >
            <span className="truncate">
              {port.label}
              {port.required && <span className="text-error ml-1">*</span>}
            </span>
            <span className="text-[10px] font-mono text-text-muted shrink-0">
              {reason ?? port.fileType}
            </span>
          </button>
        )
      })}
    </div>
  )
}
