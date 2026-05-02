import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  ChevronUp,
  Home,
  Loader2,
  RefreshCw,
} from 'lucide-react'

import { Button } from '@/components/ui/Button'
import { useDnxStore } from '@/stores/dnxStore'
import { useUIStore } from '@/stores/uiStore'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import { inferFileType } from '@/lib/fileTypeInference'
import { classifyPreview } from '@/lib/filePreviewClassifier'
import type { DnxRemoteFileEntry } from '@/types/dnx'
import { FileGlyph } from './FileGlyph'

function dnxParent(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  if (!trimmed || trimmed === '/') return '/'
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return '/'
  return trimmed.slice(0, idx) || '/'
}

export function DnxFilePanel() {
  const defaultProjectId = useDnxStore((s) => s.defaultProjectId)
  const availableProjects = useDnxStore((s) => s.availableProjects)
  const refreshProjects = useDnxStore((s) => s.refreshProjects)

  const filePickMode = useUIStore((s) => s.filePickMode)
  const resolveFilePick = useUIStore((s) => s.resolveFilePick)
  const setBottomPanelMode = useUIStore((s) => s.setBottomPanelMode)
  const addFileNode = usePipelineStore((s) => s.addFileNode)
  const openPreview = useDataPreviewStore((s) => s.openFile)

  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<DnxRemoteFileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)

  useEffect(() => {
    if (availableProjects.length === 0 && defaultProjectId) {
      void refreshProjects().catch(() => undefined)
    }
  }, [availableProjects.length, defaultProjectId, refreshProjects])

  useEffect(() => {
    if (!defaultProjectId) {
      setEntries([])
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void window.api.dnx
      .listFiles({ projectId: defaultProjectId, path })
      .then((next) => {
        if (cancelled) return
        setEntries(next)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setEntries([])
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [defaultProjectId, path, reloadNonce])

  const projectName = useMemo(() => {
    return availableProjects.find((p) => p.id === defaultProjectId)?.name ?? defaultProjectId ?? 'No project'
  }, [availableProjects, defaultProjectId])

  const handleEntry = (entry: DnxRemoteFileEntry) => {
    if (entry.isDirectory) {
      setPath(entry.path)
      return
    }
    if (filePickMode.active && filePickMode.target === 'file') {
      resolveFilePick(entry.path, inferFileType(entry.name), 'dnx')
      return
    }
    // Drop a FileNode tagged origin: 'dnx' onto the canvas. The runner uses
    // `origin` to decide whether to insert an automatic Transfer step.
    const offset = Date.now() % 80
    addFileNode(
      { x: 120 + offset, y: 120 + offset },
      {
        isInput: true,
        label: entry.name,
        path: entry.path,
        fileType: inferFileType(entry.name),
        origin: 'dnx',
        artifactRef: {
          origin: 'dnx',
          path: entry.path,
          projectId: defaultProjectId ?? undefined,
          fileId: entry.id,
          size: entry.size,
          modified: entry.modified,
          fileType: inferFileType(entry.name),
        },
        dnxProjectId: defaultProjectId ?? undefined,
        dnxFileId: entry.id ?? undefined,
      },
    )
    // The data preview panel doesn't yet know how to fetch from DNAnexus
    // (different IPC path), so we don't auto-open it for DNX entries — just
    // dropping the FileNode is the productive action.
    void setBottomPanelMode
    void openPreview
    void classifyPreview
  }

  if (!defaultProjectId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-text-muted">
        <p>Set a default DNAnexus project in Settings → DNAnexus to browse it here.</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Pick-mode banner */}
      {filePickMode.active && filePickMode.target === 'file' && (
        <div className="border-b border-accent bg-accent/10 px-3 py-1.5 text-xs text-text-primary">
          Click a DNAnexus file to use for{' '}
          {filePickMode.requesterLabel ? <b>{filePickMode.requesterLabel}</b> : 'this node'}.
        </div>
      )}

      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <Button
          variant="ghost"
          size="sm"
          icon={<Home className="h-3.5 w-3.5" />}
          onClick={() => setPath('/')}
          title="Project root"
        />
        <Button
          variant="ghost"
          size="sm"
          icon={<ChevronUp className="h-3.5 w-3.5" />}
          onClick={() => setPath(dnxParent(path))}
          disabled={path === '/'}
          title="Up"
        />
        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />}
          onClick={() => setReloadNonce((n) => n + 1)}
          title="Refresh"
        />
        <div className="ml-1 flex-1 truncate text-[11px] text-text-muted">
          <span className="text-text-secondary">{projectName}</span>
          <span className="mx-1 text-text-muted">·</span>
          <span className="font-mono">{path}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
          </div>
        )}
        {error && !loading && (
          <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
            <AlertCircle className="h-4 w-4 text-error" />
            <p className="text-xs text-error">{error}</p>
            <Button variant="secondary" size="sm" onClick={() => setReloadNonce((n) => n + 1)}>
              Retry
            </Button>
          </div>
        )}
        {!loading && !error && entries.length === 0 && (
          <div className="flex items-center justify-center py-6">
            <p className="text-xs text-text-muted">This DNAnexus folder is empty.</p>
          </div>
        )}
        {!loading && !error && entries.map((entry) => (
          <button
            key={`${entry.id ?? ''}-${entry.path}`}
            type="button"
            onClick={() => handleEntry(entry)}
            className="interactive-row flex w-full items-center gap-2 rounded-none px-3 py-1.5 text-left text-xs text-text-secondary hover:text-text-primary"
          >
            <FileGlyph entry={toGlyphEntry(entry)} size="row" />
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            <span className="shrink-0 text-[10px] text-text-muted">
              {entry.isDirectory ? 'folder' : inferFileType(entry.name)}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function toGlyphEntry(entry: DnxRemoteFileEntry) {
  return {
    name: entry.name,
    path: entry.path,
    isDirectory: entry.isDirectory,
    size: entry.size ?? 0,
    modified: entry.modified ?? 0,
    permissions: '',
    extension: extensionFromName(entry.name),
  }
}

function extensionFromName(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.vcf.gz')) return 'vcf.gz'
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1)
}
