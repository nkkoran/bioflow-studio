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
import { useState, useCallback, useEffect } from 'react'
import { Save, FolderOpen, FilePlus2, Undo2, Redo2, Play, Download, Square, AlertTriangle, XCircle, FileCode2, LayoutTemplate } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useConnectionStore, LOCAL_CONNECTION_ID } from '@/stores/connectionStore'
import { useRunStore } from '@/stores/runStore'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { classNames } from '@/lib/utils'
import { ValidationBadge } from './ValidationBadge'
import { validatePipeline, type ValidationIssue, type ValidationResult } from '@/lib/pipelineValidator'
import type { DryRunScript, PipelineSnapshot } from '@/types/pipeline'
import { ScriptPreviewModal } from './ScriptPreviewModal'
import { instantiateTemplate, PIPELINE_TEMPLATES } from '@/lib/pipelineTemplates'
import { Dialog } from '@/components/ui/Dialog'
import { savePipelineSnapshot, savePipelineSnapshotAs } from '@/lib/pipelinePersistence'

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
  const arrayChainMode = usePipelineStore((s) => s.arrayChainMode)
  const fileLifecyclePolicy = usePipelineStore((s) => s.fileLifecyclePolicy)
  const setArrayChainMode = usePipelineStore((s) => s.setArrayChainMode)
  const setFileLifecyclePolicy = usePipelineStore((s) => s.setFileLifecyclePolicy)
  const dirty = usePipelineStore((s) => s.dirty)
  const past = usePipelineStore((s) => s.past)
  const future = usePipelineStore((s) => s.future)
  const undo = usePipelineStore((s) => s.undo)
  const redo = usePipelineStore((s) => s.redo)
  const reset = usePipelineStore((s) => s.reset)
  const exportSnapshot = usePipelineStore((s) => s.exportSnapshot)
  const loadSnapshot = usePipelineStore((s) => s.loadSnapshot)
  const markSaved = usePipelineStore((s) => s.markSaved)
  const nodes = usePipelineStore((s) => s.nodes)
  const schemas = useDataPreviewStore((s) => s.schemas)

  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const activeRunId = useRunStore((s) => s.activeRunId)
  const activeRun = useRunStore((s) => s.activeRunId ? s.runs[s.activeRunId] : null)
  const startRun = useRunStore((s) => s.startRun)
  const settings = useSettingsStore((s) => s.settings)
  const confirmOnLoginNodeRun = useSettingsStore((s) => s.settings.confirmOnLoginNodeRun)
  const cancelRun = useRunStore((s) => s.cancelRun)

  const [editingName, setEditingName] = useState(false)
  const [savedMessage, setSavedMessage] = useState<{ text: string; isError: boolean } | null>(null)
  const [running, setRunning] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [scriptPreview, setScriptPreview] = useState<DryRunScript[] | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<{ result: ValidationResult; snapshot: PipelineSnapshot } | null>(null)
  const [openPicker, setOpenPicker] = useState<Array<{ id: string; name: string }> | null>(null)
  const [templatePicker, setTemplatePicker] = useState(false)
  const activeRunIsCancellable = activeRun?.status === 'queued' || activeRun?.status === 'running'

  const flashMessage = useCallback((msg: string, isError = false) => {
    setSavedMessage({ text: msg, isError })
    setTimeout(() => setSavedMessage(null), isError ? 7000 : 2000)
  }, [])

  const handleNew = useCallback(() => {
    if (dirty && !confirm('Discard unsaved changes and start a new pipeline?')) return
    reset()
  }, [dirty, reset])

  const handleSave = useCallback(async () => {
    const snapshot = exportSnapshot()
    try {
      await savePipelineSnapshot(snapshot)
      markSaved()
      flashMessage('Saved')
    } catch (err) {
      console.error('Save failed:', err)
      flashMessage('Save failed')
    }
  }, [exportSnapshot, flashMessage, markSaved])

  const handleSaveAs = useCallback(async () => {
    const snapshot = exportSnapshot()
    const nextName = window.prompt('Save pipeline as:', `${snapshot.name} copy`)
    if (!nextName?.trim()) return
    try {
      const next = {
        ...snapshot,
        createdAt: snapshot.createdAt,
      }
      const created = await savePipelineSnapshotAs(next, nextName.trim())
      loadSnapshot(created)
      markSaved()
      flashMessage('Saved as new pipeline')
    } catch (err) {
      console.error('Save as failed:', err)
      flashMessage('Save as failed', true)
    }
  }, [exportSnapshot, flashMessage, loadSnapshot, markSaved])

  const handleOpen = useCallback(async () => {
    if (dirty && !confirm('Discard unsaved changes and open a pipeline?')) return
    const ids = (await window.api.store.get<string[]>('pipelines:ids')) ?? []
    if (ids.length === 0) { flashMessage('No saved pipelines'); return }
    const entries = await Promise.all(
      ids.map(async (id) => {
        const snap = await window.api.store.get<{ name: string; id: string }>(`pipeline:${id}`)
        return snap ? { id: snap.id, name: snap.name } : null
      }),
    )
    setOpenPicker(entries.filter((e): e is { id: string; name: string } => e !== null))
  }, [dirty, flashMessage])

  const confirmOpen = useCallback(async (id: string) => {
    setOpenPicker(null)
    const snap = await window.api.store.get<any>(`pipeline:${id}`)
    if (snap) loadSnapshot(snap)
    else flashMessage('Pipeline not found', true)
  }, [loadSnapshot, flashMessage])

  const handleImport = useCallback(async () => {
    if (dirty && !confirm('Discard unsaved changes and import a pipeline?')) return
    const path = await window.api.dialog.openFile({
      filters: [{ name: 'BioFlow pipeline JSON', extensions: ['json', 'bioflow'] }],
    })
    if (!path) return
    try {
      const text = await window.api.local.read(path)
      const snapshot = JSON.parse(text) as PipelineSnapshot
      if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) {
        throw new Error('File is not a BioFlow pipeline snapshot.')
      }
      loadSnapshot(snapshot)
      flashMessage('Imported')
    } catch (err: any) {
      console.error('Import failed:', err)
      flashMessage(`Import failed: ${err?.message ?? err}`, true)
    }
  }, [dirty, loadSnapshot, flashMessage])

  const handleTemplate = useCallback(() => {
    if (dirty && !confirm('Discard unsaved changes and load a template?')) return
    setTemplatePicker(true)
  }, [dirty])

  const confirmTemplate = useCallback((idx: number) => {
    setTemplatePicker(false)
    const template = PIPELINE_TEMPLATES[idx]
    if (!template) { flashMessage('Template not found', true); return }
    loadSnapshot(instantiateTemplate(template))
    flashMessage(`Loaded ${template.name}`)
  }, [loadSnapshot, flashMessage])

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
    if (!activeConnectionId) { flashMessage('No active connection', true); return }
    if (activeConnectionId === LOCAL_CONNECTION_ID) { flashMessage('Run requires an SSH connection', true); return }
    const loginNodes = snapshot.nodes.filter((node) => node.type === 'tool' && (node.data as any).executionMode === 'login')
    if (confirmOnLoginNodeRun && loginNodes.length > 0) {
      const ok = confirm(`This run includes ${loginNodes.length} login-node tool${loginNodes.length === 1 ? '' : 's'}. Continue?`)
      if (!ok) return
    }
    setRunning(true)
    try {
      const runnable = snapshot.nodes.filter((n) => n.type === 'tool' || n.type === 'merge' || n.type === 'transform')
      await startRun(activeConnectionId, snapshot)
      flashMessage(`Submitting ${runnable.length} node${runnable.length === 1 ? '' : 's'}...`)
    } catch (err: any) {
      console.error('Run failed:', err)
      flashMessage(err?.message ?? String(err), true)
    } finally {
      setRunning(false)
    }
  }, [activeConnectionId, startRun, flashMessage, confirmOnLoginNodeRun])

  const handleRun = useCallback(async () => {
    try {
      const snapshot = exportSnapshot()
      const runnable = snapshot.nodes.filter((n) => n.type === 'tool' || n.type === 'merge' || n.type === 'transform')
      if (runnable.length === 0) { flashMessage('No tools to run'); return }
      if (!activeConnectionId) { flashMessage('No active connection'); return }
      if (activeConnectionId === LOCAL_CONNECTION_ID) { flashMessage('Run requires an SSH connection'); return }

      // Validation is pure but still wrapped — a throw here used to bubble out
      // of the async click handler as an unhandled rejection, which on its own
      // isn't fatal, but combined with other state updates before the throw it
      // left the toolbar in an inconsistent state.
      let result
      try {
        result = validatePipeline(snapshot, {
          schemas,
          annotationDefaults: {
            annovarDbPath: settings.annovarDbPath,
            annovarScriptsPath: settings.annovarScriptsPath,
            vepCachePath: settings.vepCachePath,
            vepPath: settings.vepPath,
          },
        })
      } catch (err: any) {
        console.error('[PipelineToolbar] validatePipeline threw:', err)
        flashMessage(`Validation error: ${err?.message ?? String(err)}`, true)
        return
      }

      // No issues → run immediately.
      if (result.issues.length === 0) {
        await submitRun(snapshot)
        return
      }

      // Issues exist → show confirmation modal; the modal handles the "run anyway" path.
      setConfirmDialog({ result, snapshot })
    } catch (err: any) {
      console.error('[PipelineToolbar] handleRun threw:', err)
      flashMessage(err?.message ?? String(err), true)
    }
  }, [exportSnapshot, flashMessage, activeConnectionId, submitRun, schemas, settings.annovarDbPath, settings.vepCachePath])

  const handlePreviewScripts = useCallback(async () => {
    const snapshot = exportSnapshot()
    const runnable = snapshot.nodes.filter((n) => n.type === 'tool' || n.type === 'merge' || n.type === 'transform')
    if (runnable.length === 0) { flashMessage('No tools to preview'); return }
    if (!activeConnectionId) { flashMessage('No active connection', true); return }
    if (activeConnectionId === LOCAL_CONNECTION_ID) { flashMessage('Script preview requires an SSH connection', true); return }

    let result
    try {
      result = validatePipeline(snapshot, {
        schemas,
        annotationDefaults: {
          annovarDbPath: settings.annovarDbPath,
          annovarScriptsPath: settings.annovarScriptsPath,
          vepCachePath: settings.vepCachePath,
          vepPath: settings.vepPath,
        },
      })
    } catch (err: any) {
      flashMessage(`Validation error: ${err?.message ?? String(err)}`, true)
      return
    }
    if (result.errorCount > 0) {
      setConfirmDialog({ result, snapshot })
      return
    }

    setPreviewLoading(true)
    try {
      const scripts = await window.api.pipeline.generateScriptsDry(activeConnectionId, snapshot)
      setScriptPreview(scripts)
    } catch (err: any) {
      console.error('Script preview failed:', err)
      flashMessage(err?.message ?? String(err), true)
    } finally {
      setPreviewLoading(false)
    }
  }, [activeConnectionId, exportSnapshot, flashMessage, schemas, settings.annovarDbPath, settings.vepCachePath])

  const handleCancelRun = useCallback(async () => {
    if (!activeRunId || !activeRunIsCancellable) return
    if (!confirm('Cancel this run? Submitted Slurm jobs will be cancelled.')) return
    try {
      await cancelRun(activeRunId)
      flashMessage('Run cancelled')
    } catch (err: any) {
      console.error('Cancel failed:', err)
      flashMessage(`Cancel failed: ${err?.message ?? err}`)
    }
  }, [activeRunId, activeRunIsCancellable, cancelRun, flashMessage])

  useEffect(() => {
    const onMenuCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ command: 'new' | 'open' | 'save' | 'saveAs' }>).detail
      if (!detail) return
      if (detail.command === 'new') void handleNew()
      if (detail.command === 'open') void handleOpen()
      if (detail.command === 'save') void handleSave()
      if (detail.command === 'saveAs') void handleSaveAs()
    }
    window.addEventListener('bioflow:menu-command', onMenuCommand as EventListener)
    return () => window.removeEventListener('bioflow:menu-command', onMenuCommand as EventListener)
  }, [handleNew, handleOpen, handleSave, handleSaveAs])

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
          <div className="hidden xl:flex items-center gap-1 text-[10px] text-text-muted">
            <span>Chain</span>
            <select
              value={arrayChainMode}
              onChange={(e) => setArrayChainMode(e.target.value === 'job-level' ? 'job-level' : 'task-level')}
              className="h-6 rounded border border-border bg-bg-tertiary px-1.5 text-[10px] text-text-primary"
              title="Per-pipeline array dependency mode"
            >
              <option value="task-level">Task</option>
              <option value="job-level">Job</option>
            </select>
            <span>Files</span>
            <select
              value={fileLifecyclePolicy}
              onChange={(e) => setFileLifecyclePolicy(
                e.target.value === 'keep-outputs-only' || e.target.value === 'delete-intermediates-on-success'
                  ? e.target.value
                  : 'keep-all',
              )}
              className="h-6 rounded border border-border bg-bg-tertiary px-1.5 text-[10px] text-text-primary"
              title="Per-pipeline intermediate file policy"
            >
              <option value="keep-all">Keep all</option>
              <option value="keep-outputs-only">Keep outputs</option>
              <option value="delete-intermediates-on-success">Clean up</option>
            </select>
          </div>
          <ValidationBadge />
        </div>

        {/* Feedback message — errors shown in red for 7s, info in accent for 2s */}
        {savedMessage && (
          <span
            className={`ml-2 px-2 py-0.5 text-[10px] rounded max-w-[420px] truncate ${
              savedMessage.isError
                ? 'bg-error/10 text-error'
                : 'bg-accent/10 text-accent animate-pulse'
            }`}
            title={savedMessage.isError ? savedMessage.text : undefined}
          >
            {savedMessage.text}
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
            onClick={handleImport}
            className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            title="Import pipeline JSON"
          >
            <Download size={14} className="rotate-180" />
          </button>
          <button
            onClick={handleSave}
            className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            title="Save pipeline"
          >
            <Save size={14} />
          </button>
          <button
            onClick={handleTemplate}
            className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            title="Load template"
          >
            <LayoutTemplate size={14} />
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
            variant="secondary"
            size="sm"
            onClick={handlePreviewScripts}
            disabled={previewLoading}
            className="h-7 px-2.5 text-xs"
          >
            <FileCode2 size={12} className="mr-1" />
            {previewLoading ? 'Previewing...' : 'Preview'}
          </Button>

          <Button
            variant="primary"
            size="sm"
            onClick={handleRun}
            disabled={running}
            className="h-7 px-2.5 text-xs"
          >
            <Play size={12} className="mr-1" />
            {running ? 'Starting...' : 'Run'}
          </Button>
          {activeRunId && activeRunIsCancellable && (
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
      {scriptPreview && (
        <ScriptPreviewModal scripts={scriptPreview} onClose={() => setScriptPreview(null)} />
      )}

      <Dialog
        open={openPicker !== null}
        onClose={() => setOpenPicker(null)}
        title="Open pipeline"
      >
        {openPicker && openPicker.length === 0 ? (
          <div className="text-sm text-text-muted">No saved pipelines.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {openPicker?.map((entry) => (
              <button
                key={entry.id}
                onClick={() => void confirmOpen(entry.id)}
                className="flex items-center justify-between gap-2 px-3 py-2 rounded border border-border-light hover:bg-bg-hover text-left"
              >
                <span className="text-sm text-text-primary truncate">{entry.name}</span>
                <span className="text-[10px] font-mono text-text-muted shrink-0">{entry.id}</span>
              </button>
            ))}
          </div>
        )}
      </Dialog>

      <Dialog
        open={templatePicker}
        onClose={() => setTemplatePicker(false)}
        title="Load template"
      >
        <div className="flex flex-col gap-1">
          {PIPELINE_TEMPLATES.map((template, idx) => (
            <button
              key={template.id}
              onClick={() => confirmTemplate(idx)}
              className="flex flex-col gap-0.5 px-3 py-2 rounded border border-border-light hover:bg-bg-hover text-left"
            >
              <span className="text-sm text-text-primary">{template.name}</span>
              <span className="text-[11px] text-text-muted">{template.description}</span>
            </button>
          ))}
        </div>
      </Dialog>
    </>
  )
}
