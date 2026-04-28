import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'

import { useDnxStore } from '@/stores/dnxStore'
import { useUIStore } from '@/stores/uiStore'

/**
 * Floating top banner that surfaces unrecoverable DNAnexus bridge errors.
 * Without this, errors only appeared inside Settings — users running a DNX
 * pipeline could have no idea their bridge had died.
 */
export function DnxBridgeBanner() {
  const bridgeStatus = useDnxStore((s) => s.bridgeStatus)
  const openSettings = useUIStore((s) => s.openSettings)
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)

  // Build a stable key per-message so dismissing one doesn't hide future errors.
  const key = bridgeStatus && bridgeStatus.level === 'error'
    ? `${bridgeStatus.code ?? 'ERROR'}:${bridgeStatus.message}`
    : null

  // Reset dismissal when a new error arrives.
  useEffect(() => {
    if (key && key !== dismissedKey) setDismissedKey(null)
  }, [key, dismissedKey])

  if (!bridgeStatus || bridgeStatus.level !== 'error') return null
  if (key && key === dismissedKey) return null

  return (
    <div className="fixed left-1/2 top-12 z-[70] -translate-x-1/2 w-[min(560px,calc(100%-2rem))] rounded-lg border border-error/40 bg-bg-secondary/95 px-4 py-2 shadow-2xl backdrop-blur-sm">
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-error" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-text-primary">
            DNAnexus bridge problem
            {bridgeStatus.code && (
              <span className="ml-2 font-mono text-[10px] text-text-muted">{bridgeStatus.code}</span>
            )}
          </div>
          <div className="mt-0.5 line-clamp-2 text-[11px] text-text-secondary">{bridgeStatus.message}</div>
          <div className="mt-1.5 flex items-center gap-3">
            <button
              type="button"
              onClick={() => openSettings('DNAnexus')}
              className="text-[11px] text-accent hover:underline"
            >
              Open DNAnexus settings
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDismissedKey(key)}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary"
          title="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  )
}
