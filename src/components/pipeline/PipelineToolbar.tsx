/**
 * PipelineToolbar — small top bar above the canvas with pipeline-level actions.
 *
 * Actions: undo, redo, save, open, new, run.
 * Also shows the editable pipeline name and a dirty-indicator dot.
 *
 * On Run: validates the pipeline. If there are errors a blocking modal is
 * shown (fix required). If there are only warnings the modal offers "Run
 * anyway". If everything is clean the run starts immediately.
 */
import { useState, useCallback } from 'react'
import { Save, FolderOpen, FilePlus2, Undo2, Redo2, Play, Download, Square, AlertTriangle, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useConnectionStore, LOCAL_CONNECTION_ID } from '@/stores/connectionStore'
import { useRunStore } from '@/stores/runStore'
import { classNames } from '@/lib/utils'
import { ValidationBadge } from './ValidationBadge'
import { validatePipeline, type ValidationIssue, type ValidationResult } from '@/lib/pipelineValidator'
import type { PipelineSnapshot } from '@/types/pipeline'

// ── Run-confirmation modal ──────────────────────────────────────────────────

interface ConfirmDialogProps {
  result: ValidationResult
  /** Called when the user confirms they want to run despite warnings. */
  onRunAnyway: () => void
  onClose: () => void
}

function RunConfirmDialog({ result, onRunAnyway, onClose }: ConfirmDialogProps) {
  const hasErrors = result.errorCount > 0
  const hasWarnings = result.warningCount > 0

  const headerBg = hasErrors ? 'bg-error/10 border-error/30' : 'bg-warning/10 border-warning/30'
  const headerText = hasErrors ? 'text-error' : 'text-warning'
  const HeaderIcon = hasErrors ? XCircle : AlertTriangle
  const title = hasErrors
    ? `${result.errorCount} error${result.errorCount === 1 ? '' : 's'} must be fixed before running`
    : `${result.warningCount} warning${result.warningCount === 1 ? '' : 's'} — review before running`

  // Group by severity for display.
  const errors = result.issues.filter((i) => i.severity === 'error')
  const warnings = result.issues.filter((i) => i.severity === 'warning')
  const infos = result.issues.filter((i) => i.severity === 'info')

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-[480px] max-h-[80vh] flex flex-col bg-bg-primary border border-border rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className={`flex items-center gap-2.5 px-4 py-3 border-b ${headerBg}`}>
          <HeaderIcon size={16} className={headerText} />
          <span className={`text-sm font-medium ${headerText}`}>{title}</span>
        </div>

        {/* Issue list */}
        <div className="flex-1 overflow-y-auto py-1 min-h-0">
          {[
            { label: 'Errors', items: errors, color: 'text-error' },
            { label: 'Warnings', items: warnings, color: 'text-warning' },
            { label: 'Notes', items: infos, color: 'text-accent' },
          ].map(({ label, items, color }) =>
            items.length === 0 ? null : (
              <div key={label}>
                <div className="px-4 py-1 text-[9px] uppercase tracking-wider text-text-muted border-b border-border-light">
                  {label} ({items.length})
                </div>
                {items.map((issue, i) => (
                  <ModalIssueRow key={i} issue={issue} color={color} />
                ))}
              </div>
            ),
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border bg-bg-secondary">
          {hasErrors ? (
            <>
              <span className="text-xs text-text-muted mr-auto">Fix the errors above, then try again.</span>
              <Button variant="secondary" size="sm" onClick={onClose}>
                Close
              </Button>
            </>
          ) : (
            <>
              <span className="text-xs text-text-muted mr-auto">Warnings won't stop the run.</span>
              <Button variant="secondary" size="sm" onClick={onClose}>
                Go back
              </Button>
              <Button variant="primary" size="sm" onClick={onRunAnyway}>
                <Play size={11} className="mr-1" />
                Run anyway
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ModalIssueRow({ issue, color }: { issue: ValidationIssue; color: string }) {
  return (
    <div className="px-4 py-2 border-b border-border-light/50 last:border-0 flex items-start gap-2">
      <span className={`text-[10px] font-mono shrink-0 mt-px ${color}`}>{issue.code}</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-text-primary leading-snug">{issue.message}</div>
        {issue.suggestion && (
          <div className="text-[10px] text-text-muted mt-0.5 leading-snug">{issue.suggestion}</div>
        )}
      </div>
    </div>
  )
}

// ── Toolbar ─────────────────────────────────────────────────────────────────

export function PipelineToolbar() {
  const pipelineName = usePipelineStore((s) => s.pipelineName)
  const setPipelineName = usePipelineStore((s) => s.setPipelineName)
  const dirty = usePipelineStore((s) => s.dirty)
  const past = usePipelineStore((s) => s.past)
  const future = usePipelineStore((s) => s.future)
  const undo = usePipelineStore((s) => s.undo)
  const redo = usePipelineStore((s) => s.redo)
  const reset = usePipelineStore((s) => s.reset)
  const exportSnapshot = usePipelineStore((s) => s.exportSnapshot)
  const loadSnapshot = usePipelineStore((s) => s.loadSnapshot)
  const nodes = usePipelineStore((s) => s.nodes)

  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const activeRunId = useRunStore((s) => s.activeRunId)
  const startRun = useRunStore((s) => s.startRun)
  const cancelRun = useRunStore((s) => s.cancelRun)

  const [editingName, setEditingName] = useState(false)
  const [savedMessage, setSavedMessage] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [confirmDialog, setConfirmDialog] = useState<{ result: ValidationResult; snapshot: PipelineSnapshot } | null>(null)

  const flashMessage = useCallback((msg: string) => {
    setSavedMessage(msg)
    setTimeout(() => setSavedMessage(null), 2000)
  }, [])

  const handleNew = useCallback(() => {
    if (dirty && !confirm('Discard unsaved changes and start a new pipeline?')) return
    reset()
  }, [dirty, reset])

  const handleSave = useCallback(async () => {
    const snapshot = exportSnapshot()
    try {
      await window.api.store.set(`pipeline:${snapshot.id}`, snapshot)
      const existing = (await window.api.store.get<string[]>('pipelines:ids')) ?? []
      if (!existing.includes(snapshot.id)) {
        await window.api.store.set('pipelines:ids', [...existing, snapshot.id])
      }
      flashMessage('Saved')
    } catch (err) {
      console.error('Save failed:', err)
      flashMessage('Save failed')
    }
  }, [exportSnapshot, flashMessage])

  const handleOpen = useCallback(async () => {
    if (dirty && !confirm('Discard unsaved changes and open a pipeline?')) return
    const ids = (await window.api.store.get<string[]>('pipelines:ids')) ?? []
    if (ids.length === 0) { flashMessage('No saved pipelines'); return }
    const options = await Promise.all(
      ids.map(async (id) => {
        const snap = await window.api.store.get<{ name: string; id: string }>(`pipeline:${id}`)
        return snap ? `${snap.id}: ${snap.name}` : null
      }),
    )
    const filtered = options.filter((o): o is string => o !== null)
    const pick = prompt(`Open pipeline:\n${filtered.join('\n')}\n\nEnter pipeline id:`)
    if (!pick) return
    const snap = await window.api.store.get<any>(`pipeline:${pick.trim()}`)
    if (snap) loadSnapshot(snap)
    else flashMessage('Pipeline not found')
  }, [dirty, loadSnapshot, flashMessage])

  const handleExport = useCallback(() => {
    const snapshot = exportSnapshot()
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${snapshot.name.replace(/[^a-z0-9]+/gi, '_')}.bioflow.json`
    a.click()
    URL.revokeObjectURL(url)
    flashMessage('Exported')
  }, [exportSnapshot, flashMessage])

  /** Actually submit the run (called directly if no issues, or via modal "Run anyway"). */
  const submitRun = useCallback(async (snapshot: PipelineSnapshot) => {
    if (!activeConnectionId) { flashMessage('No active connection'); return }
    if (activeConnectionId === LOCAL_CONNECTION_ID) { flashMessage('Run requires an SSH connection'); return }
    setRunning(true)
    try {
      const runnable = snapshot.nodes.filter((n) => n.type === 'tool' || n.type === 'merge')
      await startRun(activeConnectionId, snapshot)
      flashMessage(`Submitting ${runnable.length} node${runnable.length === 1 ? '' : 's'}...`)
    } catch (err: any) {
      console.error('Run failed:', err)
      flashMessage(`Run failed: ${err?.message ?? err}`)
    } finally {
      setRunning(false)
    }
  }, [activeConnectionId, startRun, flashMessage])

  const handleRun = useCallback(async () => {
    const snapshot = exportSnapshot()
    const runnable = snapshot.nodes.filter((n) => n.type === 'tool' || n.type === 'merge')
    if (runnable.length === 0) { flashMessage('No tools to run'); return }
    if (!activeConnectionId) { flashMessage('No active connection'); return }
    if (activeConnectionId === LOCAL_CONNECTION_ID) { flashMessage('Run requires an SSH connection'); return }

    const result = validatePipeline(snapshot)

    // No issues → run immediately.
    if (result.issues.length === 0) {
      await submitRun(snapshot)
      return
    }

    // Issues exist → show confirmation modal; the modal handles the "run anyway" path.
    setConfirmDialog({ result, snapshot })
  }, [exportSnapshot, flashMessage, activeConnectionId, submitRun])

  const handleCancelRun = useCallback(async () => {
    if (!activeRunId) return
    if (!confirm('Cancel this run? Submitted Slurm jobs will be cancelled.')) return
    try {
      await cancelRun(activeRunId)
      flashMessage('Run cancelled')
    } catch (err: any) {
      console.error('Cancel failed:', err)
      flashMessage(`Cancel failed: ${err?.message ?? err}`)
    }
  }, [activeRunId, cancelRun, flashMessage])

  return (
    <>
      <div className="h-10 px-3 bg-bg-secondary border-b border-border flex items-center gap-2 shrink-0">
        {/* Pipeline name */}
        <div className="flex items-center gap-2 min-w-0">
          {editingName ? (
            <Input
              autoFocus
              value={pipelineName}
              onChange={(e) => setPipelineName(e.target.value)}
              onBlur={() => setEditingName(false)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditingName(false) }}
              className="h-6 w-48 text-xs"
            />
          ) : (
            <button
              onClick={() => setEditingName(true)}
              className="text-sm font-medium text-text-primary hover:text-accent transition-colors truncate max-w-[240px]"
              title="Click to rename"
            >
              {pipelineName}
            </button>
          )}
          {dirty && <span className="w-1.5 h-1.5 rounded-full bg-accent" title="Unsaved changes" />}
          <span className="text-[10px] text-text-muted">{nodes.length} node{nodes.length === 1 ? '' : 's'}</span>
          <ValidationBadge />
        </div>

        {/* Feedback message */}
        {savedMessage && (
          <span className="ml-2 px-2 py-0.5 text-[10px] rounded bg-accent/10 text-accent animate-pulse">
            {savedMessage}
          </span>
        )}

        <div className="flex-1" />

        {/* Actions */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={undo}
            disabled={past.length === 0}
            className={classNames(
              'p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors',
              'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
            )}
            title="Undo (Cmd/Ctrl+Z)"
          >
            <Undo2 size={14} />
          </button>
          <button
            onClick={redo}
            disabled={future.length === 0}
            className={classNames(
              'p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors',
              'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
            )}
            title="Redo (Shift+Cmd/Ctrl+Z)"
          >
            <Redo2 size={14} />
          </button>

          <div className="w-px h-5 bg-border mx-1" />

          <button
            onClick={handleNew}
            className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            title="New pipeline"
          >
            <FilePlus2 size={14} />
          </button>
          <button
            onClick={handleOpen}
            className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            title="Open pipeline"
          >
            <FolderOpen size={14} />
          </button>
          <button
            onClick={handleSave}
            className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            title="Save pipeline"
          >
            <Save size={14} />
          </button>
          <button
            onClick={handleExport}
            className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            title="Export as JSON"
          >
            <Download size={14} />
          </button>

          <div className="w-px h-5 bg-border mx-1" />

          <Button
            variant="primary"
            size="sm"
            onClick={handleRun}
            disabled={running || !!activeRunId}
            className="h-7 px-2.5 text-xs"
          >
            <Play size={12} className="mr-1" />
            {running ? 'Starting...' : 'Run'}
          </Button>
          {activeRunId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCancelRun}
              className="h-7 px-2.5 text-xs ml-1 text-red-400 hover:bg-red-500/10"
              title="Cancel active run"
            >
              <Square size={12} className="mr-1" />
              Cancel
            </Button>
          )}
        </div>
      </div>

      {/* Run confirmation modal — rendered outside the toolbar so it covers the full viewport */}
      {confirmDialog && (
        <RunConfirmDialog
          result={confirmDialog.result}
          onClose={() => setConfirmDialog(null)}
          onRunAnyway={async () => {
            const snapshot = confirmDialog.snapshot
            setConfirmDialog(null)
            await submitRun(snapshot)
          }}
        />
      )}
    </>
  )
}
