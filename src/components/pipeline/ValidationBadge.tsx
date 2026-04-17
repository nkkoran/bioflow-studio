/**
 * ValidationBadge — compact badge in PipelineToolbar showing overall pipeline
 * health. Click opens a dropdown grouping issues by severity with a "jump to
 * node" action that selects the offending node on the canvas.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, AlertTriangle, XCircle, Info } from 'lucide-react'
import { usePipelineStore } from '@/stores/pipelineStore'
import { validatePipeline, type ValidationIssue, type ValidationSeverity } from '@/lib/pipelineValidator'

export function ValidationBadge() {
  const nodes = usePipelineStore((s) => s.nodes)
  const edges = usePipelineStore((s) => s.edges)
  const exportSnapshot = usePipelineStore((s) => s.exportSnapshot)
  const setSelectedNode = usePipelineStore((s) => s.setSelectedNode)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const result = useMemo(() => validatePipeline(exportSnapshot()), [nodes, edges, exportSnapshot])

  // Close the dropdown on outside click.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const { errorCount, warningCount, infoCount } = result

  // Choose badge style based on worst severity present.
  const { Icon, bg, text, label } = (() => {
    if (errorCount > 0)
      return { Icon: XCircle, bg: 'bg-error/15', text: 'text-error', label: `${errorCount} error${errorCount === 1 ? '' : 's'}` }
    if (warningCount > 0)
      return { Icon: AlertTriangle, bg: 'bg-warning/15', text: 'text-warning', label: `${warningCount} warning${warningCount === 1 ? '' : 's'}` }
    if (infoCount > 0)
      return { Icon: Info, bg: 'bg-accent/10', text: 'text-accent', label: `${infoCount} note${infoCount === 1 ? '' : 's'}` }
    return { Icon: CheckCircle2, bg: 'bg-success/10', text: 'text-success', label: 'Valid' }
  })()

  // Group issues for the dropdown body.
  const groups = useMemo(() => groupBySeverity(result.issues), [result])

  const handleJump = (nodeId?: string) => {
    if (nodeId) setSelectedNode(nodeId)
    setOpen(false)
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 px-2 h-6 rounded text-[10px] font-medium transition-colors ${bg} ${text} hover:brightness-125`}
        title="Pipeline validation"
      >
        <Icon size={12} />
        {label}
      </button>

      {open && result.issues.length > 0 && (
        <div className="absolute top-full mt-1 left-0 z-50 w-[360px] max-h-[420px] overflow-auto bg-bg-secondary border border-border rounded-lg shadow-lg py-1">
          {(['error', 'warning', 'info'] as const).map((sev) => {
            const list = groups[sev]
            if (list.length === 0) return null
            return (
              <div key={sev}>
                <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-text-muted border-b border-border-light">
                  {sev}s ({list.length})
                </div>
                {list.map((issue, i) => (
                  <IssueRow key={`${sev}-${i}`} issue={issue} onJump={handleJump} />
                ))}
              </div>
            )
          })}
        </div>
      )}

      {open && result.issues.length === 0 && (
        <div className="absolute top-full mt-1 left-0 z-50 w-[260px] bg-bg-secondary border border-border rounded-lg shadow-lg px-3 py-2 text-xs text-text-secondary">
          No issues — ready to run.
        </div>
      )}
    </div>
  )
}

function IssueRow({
  issue,
  onJump,
}: {
  issue: ValidationIssue
  onJump: (nodeId?: string) => void
}) {
  const color =
    issue.severity === 'error' ? 'text-error'
    : issue.severity === 'warning' ? 'text-warning'
    : 'text-accent'
  return (
    <div className="px-3 py-2 border-b border-border-light/50 last:border-0">
      <div className="flex items-start gap-2">
        <span className={`text-[10px] font-mono ${color}`}>{issue.code}</span>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-text-primary leading-tight">{issue.message}</div>
          {issue.suggestion && (
            <div className="text-[10px] text-text-muted mt-0.5 leading-snug">{issue.suggestion}</div>
          )}
        </div>
        {issue.nodeId && (
          <button
            onClick={() => onJump(issue.nodeId)}
            className="text-[10px] text-accent hover:underline shrink-0"
          >
            jump
          </button>
        )}
      </div>
    </div>
  )
}

function groupBySeverity(issues: ValidationIssue[]): Record<ValidationSeverity, ValidationIssue[]> {
  const groups: Record<ValidationSeverity, ValidationIssue[]> = { error: [], warning: [], info: [] }
  for (const i of issues) groups[i.severity].push(i)
  return groups
}
