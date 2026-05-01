import React, { useEffect, useMemo, useState, useCallback } from 'react'
import {
  ArrowUp,
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
  Download,
  Copy,
  FilePlus2,
  FolderPlus,
  MoveRight,
  Plus,
  Trash2,
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
import { RemoteFileBrowser } from '@/components/file-browser/RemoteFileBrowser'
import { Breadcrumb } from './Breadcrumb'
import { FileTreeNode } from './FileTreeNode'
import { FileContextMenu } from './FileContextMenu'
import { DnxFilePanel } from './DnxFilePanel'
import { useDnxStore } from '@/stores/dnxStore'
import { useDialogStore } from '@/stores/dialogStore'
import { getFileIcon } from './fileIconMap'
import { classNames, formatBytes } from '@/lib/utils'

const SORT_OPTIONS: { label: string; field: SortField; direction: SortDirection }[] = [
  { label: 'Name A-Z', field: 'name', direction: 'asc' },
  { label: 'Name Z-A', field: 'name', direction: 'desc' },
  { label: 'Size (small)', field: 'size', direction: 'asc' },
  { label: 'Size (large)', field: 'size', direction: 'desc' },
  { label: 'Modified (new)', field: 'modified', direction: 'desc' },
  { label: 'Modified (old)', field: 'modified', direction: 'asc' },
  { label: 'Extension', field: 'extension', direction: 'asc' },
]

interface ExplorerTab {
  id: string
  label: string
  origin: 'fs' | 'dnx'
  connectionId: string | null
  cwd: string
}

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
    loadPreferences,
  } = useFileStore()

  const { activeConnectionId, connections, setActiveConnection } = useConnectionStore()
  const { openFile: openPreview } = useDataPreviewStore()
  const filePickMode = useUIStore((s) => s.filePickMode)
  const resolveFilePick = useUIStore((s) => s.resolveFilePick)
  const cancelFilePick = useUIStore((s) => s.cancelFilePick)
  const setBottomPanelMode = useUIStore((s) => s.setBottomPanelMode)
  const addFileNode = usePipelineStore((s) => s.addFileNode)
  const devMode = useSettingsStore((s) => s.devMode)
  const fileExplorerViewMode = useSettingsStore((s) => s.settings.fileExplorerViewMode)
  const confirmDialog = useDialogStore((s) => s.confirm)
  const promptDialog = useDialogStore((s) => s.prompt)

  const dnxAuthStatus = useDnxStore((s) => s.authStatus)
  const dnxDefaultProjectId = useDnxStore((s) => s.defaultProjectId)
  const dnxReady = devMode && dnxAuthStatus === 'authenticated' && Boolean(dnxDefaultProjectId)

  const [origin, setOrigin] = useState<'fs' | 'dnx'>('fs')
  const [searchQuery, setSearchQuery] = useState('')
  const [bookmarksOpen, setBookmarksOpen] = useState(true)
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadMessage, setUploadMessage] = useState<string | null>(null)
  const [uploadPickerOpen, setUploadPickerOpen] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [tabs, setTabs] = useState<ExplorerTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string>('')
  const [lastSelectedPath, setLastSelectedPath] = useState<string | null>(null)
  const currentExplorerLabel = useMemo(() => {
    if (origin === 'dnx') return 'DNAnexus'
    if (activeConnectionId === LOCAL_CONNECTION_ID) return 'Local'
    const connection = activeConnectionId ? connections[activeConnectionId] : undefined
    return connection?.config.name || connection?.config.host || 'Files'
  }, [activeConnectionId, connections, origin])

  // If DNX becomes unavailable while we're on its tab, drop back to fs.
  useEffect(() => {
    if (origin === 'dnx' && !dnxReady) setOrigin('fs')
  }, [origin, dnxReady])

  useEffect(() => {
    void loadPreferences()
  }, [loadPreferences])

  useEffect(() => {
    if (tabs.length > 0) return
    const id = `tab-${Date.now()}`
    setTabs([{ id, label: currentExplorerLabel, origin: 'fs', connectionId: activeConnectionId ?? null, cwd }])
    setActiveTabId(id)
  }, [activeConnectionId, currentExplorerLabel, cwd, tabs.length])

  useEffect(() => {
    if (!activeTabId) return
    setTabs((current) => current.map((tab) => tab.id === activeTabId ? { ...tab, label: currentExplorerLabel, origin, connectionId: activeConnectionId ?? null, cwd } : tab))
  }, [activeConnectionId, activeTabId, currentExplorerLabel, cwd, origin])

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
    (entry: RemoteFileEntry, event: React.MouseEvent) => {
      if (event.shiftKey && lastSelectedPath) {
        const paths = sortedEntries.map((candidate) => candidate.path)
        const start = paths.indexOf(lastSelectedPath)
        const end = paths.indexOf(entry.path)
        if (start >= 0 && end >= 0) {
          clearSelection()
          const [from, to] = start < end ? [start, end] : [end, start]
          for (const path of paths.slice(from, to + 1)) selectFile(path)
          setLastSelectedPath(entry.path)
          return
        }
      }
      if (event.metaKey || event.ctrlKey) {
        if (selectedPaths.includes(entry.path)) deselectFile(entry.path)
        else selectFile(entry.path)
        setLastSelectedPath(entry.path)
        return
      }
      clearSelection()
      selectFile(entry.path)
      setLastSelectedPath(entry.path)
    },
    [clearSelection, deselectFile, lastSelectedPath, selectFile, selectedPaths, sortedEntries],
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
        if (!fileEntryMatchesAccept(filePickMode.accept, entry)) {
          setUploadMessage(`"${entry.name}" does not match the expected input type.`)
          window.setTimeout(() => setUploadMessage(null), 4000)
          return
        }
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
    [activeConnectionId, filePickMode.accept, filePickMode.active, filePickMode.target, resolveFilePick, openPreview, setBottomPanelMode],
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
  const selectedEntries = useMemo(() => (
    selectedPaths.map((path) => entries.find((entry) => entry.path === path)).filter((entry): entry is RemoteFileEntry => Boolean(entry))
  ), [entries, selectedPaths])
  const canManageCurrentFolder = Boolean(activeConnectionId && origin === 'fs')

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
      const stat = await window.api.local.stat(localPath).catch(() => null)
      if (likelyLargeBioFile(name, stat?.size) && !(await confirmDialog({
        title: 'Large genomic file upload',
        message: `Upload ${name} to this server folder?`,
        detail: 'Large genotype or variant files are usually better referenced where they already live, especially for RAP/DNAnexus work. Continue only if this copy is intentional.',
        confirmLabel: 'Upload',
        cancelLabel: 'Cancel',
      }))) {
        return
      }
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
  }, [activeConnectionId, addFileNode, confirmDialog, cwd, refresh, uploadPickerOpen, uploading])

  const switchTab = useCallback((tabId: string) => {
    const tab = tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    setActiveTabId(tab.id)
    setOrigin(tab.origin === 'dnx' && dnxReady ? 'dnx' : 'fs')
    if (tab.connectionId && tab.connectionId !== activeConnectionId) setActiveConnection(tab.connectionId)
    if (tab.cwd) navigate(tab.cwd)
  }, [activeConnectionId, dnxReady, navigate, setActiveConnection, tabs])

  const addExplorerTab = useCallback(() => {
    const id = `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const next: ExplorerTab = { id, label: currentExplorerLabel, origin, connectionId: activeConnectionId ?? null, cwd }
    setTabs((current) => [...current, next])
    setActiveTabId(id)
  }, [activeConnectionId, currentExplorerLabel, cwd, origin])

  const selectedPath = selectedPaths[0] ?? null
  const selectedPickEntry = filePickMode.active && filePickMode.target === 'file'
    ? selectedEntries.find((entry) => !entry.isDirectory && fileEntryMatchesAccept(filePickMode.accept, entry))
    : null

  const resolvePickedEntry = useCallback((entry: RemoteFileEntry) => {
    if (entry.isDirectory) return
    if (!fileEntryMatchesAccept(filePickMode.accept, entry)) {
      setUploadMessage(`"${entry.name}" does not match the expected input type.`)
      window.setTimeout(() => setUploadMessage(null), 4000)
      return
    }
    resolveFilePick(
      entry.path,
      inferFileType(entry.name),
      activeConnectionId === LOCAL_CONNECTION_ID ? 'local' : 'ssh',
    )
  }, [activeConnectionId, filePickMode.accept, resolveFilePick])

  const copySelected = useCallback(async () => {
    if (!activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID || !selectedPath) return
    const name = selectedPath.split('/').pop() || 'copy'
    const destination = await promptDialog({
      title: 'Copy file',
      message: 'Choose the destination path on this server.',
      defaultValue: `${cwd.replace(/\/+$/, '')}/${name}`,
      confirmLabel: 'Copy',
    })
    if (!destination?.trim()) return
    try {
      await window.api.ssh.exec(activeConnectionId, `cp -R ${shellQuote(selectedPath)} ${shellQuote(destination.trim())}`)
      setUploadMessage(`Copied ${name}`)
      await refresh()
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : String(err))
    }
  }, [activeConnectionId, cwd, promptDialog, refresh, selectedPath])

  const addEntryToCanvas = useCallback((entry: RemoteFileEntry) => {
    const originLabel = activeConnectionId === LOCAL_CONNECTION_ID ? 'local' : 'ssh'
    const source = originLabel === 'local' ? 'local' : 'remote'
    const offset = Date.now() % 80
    addFileNode(
      { x: 120 + offset, y: 140 + offset },
      {
        isInput: true,
        label: entry.name,
        path: entry.path,
        pathKind: entry.isDirectory ? 'directory' : 'file',
        fileType: entry.isDirectory ? 'any' : inferFileType(entry.name),
        source,
        origin: originLabel,
      },
    )
    setUploadMessage(`Added ${entry.name} to the canvas`)
  }, [activeConnectionId, addFileNode])

  const moveSelected = useCallback(async () => {
    if (!activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID || !selectedPath) return
    const name = selectedPath.split('/').pop() || 'file'
    const destination = await promptDialog({
      title: 'Move file',
      message: 'Choose the new path on this server.',
      defaultValue: `${cwd.replace(/\/+$/, '')}/${name}`,
      confirmLabel: 'Move',
    })
    if (!destination?.trim()) return
    try {
      await window.api.sftp.rename(activeConnectionId, selectedPath, destination.trim())
      setUploadMessage(`Moved ${name}`)
      clearSelection()
      await refresh()
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : String(err))
    }
  }, [activeConnectionId, clearSelection, cwd, promptDialog, refresh, selectedPath])

  const downloadSelected = useCallback(async () => {
    if (!activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID || !selectedPath) return
    const folder = await window.api.dialog.openDirectory()
    if (!folder) return
    const name = selectedPath.split('/').pop() || 'download'
    try {
      await window.api.sftp.download(activeConnectionId, selectedPath, `${folder}/${name}`)
      setUploadMessage(`Downloaded ${name}`)
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : String(err))
    }
  }, [activeConnectionId, selectedPath])

  const addSelectedToCanvas = useCallback(() => {
    if (selectedEntries.length === 0) return
    const originLabel = activeConnectionId === LOCAL_CONNECTION_ID ? 'local' : 'ssh'
    const source = originLabel === 'local' ? 'local' : 'remote'
    const offset = Date.now() % 80
    if (selectedEntries.length === 1) {
      const entry = selectedEntries[0]
      addFileNode(
        { x: 120 + offset, y: 140 + offset },
        {
          isInput: true,
          label: entry.name,
          path: entry.path,
          pathKind: entry.isDirectory ? 'directory' : 'file',
          fileType: entry.isDirectory ? 'any' : inferFileType(entry.name),
          source,
          origin: originLabel,
        },
      )
      setUploadMessage(`Added ${entry.name} to the canvas`)
      return
    }
    const fileEntries = selectedEntries.filter((entry) => !entry.isDirectory)
    const entriesForSplit = fileEntries.length > 0 ? fileEntries : selectedEntries
    const types = [...new Set(entriesForSplit.map((entry) => entry.isDirectory ? 'any' : inferFileType(entry.name)))]
    const splitGuess = inferManualSplitKeys(entriesForSplit)
    addFileNode(
      { x: 120 + offset, y: 140 + offset },
      {
        isInput: true,
        label: `${entriesForSplit.length} selected files`,
          path: '',
        fileType: types.length === 1 ? types[0] : 'any',
        source,
        origin: originLabel,
          split: {
            axis: splitGuess.axis,
          items: entriesForSplit.map((entry, index) => ({ key: splitGuess.keys[index] ?? entry.name, path: entry.path })),
          pattern: { kind: 'manual' },
        },
      },
    )
    setUploadMessage(`Added ${entriesForSplit.length} selected paths as a split input`)
  }, [activeConnectionId, addFileNode, selectedEntries])

  const renameEntry = useCallback(async (entry: RemoteFileEntry) => {
    if (!activeConnectionId || origin !== 'fs') return
    const next = await promptDialog({
      title: 'Rename',
      message: 'Choose the new path.',
      defaultValue: entry.path,
      confirmLabel: 'Rename',
    })
    if (!next?.trim() || next.trim() === entry.path) return
    try {
      if (activeConnectionId === LOCAL_CONNECTION_ID) await window.api.local.rename(entry.path, next.trim())
      else await window.api.sftp.rename(activeConnectionId, entry.path, next.trim())
      setUploadMessage(`Renamed ${entry.name}`)
      clearSelection()
      handleCloseContextMenu()
      await refresh()
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : String(err))
    }
  }, [activeConnectionId, clearSelection, handleCloseContextMenu, origin, promptDialog, refresh])

  const deleteEntry = useCallback(async (entry: RemoteFileEntry) => {
    if (!activeConnectionId || origin !== 'fs') return
    const confirmed = await confirmDialog({
      title: entry.isDirectory ? 'Delete folder' : 'Delete file',
      message: `Delete ${entry.path}?`,
      detail: entry.isDirectory
        ? 'This deletes the folder and everything inside it. Pipeline input files are never deleted by cleanup; use this only for files you intentionally selected here.'
        : likelyLargeBioFile(entry.name, entry.size)
          ? 'This looks like a genetic data file. Delete only if you are certain it is a disposable copy.'
          : 'This only deletes the selected file from the file explorer.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    })
    if (!confirmed) return
    try {
      if (activeConnectionId === LOCAL_CONNECTION_ID) await window.api.local.delete(entry.path)
      else await window.api.sftp.delete(activeConnectionId, entry.path)
      setUploadMessage(`Deleted ${entry.name}`)
      clearSelection()
      handleCloseContextMenu()
      await refresh()
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : String(err))
    }
  }, [activeConnectionId, clearSelection, confirmDialog, handleCloseContextMenu, origin, refresh])

  const createFileInFolder = useCallback(async (dirPath: string) => {
    if (!activeConnectionId || origin !== 'fs') return
    const name = await promptDialog({
      title: 'New file',
      message: 'Create an empty file.',
      defaultValue: `${dirPath.replace(/\/+$/, '')}/new-file.txt`,
      confirmLabel: 'Create',
    })
    if (!name?.trim()) return
    const target = normalizeChildPath(dirPath, name.trim())
    try {
      if (activeConnectionId === LOCAL_CONNECTION_ID) await window.api.local.write(target, '')
      else await window.api.sftp.write(activeConnectionId, target, '')
      setUploadMessage(`Created ${target}`)
      await refresh()
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : String(err))
    }
  }, [activeConnectionId, origin, promptDialog, refresh])

  const createFolderInFolder = useCallback(async (dirPath: string) => {
    if (!activeConnectionId || origin !== 'fs') return
    const name = await promptDialog({
      title: 'New folder',
      message: 'Create a folder.',
      defaultValue: `${dirPath.replace(/\/+$/, '')}/new-folder`,
      confirmLabel: 'Create',
    })
    if (!name?.trim()) return
    const target = normalizeChildPath(dirPath, name.trim())
    try {
      if (activeConnectionId === LOCAL_CONNECTION_ID) await window.api.local.mkdir(target)
      else await window.api.sftp.mkdir(activeConnectionId, target)
      setUploadMessage(`Created ${target}`)
      await refresh()
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : String(err))
    }
  }, [activeConnectionId, origin, promptDialog, refresh])

  const createFolder = useCallback(async () => {
    if (!activeConnectionId || origin !== 'fs') return
    const name = await promptDialog({
      title: 'New folder',
      message: 'Create a folder in the current location.',
      defaultValue: `${cwd.replace(/\/+$/, '')}/new-folder`,
      confirmLabel: 'Create',
    })
    if (!name?.trim()) return
    const target = normalizeChildPath(cwd, name.trim())
    try {
      if (activeConnectionId === LOCAL_CONNECTION_ID) await window.api.local.mkdir(target)
      else await window.api.sftp.mkdir(activeConnectionId, target)
      setUploadMessage(`Created ${target}`)
      await refresh()
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : String(err))
    }
  }, [activeConnectionId, cwd, origin, promptDialog, refresh])

  const navigateUp = useCallback(() => {
    handleNavigate(parentPath(cwd))
  }, [cwd, handleNavigate])

  const tabStrip = (
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-bg-secondary px-2 py-1 text-[11px]">
      <select
        value={activeTabId}
        onChange={(event) => switchTab(event.target.value)}
        className="h-6 min-w-0 flex-1 rounded border border-border bg-bg-tertiary px-1.5 text-[11px] text-text-primary"
      >
        {tabs.map((tab) => (
          <option key={tab.id} value={tab.id}>
            {tab.label} · {tab.origin === 'dnx' ? 'RAP' : tab.cwd || '/'}
          </option>
        ))}
      </select>
      <button type="button" onClick={addExplorerTab} className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary" title="Open another file tab">
        <Plus size={12} />
      </button>
      <button type="button" onClick={() => setBrowserOpen(true)} className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary" title="Open full file explorer">
        <FolderOpen size={12} />
      </button>
      {dnxReady && (
        <button
        type="button"
        onClick={() => setOrigin('dnx')}
        className={`rounded px-2 py-0.5 ${origin === 'dnx' ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'}`}
        >
          RAP
        </button>
      )}
    </div>
  )

  const standaloneBrowser = (
    <RemoteFileBrowser
      open={browserOpen}
      onClose={() => setBrowserOpen(false)}
      title="File Explorer"
      mode="file"
      browseOnly
      onSelect={() => undefined}
    />
  )

  if (origin === 'dnx' && dnxReady) {
    return (
      <div className="flex h-full flex-col">
        {tabStrip}
        <div className="min-h-0 flex-1">
          <DnxFilePanel />
        </div>
        {standaloneBrowser}
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
        {standaloneBrowser}
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
            {filePickMode.target === 'directory' ? 'Navigate to a folder and click Select for ' : 'Select a file, then click Use selected for '}
            {filePickMode.requesterLabel ? <b>{filePickMode.requesterLabel}</b> : 'this node'}
          </span>
          {filePickMode.target === 'file' && selectedPickEntry && (
            <button
              onClick={() => resolvePickedEntry(selectedPickEntry)}
              className="text-[10px] bg-accent text-white px-2 py-0.5 rounded hover:opacity-90"
              title="Use the selected file"
            >
              Use selected
            </button>
          )}
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

        <Tooltip content="Go to parent folder">
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowUp className="h-3.5 w-3.5" />}
            onClick={navigateUp}
            disabled={!cwd || cwd === '/' || cwd === '~'}
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

        {canManageCurrentFolder && (
          <Tooltip content="Create a folder here">
            <Button
              variant="ghost"
              size="sm"
              icon={<FolderPlus className="h-3.5 w-3.5" />}
              onClick={() => void createFolder()}
              title="New folder"
            />
          </Tooltip>
        )}

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

        {canUploadLocal && selectedPath && (
          <>
            <Tooltip content="Download selected file to this computer">
              <Button variant="ghost" size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={() => void downloadSelected()} />
            </Tooltip>
            <Tooltip content="Copy selected file on this server">
              <Button variant="ghost" size="sm" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => void copySelected()} />
            </Tooltip>
            <Tooltip content="Move or rename selected file on this server">
              <Button variant="ghost" size="sm" icon={<MoveRight className="h-3.5 w-3.5" />} onClick={() => void moveSelected()} />
            </Tooltip>
            <Tooltip content="Delete selected path">
              <Button
                variant="ghost"
                size="sm"
                icon={<Trash2 className="h-3.5 w-3.5" />}
                onClick={() => {
                  const entry = selectedEntries.find((candidate) => candidate.path === selectedPath)
                  if (entry) void deleteEntry(entry)
                }}
              />
            </Tooltip>
          </>
        )}

        {selectedEntries.length > 0 && (
          <Tooltip content={selectedEntries.length === 1 ? 'Add selected path to the canvas' : 'Add selected paths as one split input node'}>
            <Button variant="ghost" size="sm" icon={<FilePlus2 className="h-3.5 w-3.5" />} onClick={addSelectedToCanvas}>
              <span className="text-xs">Add {selectedEntries.length}</span>
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

        {!loading && !error && sortedEntries.length > 0 && (
          fileExplorerViewMode === 'icons' ? (
            <div className="grid grid-cols-[repeat(auto-fill,92px)] justify-start gap-x-3 gap-y-4 p-3">
              {sortedEntries.map((entry) => (
                <FileIconNode
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
          ) : (
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
            ))
          )
        )}
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
        onUseAsInput={addEntryToCanvas}
        onBookmark={addBookmark}
        onUnbookmark={removeBookmark}
        onRename={(entry) => void renameEntry(entry)}
        onDelete={(entry) => void deleteEntry(entry)}
        onNewFile={(dirPath) => void createFileInFolder(dirPath)}
        onNewFolder={(dirPath) => void createFolderInFolder(dirPath)}
      />
      {standaloneBrowser}
    </div>
  )
}

function FileIconNode({
  entry,
  isSelected,
  onSelect,
  onNavigate,
  onPreview,
  onContextMenu,
}: {
  entry: RemoteFileEntry
  isSelected: boolean
  onSelect: (entry: RemoteFileEntry, event: React.MouseEvent) => void
  onNavigate: (path: string) => void
  onPreview: (entry: RemoteFileEntry) => void
  onContextMenu: (event: React.MouseEvent, entry: RemoteFileEntry) => void
}) {
  const iconDef = getFileIcon(entry.extension, entry.isDirectory)
  const Icon = iconDef.icon

  return (
    <Tooltip content={entry.path} side="right" delay={500}>
      <div
        className={classNames(
          'flex h-[108px] w-[92px] cursor-pointer flex-col items-center gap-1.5 rounded-md px-1.5 py-2 text-center transition-colors',
          isSelected
            ? 'bg-accent/15'
            : 'hover:bg-bg-hover',
        )}
        draggable
        onClick={(event) => onSelect(entry, event)}
        onDoubleClick={() => {
          if (entry.isDirectory) onNavigate(entry.path)
          else onPreview(entry)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          onContextMenu(event, entry)
        }}
        onDragStart={(event) => {
          event.dataTransfer.setData('text/plain', entry.path)
          event.dataTransfer.setData('application/x-bioflow-path', entry.path)
          event.dataTransfer.setData('application/x-bioflow-file-entry', JSON.stringify({
            path: entry.path,
            name: entry.name,
            isDirectory: entry.isDirectory,
          }))
          event.dataTransfer.effectAllowed = 'copyMove'
        }}
      >
        <span className={classNames('flex h-12 w-12 items-center justify-center rounded-xl', isSelected ? 'bg-accent/20' : 'bg-bg-tertiary')}>
          <Icon className={classNames('h-7 w-7 shrink-0', iconDef.color)} />
        </span>
        <span
          className="w-full overflow-hidden break-words text-[11px] leading-4 text-text-primary"
          title={entry.name}
          style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 }}
        >
          {entry.name}{entry.isDirectory && '/'}
        </span>
        <span className="text-[10px] text-text-muted">
          {entry.isDirectory ? 'folder' : formatBytes(entry.size)}
        </span>
      </div>
    </Tooltip>
  )
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_\-./~:]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function normalizeChildPath(cwd: string, value: string): string {
  if (value.startsWith('/') || value.startsWith('~/') || value === '~') return value
  return `${cwd.replace(/\/+$/, '')}/${value.replace(/^\/+/, '')}`
}

function parentPath(path: string): string {
  const normalized = path.replace(/\/+$/, '')
  if (!normalized || normalized === '/' || normalized === '~') return normalized || '/'
  if (normalized.startsWith('~/')) {
    const rest = normalized.slice(2)
    const idx = rest.lastIndexOf('/')
    return idx < 0 ? '~' : `~/${rest.slice(0, idx)}`
  }
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return '/'
  return normalized.slice(0, idx)
}

function likelyLargeBioFile(name: string, size?: number | null): boolean {
  const lower = name.toLowerCase()
  return Boolean(size && size > 500 * 1024 * 1024)
    || /\.(bed|bim|fam|pgen|pvar|psam|bgen|vcf\.gz|bcf|bam|cram)$/i.test(lower)
}

function fileEntryMatchesAccept(accept: string[] | undefined, entry: RemoteFileEntry): boolean {
  if (!accept?.length || entry.isDirectory) return true
  const inferred = inferFileType(entry.name || entry.path)
  if (accept.includes(inferred)) return true
  if (inferred === 'pgen' && accept.includes('plink')) return true
  if (inferred === 'bed' && accept.includes('plink')) return true
  if (accept.includes('any')) return true
  return false
}

function inferManualSplitKeys(entries: RemoteFileEntry[]): { axis: string; keys: string[] } {
  const chrKeys = entries.map((entry) => {
    const match = entry.name.match(/(?:^|[^A-Za-z0-9])(?:chr|chrom|chromosome)[._-]?([0-9]+|x|y|xy|m|mt)(?=$|[^A-Za-z0-9])/i)
    return match?.[1] ? normalizeSplitKey(match[1]) : null
  })
  if (chrKeys.every(Boolean) && new Set(chrKeys).size === chrKeys.length) {
    return { axis: 'chrom', keys: chrKeys as string[] }
  }
  const numericKeys = entries.map((entry) => entry.name.match(/(\d+)/)?.[1] ?? null)
  if (numericKeys.every(Boolean) && new Set(numericKeys).size === numericKeys.length) {
    return { axis: 'item', keys: numericKeys.map((key) => normalizeSplitKey(key ?? '')) }
  }
  return { axis: 'file', keys: entries.map((entry) => entry.name) }
}

function normalizeSplitKey(key: string): string {
  const numeric = Number(key)
  return Number.isFinite(numeric) ? String(numeric) : key.toLowerCase()
}
