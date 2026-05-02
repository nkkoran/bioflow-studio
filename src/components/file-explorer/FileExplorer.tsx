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
  MoreHorizontal,
  Eye,
  EyeOff,
  X,
} from 'lucide-react'
import { useFileStore } from '@/stores/fileStore'
import { LOCAL_CONNECTION_ID, useConnectionStore } from '@/stores/connectionStore'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import { useUIStore } from '@/stores/uiStore'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useDataCartStore } from '@/stores/dataCartStore'
import type { RemoteFileEntry, SortField, SortDirection } from '@/types/files'
import type { DataArtifact, DataArtifactRole, FileNodeData } from '@/types/pipeline'
import { inferFileType } from '@/lib/fileTypeInference'
import { classifyPreview } from '@/lib/filePreviewClassifier'
import { artifactFromEntry, basename, collectProtectedInputPaths, isLargeGeneticPath, stripKnownPlinkExtension } from '@/lib/dataArtifacts'
import { Button } from '@/components/ui/Button'
import { Tooltip } from '@/components/ui/Tooltip'
import { RemoteFileBrowser } from '@/components/file-browser/RemoteFileBrowser'
import { Breadcrumb } from './Breadcrumb'
import { FileTreeNode } from './FileTreeNode'
import { FileContextMenu } from './FileContextMenu'
import { DnxFilePanel } from './DnxFilePanel'
import { useDnxStore } from '@/stores/dnxStore'
import { useDialogStore } from '@/stores/dialogStore'
import { classNames, formatBytes } from '@/lib/utils'
import { FileGlyph } from './FileGlyph'

const SORT_OPTIONS: { label: string; field: SortField; direction: SortDirection }[] = [
  { label: 'Name A-Z', field: 'name', direction: 'asc' },
  { label: 'Name Z-A', field: 'name', direction: 'desc' },
  { label: 'Size (small)', field: 'size', direction: 'asc' },
  { label: 'Size (large)', field: 'size', direction: 'desc' },
  { label: 'Modified (new)', field: 'modified', direction: 'desc' },
  { label: 'Modified (old)', field: 'modified', direction: 'asc' },
  { label: 'Extension', field: 'extension', direction: 'asc' },
]

const DATA_ROLE_OPTIONS: Array<{ value: DataArtifactRole; label: string }> = [
  { value: 'genotypes', label: 'Genotypes' },
  { value: 'phenotype', label: 'Phenotype' },
  { value: 'covariates', label: 'Covariates' },
  { value: 'keep', label: 'Keep samples' },
  { value: 'extract', label: 'Extract SNPs' },
  { value: 'read-freq', label: 'Read freq' },
  { value: 'summary-stats', label: 'Summary stats' },
  { value: 'other', label: 'Other' },
]

const SPLIT_ROLES = new Set<DataArtifactRole>(['genotypes', 'read-freq'])

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
    cwdConnectionId,
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
  const updateNodeData = usePipelineStore((s) => s.updateNodeData)
  const exportSnapshot = usePipelineStore((s) => s.exportSnapshot)
  const devMode = useSettingsStore((s) => s.devMode)
  const fileExplorerViewMode = useSettingsStore((s) => s.settings.fileExplorerViewMode)
  const confirmDialog = useDialogStore((s) => s.confirm)
  const promptDialog = useDialogStore((s) => s.prompt)
  const dataCartItems = useDataCartStore((s) => s.items)
  const dataCartOpen = useDataCartStore((s) => s.open)
  const setDataCartOpen = useDataCartStore((s) => s.setOpen)
  const addDataCartItems = useDataCartStore((s) => s.addItems)
  const removeDataCartItem = useDataCartStore((s) => s.removeItem)
  const clearDataCart = useDataCartStore((s) => s.clear)
  const updateDataCartRole = useDataCartStore((s) => s.updateRole)
  const updateDataCartAxis = useDataCartStore((s) => s.updateAxis)
  const setDataCartSidecarStatuses = useDataCartStore((s) => s.setSidecarStatuses)

  const dnxAuthStatus = useDnxStore((s) => s.authStatus)
  const dnxDefaultProjectId = useDnxStore((s) => s.defaultProjectId)
  const dnxReady = devMode && dnxAuthStatus === 'authenticated' && Boolean(dnxDefaultProjectId)

  const [origin, setOrigin] = useState<'fs' | 'dnx'>('fs')
  const [searchQuery, setSearchQuery] = useState('')
  const [deepSearchResults, setDeepSearchResults] = useState<RemoteFileEntry[] | null>(null)
  const [searchingDeep, setSearchingDeep] = useState(false)
  const [bookmarksOpen, setBookmarksOpen] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadMessage, setUploadMessage] = useState<string | null>(null)
  const [uploadPickerOpen, setUploadPickerOpen] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [moreActionsOpen, setMoreActionsOpen] = useState(false)
  const [tabs, setTabs] = useState<ExplorerTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string>('')
  const [lastSelectedPath, setLastSelectedPath] = useState<string | null>(null)
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; x: number; y: number; active: boolean } | null>(null)
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
      if (cwdConnectionId === activeConnectionId) return
      const conn = connections[activeConnectionId]
      if (conn?.config.defaultDirectory) {
        navigate(conn.config.defaultDirectory, { connectionId: activeConnectionId })
      } else if (conn?.isLocal) {
        // Local connection: get homedir via local API
        window.api.local.homedir().then((home) => navigate(home, { connectionId: activeConnectionId })).catch(() => navigate('/', { connectionId: activeConnectionId }))
      } else {
        // Remote: resolve ~ via SSH exec
        window.api.ssh.exec(activeConnectionId, 'echo $HOME').then((result) => {
          const homePath = result.stdout.trim() || '/home'
          navigate(homePath, { connectionId: activeConnectionId })
        }).catch(() => {
          navigate('/home', { connectionId: activeConnectionId })
        })
      }
    }
  }, [activeConnectionId, cwdConnectionId, isConnected]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sort entries: directories first, then by sort field
  const visibleEntries = useMemo(() => {
    const sourceEntries = deepSearchResults ?? entries
    return showHidden
      ? sourceEntries
      : sourceEntries.filter((entry) => !entry.name.startsWith('.'))
  }, [deepSearchResults, entries, showHidden])
  const sortedEntries = useMemo(() => {
    const filtered = searchQuery
      ? visibleEntries.filter((e) =>
          e.name.toLowerCase().includes(searchQuery.toLowerCase()) || e.path.toLowerCase().includes(searchQuery.toLowerCase()),
        )
      : visibleEntries

    return [...filtered].sort((a, b) => {
      // Directories always first
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1

      // Hidden paths are opt-in and, when visible, never displace normal files.
      const aHidden = a.name.startsWith('.')
      const bHidden = b.name.startsWith('.')
      if (aHidden !== bHidden) return aHidden ? 1 : -1

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
  }, [visibleEntries, sortField, sortDirection, searchQuery])

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

  const applyMarqueeSelection = useCallback((box: { startX: number; startY: number; x: number; y: number }) => {
    const left = Math.min(box.startX, box.x)
    const right = Math.max(box.startX, box.x)
    const top = Math.min(box.startY, box.y)
    const bottom = Math.max(box.startY, box.y)
    const matches: string[] = []
    document.querySelectorAll<HTMLElement>('[data-file-path]').forEach((element) => {
      const rect = element.getBoundingClientRect()
      if (rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom) {
        const path = element.dataset.filePath
        if (path) matches.push(path)
      }
    })
    clearSelection()
    for (const path of matches) selectFile(path)
  }, [clearSelection, selectFile])

  const startMarquee = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('[data-file-path]')) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setMarquee({ startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: true })
  }, [])

  const updateMarquee = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    setMarquee((current) => {
      if (!current?.active) return current
      const next = { ...current, x: event.clientX, y: event.clientY }
      applyMarqueeSelection(next)
      return next
    })
  }, [applyMarqueeSelection])

  const finishMarquee = useCallback(() => {
    setMarquee(null)
  }, [])

  const handleNavigate = useCallback(
    (path: string) => {
      setSearchQuery('')
      setDeepSearchResults(null)
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
    selectedPaths.map((path) => visibleEntries.find((entry) => entry.path === path)).filter((entry): entry is RemoteFileEntry => Boolean(entry))
  ), [selectedPaths, visibleEntries])
  const canManageCurrentFolder = Boolean(activeConnectionId && origin === 'fs')

  const stageSelectedToCart = useCallback(() => {
    if (selectedEntries.length === 0) return
    const itemOrigin = activeConnectionId === LOCAL_CONNECTION_ID ? 'local' : 'ssh'
    addDataCartItems(selectedEntries.map((entry) => artifactFromEntry(entry, itemOrigin)))
    setUploadMessage(`Staged ${selectedEntries.length} item${selectedEntries.length === 1 ? '' : 's'} in the data cart`)
  }, [activeConnectionId, addDataCartItems, selectedEntries])

  const addDataCartToCanvas = useCallback(() => {
    if (dataCartItems.length === 0) return
    const offset = Date.now() % 80
    const groups = new Map<string, { role: DataArtifactRole; artifacts: DataArtifact[] }>()
    for (const item of dataCartItems) {
      const role = item.role ?? 'other'
      const key = `${role}:${item.origin}`
      const group = groups.get(key) ?? { role, artifacts: [] }
      group.artifacts.push(item)
      groups.set(key, group)
    }
    let created = 0
    for (const { role, artifacts } of groups.values()) {
      const rawFileArtifacts = artifacts.filter((item) => item.path)
      const fileArtifacts = SPLIT_ROLES.has(role)
        ? collapsePlinkFilesetArtifacts(rawFileArtifacts)
        : rawFileArtifacts
      if (fileArtifacts.length === 0) continue
      const originLabel = fileArtifacts[0].origin
      const source = originLabel === 'local' ? 'local' : 'remote'
      const roleLabel = DATA_ROLE_OPTIONS.find((option) => option.value === role)?.label ?? 'Files'
      if (fileArtifacts.length > 1 && SPLIT_ROLES.has(role)) {
        const entriesForSplit = fileArtifacts.map((artifact) => ({
          name: artifact.label,
          path: artifact.path!,
          isDirectory: artifact.kind === 'directory',
          size: artifact.size ?? 0,
          modified: artifact.modified ?? Date.now(),
          permissions: '',
          extension: artifact.label.includes('.') ? artifact.label.split('.').pop() ?? '' : '',
        } satisfies RemoteFileEntry))
        const splitGuess = inferManualSplitKeys(entriesForSplit)
        const types = [...new Set(fileArtifacts.map((artifact) => artifact.fileType))]
        addFileNode(
          { x: 120 + offset + created * 28, y: 140 + offset + created * 28 },
          {
            isInput: true,
            label: `${roleLabel} (${fileArtifacts.length})`,
            path: '',
            fileType: types.length === 1 ? types[0] : 'any',
            source,
            origin: originLabel,
            split: {
              axis: fileArtifacts[0].axis || splitGuess.axis,
              items: fileArtifacts.map((artifact, index) => ({
                key: splitGuess.keys[index] ?? artifact.label,
                rawKey: splitGuess.rawKeys[index] ?? splitGuess.keys[index] ?? artifact.label,
                path: artifact.path!,
              })),
              pattern: { kind: 'manual' },
            },
          },
        )
        created += 1
        continue
      }
      for (const artifact of fileArtifacts) {
        addFileNode(
          { x: 120 + offset + created * 28, y: 140 + offset + created * 28 },
          {
            isInput: true,
            label: role === 'other' ? artifact.label : `${roleLabel}: ${artifact.label}`,
            path: artifact.path ?? '',
            pathKind: artifact.kind === 'directory' ? 'directory' : 'file',
            fileType: artifact.fileType,
            source,
            origin: artifact.origin,
          },
        )
        created += 1
      }
    }
    if (created > 0) {
      setUploadMessage(`Added ${created} data node${created === 1 ? '' : 's'} from the cart`)
      clearDataCart()
    }
  }, [addFileNode, clearDataCart, dataCartItems])

  const runDeepSearch = useCallback(async () => {
    if (!activeConnectionId || !searchQuery.trim() || origin !== 'fs') return
    setSearchingDeep(true)
    try {
      const results = activeConnectionId === LOCAL_CONNECTION_ID
        ? await window.api.local.search(cwd, searchQuery.trim(), { maxResults: 200, maxDepth: 5 })
        : await window.api.sftp.search(activeConnectionId, cwd, searchQuery.trim(), { maxResults: 200, maxDepth: 5 })
      setDeepSearchResults(results)
      setUploadMessage(`Found ${results.length} matching path${results.length === 1 ? '' : 's'} under ${cwd}`)
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setSearchingDeep(false)
      window.setTimeout(() => setUploadMessage(null), 4000)
    }
  }, [activeConnectionId, cwd, origin, searchQuery])

  useEffect(() => {
    if (!activeConnectionId || dataCartItems.length === 0) return
    const pending = dataCartItems.filter((item) => item.origin === (activeConnectionId === LOCAL_CONNECTION_ID ? 'local' : 'ssh') && item.sidecars?.some((sidecar) => !sidecar.status || sidecar.status === 'unknown'))
    if (pending.length === 0) return
    let cancelled = false
    async function checkSidecars() {
      for (const item of pending) {
        const paths = item.sidecars?.map((sidecar) => sidecar.path) ?? []
        if (paths.length === 0) continue
        try {
          const rows = activeConnectionId === LOCAL_CONNECTION_ID
            ? await window.api.local.statMany(paths)
            : await window.api.sftp.statMany(activeConnectionId!, paths)
          if (cancelled) return
          setDataCartSidecarStatuses(item.id, Object.fromEntries(rows.map((row) => [row.path, row.ok ? 'present' : 'missing'])))
        } catch {
          if (!cancelled) setDataCartSidecarStatuses(item.id, Object.fromEntries(paths.map((path) => [path, 'unknown'])))
        }
      }
    }
    void checkSidecars()
    return () => { cancelled = true }
  }, [activeConnectionId, dataCartItems, setDataCartSidecarStatuses])

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
    if (tab.cwd) navigate(tab.cwd, { connectionId: tab.connectionId ?? undefined })
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
    const entriesForSplitRaw = fileEntries.length > 0 ? fileEntries : selectedEntries
    const entriesForSplit = collapsePlinkFileEntries(entriesForSplitRaw)
    if (entriesForSplit.length === 1) {
      addEntryToCanvas(entriesForSplit[0])
      return
    }
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
          items: entriesForSplit.map((entry, index) => ({ key: splitGuess.keys[index] ?? entry.name, rawKey: splitGuess.rawKeys[index] ?? entry.name, path: entry.path })),
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
    const snapshot = exportSnapshot()
    const protectedInputs = new Set(collectProtectedInputPaths(snapshot))
    if (protectedInputs.has(entry.path)) {
      setUploadMessage('That path is currently used as a pipeline input, so BioFlow will not delete it from the explorer.')
      window.setTimeout(() => setUploadMessage(null), 5000)
      return
    }
    const folderPrefix = entry.path.replace(/\/+$/, '') + '/'
    if (entry.isDirectory && [...protectedInputs].some((path) => path.startsWith(folderPrefix))) {
      setUploadMessage('That folder contains a current pipeline input or PLINK sidecar, so BioFlow will not delete it from the explorer.')
      window.setTimeout(() => setUploadMessage(null), 5000)
      return
    }
    const confirmed = await confirmDialog({
      title: entry.isDirectory ? 'Delete folder' : 'Delete file',
      message: `Delete ${entry.path}?`,
      detail: entry.isDirectory
        ? 'This deletes the folder and everything inside it. Pipeline input files are never deleted by cleanup; use this only for files you intentionally selected here.'
        : likelyLargeBioFile(entry.name, entry.size) || isLargeGeneticPath(entry.path)
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
      const affectedNodes = snapshot.nodes.filter((node) => (
        node.type === 'file' && fileNodeReferencesDeletedPath(node.data as FileNodeData, entry.path, entry.isDirectory)
      ))
      for (const node of affectedNodes) updateNodeData(node.id, { status: 'missing' } as Partial<FileNodeData>)
      setUploadMessage(
        affectedNodes.length > 0
          ? `Deleted ${entry.name}; flagged ${affectedNodes.length} canvas file node${affectedNodes.length === 1 ? '' : 's'} as missing.`
          : `Deleted ${entry.name}`,
      )
      clearSelection()
      handleCloseContextMenu()
      await refresh()
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : String(err))
    }
  }, [activeConnectionId, clearSelection, confirmDialog, exportSnapshot, handleCloseContextMenu, origin, refresh, updateNodeData])

  const deleteSelectedEntries = useCallback(async () => {
    for (const entry of selectedEntries) {
      await deleteEntry(entry)
    }
  }, [deleteEntry, selectedEntries])

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
    <div className="flex shrink-0 items-center gap-1 bg-bg-secondary/60 px-2 py-1 text-[11px]">
      <select
        value={activeTabId}
        onChange={(event) => switchTab(event.target.value)}
        className="h-6 min-w-0 flex-1 rounded bg-bg-tertiary px-1.5 text-[11px] text-text-primary shadow-sm"
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
    <div className="flex h-full min-h-0 flex-col">
      {tabStrip}
      {/* Pick-mode banner — file or directory. */}
      {filePickMode.active && (
        <div className="animate-fade-up mx-2 mt-2 rounded-lg bg-accent/10 px-3 py-1.5 flex items-center gap-2 shadow-sm">
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
      <div>
        <Breadcrumb path={cwd} onNavigate={handleNavigate} />
      </div>

      {/* Toolbar */}
      <div className="relative flex items-center gap-2 overflow-visible px-3 py-2">
        {selectedEntries.length > 0 ? (
          <>
            <button
              type="button"
              onClick={clearSelection}
              className="interactive-row flex h-7 min-w-0 items-center gap-1.5 px-2 text-xs text-text-secondary"
              aria-label="Clear file selection"
              title="Clear selection"
            >
              <X className="h-3.5 w-3.5 shrink-0" />
              <span className="text-nowrap">{selectedEntries.length} selected</span>
            </button>
            <ToolbarIconButton
              label="Download selected"
              icon={<Download className="h-3.5 w-3.5" />}
              onClick={() => void downloadSelected()}
              disabled={!canUploadLocal || !selectedPath}
            />
            <ToolbarIconButton
              label="Delete selected"
              icon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => void deleteSelectedEntries()}
              disabled={!selectedPath}
              danger
            />
          </>
        ) : (
          <>
            <ToolbarIconButton
              label="New folder"
              icon={<FolderPlus className="h-3.5 w-3.5" />}
              onClick={() => void createFolder()}
              disabled={!canManageCurrentFolder}
            />
            <ToolbarIconButton
              label="Upload"
              icon={<Upload className={classNames('h-3.5 w-3.5', uploading && 'animate-fade-in')} />}
              onClick={() => void uploadLocalFile()}
              disabled={!canUploadLocal || uploading}
            />
            <ToolbarIconButton
              label="Refresh"
              icon={<RefreshCw className={classNames('h-3.5 w-3.5', loading && 'animate-spin')} />}
              onClick={refresh}
              disabled={loading}
            />
          </>
        )}

        <div className="relative ml-auto">
          <ToolbarIconButton
            label="More file actions"
            icon={<MoreHorizontal className="h-3.5 w-3.5" />}
            onClick={() => setMoreActionsOpen((open) => !open)}
          />

          {moreActionsOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMoreActionsOpen(false)} />
              <div className="surface-popover absolute right-0 top-full z-50 mt-1 w-48 rounded-lg py-1">
                <MoreActionButton
                  icon={<ArrowUp className="h-3.5 w-3.5" />}
                  label="Parent folder"
                  disabled={!cwd || cwd === '/' || cwd === '~'}
                  onClick={() => {
                    setMoreActionsOpen(false)
                    navigateUp()
                  }}
                />
                <MoreActionButton
                  icon={<Bookmark className={classNames('h-3.5 w-3.5', isCurrentBookmarked && 'fill-accent text-accent')} />}
                  label={isCurrentBookmarked ? 'Remove bookmark' : 'Bookmark folder'}
                  onClick={() => {
                    setMoreActionsOpen(false)
                    isCurrentBookmarked ? removeBookmark(cwd) : addBookmark(cwd)
                  }}
                />
                <MoreActionButton
                  icon={showHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  label={showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
                  onClick={() => setShowHidden((value) => !value)}
                />
                {selectedEntries.length > 0 && (
                  <>
                    <div className="my-1 h-px bg-border-light" />
                    <MoreActionButton
                      icon={<Download className="h-3.5 w-3.5" />}
                      label="Download"
                      disabled={!canUploadLocal || !selectedPath}
                      onClick={() => {
                        setMoreActionsOpen(false)
                        void downloadSelected()
                      }}
                    />
                    <MoreActionButton
                      icon={<Copy className="h-3.5 w-3.5" />}
                      label="Copy"
                      disabled={!canUploadLocal || !selectedPath}
                      onClick={() => {
                        setMoreActionsOpen(false)
                        void copySelected()
                      }}
                    />
                    <MoreActionButton
                      icon={<MoveRight className="h-3.5 w-3.5" />}
                      label="Move"
                      disabled={!canUploadLocal || !selectedPath}
                      onClick={() => {
                        setMoreActionsOpen(false)
                        void moveSelected()
                      }}
                    />
                    <MoreActionButton
                      icon={<Trash2 className="h-3.5 w-3.5" />}
                      label="Delete"
                      disabled={!selectedPath}
                      danger
                      onClick={() => {
                        setMoreActionsOpen(false)
                        void deleteSelectedEntries()
                      }}
                    />
                    <MoreActionButton
                      icon={<FilePlus2 className="h-3.5 w-3.5" />}
                      label={selectedEntries.length === 1 ? 'Add to canvas' : 'Add as split node'}
                      onClick={() => {
                        setMoreActionsOpen(false)
                        addSelectedToCanvas()
                      }}
                    />
                    <MoreActionButton
                      icon={<Plus className="h-3.5 w-3.5" />}
                      label="Stage in cart"
                      onClick={() => {
                        setMoreActionsOpen(false)
                        stageSelectedToCart()
                      }}
                    />
                  </>
                )}
                <div className="my-1 h-px bg-border-light" />
                <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-text-muted">Sort</div>
                {SORT_OPTIONS.map((opt) => (
                  <MoreActionButton
                    key={`${opt.field}-${opt.direction}`}
                    label={opt.label}
                    active={sortField === opt.field && sortDirection === opt.direction}
                    onClick={() => {
                      setSort(opt.field, opt.direction)
                      setMoreActionsOpen(false)
                    }}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {uploadMessage && (
        <div className="mx-2 rounded-md bg-bg-tertiary/70 px-3 py-1 text-[10px] text-text-muted shadow-sm">
          {uploadMessage}
        </div>
      )}

      {/* Bookmarks section */}
      {bookmarks.length > 0 && (
        <div>
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
      <div className="px-2 py-1.5">
        <div className="flex items-center gap-1.5 rounded-md bg-bg-tertiary px-2 py-1">
          <Search className="h-3.5 w-3.5 text-text-muted" />
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runDeepSearch()
              if (e.key === 'Escape') setDeepSearchResults(null)
            }}
            className="w-full bg-transparent text-xs text-text-primary placeholder:text-text-muted outline-none"
          />
          {deepSearchResults && (
            <button type="button" onClick={() => setDeepSearchResults(null)} className="rounded px-1 text-[10px] text-text-muted hover:bg-bg-hover hover:text-text-primary">
              local
            </button>
          )}
          <button
            type="button"
            onClick={() => void runDeepSearch()}
            disabled={!searchQuery.trim() || searchingDeep}
            className="rounded bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-secondary hover:text-text-primary disabled:opacity-40"
            title="Search inside folders from the current location"
          >
            {searchingDeep ? '...' : 'deep'}
          </button>
        </div>
      </div>

      {dataCartItems.length > 0 && (
        <div className="bg-bg-secondary/60">
          <button
            type="button"
            onClick={() => setDataCartOpen(!dataCartOpen)}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-hover"
          >
            {dataCartOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <FilePlus2 className="h-3 w-3" />
            Data cart ({dataCartItems.length})
            <span className="ml-auto text-[10px] text-text-muted">stage, label, add</span>
          </button>
          {dataCartOpen && (
            <div className="flex max-h-64 flex-col gap-1 overflow-y-auto px-2 pb-2">
              {dataCartItems.map((item) => (
                <DataCartRow
                  key={item.id}
                  item={item}
                  onRole={(role) => updateDataCartRole(item.id, role)}
                  onAxis={(axis) => updateDataCartAxis(item.id, axis)}
                  onRemove={() => removeDataCartItem(item.id)}
                />
              ))}
              <div className="mt-1 flex items-center gap-1">
                <Button variant="primary" size="sm" className="h-7 px-2 text-[11px]" onClick={addDataCartToCanvas}>
                  Add to canvas
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={clearDataCart}>
                  Clear
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* File list */}
      <div
        className="scroll-region relative"
        onPointerDown={startMarquee}
        onPointerMove={updateMarquee}
        onPointerUp={finishMarquee}
        onPointerCancel={finishMarquee}
      >
        {marquee?.active && (
          <div
            className="pointer-events-none fixed z-[120] rounded border border-accent bg-accent/15"
            style={{
              left: Math.min(marquee.startX, marquee.x),
              top: Math.min(marquee.startY, marquee.y),
              width: Math.abs(marquee.x - marquee.startX),
              height: Math.abs(marquee.y - marquee.startY),
            }}
          />
        )}
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

function ToolbarIconButton({
  label,
  icon,
  onClick,
  disabled,
  danger = false,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={onClick}
        disabled={disabled}
        className={classNames(
          'interactive-button flex h-7 min-w-7 items-center justify-center rounded-md text-text-muted disabled:cursor-not-allowed disabled:opacity-40',
          danger ? 'hover:text-error' : 'hover:text-text-primary',
        )}
      >
        {icon}
      </button>
    </Tooltip>
  )
}

function MoreActionButton({
  label,
  icon,
  onClick,
  disabled,
  active,
  danger = false,
}: {
  label: string
  icon?: React.ReactNode
  onClick: () => void
  disabled?: boolean
  active?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={classNames(
        'interactive-row flex h-8 w-full items-center gap-2 px-3 text-left text-xs disabled:cursor-not-allowed disabled:opacity-40',
        active ? 'text-accent' : danger ? 'text-error' : 'text-text-primary',
      )}
    >
      {icon && <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-muted">{icon}</span>}
      <span className="text-nowrap min-w-0 flex-1">{label}</span>
    </button>
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
  return (
    <Tooltip content={entry.path} side="right" delay={500}>
      <div
        data-file-path={entry.path}
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
        <FileGlyph entry={entry} size="grid" selected={isSelected} />
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

function DataCartRow({
  item,
  onRole,
  onAxis,
  onRemove,
}: {
  item: DataArtifact
  onRole: (role: DataArtifactRole) => void
  onAxis: (axis: string) => void
  onRemove: () => void
}) {
  const missingSidecars = item.sidecars?.filter((sidecar) => sidecar.status === 'missing') ?? []
  const presentSidecars = item.sidecars?.filter((sidecar) => sidecar.status === 'present') ?? []
  return (
    <div className="rounded-md border border-border-light bg-bg-primary px-2 py-1.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium text-text-primary" title={item.path}>{item.label}</div>
          <div className="truncate text-[10px] text-text-muted">{item.kind} · {item.fileType}</div>
        </div>
        <button type="button" onClick={onRemove} className="rounded p-0.5 text-text-muted hover:bg-bg-hover hover:text-text-primary" title="Remove from cart">
          <Trash2 size={12} />
        </button>
      </div>
      <div className="mt-1.5 grid grid-cols-[1fr_68px] gap-1">
        <select
          value={item.role ?? 'other'}
          onChange={(event) => onRole(event.target.value as DataArtifactRole)}
          className="h-6 min-w-0 rounded border border-border bg-bg-tertiary px-1.5 text-[10px] text-text-primary"
        >
          {DATA_ROLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <input
          value={item.axis ?? ''}
          onChange={(event) => onAxis(event.target.value)}
          placeholder="axis"
          className="h-6 min-w-0 rounded border border-border bg-bg-tertiary px-1.5 text-[10px] text-text-primary"
        />
      </div>
      {item.sidecars && item.sidecars.length > 0 && (
        <div className={classNames(
          'mt-1 rounded px-1.5 py-1 text-[10px]',
          missingSidecars.length > 0 ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success',
        )}>
          {missingSidecars.length > 0
            ? `Missing sidecar${missingSidecars.length === 1 ? '' : 's'}: ${missingSidecars.map((sidecar) => basename(sidecar.path)).join(', ')}`
            : presentSidecars.length === item.sidecars.length
              ? 'PLINK sidecars found'
              : 'Checking PLINK sidecars'}
        </div>
      )}
    </div>
  )
}

function collapsePlinkFilesetArtifacts(items: DataArtifact[]): DataArtifact[] {
  const byPrefix = new Map<string, DataArtifact[]>()
  const passthrough: DataArtifact[] = []
  for (const item of items) {
    if (!item.path) continue
    const parsed = stripKnownPlinkExtension(item.path)
    if (!parsed.family) {
      passthrough.push(item)
      continue
    }
    const key = `${item.origin}:${parsed.family}:${parsed.prefix}`
    byPrefix.set(key, [...(byPrefix.get(key) ?? []), item])
  }
  const collapsed = [...byPrefix.values()].map((group) => (
    group.find((item) => /\.pgen$/i.test(item.path ?? '')) ??
    group.find((item) => /\.bed$/i.test(item.path ?? '')) ??
    group[0]
  ))
  return [...passthrough, ...collapsed]
}

function collapsePlinkFileEntries(entries: RemoteFileEntry[]): RemoteFileEntry[] {
  const byPrefix = new Map<string, RemoteFileEntry[]>()
  const passthrough: RemoteFileEntry[] = []
  for (const entry of entries) {
    if (entry.isDirectory) {
      passthrough.push(entry)
      continue
    }
    const parsed = stripKnownPlinkExtension(entry.path)
    if (!parsed.family) {
      passthrough.push(entry)
      continue
    }
    const key = `${parsed.family}:${parsed.prefix}`
    byPrefix.set(key, [...(byPrefix.get(key) ?? []), entry])
  }
  const collapsed = [...byPrefix.values()].map((group) => (
    group.find((entry) => /\.pgen$/i.test(entry.path)) ??
    group.find((entry) => /\.bed$/i.test(entry.path)) ??
    group[0]
  ))
  return [...passthrough, ...collapsed]
}

function fileNodeReferencesDeletedPath(data: FileNodeData, deletedPath: string, isDirectory: boolean): boolean {
  const normalizedDeleted = deletedPath.replace(/\/+$/, '')
  const folderPrefix = `${normalizedDeleted}/`
  const matches = (candidate?: string) => {
    if (!candidate) return false
    const normalizedCandidate = candidate.replace(/\/+$/, '')
    if (normalizedCandidate === normalizedDeleted) return true
    return isDirectory && normalizedCandidate.startsWith(folderPrefix)
  }

  return matches(data.path) || (data.split?.items ?? []).some((item) => matches(item.path))
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

function inferManualSplitKeys(entries: RemoteFileEntry[]): { axis: string; keys: string[]; rawKeys: string[] } {
  const chrKeys = entries.map((entry) => {
    const match = entry.name.match(/(?:^|[^A-Za-z0-9])(?:chr|chrom|chromosome)[._-]?([0-9]+|x|y|xy|m|mt)(?=$|[^A-Za-z0-9])/i)
    return match?.[1] ? { key: normalizeSplitKey(match[1]), rawKey: match[1] } : null
  })
  if (chrKeys.every(Boolean) && new Set(chrKeys.map((item) => item?.key)).size === chrKeys.length) {
    return { axis: 'chrom', keys: chrKeys.map((item) => item!.key), rawKeys: chrKeys.map((item) => item!.rawKey) }
  }
  const numericKeys = entries.map((entry) => entry.name.match(/(\d+)/)?.[1] ?? null)
  const normalizedNumeric = numericKeys.map((key) => key ? normalizeSplitKey(key) : null)
  if (numericKeys.every(Boolean) && new Set(normalizedNumeric).size === numericKeys.length) {
    return { axis: 'item', keys: normalizedNumeric as string[], rawKeys: numericKeys as string[] }
  }
  return { axis: 'file', keys: entries.map((entry) => entry.name), rawKeys: entries.map((entry) => entry.name) }
}

function normalizeSplitKey(key: string): string {
  const numeric = Number(key)
  return Number.isFinite(numeric) ? String(numeric) : key.toLowerCase()
}
