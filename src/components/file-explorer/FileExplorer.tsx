import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import {
  ArrowLeft,
  ArrowRight,
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
import { MenuSelect } from '@/components/ui/MenuSelect'
import { MiddleEllipsis } from '@/components/ui/MiddleEllipsis'
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
  const openConnectionDialog = useUIStore((s) => s.openConnectionDialog)
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
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false)
  const [deepSearchResults, setDeepSearchResults] = useState<RemoteFileEntry[] | null>(null)
  const [searchingDeep, setSearchingDeep] = useState(false)
  const [bookmarksOpen, setBookmarksOpen] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadMessage, setUploadMessage] = useState<string | null>(null)
  const [uploadPickerOpen, setUploadPickerOpen] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [moreActionsOpen, setMoreActionsOpen] = useState(false)
  const [recentsOpen, setRecentsOpen] = useState(true)
  const [tabs, setTabs] = useState<ExplorerTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string>('')
  const [lastSelectedPath, setLastSelectedPath] = useState<string | null>(null)
  const [sidebarBackStack, setSidebarBackStack] = useState<string[]>([])
  const [sidebarForwardStack, setSidebarForwardStack] = useState<string[]>([])
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; x: number; y: number; active: boolean } | null>(null)
  const sidebarSearchInputRef = useRef<HTMLInputElement>(null)
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
    if (!sidebarSearchOpen) return
    const id = window.setTimeout(() => sidebarSearchInputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [sidebarSearchOpen])

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

  useEffect(() => {
    setSidebarBackStack([])
    setSidebarForwardStack([])
  }, [activeConnectionId, origin])

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
    (path: string, opts: { pushHistory?: boolean } = {}) => {
      if (opts.pushHistory !== false && cwd && path !== cwd) {
        setSidebarBackStack((stack) => [...stack, cwd].slice(-40))
        setSidebarForwardStack([])
      }
      setSearchQuery('')
      setDeepSearchResults(null)
      navigate(path, { connectionId: cwdConnectionId ?? activeConnectionId ?? undefined })
    },
    [activeConnectionId, cwd, cwdConnectionId, navigate],
  )

  const navigateBack = useCallback(() => {
    const previous = sidebarBackStack[sidebarBackStack.length - 1]
    if (!previous) return
    setSidebarBackStack((stack) => stack.slice(0, -1))
    if (cwd) setSidebarForwardStack((stack) => [...stack, cwd].slice(-40))
    handleNavigate(previous, { pushHistory: false })
  }, [cwd, handleNavigate, sidebarBackStack])

  const navigateForward = useCallback(() => {
    const next = sidebarForwardStack[sidebarForwardStack.length - 1]
    if (!next) return
    setSidebarForwardStack((stack) => stack.slice(0, -1))
    if (cwd) setSidebarBackStack((stack) => [...stack, cwd].slice(-40))
    handleNavigate(next, { pushHistory: false })
  }, [cwd, handleNavigate, sidebarForwardStack])

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
          (cwdConnectionId ?? activeConnectionId) === LOCAL_CONNECTION_ID ? 'local' : 'ssh',
        )
        return
      }
      openPreview(entry.path, entry.name, classifyPreview(entry.name || entry.path), {
        connectionId: cwdConnectionId ?? activeConnectionId ?? undefined,
      })
      setBottomPanelMode('data')
    },
    [activeConnectionId, cwdConnectionId, filePickMode.accept, filePickMode.active, filePickMode.target, resolveFilePick, openPreview, setBottomPanelMode],
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
  const selectedEntries = useMemo(() => (
    selectedPaths.map((path) => visibleEntries.find((entry) => entry.path === path)).filter((entry): entry is RemoteFileEntry => Boolean(entry))
  ), [selectedPaths, visibleEntries])
  const currentFileConnectionId = cwdConnectionId ?? activeConnectionId
  const canUploadLocal = Boolean(currentFileConnectionId && currentFileConnectionId !== LOCAL_CONNECTION_ID)
  const canManageCurrentFolder = Boolean(currentFileConnectionId && origin === 'fs')

  const stageSelectedToCart = useCallback(() => {
    if (selectedEntries.length === 0) return
    const itemOrigin = currentFileConnectionId === LOCAL_CONNECTION_ID ? 'local' : 'ssh'
    addDataCartItems(selectedEntries.map((entry) => artifactFromEntry(entry, itemOrigin)))
    setUploadMessage(`Staged ${selectedEntries.length} item${selectedEntries.length === 1 ? '' : 's'} in the data cart`)
  }, [addDataCartItems, currentFileConnectionId, selectedEntries])

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
    if (!currentFileConnectionId || !searchQuery.trim() || origin !== 'fs') return
    setSearchingDeep(true)
    try {
      const results = currentFileConnectionId === LOCAL_CONNECTION_ID
        ? await window.api.local.search(cwd, searchQuery.trim(), { maxResults: 200, maxDepth: 5 })
        : await window.api.sftp.search(currentFileConnectionId, cwd, searchQuery.trim(), { maxResults: 200, maxDepth: 5 })
      setDeepSearchResults(results)
      setUploadMessage(`Found ${results.length} matching path${results.length === 1 ? '' : 's'} under ${cwd}`)
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setSearchingDeep(false)
      window.setTimeout(() => setUploadMessage(null), 4000)
    }
  }, [currentFileConnectionId, cwd, origin, searchQuery])

  useEffect(() => {
    if (!currentFileConnectionId || dataCartItems.length === 0) return
    const connectionId = currentFileConnectionId
    const pending = dataCartItems.filter((item) => item.origin === (connectionId === LOCAL_CONNECTION_ID ? 'local' : 'ssh') && item.sidecars?.some((sidecar) => !sidecar.status || sidecar.status === 'unknown'))
    if (pending.length === 0) return
    let cancelled = false
    async function checkSidecars() {
      for (const item of pending) {
        const paths = item.sidecars?.map((sidecar) => sidecar.path) ?? []
        if (paths.length === 0) continue
        try {
          const rows = connectionId === LOCAL_CONNECTION_ID
            ? await window.api.local.statMany(paths)
            : await window.api.sftp.statMany(connectionId, paths)
          if (cancelled) return
          setDataCartSidecarStatuses(item.id, Object.fromEntries(rows.map((row) => [row.path, row.ok ? 'present' : 'missing'])))
        } catch {
          if (!cancelled) setDataCartSidecarStatuses(item.id, Object.fromEntries(paths.map((path) => [path, 'unknown'])))
        }
      }
    }
    void checkSidecars()
    return () => { cancelled = true }
  }, [currentFileConnectionId, dataCartItems, setDataCartSidecarStatuses])

  const uploadLocalFile = useCallback(async () => {
    if (!currentFileConnectionId || currentFileConnectionId === LOCAL_CONNECTION_ID || uploading || uploadPickerOpen) return
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
      await window.api.sftp.upload(currentFileConnectionId, localPath, remotePath)
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
  }, [addFileNode, confirmDialog, currentFileConnectionId, cwd, refresh, uploadPickerOpen, uploading])

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

  const closeExplorerTab = useCallback((tabId: string) => {
    if (tabs.length <= 1) return
    const index = tabs.findIndex((tab) => tab.id === tabId)
    const nextTabs = tabs.filter((tab) => tab.id !== tabId)
    setTabs(nextTabs)
    if (activeTabId === tabId) {
      const fallback = nextTabs[Math.min(Math.max(index, 0), nextTabs.length - 1)]
      if (fallback) switchTab(fallback.id)
    }
  }, [activeTabId, switchTab, tabs])

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
      (cwdConnectionId ?? activeConnectionId) === LOCAL_CONNECTION_ID ? 'local' : 'ssh',
    )
  }, [activeConnectionId, cwdConnectionId, filePickMode.accept, resolveFilePick])

  const copySelected = useCallback(async () => {
    if (!currentFileConnectionId || currentFileConnectionId === LOCAL_CONNECTION_ID || !selectedPath) return
    const name = selectedPath.split('/').pop() || 'copy'
    const destination = await promptDialog({
      title: 'Copy file',
      message: 'Choose the destination path on this server.',
      defaultValue: `${cwd.replace(/\/+$/, '')}/${name}`,
      confirmLabel: 'Copy',
    })
    if (!destination?.trim()) return
    try {
      await window.api.ssh.exec(currentFileConnectionId, `cp -R ${shellQuote(selectedPath)} ${shellQuote(destination.trim())}`)
      setUploadMessage(`Copied ${name}`)
      await refresh()
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : String(err))
    }
  }, [currentFileConnectionId, cwd, promptDialog, refresh, selectedPath])

  const addEntryToCanvas = useCallback((entry: RemoteFileEntry) => {
    const originLabel = currentFileConnectionId === LOCAL_CONNECTION_ID ? 'local' : 'ssh'
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
  }, [addFileNode, currentFileConnectionId])

  const moveSelected = useCallback(async () => {
    if (!currentFileConnectionId || currentFileConnectionId === LOCAL_CONNECTION_ID || !selectedPath) return
    const name = selectedPath.split('/').pop() || 'file'
    const destination = await promptDialog({
      title: 'Move file',
      message: 'Choose the new path on this server.',
      defaultValue: `${cwd.replace(/\/+$/, '')}/${name}`,
      confirmLabel: 'Move',
    })
    if (!destination?.trim()) return
    try {
      await window.api.sftp.rename(currentFileConnectionId, selectedPath, destination.trim())
      setUploadMessage(`Moved ${name}`)
      clearSelection()
      await refresh()
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : String(err))
    }
  }, [clearSelection, currentFileConnectionId, cwd, promptDialog, refresh, selectedPath])

  const downloadSelected = useCallback(async () => {
    if (!currentFileConnectionId || currentFileConnectionId === LOCAL_CONNECTION_ID || !selectedPath) return
    const folder = await window.api.dialog.openDirectory()
    if (!folder) return
    const name = selectedPath.split('/').pop() || 'download'
    try {
      await window.api.sftp.download(currentFileConnectionId, selectedPath, `${folder}/${name}`)
      setUploadMessage(`Downloaded ${name}`)
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : String(err))
    }
  }, [currentFileConnectionId, selectedPath])

  const addSelectedToCanvas = useCallback(() => {
    if (selectedEntries.length === 0) return
    const originLabel = currentFileConnectionId === LOCAL_CONNECTION_ID ? 'local' : 'ssh'
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
  }, [addFileNode, currentFileConnectionId, selectedEntries])

  const renameEntry = useCallback(async (entry: RemoteFileEntry) => {
    if (!currentFileConnectionId || origin !== 'fs') return
    const next = await promptDialog({
      title: 'Rename',
      message: 'Choose the new path.',
      defaultValue: entry.path,
      confirmLabel: 'Rename',
    })
    if (!next?.trim() || next.trim() === entry.path) return
    try {
      if (currentFileConnectionId === LOCAL_CONNECTION_ID) await window.api.local.rename(entry.path, next.trim())
      else await window.api.sftp.rename(currentFileConnectionId, entry.path, next.trim())
      setUploadMessage(`Renamed ${entry.name}`)
      clearSelection()
      handleCloseContextMenu()
      await refresh()
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : String(err))
    }
  }, [clearSelection, currentFileConnectionId, handleCloseContextMenu, origin, promptDialog, refresh])

  const deleteEntry = useCallback(async (entry: RemoteFileEntry) => {
    if (!currentFileConnectionId || origin !== 'fs') return
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
      if (currentFileConnectionId === LOCAL_CONNECTION_ID) await window.api.local.delete(entry.path)
      else await window.api.sftp.delete(currentFileConnectionId, entry.path)
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
  }, [clearSelection, confirmDialog, currentFileConnectionId, exportSnapshot, handleCloseContextMenu, origin, refresh, updateNodeData])

  const deleteSelectedEntries = useCallback(async () => {
    for (const entry of selectedEntries) {
      await deleteEntry(entry)
    }
  }, [deleteEntry, selectedEntries])

  const createFileInFolder = useCallback(async (dirPath: string) => {
    if (!currentFileConnectionId || origin !== 'fs') return
    const name = await promptDialog({
      title: 'New file',
      message: 'Create an empty file.',
      defaultValue: `${dirPath.replace(/\/+$/, '')}/new-file.txt`,
      confirmLabel: 'Create',
    })
    if (!name?.trim()) return
    const target = normalizeChildPath(dirPath, name.trim())
    try {
      if (currentFileConnectionId === LOCAL_CONNECTION_ID) await window.api.local.write(target, '')
      else await window.api.sftp.write(currentFileConnectionId, target, '')
      setUploadMessage(`Created ${target}`)
      await refresh()
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : String(err))
    }
  }, [currentFileConnectionId, origin, promptDialog, refresh])

  const createFolderInFolder = useCallback(async (dirPath: string) => {
    if (!currentFileConnectionId || origin !== 'fs') return
    const name = await promptDialog({
      title: 'New folder',
      message: 'Create a folder.',
      defaultValue: `${dirPath.replace(/\/+$/, '')}/new-folder`,
      confirmLabel: 'Create',
    })
    if (!name?.trim()) return
    const target = normalizeChildPath(dirPath, name.trim())
    try {
      if (currentFileConnectionId === LOCAL_CONNECTION_ID) await window.api.local.mkdir(target)
      else await window.api.sftp.mkdir(currentFileConnectionId, target)
      setUploadMessage(`Created ${target}`)
      await refresh()
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : String(err))
    }
  }, [currentFileConnectionId, origin, promptDialog, refresh])

  const createFolder = useCallback(async () => {
    if (!currentFileConnectionId || origin !== 'fs') return
    const name = await promptDialog({
      title: 'New folder',
      message: 'Create a folder in the current location.',
      defaultValue: `${cwd.replace(/\/+$/, '')}/new-folder`,
      confirmLabel: 'Create',
    })
    if (!name?.trim()) return
    const target = normalizeChildPath(cwd, name.trim())
    try {
      if (currentFileConnectionId === LOCAL_CONNECTION_ID) await window.api.local.mkdir(target)
      else await window.api.sftp.mkdir(currentFileConnectionId, target)
      setUploadMessage(`Created ${target}`)
      await refresh()
    } catch (err) {
      setUploadMessage(err instanceof Error ? err.message : String(err))
    }
  }, [currentFileConnectionId, cwd, origin, promptDialog, refresh])

  const navigateUp = useCallback(() => {
    handleNavigate(parentPath(cwd))
  }, [cwd, handleNavigate])

  const compactPathLabel = origin === 'dnx' ? 'DNAnexus /' : compactSidebarPath(cwd)
  const itemCountLabel = `${sortedEntries.length} item${sortedEntries.length === 1 ? '' : 's'}`
  const recentTabs = tabs.filter((tab) => tab.id !== activeTabId).slice(-4).reverse()

  const sidebarHeader = (
    <div className="shrink-0 overflow-visible">
      <div className="flex h-7 items-center gap-1 overflow-visible px-1.5">
        <ToolbarIconButton
          label="Back"
          icon={<ArrowLeft className="h-3 w-3" />}
          onClick={navigateBack}
          disabled={sidebarBackStack.length === 0 || loading}
        />
        <ToolbarIconButton
          label="Forward"
          icon={<ArrowRight className="h-3 w-3" />}
          onClick={navigateForward}
          disabled={sidebarForwardStack.length === 0 || loading}
        />
        <button
          type="button"
          onClick={() => setBrowserOpen(true)}
          className="interactive-row flex min-w-0 flex-1 items-center gap-1 px-1 text-left text-[10px] text-text-secondary hover:text-text-primary"
          title={origin === 'dnx' ? 'Open full file explorer' : `${cwd} - click to open full file explorer`}
        >
          <FolderOpen size={12} className="shrink-0 text-text-muted" />
          <span className="min-w-0 flex-1 font-mono" title={origin === 'dnx' ? currentExplorerLabel : cwd}>
            <MiddleEllipsis value={origin === 'dnx' ? currentExplorerLabel : compactPathLabel} max={30} />
          </span>
        </button>
        <button
          type="button"
          onClick={() => setBrowserOpen(true)}
          className="interactive-row flex h-6 w-6 shrink-0 items-center justify-center text-accent"
          title="Open full file explorer"
          aria-label="Open full file explorer"
        >
          <FolderOpen size={12} className="shrink-0" />
        </button>
        <ToolbarIconButton
          label="Parent folder"
          icon={<ArrowUp className="h-3 w-3" />}
          onClick={navigateUp}
          disabled={!isConnected || origin !== 'fs' || !cwd || cwd === '/' || cwd === '~' || loading}
        />
        <ToolbarIconButton
          label={sidebarSearchOpen ? 'Close search' : 'Filter files'}
          icon={<Search className="h-3 w-3" />}
          onClick={() => {
            setSidebarSearchOpen((open) => {
              if (open) {
                setSearchQuery('')
                setDeepSearchResults(null)
              }
              return !open
            })
          }}
        />
        <ToolbarIconButton
          label="Refresh"
          icon={<RefreshCw className={classNames('h-3 w-3', loading && 'animate-fade-in')} />}
          onClick={() => void refresh()}
          disabled={!isConnected || origin !== 'fs' || loading}
        />
        <ToolbarIconButton
          label="Upload"
          icon={<Upload className="h-3 w-3" />}
          onClick={() => void uploadLocalFile()}
          disabled={!canUploadLocal || uploading}
        />
        <div className="relative overflow-visible">
          <ToolbarIconButton
            label="Explorer menu"
            icon={<MoreHorizontal className="h-3 w-3" />}
            onClick={() => setMoreActionsOpen((open) => !open)}
          />
          {moreActionsOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMoreActionsOpen(false)} />
              <div className="surface-popover absolute right-0 top-full z-50 mt-1 w-56 rounded-lg py-1">
                <MoreActionButton
                  icon={<FolderOpen className="h-3 w-3" />}
                  label="Open full explorer"
                  onClick={() => {
                    setMoreActionsOpen(false)
                    setBrowserOpen(true)
                  }}
                />
                <MoreActionButton
                  icon={<Plus className="h-3 w-3" />}
                  label="New explorer tab"
                  onClick={() => {
                    setMoreActionsOpen(false)
                    addExplorerTab()
                  }}
                />
                {dnxReady && (
                  <MoreActionButton
                    label={origin === 'dnx' ? 'Use server files' : 'Use RAP files'}
                    active={origin === 'dnx'}
                    onClick={() => {
                      setMoreActionsOpen(false)
                      setOrigin(origin === 'dnx' ? 'fs' : 'dnx')
                    }}
                  />
                )}
                <div className="my-1 h-px bg-border-light" />
                <MoreActionButton
                  icon={<ArrowUp className="h-3 w-3" />}
                  label="Parent folder"
                  disabled={!isConnected || origin !== 'fs' || !cwd || cwd === '/' || cwd === '~'}
                  onClick={() => {
                    setMoreActionsOpen(false)
                    navigateUp()
                  }}
                />
                <MoreActionButton
                  icon={<Bookmark className={classNames('h-3 w-3', isCurrentBookmarked && 'fill-accent text-accent')} />}
                  label={isCurrentBookmarked ? 'Remove bookmark' : 'Bookmark folder'}
                  disabled={!isConnected || origin !== 'fs'}
                  onClick={() => {
                    setMoreActionsOpen(false)
                    isCurrentBookmarked ? removeBookmark(cwd) : addBookmark(cwd)
                  }}
                />
                <MoreActionButton
                  icon={<RefreshCw className={classNames('h-3 w-3', loading && 'animate-fade-in')} />}
                  label="Refresh"
                  disabled={!isConnected || origin !== 'fs' || loading}
                  onClick={() => {
                    setMoreActionsOpen(false)
                    refresh()
                  }}
                />
                <MoreActionButton
                  icon={<FolderPlus className="h-3 w-3" />}
                  label="New folder"
                  disabled={!canManageCurrentFolder}
                  onClick={() => {
                    setMoreActionsOpen(false)
                    void createFolder()
                  }}
                />
                <MoreActionButton
                  icon={<Upload className="h-3 w-3" />}
                  label="Upload"
                  disabled={!canUploadLocal || uploading}
                  onClick={() => {
                    setMoreActionsOpen(false)
                    void uploadLocalFile()
                  }}
                />
                {selectedEntries.length > 0 && (
                  <>
                    <div className="my-1 h-px bg-border-light" />
                    <MoreActionButton
                      icon={<Copy className="h-3 w-3" />}
                      label="Copy"
                      disabled={!canUploadLocal || !selectedPath}
                      onClick={() => {
                        setMoreActionsOpen(false)
                        void copySelected()
                      }}
                    />
                    <MoreActionButton
                      icon={<MoveRight className="h-3 w-3" />}
                      label="Move"
                      disabled={!canUploadLocal || !selectedPath}
                      onClick={() => {
                        setMoreActionsOpen(false)
                        void moveSelected()
                      }}
                    />
                    <MoreActionButton
                      icon={<FilePlus2 className="h-3 w-3" />}
                      label={selectedEntries.length === 1 ? 'Add to canvas' : 'Add as split node'}
                      onClick={() => {
                        setMoreActionsOpen(false)
                        addSelectedToCanvas()
                      }}
                    />
                    <MoreActionButton
                      icon={<Plus className="h-3 w-3" />}
                      label="Stage in cart"
                      onClick={() => {
                        setMoreActionsOpen(false)
                        stageSelectedToCart()
                      }}
                    />
                    <MoreActionButton
                      icon={<Trash2 className="h-3 w-3" />}
                      label="Delete"
                      disabled={!selectedPath}
                      danger
                      onClick={() => {
                        setMoreActionsOpen(false)
                        void deleteSelectedEntries()
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

      <div className="flex h-7 items-center gap-1 overflow-hidden px-2 pb-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              title={`${tab.label}: ${tab.cwd}`}
              className={classNames(
                'interactive-row flex h-6 min-w-[4.5rem] max-w-[9rem] items-center gap-1 px-1 text-left text-[10px]',
                tab.id === activeTabId ? 'bg-bg-tertiary text-text-primary shadow-sm' : 'text-text-muted hover:text-text-primary',
              )}
            >
              <button
                type="button"
                onClick={() => switchTab(tab.id)}
                className="flex min-w-0 flex-1 items-center gap-1 text-left"
                aria-label={`Switch to ${tab.label}`}
              >
                <FolderOpen size={11} className="shrink-0" />
                <span className="min-w-0 flex-1 font-mono" title={tab.cwd}>
                  <MiddleEllipsis value={tab.origin === 'dnx' ? 'DNX' : compactSidebarPath(tab.cwd)} max={18} />
                </span>
              </button>
              {tabs.length > 1 && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    closeExplorerTab(tab.id)
                  }}
                  className="rounded p-0.5 text-text-muted hover:bg-bg-hover hover:text-text-primary"
                  aria-label={`Close ${tab.label}`}
                >
                  <X size={10} />
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addExplorerTab}
          className="interactive-button flex h-6 w-6 shrink-0 items-center justify-center text-text-muted hover:text-text-primary"
          title="New explorer tab"
          aria-label="New explorer tab"
        >
          <Plus size={12} />
        </button>
      </div>

      {sidebarSearchOpen && (
        <div className="animate-fade-up px-2 pb-2">
          <div className="bioflow-field flex h-7 items-center gap-1.5 rounded-md px-2">
            <Search size={12} className="shrink-0 text-text-muted" />
            <input
              ref={sidebarSearchInputRef}
              type="text"
              placeholder="Filter files..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runDeepSearch()
                if (e.key === 'Escape') {
                  setSidebarSearchOpen(false)
                  setSearchQuery('')
                  setDeepSearchResults(null)
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-[11px] text-text-primary placeholder:text-text-muted outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('')
                  setDeepSearchResults(null)
                }}
                className="interactive-button flex h-5 w-5 items-center justify-center text-text-muted hover:text-text-primary"
                aria-label="Clear file filter"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )

  const standaloneBrowser = (
    <RemoteFileBrowser
      open={browserOpen}
      onClose={() => setBrowserOpen(false)}
      title="File Explorer"
      mode="multi-file"
      browseOnly
      onSelect={() => undefined}
    />
  )

  if (origin === 'dnx' && dnxReady) {
    return (
      <div className="flex h-full flex-col">
        {sidebarHeader}
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
        {sidebarHeader}
        <div className="bioflow-empty-state animate-fade-up flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <FolderOpen className="text-text-muted" strokeWidth={1.5} />
          <p className="text-sm font-medium text-text-secondary">No files</p>
          <p className="text-wrap text-xs text-text-muted">Connect to a cluster to browse files.</p>
          <button
            type="button"
            onClick={openConnectionDialog}
            className="interactive-row px-2 py-1 text-xs text-accent"
          >
            Connect to cluster
          </button>
        </div>
        <footer className="flex h-6 shrink-0 items-center justify-between px-3 text-[11px] text-text-muted">
          <span>0 items</span>
          <ServerOff size={13} />
        </footer>
        {standaloneBrowser}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {sidebarHeader}
      {filePickMode.active && (
        <div className="animate-fade-up mx-2 mb-2 rounded-lg bg-accent/10 px-3 py-1.5 flex items-center gap-2 shadow-sm">
          <span className="text-nowrap flex-1 text-xs text-text-primary">
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
              onClick={() => resolveFilePick(cwd, undefined, (cwdConnectionId ?? activeConnectionId) === LOCAL_CONNECTION_ID ? 'local' : 'ssh')}
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

      {uploadMessage && (
        <div className="animate-fade-up mx-2 mb-2 rounded-md bg-bg-tertiary/70 px-3 py-1 text-[10px] text-text-muted shadow-sm">
          {uploadMessage}
        </div>
      )}

      {bookmarks.length > 0 && (
        <section className="shrink-0 pb-1">
          <button
            className="bioflow-section-label interactive-row flex h-6 w-full items-center gap-1.5 rounded-none px-3 text-left"
            onClick={() => setBookmarksOpen(!bookmarksOpen)}
          >
            {bookmarksOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span className="text-nowrap">Bookmarks</span>
          </button>

          {bookmarksOpen && (
            <div className="px-1 pb-1">
              {bookmarks.map((bm) => (
                <button
                  key={bm}
                  className="interactive-row flex h-6 w-full items-center gap-1.5 px-2 text-left text-[10px] text-text-secondary hover:text-text-primary"
                  onClick={() => handleNavigate(bm)}
                  title={bm}
                >
                  <FolderOpen size={12} className="shrink-0 text-text-muted" />
                  <span className="min-w-0 flex-1 font-mono">
                    <MiddleEllipsis value={compactSidebarPath(bm)} max={28} />
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {recentTabs.length > 0 && (
        <section className="shrink-0 pb-1">
          <button
            className="bioflow-section-label interactive-row flex h-6 w-full items-center gap-1.5 rounded-none px-3 text-left"
            onClick={() => setRecentsOpen(!recentsOpen)}
          >
            {recentsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span className="text-nowrap">Recents</span>
          </button>
          {recentsOpen && (
            <div className="px-1 pb-1">
              {recentTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => switchTab(tab.id)}
                  className="interactive-row flex h-6 w-full items-center gap-1.5 px-2 text-left text-[9px] text-text-secondary hover:text-text-primary"
                >
                  <FolderOpen size={12} className="shrink-0 text-text-muted" />
                  <span className="text-nowrap min-w-0 flex-1 truncate font-mono">{tab.label}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {dataCartItems.length > 0 && (
        <section className="shrink-0 bg-bg-secondary/30">
          <button
            type="button"
            onClick={() => setDataCartOpen(!dataCartOpen)}
            className="bioflow-section-label interactive-row flex h-6 w-full items-center gap-1.5 rounded-none px-3 text-left"
          >
            {dataCartOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <span className="text-nowrap">Data cart ({dataCartItems.length})</span>
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
        </section>
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
          <div className="flex flex-col gap-2 p-3">
            <div className="animate-shimmer h-7 rounded-md" />
            <div className="animate-shimmer h-7 rounded-md" />
            <div className="animate-shimmer h-7 rounded-md" />
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
          <div className="bioflow-empty-state animate-fade-up flex h-full flex-col items-center justify-center gap-2 px-5 text-center">
            <FolderOpen className="text-text-muted" strokeWidth={1.5} />
            <p className="text-sm font-medium text-text-secondary">No files</p>
            <p className="text-wrap text-xs text-text-muted">
              {searchQuery ? 'No matching files in this folder.' : 'This directory is empty.'}
            </p>
          </div>
        )}

        {!loading && !error && sortedEntries.length > 0 && (
          <div className="px-1 pb-2">
            {selectedEntries.length > 0 && (
              <div className="animate-fade-up sticky top-0 z-20 flex h-9 items-center gap-1.5 bg-bg-secondary/95 px-2 shadow-sm backdrop-blur">
                <button
                  type="button"
                  onClick={clearSelection}
                  className="interactive-row flex min-w-0 flex-1 items-center gap-1.5 px-2 text-xs text-text-secondary"
                  aria-label="Clear file selection"
                >
                  <span className="text-nowrap">{selectedEntries.length} selected</span>
                </button>
                <ToolbarIconButton
                  label="Download selected"
                  icon={<Download className="h-3 w-3" />}
                  onClick={() => void downloadSelected()}
                  disabled={!canUploadLocal || !selectedPath}
                />
                <ToolbarIconButton
                  label={selectedEntries.length === 1 ? 'Add selected to canvas' : 'Add selected as split node'}
                  icon={<FilePlus2 className="h-3 w-3" />}
                  onClick={addSelectedToCanvas}
                />
                <ToolbarIconButton
                  label="Delete selected"
                  icon={<Trash2 className="h-3 w-3" />}
                  onClick={() => void deleteSelectedEntries()}
                  disabled={!selectedPath}
                  danger
                />
                <ToolbarIconButton
                  label="Clear selection"
                  icon={<X className="h-3 w-3" />}
                  onClick={clearSelection}
                />
              </div>
            )}
            {sortedEntries.map((entry) => (
              <SidebarFileRow
                key={entry.path}
                entry={entry}
                isSelected={selectedPaths.includes(entry.path)}
                dragEntries={selectedPaths.includes(entry.path) && selectedEntries.length > 1 ? selectedEntries : [entry]}
                onSelect={handleSelect}
                onNavigate={handleNavigate}
                onPreview={handlePreview}
                onContextMenu={handleContextMenu}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="flex h-6 shrink-0 items-center justify-between gap-2 px-3 text-[11px] text-text-muted">
        <span className="text-nowrap">{deepSearchResults ? `${itemCountLabel} found` : itemCountLabel}</span>
        <Tooltip content={showHidden ? 'Hide dotfiles' : 'Show hidden files'}>
          <button
            type="button"
            aria-label={showHidden ? 'Hide dotfiles' : 'Show hidden files'}
            onClick={() => setShowHidden((value) => !value)}
            className="interactive-button flex h-5 w-5 items-center justify-center text-text-muted hover:text-text-primary"
          >
            {showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
        </Tooltip>
      </footer>

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
          'interactive-button flex h-6 min-w-6 items-center justify-center rounded text-text-muted disabled:cursor-not-allowed disabled:opacity-40',
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
        'interactive-row flex h-7 w-full items-center gap-1.5 px-2.5 text-left text-[11px] disabled:cursor-not-allowed disabled:opacity-40',
        active ? 'text-accent' : danger ? 'text-error' : 'text-text-primary',
      )}
    >
      {icon && <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-muted">{icon}</span>}
      <span className="text-nowrap min-w-0 flex-1">{label}</span>
    </button>
  )
}

function SidebarFileRow({
  entry,
  isSelected,
  dragEntries,
  onSelect,
  onNavigate,
  onPreview,
  onContextMenu,
}: {
  entry: RemoteFileEntry
  isSelected: boolean
  dragEntries: RemoteFileEntry[]
  onSelect: (entry: RemoteFileEntry, event: React.MouseEvent) => void
  onNavigate: (path: string) => void
  onPreview: (entry: RemoteFileEntry) => void
  onContextMenu: (event: React.MouseEvent, entry: RemoteFileEntry) => void
}) {
  const fileType = entry.isDirectory ? '' : inferFileType(entry.name)
  return (
    <div
      data-file-path={entry.path}
      className={classNames(
        'group flex h-6 min-w-0 items-center gap-1 rounded-sm border-l-2 pr-1 text-[11px]',
        isSelected
          ? 'border-accent bg-bg-tertiary text-text-primary'
          : 'border-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary',
      )}
      draggable
      onClick={(event) => {
        if (entry.isDirectory && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
          onNavigate(entry.path)
          return
        }
        onSelect(entry, event)
      }}
      onDoubleClick={() => {
        if (entry.isDirectory) onNavigate(entry.path)
        else onPreview(entry)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        onContextMenu(event, entry)
      }}
      onDragStart={(event) => {
        const primary = dragEntries[0] ?? entry
        event.dataTransfer.setData('text/plain', primary.path)
        event.dataTransfer.setData('application/x-bioflow-path', primary.path)
        event.dataTransfer.setData('application/x-bioflow-file-entry', JSON.stringify({
          path: primary.path,
          name: primary.name,
          isDirectory: primary.isDirectory,
        }))
        event.dataTransfer.setData('application/x-bioflow-file-entries', JSON.stringify(dragEntries.map((item) => ({
          path: item.path,
          name: item.name,
          isDirectory: item.isDirectory,
        }))))
        event.dataTransfer.effectAllowed = 'copyMove'
      }}
      title={entry.path}
    >
      <button
        type="button"
        className="flex h-6 w-4 shrink-0 items-center justify-center text-text-muted hover:text-text-primary"
        onClick={(event) => {
          event.stopPropagation()
          if (entry.isDirectory) onNavigate(entry.path)
        }}
        aria-label={entry.isDirectory ? `Open ${entry.name}` : entry.name}
        tabIndex={entry.isDirectory ? 0 : -1}
      >
        {entry.isDirectory ? <ChevronRight size={11} /> : null}
      </button>
      <FileGlyph entry={entry} size="row" selected={isSelected} />
      <span className="text-nowrap min-w-0 flex-1">{entry.name}{entry.isDirectory ? '/' : ''}</span>
      {!entry.isDirectory && (
        <span className="bioflow-badge text-nowrap max-w-12 shrink-0 rounded bg-bg-tertiary px-1 text-[9px] text-text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {fileType}
        </span>
      )}
      <button
        type="button"
        className="interactive-button flex h-5 w-5 shrink-0 items-center justify-center text-text-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        onClick={(event) => {
          event.stopPropagation()
          onContextMenu(event, entry)
        }}
        aria-label={`Open actions for ${entry.name}`}
      >
        <MoreHorizontal size={12} />
      </button>
    </div>
  )
}

function FileIconNode({
  entry,
  isSelected,
  dragEntries = [entry],
  onSelect,
  onNavigate,
  onPreview,
  onContextMenu,
}: {
  entry: RemoteFileEntry
  isSelected: boolean
  dragEntries?: RemoteFileEntry[]
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
          'flex h-[88px] w-[78px] cursor-pointer flex-col items-center gap-1.5 rounded-md px-1.5 py-2 text-center transition-colors',
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
          const primary = dragEntries[0] ?? entry
          event.dataTransfer.setData('text/plain', primary.path)
          event.dataTransfer.setData('application/x-bioflow-path', primary.path)
          event.dataTransfer.setData('application/x-bioflow-file-entry', JSON.stringify({
            path: primary.path,
            name: primary.name,
            isDirectory: primary.isDirectory,
          }))
          event.dataTransfer.setData('application/x-bioflow-file-entries', JSON.stringify(dragEntries.map((item) => ({
            path: item.path,
            name: item.name,
            isDirectory: item.isDirectory,
          }))))
          event.dataTransfer.effectAllowed = 'copyMove'
        }}
      >
        <FileGlyph entry={entry} size="grid" selected={isSelected} />
        <span
          className="w-full overflow-hidden break-words text-[10px] leading-3 text-text-primary"
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
        <MenuSelect<DataArtifactRole>
          value={item.role ?? 'other'}
          onChange={(value) => onRole((value || 'other') as DataArtifactRole)}
          options={DATA_ROLE_OPTIONS}
          ariaLabel="Data role"
          buttonClassName="h-6 text-[10px] px-1.5"
          menuClassName="w-40"
        />
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

function compactSidebarPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return 'Files'
  if (trimmed === '/' || trimmed === '~') return trimmed
  const suffix = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
  const parts = suffix.split('/').filter(Boolean)
  if (suffix.startsWith('~/')) {
    const homeParts = suffix.slice(2).split('/').filter(Boolean)
    if (homeParts.length <= 1) return `~/${homeParts.join('/')}`.replace(/\/$/, '')
    return `.../${homeParts.slice(-2).join('/')}`
  }
  if (parts.length <= 2) return suffix.startsWith('/') ? `/${parts.join('/')}` : parts.join('/')
  return `.../${parts.slice(-2).join('/')}`
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
