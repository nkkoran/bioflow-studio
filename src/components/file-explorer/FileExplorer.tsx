import React, { useEffect, useMemo, useState, useCallback } from 'react'
import {
  RefreshCw,
  Bookmark,
  ChevronDown,
  ChevronRight,
  Search,
  Loader2,
  AlertCircle,
  FolderOpen,
  ServerOff,
  Upload,
} from 'lucide-react'
import { useFileStore } from '@/stores/fileStore'
import { LOCAL_CONNECTION_ID, useConnectionStore } from '@/stores/connectionStore'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import { useUIStore } from '@/stores/uiStore'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type { RemoteFileEntry, SortField, SortDirection } from '@/types/files'
import { inferFileType } from '@/lib/fileTypeInference'
import { classifyPreview } from '@/lib/filePreviewClassifier'
import { Button } from '@/components/ui/Button'
import { Tooltip } from '@/components/ui/Tooltip'
import { Breadcrumb } from './Breadcrumb'
import { FileTreeNode } from './FileTreeNode'
import { FileContextMenu } from './FileContextMenu'
import { DnxFilePanel } from './DnxFilePanel'
import { useDnxStore } from '@/stores/dnxStore'

const SORT_OPTIONS: { label: string; field: SortField; direction: SortDirection }[] = [
  { label: 'Name A-Z', field: 'name', direction: 'asc' },
  { label: 'Name Z-A', field: 'name', direction: 'desc' },
  { label: 'Size (small)', field: 'size', direction: 'asc' },
  { label: 'Size (large)', field: 'size', direction: 'desc' },
  { label: 'Modified (new)', field: 'modified', direction: 'desc' },
  { label: 'Modified (old)', field: 'modified', direction: 'asc' },
  { label: 'Extension', field: 'extension', direction: 'asc' },
]

export function FileExplorer() {
  const {
    cwd,
    entries,
    loading,
    error,
    bookmarks,
    sortField,
    sortDirection,
    selectedPaths,
    navigate,
    refresh,
    addBookmark,
    removeBookmark,
    setSort,
    selectFile,
    deselectFile,
    clearSelection,
  } = useFileStore()

  const { activeConnectionId, connections } = useConnectionStore()
  const { openFile: openPreview } = useDataPreviewStore()
  const filePickMode = useUIStore((s) => s.filePickMode)
  const resolveFilePick = useUIStore((s) => s.resolveFilePick)
  const cancelFilePick = useUIStore((s) => s.cancelFilePick)
  const setBottomPanelMode = useUIStore((s) => s.setBottomPanelMode)
  const addFileNode = usePipelineStore((s) => s.addFileNode)
  const devMode = useSettingsStore((s) => s.devMode)

  const dnxAuthStatus = useDnxStore((s) => s.authStatus)
  const dnxDefaultProjectId = useDnxStore((s) => s.defaultProjectId)
  const dnxReady = devMode && dnxAuthStatus === 'authenticated' && Boolean(dnxDefaultProjectId)

  const [origin, setOrigin] = useState<'fs' | 'dnx'>('fs')
  // If DNX becomes unavailable while we're on its tab, drop back to fs.
  useEffect(() => {
    if (origin === 'dnx' && !dnxReady) setOrigin('fs')
  }, [origin, dnxReady])

  const [searchQuery, setSearchQuery] = useState('')
  const [bookmarksOpen, setBookmarksOpen] = useState(true)
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadMessage, setUploadMessage] = useState<string | null>(null)
  const [uploadPickerOpen, setUploadPickerOpen] = useState(false)

  // Context menu state
  const [contextEntry, setContextEntry] = useState<RemoteFileEntry | null>(null)
  const [contextPos, setContextPos] = useState<{ x: number; y: number } | null>(null)

  // Determine connection state
  const isConnected =
    activeConnectionId != null &&
    connections[activeConnectionId]?.status === 'connected'

  // Navigate to home directory on connect
  useEffect(() => {
    if (isConnected && activeConnectionId) {
      const conn = connections[activeConnectionId]
      if (conn?.config.defaultDirectory) {
        navigate(conn.config.defaultDirectory)
      } else if (conn?.isLocal) {
        // Local connection: get homedir via local API
        window.api.local.homedir().then((home) => navigate(home)).catch(() => navigate('/'))
      } else {
        // Remote: resolve ~ via SSH exec
        window.api.ssh.exec(activeConnectionId, 'echo $HOME').then((result) => {
          const homePath = result.stdout.trim() || '/home'
          navigate(homePath)
        }).catch(() => {
          navigate('/home')
        })
      }
    }
  }, [activeConnectionId, isConnected]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sort entries: directories first, then by sort field
  const sortedEntries = useMemo(() => {
    const filtered = searchQuery
      ? entries.filter((e) =>
          e.name.toLowerCase().includes(searchQuery.toLowerCase()),
        )
      : entries

    return [...filtered].sort((a, b) => {
      // Directories always first
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1

      const dir = sortDirection === 'asc' ? 1 : -1
      switch (sortField) {
        case 'name':
          return dir * a.name.localeCompare(b.name)
        case 'size':
          return dir * (a.size - b.size)
        case 'modified':
          return dir * (a.modified - b.modified)
        case 'extension':
          return dir * a.extension.localeCompare(b.extension)
        default:
          return 0
      }
    })
  }, [entries, sortField, sortDirection, searchQuery])

  const handleSelect = useCallback(
    (path: string) => {
      if (selectedPaths.includes(path)) {
        deselectFile(path)
      } else {
        clearSelection()
        selectFile(path)
      }
    },
    [selectedPaths, selectFile, deselectFile, clearSelection],
  )

  const handleNavigate = useCallback(
    (path: string) => {
      setSearchQuery('')
      navigate(path)
    },
    [navigate],
  )

  const handlePreview = useCallback(
    (entry: RemoteFileEntry) => {
      // File-pick hand-off: take priority over preview when we're in a file-pick
      // and the user clicked a file. Directory-pick mode intentionally ignores
      // file clicks — the user selects via the banner's "Select this folder".
      if (filePickMode.active && filePickMode.target === 'file' && !entry.isDirectory) {
        resolveFilePick(
          entry.path,
          inferFileType(entry.name),
          activeConnectionId === LOCAL_CONNECTION_ID ? 'local' : 'ssh',
        )
        return
      }
      openPreview(entry.path, entry.name, classifyPreview(entry.name || entry.path))
      setBottomPanelMode('data')
    },
    [activeConnectionId, filePickMode.active, filePickMode.target, resolveFilePick, openPreview, setBottomPanelMode],
  )

  // Escape cancels an active pick.
  useEffect(() => {
    if (!filePickMode.active) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') cancelFilePick()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [filePickMode.active, cancelFilePick])

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, entry: RemoteFileEntry) => {
      setContextEntry(entry)
      setContextPos({ x: e.clientX, y: e.clientY })
    },
    [],
  )

  const handleCloseContextMenu = useCallback(() => {
    setContextEntry(null)
    setContextPos(null)
  }, [])

  const handleCopyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path)
  }, [])

  const isCurrentBookmarked = bookmarks.includes(cwd)
  const canUploadLocal = Boolean(activeConnectionId && activeConnectionId !== LOCAL_CONNECTION_ID)

  const uploadLocalFile = useCallback(async () => {
    if (!activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID || uploading || uploadPickerOpen) return
    setUploadPickerOpen(true)
    const localPath = await window.api.dialog.openFile().finally(() => setUploadPickerOpen(false))
    if (!localPath) return
    const name = localPath.split('/').pop() || 'upload'
    const remotePath = `${cwd.replace(/\/+$/, '')}/${name}`
    setUploading(true)
    setUploadMessage(null)
    try {
      await window.api.sftp.upload(activeConnectionId, localPath, remotePath)
      const offset = Date.now() % 80
      addFileNode(
        { x: 120 + offset, y: 120 + offset },
        {
          isInput: true,
          label: name,
          path: remotePath,
          fileType: inferFileType(name),
        },
      )
      setUploadMessage(`Uploaded ${name} and added it to the pipeline`)
      await refresh()
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
      window.setTimeout(() => setUploadMessage(null), 4000)
    }
  }, [activeConnectionId, addFileNode, cwd, refresh, uploadPickerOpen, uploading])

  const tabStrip = dnxReady ? (
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-bg-secondary px-2 py-1 text-[11px]">
      <button
        type="button"
        onClick={() => setOrigin('fs')}
        className={`rounded px-2 py-0.5 ${origin === 'fs' ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'}`}
      >
        {activeConnectionId === LOCAL_CONNECTION_ID ? 'Local' : 'Rorqual'}
      </button>
      <button
        type="button"
        onClick={() => setOrigin('dnx')}
        className={`rounded px-2 py-0.5 ${origin === 'dnx' ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'}`}
      >
        DNAnexus
      </button>
    </div>
  ) : null

  if (origin === 'dnx' && dnxReady) {
    return (
      <div className="flex h-full flex-col">
        {tabStrip}
        <div className="min-h-0 flex-1">
          <DnxFilePanel />
        </div>
      </div>
    )
  }

  // Not connected state
  if (!isConnected) {
    return (
      <div className="flex h-full flex-col">
        {tabStrip}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <ServerOff className="h-10 w-10 text-text-muted" />
          <p className="text-sm text-text-muted">
            Connect to a server to browse files
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {tabStrip}
      {/* Pick-mode banner — file or directory. */}
      {filePickMode.active && (
        <div className="border-b border-accent bg-accent/10 px-3 py-1.5 flex items-center gap-2">
          <span className="text-xs text-text-primary flex-1 truncate">
            {filePickMode.target === 'directory' ? 'Navigate to a folder and click Select for ' : 'Click a file to use for '}
            {filePickMode.requesterLabel ? <b>{filePickMode.requesterLabel}</b> : 'this node'}
          </span>
          {filePickMode.target === 'directory' && (
            <button
              onClick={() => resolveFilePick(cwd, undefined, activeConnectionId === LOCAL_CONNECTION_ID ? 'local' : 'ssh')}
              className="text-[10px] bg-accent text-white px-2 py-0.5 rounded hover:opacity-90"
              title="Use the current folder"
            >
              Select this folder
            </button>
          )}
          <button
            onClick={cancelFilePick}
            className="text-[10px] text-text-secondary hover:text-text-primary underline"
            title="Cancel (Esc)"
          >
            cancel
          </button>
        </div>
      )}

      {/* Breadcrumb */}
      <div className="border-b border-border">
        <Breadcrumb path={cwd} onNavigate={handleNavigate} />
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <Tooltip content="Refresh">
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />}
            onClick={refresh}
            disabled={loading}
          />
        </Tooltip>

        <Tooltip content={isCurrentBookmarked ? 'Remove bookmark' : 'Bookmark this folder'}>
          <Button
            variant="ghost"
            size="sm"
            icon={
              <Bookmark
                className={`h-3.5 w-3.5 ${isCurrentBookmarked ? 'fill-accent text-accent' : ''}`}
              />
            }
            onClick={() =>
              isCurrentBookmarked ? removeBookmark(cwd) : addBookmark(cwd)
            }
          />
        </Tooltip>

        {canUploadLocal && (
          <Tooltip content="Upload a file from this computer to the current folder">
            <Button
              variant="ghost"
              size="sm"
              icon={<Upload className={`h-3.5 w-3.5 ${uploading ? 'animate-pulse' : ''}`} />}
              onClick={() => void uploadLocalFile()}
              disabled={uploading}
              title="Upload local file"
            >
              <span className="text-xs">Upload</span>
            </Button>
          </Tooltip>
        )}

        {/* Sort dropdown */}
        <div className="relative ml-auto">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSortDropdownOpen(!sortDropdownOpen)}
          >
            <span className="text-xs text-text-secondary">Sort</span>
            <ChevronDown className="ml-0.5 h-3 w-3 text-text-muted" />
          </Button>

          {sortDropdownOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setSortDropdownOpen(false)}
              />
              <div className="absolute right-0 top-full z-50 mt-1 min-w-[140px] rounded-lg border border-border bg-bg-secondary py-1 shadow-xl">
                {SORT_OPTIONS.map((opt) => (
                  <button
                    key={`${opt.field}-${opt.direction}`}
                    className={`flex w-full items-center px-3 py-1.5 text-xs transition-colors hover:bg-bg-hover ${
                      sortField === opt.field && sortDirection === opt.direction
                        ? 'text-accent'
                        : 'text-text-primary'
                    }`}
                    onClick={() => {
                      setSort(opt.field, opt.direction)
                      setSortDropdownOpen(false)
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {uploadMessage && (
        <div className="border-b border-border px-3 py-1 text-[10px] text-text-muted">
          {uploadMessage}
        </div>
      )}

      {/* Bookmarks section */}
      {bookmarks.length > 0 && (
        <div className="border-b border-border">
          <button
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-hover"
            onClick={() => setBookmarksOpen(!bookmarksOpen)}
          >
            {bookmarksOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <Bookmark className="h-3 w-3" />
            Bookmarks
          </button>

          {bookmarksOpen && (
            <div className="pb-1">
              {bookmarks.map((bm) => (
                <button
                  key={bm}
                  className="flex w-full items-center gap-2 px-5 py-1 text-xs text-text-muted transition-colors hover:bg-bg-hover hover:text-accent"
                  onClick={() => handleNavigate(bm)}
                >
                  <FolderOpen className="h-3 w-3 shrink-0" />
                  <span className="truncate">{bm}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Search */}
      <div className="border-b border-border px-2 py-1.5">
        <div className="flex items-center gap-1.5 rounded-md bg-bg-tertiary px-2 py-1">
          <Search className="h-3.5 w-3.5 text-text-muted" />
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-transparent text-xs text-text-primary placeholder:text-text-muted outline-none"
          />
        </div>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
          </div>
        )}

        {error && !loading && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <AlertCircle className="h-5 w-5 text-error" />
            <p className="text-xs text-error">{error}</p>
            <Button variant="secondary" size="sm" onClick={refresh}>
              Retry
            </Button>
          </div>
        )}

        {!loading && !error && sortedEntries.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <p className="text-xs text-text-muted">
              {searchQuery ? 'No matching files' : 'This directory is empty'}
            </p>
          </div>
        )}

        {!loading &&
          !error &&
          sortedEntries.map((entry) => (
            <FileTreeNode
              key={entry.path}
              entry={entry}
              isSelected={selectedPaths.includes(entry.path)}
              onSelect={handleSelect}
              onNavigate={handleNavigate}
              onPreview={handlePreview}
              onContextMenu={handleContextMenu}
            />
          ))}
      </div>

      {/* Context Menu */}
      <FileContextMenu
        entry={contextEntry}
        position={contextPos}
        isBookmarked={contextEntry ? bookmarks.includes(contextEntry.path) : false}
        onClose={handleCloseContextMenu}
        onOpen={(entry) => handleNavigate(entry.path)}
        onPreview={handlePreview}
        onCopyPath={handleCopyPath}
        onBookmark={addBookmark}
        onUnbookmark={removeBookmark}
        onRename={() => {}}
        onDelete={() => {}}
        onNewFile={() => {}}
        onNewFolder={() => {}}
      />
    </div>
  )
}
