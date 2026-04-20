import { useMemo, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { useConnectionStore } from '@/stores/connectionStore'
import { useSettingsStore } from '@/stores/settingsStore'

export function LoginPolicyToast() {
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const connections = useConnectionStore((s) => s.connections)
  const loginPolicy = useConnectionStore((s) => s.loginPolicy)
  const threshold = useSettingsStore((s) => s.settings.clusterLoginPolicyWarnSeconds)
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())

  const warning = useMemo(() => {
    if (!activeConnectionId || threshold <= 0 || dismissed.has(activeConnectionId)) return null
    const entry = connections[activeConnectionId]
    const policy = loginPolicy[activeConnectionId]
    if (!entry || entry.isLocal || !policy?.cpuTimeLimitSeconds) return null
    if (policy.cpuTimeLimitSeconds >= threshold) return null
    return { entry, policy }
  }, [activeConnectionId, connections, dismissed, loginPolicy, threshold])

  if (!activeConnectionId || !warning) return null

  return (
    <div className="fixed right-4 top-14 z-50 w-[360px] max-w-[calc(100vw-2rem)] rounded-md border border-warning/40 bg-bg-secondary p-3 shadow-xl">
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-primary">Login-node limit detected</div>
          <div className="mt-1 text-xs leading-5 text-text-secondary">
            {warning.policy.hostname || warning.entry.config.host} reports a CPU time limit of{' '}
            <span className="font-mono text-warning">{formatSeconds(warning.policy.cpuTimeLimitSeconds ?? 0)}</span>.
            Keep real pipeline work on Slurm; login-node mode is best for quick setup checks.
          </div>
          {warning.policy.memLimitMB && (
            <div className="mt-1 text-[11px] text-text-muted">
              Memory limit: {formatMemory(warning.policy.memLimitMB)}
            </div>
          )}
        </div>
        <button
          type="button"
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary"
          title="Dismiss"
          onClick={() => {
            setDismissed((current) => {
              const next = new Set(current)
              next.add(activeConnectionId)
              return next
            })
          }}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return `${hours}h`
}

function formatMemory(mb: number): string {
  if (mb < 1024) return `${mb} MB`
  const gb = mb / 1024
  return `${Number.isInteger(gb) ? gb.toFixed(0) : gb.toFixed(1)} GB`
}
