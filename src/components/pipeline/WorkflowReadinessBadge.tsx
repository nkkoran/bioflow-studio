import { useEffect, useRef, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { useWorkflowReadinessStore } from '@/stores/readinessStore'
import type { WorkflowReadinessIssue, WorkflowReadinessReport } from '@/types/readiness'

export function WorkflowReadinessBadge() {
  const nodes = usePipelineStore((s) => s.nodes)
  const edges = usePipelineStore((s) => s.edges)
  const exportSnapshot = usePipelineStore((s) => s.exportSnapshot)
  const setSelectedNode = usePipelineStore((s) => s.setSelectedNode)
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const evaluateSnapshot = useWorkflowReadinessStore((s) => s.evaluateSnapshot)
  const loading = useWorkflowReadinessStore((s) => s.loading)

  const [report, setReport] = useState<WorkflowReadinessReport | null>(null)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setReport(null)
    setOpen(false)
  }, [nodes, edges])

  useEffect(() => {
    if (!open) return
    function onDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const handleEvaluate = async () => {
    if (!activeConnectionId) return
    const next = await evaluateSnapshot(activeConnectionId, exportSnapshot(), { force: true })
    setReport(next)
    setOpen(true)
  }

  if (!report) {
    return (
      <button
        onClick={() => void handleEvaluate()}
        disabled={!activeConnectionId || loading}
        className="inline-flex items-center gap-1.5 px-2 h-6 rounded text-[10px] font-medium text-text-muted hover:text-text-primary hover:bg-bg-tertiary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title="Check workflow readiness, file handoffs, and common file/schema issues"
      >
        {loading ? <Loader2 size={11} className="animate-spin" /> : <Activity size={11} />}
        Readiness
      </button>
    )
  }

  const errorCount = report.issues.filter((issue) => issue.severity === 'error').length
  const warningCount = report.issues.filter((issue) => issue.severity === 'warning').length
  const { Icon, bg, text, label } = (() => {
    if (errorCount > 0) {
      return { Icon: XCircle, bg: 'bg-error/15', text: 'text-error', label: `${errorCount} blocking` }
    }
    if (warningCount > 0) {
      return { Icon: AlertTriangle, bg: 'bg-warning/15', text: 'text-warning', label: `${warningCount} warning${warningCount === 1 ? '' : 's'}` }
    }
    return { Icon: CheckCircle2, bg: 'bg-success/10', text: 'text-success', label: 'Ready' }
  })()

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex items-center gap-1.5 px-2 h-6 rounded text-[10px] font-medium transition-colors ${bg} ${text} hover:brightness-125`}
        title="Workflow readiness — click to see details"
      >
        {loading ? <Loader2 size={11} className="animate-spin" /> : <Icon size={12} />}
        {label}
      </button>

      {open && (
        <div className="absolute top-full mt-1 left-0 z-50 w-[380px] max-h-[420px] overflow-auto bg-bg-secondary border border-border rounded-lg shadow-lg py-1">
          {report.issues.length === 0 ? (
            <div className="px-3 py-2 text-xs text-text-secondary">
              Workflow handoffs, required columns, and export coverage look ready.
            </div>
          ) : (
            Object.entries(groupByCategory(report.issues)).map(([category, issues]) => (
              issues.length === 0 ? null : (
                <div key={category}>
                  <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-text-muted border-b border-border-light">
                    {category} ({issues.length})
                  </div>
                  {issues.map((issue, index) => (
                    <ReadinessIssueRow
                      key={`${category}-${index}`}
                      issue={issue}
                      onJump={(nodeId) => {
                        if (nodeId) setSelectedNode(nodeId)
                        setOpen(false)
                      }}
                    />
                  ))}
                </div>
              )
            ))
          )}
        </div>
      )}
    </div>
  )
}

function ReadinessIssueRow({ issue, onJump }: { issue: WorkflowReadinessIssue; onJump: (nodeId?: string) => void }) {
  const color = issue.severity === 'error' ? 'text-error' : issue.severity === 'warning' ? 'text-warning' : 'text-accent'
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
          <button onClick={() => onJump(issue.nodeId)} className="text-[10px] text-accent hover:underline shrink-0">
            jump
          </button>
        )}
      </div>
    </div>
  )
}

function groupByCategory(issues: WorkflowReadinessIssue[]): Record<string, WorkflowReadinessIssue[]> {
  const groups: Record<string, WorkflowReadinessIssue[]> = {}
  for (const issue of issues) {
    if (!groups[issue.category]) groups[issue.category] = []
    groups[issue.category].push(issue)
  }
  return groups
}
