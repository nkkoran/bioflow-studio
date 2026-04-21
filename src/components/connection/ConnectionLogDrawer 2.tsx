import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import type { SshDebugEvent } from '@/types/ssh'
import { classNames } from '@/lib/utils'

const MAX_EVENTS = 500

interface Props {
  open: boolean
  onClose: () => void
  connectionId?: string | null
}

export function ConnectionLogDrawer({ open, onClose, connectionId }: Props) {
  const [events, setEvents] = useState<SshDebugEvent[]>([])

  useEffect(() => {
    if (!window.api.ssh.onDebug) return
    return window.api.ssh.onDebug((event) => {
      setEvents((prev) => [...prev, event].slice(-MAX_EVENTS))
    })
  }, [])

  const visible = useMemo(
    () => connectionId ? events.filter((event) => event.connectionId === connectionId) : events,
    [connectionId, events],
  )

  if (!open) return null

  return (
    <div className="fixed inset-y-0 right-0 z-[80] flex">
      <button
        className="w-screen bg-black/30"
        aria-label="Close connection log"
        onClick={onClose}
      />
      <div className="h-full w-[420px] max-w-[90vw] border-l border-border bg-bg-secondary shadow-2xl">
        <div className="flex h-10 items-center justify-between border-b border-border px-3">
          <div>
            <div className="text-sm font-semibold text-text-primary">SSH diagnostic log</div>
            <div className="text-[10px] text-text-muted">{visible.length} events</div>
          </div>
          <button className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="h-[calc(100%-2.5rem)] overflow-y-auto p-3 font-mono text-[11px]">
          {visible.length === 0 ? (
            <div className="rounded border border-border bg-bg-tertiary px-3 py-2 font-sans text-xs text-text-muted">
              Connect or reconnect to capture auth, banner, prompt, and error events.
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {visible.map((event, idx) => (
                <div key={`${event.at}-${idx}`} className="rounded border border-border bg-bg-primary px-2 py-1.5">
                  <div className="mb-1 flex items-center gap-2">
                    <span className={classNames('rounded px-1.5 py-0.5 text-[10px]', stageClass(event.stage))}>
                      {event.stage}
                    </span>
                    <span className="text-text-muted">{new Date(event.at).toLocaleTimeString()}</span>
                  </div>
                  <div className="whitespace-pre-wrap break-words text-text-secondary">{event.detail}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function stageClass(stage: SshDebugEvent['stage']): string {
  switch (stage) {
    case 'error': return 'bg-error/15 text-error'
    case 'prompt': return 'bg-warning/15 text-warning'
    case 'banner': return 'bg-accent/10 text-accent'
    case 'auth': return 'bg-blue-500/15 text-blue-300'
    default: return 'bg-bg-tertiary text-text-muted'
  }
}
