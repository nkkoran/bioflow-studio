/**
 * Summary card for a completed node in the Jobs panel. Shows duration, exit
 * code, job id, error (if any), and SFTP-lists the output directory so the
 * user can see exactly what the run produced.
 *
 * Rendered above the LogViewer. Stays hidden while the node is running/queued
 * — logs are the right view for in-progress state.
 */
import { useEffect, useState } from 'react'
import { FileText, AlertCircle, Eye, FolderOpen, Copy } from 'lucide-react'
import type { NodeRunState } from '@/types/pipeline'
import { inferFileType } from '@/lib/fileTypeInference'
import { isTabularFile, pathDirname } from '@/lib/utils'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import { useFileStore } from '@/stores/fileStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type { DnxJobStatus } from '@/types/dnx'

interface Props {
  runId: string
  connectionId: string
  ns: NodeRunState
}

interface OutputEntry {
  name: string
  path: string
  size: number
  modified: number
}

export function JobSummary({ runId, connectionId, ns }: Props) {
  const [outputs, setOutputs] = useState<OutputEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [dnxStatus, setDnxStatus] = useState<DnxJobStatus | null>(null)
  const openPreview = useDataPreviewStore((s) => s.openFile)
  const navigate = useFileStore((s) => s.navigate)
  const clearSelection = useFileStore((s) => s.clearSelection)
  const selectFile = useFileStore((s) => s.selectFile)
  const setActiveConnection = useConnectionStore((s) => s.setActiveConnection)
  const setBottomPanelMode = useUIStore((s) => s.setBottomPanelMode)
  const devMode = useSettingsStore((s) => s.devMode)

  useEffect(() => {
    let cancelled = false
    setOutputs(null)
    setError(null)
    void (async () => {
      try {
        const list = await window.api.pipeline.listOutputs(runId, ns.nodeId)
        if (cancelled) return
        setOutputs(list.sort((a, b) => b.modified - a.modified))
      } catch (err: any) {
        if (cancelled) return
        setError(String(err?.message ?? err))
      }
    })()
    return () => { cancelled = true }
    // Re-fetch when the node or its terminal state changes.
  }, [runId, ns.nodeId, ns.status, ns.finishedAt])

  useEffect(() => {
    if (!devMode || !ns.jobId?.startsWith('job-') || !window.api?.dnx) {
      setDnxStatus(null)
      return
    }
    let cancelled = false
    void window.api.dnx.jobStatus({ jobId: ns.jobId }).then((status) => {
      if (!cancelled) setDnxStatus(status)
    }).catch(() => {
      if (!cancelled) setDnxStatus(null)
    })
    return () => { cancelled = true }
  }, [devMode, ns.jobId, ns.status, ns.finishedAt])

  const duration =
    ns.startedAt && ns.finishedAt
      ? formatDuration(ns.finishedAt - ns.startedAt)
      : null

  const handlePreview = (entry: OutputEntry) => {
    const path = entry.path
    if (!path) return
    openPreview(path, entry.name)
    setBottomPanelMode('data')
  }

  const handleLocatePath = async (path: string, label: string) => {
    if (!path) return
    setActionMessage(null)
    try {
      setActiveConnection(connectionId)
      await navigate(pathDirname(path))
      clearSelection()
      selectFile(path)
      setActionMessage(`Selected ${label} in the file explorer.`)
    } catch (err: any) {
      setActionMessage(`Could not open folder: ${err?.message ?? err}`)
    }
  }

  const handleLocate = async (entry: OutputEntry) => {
    const path = entry.path
    if (!path) return
    await handleLocatePath(path, entry.name)
  }

  const handleCopyPathValue = async (path: string) => {
    await navigator.clipboard.writeText(path)
    setActionMessage('Copied path.')
  }

  const handleCopyPath = async (entry: OutputEntry) => {
    const path = entry.path
    if (!path) return
    await handleCopyPathValue(path)
  }

  return (
    <div className="border-b border-border-light bg-bg-secondary/40 px-3 py-2 shrink-0">
      <div className="flex items-center gap-4 text-[11px] text-text-secondary">
        <span className={`px-1.5 py-0.5 rounded ${statusChipColor(ns.status)}`}>
          {ns.status}
        </span>
        {ns.jobId && (
          <span>
            <span className="text-text-muted">job </span>
            <span className="font-mono text-text-primary">{ns.jobId}</span>
          </span>
        )}
        {duration && (
          <span>
            <span className="text-text-muted">duration </span>
            {duration}
          </span>
        )}
        {typeof ns.exitCode === 'number' && (
          <span>
            <span className="text-text-muted">exit </span>
            <span className={ns.exitCode === 0 ? 'text-success' : 'text-error'}>{ns.exitCode}</span>
          </span>
        )}
      </div>

      {ns.error && (
        <div className="mt-2 flex items-start gap-1.5 text-[11px] text-error bg-error/5 border border-error/20 rounded px-2 py-1">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span className="font-mono whitespace-pre-wrap break-all">{ns.error}</span>
        </div>
      )}

      {dnxStatus && (
        <div className="mt-2 rounded border border-cyan-500/20 bg-cyan-500/5 px-2 py-1.5 text-[11px] text-text-secondary">
          <div className="flex flex-wrap items-center gap-3">
            <span>DNAnexus state <span className="font-mono text-text-primary">{dnxStatus.state}</span></span>
            {dnxStatus.projectId && <span>project <span className="font-mono text-text-primary">{dnxStatus.projectId}</span></span>}
            {dnxStatus.outputFolder && <span>output <span className="font-mono text-text-primary">{dnxStatus.outputFolder}</span></span>}
            {dnxStatus.fileIds?.length ? <span>{dnxStatus.fileIds.length} output file{dnxStatus.fileIds.length === 1 ? '' : 's'}</span> : null}
            {dnxStatus.projectId && (
              <a
                href={dnxJobUrl(dnxStatus.projectId, dnxStatus.jobId)}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                Open in DNAnexus
              </a>
            )}
          </div>
        </div>
      )}

      {/* Files table */}
      <div className="mt-2">
        <div className="text-[10px] uppercase tracking-wide text-text-muted mb-1">Files created</div>
        {error ? (
          <div className="text-[11px] text-warning">{error}</div>
        ) : outputs === null ? (
          <div className="text-[11px] text-text-muted italic">Listing…</div>
        ) : outputs.length === 0 ? (
          <div className="text-[11px] text-text-muted italic">No output files found in {ns.outputDir ?? '(unknown dir)'}.</div>
        ) : (
          <div className="max-h-32 overflow-y-auto border border-border-light rounded bg-bg-primary">
            <table className="w-full text-[11px] font-mono">
              <tbody>
                {outputs.map((f) => (
                  <tr key={f.name} className="border-b border-border-light last:border-b-0 hover:bg-bg-hover">
                    <td className="px-2 py-0.5 flex items-center gap-1.5">
                      <FileText size={10} className="text-text-muted shrink-0" />
                      <button
                        className="text-text-primary truncate hover:text-accent text-left"
                        title={f.path}
                        onClick={() => void handleLocate(f)}
                      >
                        {f.name}
                      </button>
                      <span className="text-[9px] text-text-muted shrink-0 uppercase">
                        {inferFileType(f.name)}
                      </span>
                    </td>
                    <td className="px-2 py-0.5 text-right text-text-muted tabular-nums">{formatBytes(f.size)}</td>
                    <td className="px-2 py-0.5 text-right text-text-muted whitespace-nowrap">{formatRelativeTime(f.modified)}</td>
                    <td className="px-2 py-0.5">
                      <div className="flex justify-end gap-1">
                        {isTabularFile(extensionFor(f.name)) && (
                          <IconAction title="Preview in Data tab" onClick={() => handlePreview(f)}>
                            <Eye size={10} />
                          </IconAction>
                        )}
                        <IconAction title="Show in File Explorer" onClick={() => void handleLocate(f)}>
                          <FolderOpen size={10} />
                        </IconAction>
                        <IconAction title="Copy path" onClick={() => void handleCopyPath(f)}>
                          <Copy size={10} />
                        </IconAction>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {actionMessage && (
          <div className="mt-1 text-[10px] text-text-muted">{actionMessage}</div>
        )}
      </div>

      {(ns.stdoutPath || ns.stderrPath) && (
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wide text-text-muted mb-1">Log files</div>
          <div className="flex flex-wrap gap-1.5">
            {ns.stdoutPath && (
              <LogFileButton
                label={ns.stdoutPath === ns.stderrPath ? 'slurm log' : 'stdout'}
                path={ns.stdoutPath}
                onLocate={handleLocatePath}
                onCopy={handleCopyPathValue}
              />
            )}
            {ns.stderrPath && ns.stderrPath !== ns.stdoutPath && (
              <LogFileButton
                label="stderr"
                path={ns.stderrPath}
                onLocate={handleLocatePath}
                onCopy={handleCopyPathValue}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function dnxJobUrl(projectId: string, jobId: string): string {
  return `https://platform.dnanexus.com/panx/projects/${encodeURIComponent(projectId)}/monitor/job/${encodeURIComponent(jobId)}`
}

function LogFileButton({
  label,
  path,
  onLocate,
  onCopy,
}: {
  label: string
  path: string
  onLocate: (path: string, label: string) => void | Promise<void>
  onCopy: (path: string) => void | Promise<void>
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded border border-border-light bg-bg-primary px-1.5 py-1 text-[10px]">
      <button
        className="font-mono text-text-primary hover:text-accent"
        title={path}
        onClick={() => void onLocate(path, label)}
      >
        {label}
      </button>
      <button
        className="text-text-muted hover:text-text-primary"
        title="Copy log path"
        onClick={() => void onCopy(path)}
      >
        <Copy size={10} />
      </button>
    </div>
  )
}

function IconAction({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover"
    >
      {children}
    </button>
  )
}

function extensionFor(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx === -1 ? '' : name.slice(idx + 1)
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatRelativeTime(ts: number): string {
  // ls may report mtime in ms or s depending on the platform — normalize.
  const ms = ts < 1e12 ? ts * 1000 : ts
  const diff = Date.now() - ms
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function statusChipColor(status: NodeRunState['status']): string {
  switch (status) {
    case 'done': return 'bg-success/20 text-success'
    case 'failed': return 'bg-error/20 text-error'
    case 'cancelled': return 'bg-text-muted/20 text-text-muted'
    default: return 'bg-bg-primary text-text-secondary'
  }
}
