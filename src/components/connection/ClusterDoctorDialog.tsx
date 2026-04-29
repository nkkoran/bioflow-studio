import { useEffect } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, ShieldAlert } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { doctorReportKey, useClusterDoctorStore } from '@/stores/clusterDoctorStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { ClusterDoctorCheck, ClusterDoctorReport } from '@/types/workspace'

interface ClusterDoctorDialogProps {
  open: boolean
  onClose: () => void
  connectionId: string | null
  report?: ClusterDoctorReport | null
}

export function ClusterDoctorDialog({ open, onClose, connectionId, report }: ClusterDoctorDialogProps) {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const reportKey = connectionId ? doctorReportKey(connectionId, activeWorkspaceId) : ''
  const cachedReport = useClusterDoctorStore((s) => (reportKey ? s.reports[reportKey] : undefined))
  const loading = useClusterDoctorStore((s) => (reportKey ? s.loadingByConnection[reportKey] : false))
  const runReport = useClusterDoctorStore((s) => s.runReport)
  const activeReport = report ?? cachedReport ?? null

  useEffect(() => {
    if (!open || !connectionId || report) return
    void runReport(connectionId).catch((err) => {
      console.error('[ClusterDoctorDialog] report failed:', err)
    })
  }, [connectionId, open, report, runReport])

  const errors = activeReport?.checks.filter((check) => check.status === 'error').length ?? 0
  const warnings = activeReport?.checks.filter((check) => check.status === 'warning').length ?? 0

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Cluster Readiness Doctor"
      width="max-w-3xl"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {connectionId && (
            <Button variant="primary" onClick={() => void runReport(connectionId, { force: true })} disabled={loading}>
              {loading ? 'Running...' : 'Run checks again'}
            </Button>
          )}
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-border bg-bg-tertiary/40 px-4 py-3">
          <div className="flex items-center gap-2 text-sm text-text-primary">
            <ShieldAlert size={16} className="text-accent" />
            BioFlow checks the connection, Slurm commands, analysis folder, and tool paths before you launch a run.
          </div>
          {activeReport && (
            <div className="mt-2 flex items-center gap-3 text-xs text-text-muted">
              <span>{activeReport.checks.length} checks</span>
              <span>{errors} blocking</span>
              <span>{warnings} warning{warnings === 1 ? '' : 's'}</span>
              <span>Last updated {new Date(activeReport.createdAt).toLocaleTimeString()}</span>
            </div>
          )}
        </div>

        {loading && !activeReport && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-text-muted">
            <Loader2 size={16} className="animate-spin" />
            Running cluster checks...
          </div>
        )}

        {activeReport && (
          <div className="flex flex-col gap-2">
            {activeReport.checks.map((check) => (
              <DoctorCheckRow key={check.id} check={check} />
            ))}
          </div>
        )}
      </div>
    </Dialog>
  )
}

function DoctorCheckRow({ check }: { check: ClusterDoctorCheck }) {
  const Icon = check.status === 'pass' ? CheckCircle2 : AlertTriangle
  const tone = check.status === 'pass'
    ? 'border-success/30 bg-success/10 text-success'
    : check.status === 'error'
      ? 'border-error/30 bg-error/10 text-error'
      : 'border-warning/30 bg-warning/10 text-warning'

  return (
    <div className={`rounded-lg border px-3 py-3 ${tone}`}>
      <div className="flex items-start gap-3">
        <Icon size={16} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{check.title}</span>
            <span className="rounded-full bg-black/10 px-2 py-0.5 text-[10px] uppercase tracking-wide">
              {check.severity}
            </span>
          </div>
          <div className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-text-primary">{check.detail}</div>
          {check.suggestion && (
            <div className="mt-2 text-[11px] leading-relaxed text-text-muted">
              Next step: {check.suggestion}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
