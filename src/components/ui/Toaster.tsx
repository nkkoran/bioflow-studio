import { useEffect, useState } from 'react'
import { CheckCircle2, XCircle, Info } from 'lucide-react'

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastDetail {
  kind?: ToastKind
  message: string
  durationMs?: number
}

interface Toast extends ToastDetail {
  id: number
}

let nextId = 1

export function showToast(detail: ToastDetail): void {
  window.dispatchEvent(new CustomEvent('bioflow:toast', { detail }))
}

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ToastDetail>).detail
      if (!detail || !detail.message) return
      const id = nextId++
      const duration = detail.durationMs ?? 4500
      setToasts((current) => [...current, { id, kind: detail.kind ?? 'info', message: detail.message, durationMs: duration }])
      window.setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id))
      }, duration)
    }
    window.addEventListener('bioflow:toast', handler as EventListener)
    return () => window.removeEventListener('bioflow:toast', handler as EventListener)
  }, [])

  if (toasts.length === 0) return null

  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-[200] flex flex-col gap-2">
      {toasts.map((toast) => {
        const Icon = toast.kind === 'success' ? CheckCircle2 : toast.kind === 'error' ? XCircle : Info
        const tone =
          toast.kind === 'success' ? 'border-success/50 text-text-primary' :
          toast.kind === 'error' ? 'border-error/60 text-text-primary' :
          'border-border text-text-primary'
        return (
          <div
            key={toast.id}
            className={`pointer-events-auto flex max-w-sm items-start gap-2 rounded-md border ${tone} bg-bg-secondary px-3 py-2 text-xs shadow-xl`}
          >
            <Icon size={14} className={toast.kind === 'success' ? 'text-success mt-0.5' : toast.kind === 'error' ? 'text-error mt-0.5' : 'text-accent mt-0.5'} />
            <div className="flex-1 leading-snug">{toast.message}</div>
            <button
              type="button"
              className="text-text-muted hover:text-text-primary"
              onClick={() => setToasts((current) => current.filter((t) => t.id !== toast.id))}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
