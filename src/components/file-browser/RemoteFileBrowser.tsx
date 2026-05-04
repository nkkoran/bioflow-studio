import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronRight,
  Clock3,
  Code2,
  Copy,
  EyeOff,
  FilePlus2,
  FileText,
  FolderOpen,
  FolderPlus,
  Grid2X2,
  HardDrive,
  Home,
  List,
  MoreHorizontal,
  PanelsLeftRight,
  Pencil,
  RefreshCw,
  Search,
  Server,
  SlidersHorizontal,
  Star,
  Table2,
  TerminalSquare,
  Upload,
  X,
} from 'lucide-react'

import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { MenuSelect } from '@/components/ui/MenuSelect'
import { ContextMenu } from '@/components/ui/ContextMenu'
import { useConnectionStore, LOCAL_CONNECTION_ID } from '@/stores/connectionStore'
import { useDnxStore } from '@/stores/dnxStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useDialogStore } from '@/stores/dialogStore'
import { inferFileType } from '@/lib/fileTypeInference'
import { collapseHomePath, expandHomePath, pathDirname } from '@/lib/remotePath'
import { classNames, formatBytes } from '@/lib/utils'
import type { RemoteFileEntry } from '@/types'
import type { FileOrigin } from '@/constants/connections'
import { SplitFileTransferDialog } from '@/components/file-explorer/SplitFileTransferDialog'
import { FileGlyph } from '@/components/file-explorer/FileGlyph'
import { headPreviewFileForConnection, statFileForConnection } from '@/stores/fileStore'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useUIStore } from '@/stores/uiStore'
import { collectProtectedInputPaths } from '@/lib/dataArtifacts'

const RECENTS_KEY = 'fileBrowser:recents:v1'
const FAVORITES_KEY = 'fileBrowser:favorites:v1'

type BrowserPreviewKind = 'empty' | 'loading' | 'text' | 'table' | 'binary' | 'error'

interface BrowserPreview {
  path: string
  name: string
  kind: BrowserPreviewKind
  text: string
  error?: string
  stat?: { size: number; modified: number; isDirectory: boolean; permissions: string }
  table?: { delimiter: string; headers: string[]; rows: string[][]; totalRows: number }
}

interface RemoteFileBrowserProps {
  open: boolean
  onClose: () => void
  title?: string
  mode: 'file' | 'directory' | 'multi-file'
  initialPath?: string
  accept?: string[]
  onSelect: (paths: string[], origin?: FileOrigin) => void
  browseOnly?: boolean
  showTransfer?: boolean
}

function matchesAcceptedType(accept: string[] | undefined, entry: RemoteFileEntry): boolean {
  if (!accept?.length || entry.isDirectory) return true
  const inferred = inferFileType(entry.name)
  if (accept.includes(inferred)) return true
  // `.bed` is ambiguous in the generic file-type inference, but when the
  // picker is explicitly scoped to PLINK inputs we should still allow the
  // user to choose the BED prefix file.
  if (inferred === 'bed' && accept.includes('plink')) return true
  return false
}

export function RemoteFileBrowser({
  open,
  onClose,
  title = 'Browse remote files',
  mode,
  initialPath,
  accept,
  onSelect,
  browseOnly = false,
  showTransfer = true,
}: RemoteFileBrowserProps) {
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const connections = useConnectionStore((s) => s.connections)
  const setActiveConnection = useConnectionStore((s) => s.setActiveConnection)
  const connectLocal = useConnectionStore((s) => s.connectLocal)
  const defaultDirectory = useConnectionStore((s) => activeConnectionId && activeConnectionId !== LOCAL_CONNECTION_ID ? s.connections[activeConnectionId]?.config.defaultDirectory ?? '' : '')
  const localDefaultDirectory = useConnectionStore((s) => s.connections[LOCAL_CONNECTION_ID]?.config.defaultDirectory ?? '')
  const dnxDefaultProjectId = useDnxStore((s) => s.defaultProjectId)
  const dnxAvailableProjects = useDnxStore((s) => s.availableProjects)
  const devMode = useSettingsStore((s) => s.devMode)
  const fileExplorerViewMode = useSettingsStore((s) => s.settings.fileExplorerViewMode)
  const splitExplorerBasePane = useSettingsStore((s) => s.settings.splitExplorerBasePane)
  const setSetting = useSettingsStore((s) => s.setSetting)
  const openPreview = useDataPreviewStore((s) => s.openFile)
  const setBottomPanelMode = useUIStore((s) => s.setBottomPanelMode)
  const exportSnapshot = usePipelineStore((s) => s.exportSnapshot)
  const addFileNode = usePipelineStore((s) => s.addFileNode)
  const refreshDnxProjects = useDnxStore((s) => s.refreshProjects)
  const confirmDialog = useDialogStore((s) => s.confirm)
  const promptDialog = useDialogStore((s) => s.prompt)
  const [cwd, setCwd] = useState(initialPath ?? '')
  const [origin, setOrigin] = useState<FileOrigin>('local')
  const [homeDir, setHomeDir] = useState<string | null>(null)
  const [localHomeDir, setLocalHomeDir] = useState<string | null>(null)
  const [entries, setEntries] = useState<RemoteFileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [hideDotfiles, setHideDotfiles] = useState(true)
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortMode, setSortMode] = useState<'name' | 'size' | 'modified'>('name')
  const [preview, setPreview] = useState<BrowserPreview>({ path: '', name: '', kind: 'empty', text: '' })
  const [editMode, setEditMode] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [pathCopied, setPathCopied] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ path: string; position: { x: number; y: number } } | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [recents, setRecents] = useState<string[]>([])
  const [favoritePaths, setFavoritePaths] = useState<string[]>([])
  const [reloadNonce, setReloadNonce] = useState(0)
  const [backStack, setBackStack] = useState<string[]>([])
  const [forwardStack, setForwardStack] = useState<string[]>([])
  const [splitOpen, setSplitOpen] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const effectiveHomeDir = origin === 'local' ? (localHomeDir ?? homeDir) : homeDir

  useEffect(() => {
    if (!open) return
    void window.api.store.get<string[]>(RECENTS_KEY).then((value) => setRecents(value ?? []))
    void window.api.store.get<string[]>(FAVORITES_KEY).then((value) => setFavoritePaths(value ?? []))
    if (dnxAvailableProjects.length === 0 && dnxDefaultProjectId) {
      void refreshDnxProjects().catch(() => undefined)
    }
  }, [dnxAvailableProjects.length, dnxDefaultProjectId, open, refreshDnxProjects])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.api.local.homedir().then((home) => {
      if (!cancelled) setLocalHomeDir(home)
    }).catch(() => {
      if (!cancelled) setLocalHomeDir(null)
    })
    return () => { cancelled = true }
  }, [open])

  useEffect(() => {
    if (!open) return
    setSearchOpen(false)
    setSearchQuery('')
    setPreview({ path: '', name: '', kind: 'empty', text: '' })
    setEditMode(false)
    setContextMenu(null)
    setFiltersOpen(false)
  }, [open])

  useEffect(() => {
    if (!searchOpen) return
    const id = window.setTimeout(() => searchInputRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [searchOpen])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function loadHome() {
      if (origin === 'dnx') {
        if (!cancelled) setHomeDir(null)
        return
      }
      if (origin === 'local' || activeConnectionId === LOCAL_CONNECTION_ID) {
        const home = await window.api.local.homedir()
        if (!cancelled) setHomeDir(home)
        return
      }
      if (!activeConnectionId) return
      const result = await window.api.ssh.exec(activeConnectionId, 'printf %s "$HOME"')
      if (!cancelled) setHomeDir(result.stdout.trim() || null)
    }
    void loadHome().catch(() => {
      if (!cancelled) setHomeDir(null)
    })
    return () => { cancelled = true }
  }, [activeConnectionId, open, origin])

  useEffect(() => {
    if (!open) return
    if (dnxDefaultProjectId && origin === 'dnx') return
    if (activeConnectionId === LOCAL_CONNECTION_ID || !activeConnectionId) {
      setOrigin('local')
      return
    }
    setOrigin('ssh')
  }, [activeConnectionId, dnxDefaultProjectId, open, origin])

  useEffect(() => {
    setSelected([])
  }, [origin])

  useEffect(() => {
    if (!open) return
    const defaultPath = origin === 'dnx'
      ? '/'
      : origin === 'local'
        ? (localDefaultDirectory || localHomeDir || '')
        : defaultDirectory || (homeDir ? collapseHomePath(homeDir, homeDir) : '')
    if (initialPath) {
      setCwd(mode === 'directory' ? initialPath : pathDirname(initialPath) || initialPath)
      setBackStack([])
      setForwardStack([])
      return
    }
    if (defaultPath) {
      setCwd(defaultPath)
      setBackStack([])
      setForwardStack([])
    }
  }, [defaultDirectory, homeDir, initialPath, localDefaultDirectory, localHomeDir, open, origin])

  useEffect(() => {
    if (!open || !cwd) return
    if (origin === 'ssh' && (!activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID)) {
      setEntries([])
      setLoading(false)
      setError('Connect to SSH before browsing remote files.')
      return
    }
    if (origin === 'ssh' && (cwd === '~' || cwd.startsWith('~/')) && !effectiveHomeDir) {
      setEntries([])
      setLoading(true)
      setError(null)
      return
    }
    if (origin === 'dnx' && !dnxDefaultProjectId) return
    const path = origin === 'dnx' ? normalizeDnxPath(cwd) : expandHomePath(cwd, effectiveHomeDir)
    let cancelled = false
    setLoading(true)
    setError(null)
    const promise = origin === 'local'
      ? window.api.local.ls(path)
      : origin === 'dnx'
        ? window.api.dnx.listFiles({ projectId: dnxDefaultProjectId!, path })
        : window.api.sftp.ls(activeConnectionId!, path, { force: reloadNonce > 0 })
    const timeout = new Promise<RemoteFileEntry[]>((_, reject) => {
      window.setTimeout(() => reject(new Error('Listing timed out. Try Refresh.')), 15000)
    })
    void Promise.race([promise, timeout]).then((next) => {
      if (cancelled) return
      setEntries(next)
      setLoading(false)
    }).catch((err) => {
      if (cancelled) return
      setError(err instanceof Error ? err.message : String(err))
      setEntries([])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [activeConnectionId, cwd, dnxDefaultProjectId, effectiveHomeDir, open, origin, reloadNonce])

  const favorites = useMemo(() => {
    const base = origin === 'dnx'
      ? ['/']
      : [
          effectiveHomeDir ? collapseHomePath(effectiveHomeDir, effectiveHomeDir) : '',
          (origin === 'local' ? localDefaultDirectory : defaultDirectory) ? collapseHomePath(origin === 'local' ? localDefaultDirectory : defaultDirectory, effectiveHomeDir) : '',
          '~/scratch',
          '~/projects',
        ].filter(Boolean)
    return [...new Set([...favoritePaths.map((path) => collapseHomePath(path, effectiveHomeDir)), ...base])]
  }, [defaultDirectory, effectiveHomeDir, favoritePaths, homeDir, localDefaultDirectory, origin])

  const toggleFavorite = async (path: string) => {
    const next = favoritePaths.includes(path)
      ? favoritePaths.filter((entry) => entry !== path)
      : [...favoritePaths, path]
    setFavoritePaths(next)
    await window.api.store.set(FAVORITES_KEY, next)
  }

  const visibleEntries = useMemo(() => entries
    .filter((entry) => !hideDotfiles || !entry.name.startsWith('.'))
    .filter((entry) => {
      if (entry.isDirectory) return true
      if (typeFilter === 'all') return true
      const type = inferFileType(entry.name)
      if (typeFilter === 'tabular') return type === 'tsv' || type === 'csv' || type === 'txt'
      if (typeFilter === 'variants') return type === 'vcf' || type === 'bcf'
      if (typeFilter === 'plink') return type === 'plink' || type === 'pgen' || type === 'bgen' || type === 'bed'
      return type === typeFilter
    })
    .filter((entry) => {
      const query = searchQuery.trim().toLowerCase()
      if (!query) return true
      return entry.name.toLowerCase().includes(query) || entry.path.toLowerCase().includes(query)
    })
    .filter((entry) => matchesAcceptedType(accept, entry))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      if (sortMode === 'size') return b.size - a.size
      if (sortMode === 'modified') return b.modified - a.modified
      return a.name.localeCompare(b.name, undefined, { numeric: true })
  }), [accept, entries, hideDotfiles, searchQuery, sortMode, typeFilter])
  const selectedEntries = useMemo(() => selected.map((path) => entries.find((entry) => entry.path === path)).filter((entry): entry is RemoteFileEntry => Boolean(entry)), [entries, selected])
  const selectedEntry = selectedEntries[0] ?? null
  const contextEntry = useMemo(() => contextMenu ? entries.find((entry) => entry.path === contextMenu.path) ?? null : null, [contextMenu, entries])
  const filterChips = useMemo(() => {
    const accepted = accept?.filter(Boolean) ?? []
    if (accepted.length > 0) return ['all', ...accepted]
    return ['all', 'tabular', 'variants', 'plink']
  }, [accept])
  const protectedInputPaths = useMemo(() => new Set(collectProtectedInputPaths(exportSnapshot())), [exportSnapshot])
  const selectedPathIsPipelineInput = selectedEntry ? protectedInputPaths.has(selectedEntry.path) : false

  useEffect(() => {
    if (!open || !selectedEntry || selectedEntry.isDirectory) {
      setPreview({ path: '', name: '', kind: 'empty', text: '' })
      setEditMode(false)
      return
    }
    let cancelled = false
    const normalizedPath = normalizeSelectedPath(selectedEntry.path, origin, effectiveHomeDir)
    const connectionId = origin === 'local' ? LOCAL_CONNECTION_ID : activeConnectionId
    setPreview({ path: normalizedPath, name: selectedEntry.name, kind: 'loading', text: '' })
    setEditMode(false)
    setEditDraft('')

    async function loadPreview() {
      if (origin === 'dnx') {
        if (!cancelled) {
          setPreview({
            path: normalizedPath,
            name: selectedEntry!.name,
            kind: 'binary',
            text: '',
            stat: { size: selectedEntry!.size, modified: selectedEntry!.modified, isDirectory: false, permissions: '' },
          })
        }
        return
      }
      if (!connectionId) throw new Error('No connection available for preview.')
      const stat = await statFileForConnection(connectionId, normalizedPath)
      const extension = selectedEntry!.name.toLowerCase()
      if (!isTextPreviewName(extension)) {
        if (!cancelled) setPreview({ path: normalizedPath, name: selectedEntry!.name, kind: 'binary', text: '', stat })
        return
      }
      const text = await headPreviewFileForConnection(connectionId, normalizedPath, 200)
      const sample = text.slice(0, 4096)
      const nonPrintable = sample.length > 0 ? sample.replace(/[\x20-\x7E\t\n\r]/g, '').length / sample.length : 0
      if (sample.includes('\u0000') || nonPrintable > 0.05) {
        if (!cancelled) setPreview({ path: normalizedPath, name: selectedEntry!.name, kind: 'binary', text: '', stat })
        return
      }
      const table = detectMiniTable(text)
      if (!cancelled) {
        setPreview({
          path: normalizedPath,
          name: selectedEntry!.name,
          kind: table ? 'table' : 'text',
          text,
          stat,
          table: table ?? undefined,
        })
        setEditDraft(text)
      }
    }

    void loadPreview().catch((err) => {
      if (cancelled) return
      setPreview({
        path: normalizedPath,
        name: selectedEntry.name,
        kind: 'error',
        text: '',
        error: err instanceof Error ? err.message : String(err),
      })
    })
    return () => { cancelled = true }
  }, [activeConnectionId, effectiveHomeDir, open, origin, selectedEntry])

  const navigateTo = (nextPath: string, opts: { pushHistory?: boolean } = {}) => {
    const normalized = origin === 'dnx'
      ? normalizeDnxPath(nextPath)
      : collapseHomePath(expandHomePath(nextPath, effectiveHomeDir), effectiveHomeDir)
    setSelected([])
    setCwd((current) => {
      if (current !== normalized && opts.pushHistory !== false) {
        setBackStack((prev) => [...prev, current].filter(Boolean).slice(-40))
        setForwardStack([])
      }
      return normalized
    })
  }

  const goBack = () => {
    setBackStack((prev) => {
      const next = prev[prev.length - 1]
      if (!next) return prev
      setSelected([])
      setForwardStack((forward) => [...forward, cwd].slice(-40))
      setCwd(next)
      return prev.slice(0, -1)
    })
  }

  const goForward = () => {
    setForwardStack((prev) => {
      const next = prev[prev.length - 1]
      if (!next) return prev
      setSelected([])
      setBackStack((back) => [...back, cwd].slice(-40))
      setCwd(next)
      return prev.slice(0, -1)
    })
  }

  const goUp = () => {
    const currentPath = origin === 'dnx' ? normalizeDnxPath(cwd) : expandHomePath(cwd, effectiveHomeDir)
    const parent = pathDirname(currentPath)
    if (!parent || parent === currentPath) return
    navigateTo(parent)
  }

  const goHome = () => {
    if (origin === 'dnx') {
      navigateTo('/')
      return
    }
    if (!effectiveHomeDir) return
    navigateTo(effectiveHomeDir)
  }

  const refreshCurrentFolder = () => setReloadNonce((value) => value + 1)

  const splitInitialPanes = useMemo(() => {
    const baseOrigin = activeConnectionId && activeConnectionId !== LOCAL_CONNECTION_ID ? 'ssh' : 'local'
    const rawBase = baseOrigin === 'ssh' ? (defaultDirectory || homeDir || '/') : (localDefaultDirectory || localHomeDir || '/')
    const basePath = expandHomePath(rawBase, baseOrigin === 'ssh' ? homeDir : localHomeDir)
    const currentOrigin = origin === 'ssh' ? 'ssh' : 'local'
    const selectedFolder = selectedEntry?.isDirectory ? selectedEntry.path : ''
    const currentPath = origin === 'dnx'
      ? basePath
      : normalizeSelectedPath(selectedFolder || cwd, origin, effectiveHomeDir)
    const base = { origin: baseOrigin as 'local' | 'ssh', connectionId: baseOrigin === 'ssh' ? activeConnectionId : null, cwd: basePath }
    const current = { origin: currentOrigin as 'local' | 'ssh', connectionId: currentOrigin === 'ssh' ? activeConnectionId : null, cwd: currentPath || basePath }
    return splitExplorerBasePane === 'left'
      ? [base, current] as [{ origin: 'local' | 'ssh'; connectionId: string | null; cwd: string }, { origin: 'local' | 'ssh'; connectionId: string | null; cwd: string }]
      : [current, base] as [{ origin: 'local' | 'ssh'; connectionId: string | null; cwd: string }, { origin: 'local' | 'ssh'; connectionId: string | null; cwd: string }]
  }, [activeConnectionId, cwd, defaultDirectory, effectiveHomeDir, homeDir, localDefaultDirectory, localHomeDir, origin, selectedEntry, splitExplorerBasePane])

  const breadcrumbs = useMemo(() => {
    if (origin === 'dnx') {
      const normalized = normalizeDnxPath(cwd)
      const parts = normalized.replace(/^\/+/, '').split('/').filter(Boolean)
      const crumbs: Array<{ label: string; path: string }> = [{ label: '/', path: '/' }]
      let running = ''
      for (const part of parts) {
        running = `${running}/${part}`.replace(/\/{2,}/g, '/')
        crumbs.push({ label: part, path: running })
      }
      return crumbs
    }
    const expanded = expandHomePath(cwd, effectiveHomeDir)
    const prefix = effectiveHomeDir && expanded.startsWith(effectiveHomeDir) ? '~' : ''
    const relative = prefix && effectiveHomeDir ? expanded.slice(effectiveHomeDir.length).replace(/^\/+/, '') : expanded.replace(/^\/+/, '')
    const parts = relative ? relative.split('/').filter(Boolean) : []
    const crumbs: Array<{ label: string; path: string }> = [{ label: prefix || '/', path: prefix || '/' }]
    let running = prefix || ''
    for (const part of parts) {
      running = running === '/' ? `/${part}` : `${running}/${part}`.replace(/\/{2,}/g, '/')
      crumbs.push({ label: part, path: running })
    }
    return crumbs
  }, [cwd, effectiveHomeDir, origin])

  const originLabel = useMemo(() => {
    if (origin === 'dnx') {
      const activeProject = dnxAvailableProjects.find((project) => project.id === dnxDefaultProjectId)
      return activeProject ? `DNX: ${activeProject.name}` : 'DNX'
    }
    if (origin === 'local') return 'Local'
    return 'Rorqual (SSH)'
  }, [dnxAvailableProjects, dnxDefaultProjectId, origin])
  const canMultiSelect = mode === 'multi-file'

  const selectEntry = (entry: RemoteFileEntry) => {
    if (entry.isDirectory) {
      setSelected([entry.path])
      return
    }
    if (canMultiSelect) {
      setSelected((prev) => prev.includes(entry.path) ? prev.filter((path) => path !== entry.path) : [...prev, entry.path])
    } else {
      setSelected([entry.path])
    }
  }

  const activateEntry = (entry: RemoteFileEntry) => {
    if (entry.isDirectory) {
      navigateTo(entry.path)
      return
    }
    setSelected([entry.path])
    if (browseOnly) return
    onSelect([entry.path], origin)
    onClose()
  }

  const copyEntry = async (entry: RemoteFileEntry) => {
    if (origin === 'dnx' || actionBusy) return
    if (origin === 'local' && entry.isDirectory) {
      setActionMessage('Local folder copy is not available here. Use the split transfer view for file moves.')
      return
    }
    const destination = await promptDialog({
      title: 'Copy path',
      message: 'Choose the destination path.',
      defaultValue: `${normalizeSelectedPath(cwd, origin, effectiveHomeDir).replace(/\/+$/, '')}/${entry.name}`,
      confirmLabel: 'Copy',
    })
    if (!destination?.trim()) return
    setActionBusy(true)
    setActionMessage(null)
    try {
      if (origin === 'local') await window.api.local.copy(entry.path, destination.trim())
      else await window.api.ssh.exec(activeConnectionId!, `cp -R ${shellQuote(entry.path)} ${shellQuote(destination.trim())}`)
      setActionMessage(`Copied ${entry.name}`)
      refreshCurrentFolder()
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setActionBusy(false)
    }
  }

  const copySelected = async () => {
    if (!selectedEntry) return
    await copyEntry(selectedEntry)
  }

  const moveEntry = async (entry: RemoteFileEntry) => {
    if (origin === 'dnx' || actionBusy) return
    const destination = await promptDialog({
      title: 'Move or rename path',
      message: 'Choose the new path.',
      defaultValue: `${normalizeSelectedPath(cwd, origin, effectiveHomeDir).replace(/\/+$/, '')}/${entry.name}`,
      confirmLabel: 'Move',
    })
    if (!destination?.trim()) return
    setActionBusy(true)
    setActionMessage(null)
    try {
      if (origin === 'local') await window.api.local.rename(entry.path, destination.trim())
      else await window.api.sftp.rename(activeConnectionId!, entry.path, destination.trim())
      setSelected([])
      setActionMessage(`Moved ${entry.name}`)
      refreshCurrentFolder()
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setActionBusy(false)
    }
  }

  const moveSelected = async () => {
    if (!selectedEntry) return
    await moveEntry(selectedEntry)
  }

  const downloadEntry = async (entry: RemoteFileEntry) => {
    if (origin !== 'ssh' || !activeConnectionId || actionBusy) return
    const folder = await window.api.dialog.openDirectory()
    if (!folder) return
    setActionBusy(true)
    setActionMessage(null)
    try {
      await window.api.sftp.download(activeConnectionId, entry.path, `${folder.replace(/\/+$/, '')}/${entry.name}`)
      setActionMessage(`Downloaded ${entry.name}`)
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setActionBusy(false)
    }
  }

  const downloadSelected = async () => {
    if (!selectedEntry) return
    await downloadEntry(selectedEntry)
  }

  const deleteEntry = async (entry: RemoteFileEntry) => {
    if (origin === 'dnx' || actionBusy) return
    const confirmed = await confirmDialog({
      title: entry.isDirectory ? 'Delete folder' : 'Delete file',
      message: `Delete ${entry.path}?`,
      detail: entry.isDirectory ? 'This deletes the folder and everything inside it.' : undefined,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    })
    if (!confirmed) return
    setActionBusy(true)
    setActionMessage(null)
    try {
      if (origin === 'local') await window.api.local.delete(entry.path)
      else await window.api.sftp.delete(activeConnectionId!, entry.path)
      setActionMessage(`Deleted ${entry.name}`)
      setSelected([])
      refreshCurrentFolder()
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setActionBusy(false)
    }
  }

  const deleteSelected = async () => {
    if (!selectedEntry) return
    await deleteEntry(selectedEntry)
  }

  const uploadToCurrentFolder = async () => {
    if (origin !== 'ssh' || !activeConnectionId || actionBusy) return
    const localPath = await window.api.dialog.openFile()
    if (!localPath) return
    const name = localPath.split('/').pop() || 'upload'
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
    const destination = `${normalizeSelectedPath(cwd, origin, effectiveHomeDir).replace(/\/+$/, '')}/${name}`
    setActionBusy(true)
    setActionMessage(null)
    try {
      await window.api.sftp.upload(activeConnectionId, localPath, destination)
      setActionMessage(`Uploaded ${name}`)
      refreshCurrentFolder()
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setActionBusy(false)
    }
  }

  const createFolderInCurrent = async () => {
    if (origin === 'dnx' || actionBusy) return
    const basePath = normalizeSelectedPath(cwd, origin, effectiveHomeDir).replace(/\/+$/, '')
    const next = await promptDialog({
      title: 'New folder',
      message: 'Choose the folder path.',
      defaultValue: `${basePath}/new-folder`,
      confirmLabel: 'Create',
    })
    if (!next?.trim()) return
    setActionBusy(true)
    setActionMessage(null)
    try {
      if (origin === 'local') await window.api.local.mkdir(next.trim())
      else if (activeConnectionId) await window.api.sftp.mkdir(activeConnectionId, next.trim())
      setActionMessage('Folder created')
      refreshCurrentFolder()
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setActionBusy(false)
    }
  }

  const copyPreviewPath = async () => {
    if (!preview.path) return
    await navigator.clipboard.writeText(preview.path)
    setPathCopied(true)
    window.setTimeout(() => setPathCopied(false), 1200)
  }

  const openPreviewInDataPanel = async () => {
    if (!selectedEntry || selectedEntry.isDirectory || !preview.path) return
    openPreview(preview.path, selectedEntry.name, preview.kind === 'table' ? 'tabular' : 'text', {
      connectionId: origin === 'local' ? LOCAL_CONNECTION_ID : activeConnectionId ?? undefined,
    })
    setBottomPanelMode('data')
  }

  const openPreviewTerminal = () => {
    if (!preview.path) return
    setBottomPanelMode('terminal')
    setActionMessage(`Opened terminal panel for ${preview.path}`)
  }

  const savePreviewEdit = async () => {
    if (!preview.path || origin === 'dnx' || savingEdit) return
    const connectionId = origin === 'local' ? LOCAL_CONNECTION_ID : activeConnectionId
    if (!connectionId) return
    setSavingEdit(true)
    setActionMessage(null)
    try {
      if (connectionId === LOCAL_CONNECTION_ID) await window.api.local.write(preview.path, editDraft)
      else await window.api.sftp.write(connectionId, preview.path, editDraft)
      setPreview((current) => ({
        ...current,
        text: editDraft,
        kind: detectMiniTable(editDraft) ? 'table' : 'text',
        table: detectMiniTable(editDraft) ?? undefined,
      }))
      setEditMode(false)
      setActionMessage(`Saved ${preview.name}`)
      refreshCurrentFolder()
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingEdit(false)
    }
  }

  const addEntriesToCanvas = (entriesToAdd: RemoteFileEntry[]) => {
    if (entriesToAdd.length === 0) return
    const itemOrigin: FileOrigin = origin
    const source = itemOrigin === 'local' ? 'local' : 'remote'
    const offset = Date.now() % 80
    if (entriesToAdd.length === 1) {
      const entry = entriesToAdd[0]
      addFileNode(
        { x: 120 + offset, y: 140 + offset },
        {
          isInput: true,
          label: entry.name,
          path: normalizeSelectedPath(entry.path, origin, effectiveHomeDir),
          pathKind: entry.isDirectory ? 'directory' : 'file',
          fileType: entry.isDirectory ? 'any' : inferFileType(entry.name),
          source,
          origin: itemOrigin,
        },
      )
      setActionMessage(`Added ${entry.name} to the canvas`)
      return
    }

    const fileEntries = entriesToAdd.filter((entry) => !entry.isDirectory)
    const entriesForSplit = fileEntries.length > 0 ? collapseBrowserPlinkFileEntries(fileEntries) : entriesToAdd
    if (entriesForSplit.length === 1) {
      addEntriesToCanvas(entriesForSplit)
      return
    }
    const splitGuess = inferBrowserSplitKeys(entriesForSplit)
    const types = [...new Set(entriesForSplit.map((entry) => entry.isDirectory ? 'any' : inferFileType(entry.name)))]
    addFileNode(
      { x: 120 + offset, y: 140 + offset },
      {
        isInput: true,
        label: `${entriesForSplit.length} selected files`,
        path: '',
        fileType: types.length === 1 ? types[0] : 'any',
        source,
        origin: itemOrigin,
        split: {
          axis: splitGuess.axis,
          items: entriesForSplit.map((entry, index) => ({
            key: splitGuess.keys[index] ?? entry.name,
            rawKey: splitGuess.rawKeys[index] ?? entry.name,
            path: normalizeSelectedPath(entry.path, origin, effectiveHomeDir),
          })),
          pattern: { kind: 'manual' },
        },
      },
    )
    setActionMessage(`Added ${entriesForSplit.length} selected paths as a split input`)
  }

  const confirmSelection = async () => {
    const picked = mode === 'directory'
      ? [selected[0] ? normalizeSelectedPath(selected[0], origin, effectiveHomeDir) : normalizeSelectedPath(cwd, origin, effectiveHomeDir)]
      : selected.length > 0 ? selected.map((path) => normalizeSelectedPath(path, origin, effectiveHomeDir)) : []
    if (browseOnly || picked.length === 0) {
      onClose()
      return
    }
    const nextRecents = [...new Set([...picked, ...recents])].slice(0, 12)
    await window.api.store.set(RECENTS_KEY, nextRecents)
    onSelect(picked, origin)
    onClose()
  }

  const canSelect = mode === 'directory' ? Boolean(cwd) : selected.length > 0

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      className="bioflow-file-browser-dialog"
      bodyClassName="bioflow-file-browser-body"
    >
      <div className="bioflow-file-browser-grid">
        <aside className="bioflow-file-browser-sidebar scroll-region p-2">
          <SourceRailRow
            icon={<HardDrive size={12} />}
            label="Local"
            active={origin === 'local'}
            onClick={() => {
              const target = localDefaultDirectory || localHomeDir || undefined
              setOrigin('local')
              void connectLocal(target)
              if (target) navigateTo(target, { pushHistory: false })
            }}
          />
          <div className="bioflow-section-label mt-3 px-2 py-1">SSH connections</div>
          {Object.entries(connections).filter(([id]) => id !== LOCAL_CONNECTION_ID).map(([id, connection]) => (
            <SourceRailRow
              key={id}
              icon={<Server size={12} />}
              label={connection.config.name || connection.config.host}
              active={origin === 'ssh' && activeConnectionId === id}
              disabled={connection.status !== 'connected'}
              onClick={() => {
                setActiveConnection(id)
                setOrigin('ssh')
                if (connection.config.defaultDirectory) navigateTo(connection.config.defaultDirectory, { pushHistory: false })
              }}
            />
          ))}
          {devMode && (
            <>
              <div className="bioflow-section-label mt-3 px-2 py-1">DNAnexus</div>
              <SourceRailRow
                icon={<Server size={12} />}
                label={originLabel}
                active={origin === 'dnx'}
                disabled={!dnxDefaultProjectId}
                onClick={() => setOrigin('dnx')}
              />
            </>
          )}
          <div className="bioflow-section-label mt-3 px-2 py-1">Favorites</div>
          {favorites.map((path) => (
            <SourceRailRow key={path} icon={<Star size={12} />} label={collapseHomePath(path, effectiveHomeDir)} onClick={() => navigateTo(path)} />
          ))}
          <div className="bioflow-section-label mt-3 px-2 py-1">Recents</div>
          {recents.length > 0 ? recents.map((path) => (
            <SourceRailRow
              key={path}
              icon={<Clock3 size={12} />}
              label={collapseHomePath(path, effectiveHomeDir)}
              onClick={() => {
                if (mode === 'directory') navigateTo(path)
                else setSelected([path])
              }}
            />
          )) : <div className="px-2 py-1 text-[11px] text-text-muted">No recent picks yet.</div>}
          <div className="mt-auto flex flex-col gap-1 pt-3">
            {showTransfer && (
              <button type="button" onClick={() => setSplitOpen(true)} className="interactive-row flex h-7 items-center gap-1.5 px-2 text-[11px] text-text-secondary hover:text-text-primary">
                <PanelsLeftRight size={12} />
                <span className="text-nowrap">Split transfer</span>
              </button>
            )}
            <button type="button" onClick={() => void toggleFavorite(normalizeSelectedPath(cwd, origin, effectiveHomeDir))} className="interactive-row flex h-7 items-center gap-1.5 px-2 text-[11px] text-text-secondary hover:text-text-primary">
              <Star size={12} />
              <span className="text-nowrap">Add favorite</span>
            </button>
          </div>
        </aside>

        <section className="bioflow-file-browser-main">
          <header className="bioflow-file-browser-header">
            <div className="flex shrink-0 items-center gap-1">
              <BrowserToolbarIconButton
                label="Back"
                icon={<ArrowLeft size={12} />}
                onClick={goBack}
                disabled={backStack.length === 0}
              />
              <BrowserToolbarIconButton
                label="Forward"
                icon={<ArrowRight size={12} />}
                onClick={goForward}
                disabled={forwardStack.length === 0}
              />
              <BrowserToolbarIconButton
                label="Parent folder"
                icon={<ArrowUp size={12} />}
                onClick={goUp}
                disabled={!cwd || cwd === '/' || cwd === '~'}
              />
              <BrowserToolbarIconButton
                label="Home"
                icon={<Home size={12} />}
                onClick={goHome}
                disabled={origin !== 'dnx' && !effectiveHomeDir}
              />
            </div>
            <div className="min-w-0 flex-1 overflow-hidden">
              <div className="flex min-w-0 items-center gap-1 text-[11px] text-text-secondary">
                {breadcrumbs.map((crumb, index) => (
                  <span key={`${crumb.path}-${index}`} className="flex min-w-0 items-center gap-1">
                    {index > 0 && <ChevronRight size={11} className="shrink-0 text-text-muted" />}
                    <button
                      type="button"
                      className="text-nowrap min-w-0 max-w-28 truncate rounded px-1 py-0.5 font-mono hover:bg-bg-hover hover:text-text-primary"
                      onClick={() => navigateTo(crumb.path)}
                      title={crumb.path}
                    >
                      {index === 0 && breadcrumbs.length > 3 ? '...' : crumb.label}
                    </button>
                  </span>
                ))}
              </div>
            </div>
            <button
              type="button"
              className="interactive-button flex h-6 min-w-6 items-center justify-center text-text-muted hover:text-text-primary"
              title={fileExplorerViewMode === 'icons' ? 'Show list view' : 'Show grid view'}
              onClick={() => void setSetting('settings:fileExplorerViewMode', fileExplorerViewMode === 'icons' ? 'list' : 'icons')}
            >
              {fileExplorerViewMode === 'icons' ? <List size={12} /> : <Grid2X2 size={12} />}
            </button>
            <MenuSelect
              value={sortMode}
              onChange={(value) => setSortMode((value || 'name') as 'name' | 'size' | 'modified')}
              options={[
                { value: 'name', label: 'Name' },
                { value: 'modified', label: 'Modified' },
                { value: 'size', label: 'Size' },
              ]}
              ariaLabel="Sort files"
              className="w-24"
              buttonClassName="h-6 text-[10px]"
              menuClassName="w-32"
            />
            <button
              type="button"
              className="interactive-button flex h-6 min-w-6 items-center justify-center text-text-muted hover:text-text-primary"
              title="Search files"
              onClick={() => setSearchOpen((value) => !value)}
            >
              <Search size={12} />
            </button>
            <button
              type="button"
              className="interactive-button flex h-6 min-w-6 items-center justify-center text-text-muted hover:text-text-primary"
              title="New folder"
              disabled={origin === 'dnx' || actionBusy}
              onClick={() => void createFolderInCurrent()}
            >
              <FolderPlus size={12} />
            </button>
            <button
              type="button"
              className="interactive-button flex h-6 min-w-6 items-center justify-center text-text-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
              title="Upload"
              disabled={origin !== 'ssh' || !activeConnectionId || actionBusy}
              onClick={() => void uploadToCurrentFolder()}
            >
              <Upload size={12} />
            </button>
            <button
              type="button"
              className="interactive-button flex h-6 min-w-6 items-center justify-center text-text-muted hover:text-text-primary"
              title="Refresh"
              onClick={refreshCurrentFolder}
            >
              <RefreshCw size={12} className={loading ? 'animate-fade-in' : ''} />
            </button>
          </header>

          {searchOpen && (
            <div className="animate-fade-up px-3 py-2">
              <div className="bioflow-field flex h-7 items-center gap-1.5 rounded-md px-2">
                <Search size={12} className="text-text-muted" />
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setSearchOpen(false)
                      setSearchQuery('')
                    }
                  }}
                  placeholder="Filter files..."
                  className="min-w-0 flex-1 bg-transparent text-[11px] text-text-primary placeholder:text-text-muted outline-none"
                />
                {searchQuery && (
                  <button type="button" onClick={() => setSearchQuery('')} className="interactive-button flex h-5 w-5 items-center justify-center text-text-muted">
                    <X size={12} />
                  </button>
                )}
              </div>
            </div>
          )}

          <main className="bioflow-file-browser-list scroll-region">
            {actionMessage && (
              <div className="animate-fade-up mx-3 mt-3 rounded-md bg-bg-secondary px-3 py-1.5 text-[11px] text-text-secondary shadow-sm">
                {actionMessage}
              </div>
            )}
            {error ? (
              <div className="bioflow-empty-state flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                <AlertCircle className="text-error" />
                <p className="text-wrap text-xs text-error">{error}</p>
                <Button variant="secondary" size="sm" onClick={refreshCurrentFolder}>Retry</Button>
              </div>
            ) : loading ? (
              <div className="flex flex-col gap-2 p-3">
                <div className="animate-shimmer h-8 rounded-md" />
                <div className="animate-shimmer h-8 rounded-md" />
                <div className="animate-shimmer h-8 rounded-md" />
              </div>
            ) : visibleEntries.length === 0 ? (
              <div className="bioflow-empty-state animate-fade-up flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                <FolderOpen className="text-text-muted" strokeWidth={1.5} />
                <p className="text-sm font-medium text-text-secondary">No files</p>
                <p className="text-wrap text-xs text-text-muted">No matching files in this location.</p>
              </div>
            ) : fileExplorerViewMode === 'icons' ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(6rem,6rem))] justify-start gap-x-3 gap-y-2.5 p-3">
                {visibleEntries.map((entry) => (
                  <BrowserGridCard
                    key={entry.path}
                    entry={entry}
                    selected={selected.includes(entry.path)}
                    onSelect={selectEntry}
                    onActivate={activateEntry}
                  />
                ))}
              </div>
            ) : (
              <div className="py-1">
                {visibleEntries.map((entry) => (
                  <BrowserFileRow
                    key={entry.path}
                    entry={entry}
                    selected={selected.includes(entry.path)}
                    onSelect={selectEntry}
                    onActivate={activateEntry}
                    onMenu={(position) => {
                      setSelected([entry.path])
                      setContextMenu((current) => current?.path === entry.path ? null : { path: entry.path, position })
                    }}
                  />
                ))}
              </div>
            )}
          </main>

          {contextEntry && contextMenu && (
            <ContextMenu
              position={contextMenu.position}
              onClose={() => setContextMenu(null)}
              items={[
                { label: 'Open', onClick: () => activateEntry(contextEntry) },
                { label: 'Copy path', onClick: () => void navigator.clipboard.writeText(contextEntry.path) },
                ...(browseOnly
                  ? [{ label: 'Add to canvas', onClick: () => addEntriesToCanvas([contextEntry]) }]
                  : []),
                { label: 'Copy to...', onClick: () => void copyEntry(contextEntry), disabled: origin === 'dnx' },
                ...(origin === 'ssh' ? [{ label: 'Download', onClick: () => void downloadEntry(contextEntry) }] : []),
                { label: 'Rename', onClick: () => void moveEntry(contextEntry), disabled: origin === 'dnx' || contextEntry.isDirectory },
                { label: 'Move to...', onClick: () => void moveEntry(contextEntry), disabled: origin === 'dnx' },
                { label: '', onClick: () => undefined, separator: true },
                { label: 'Delete', onClick: () => void deleteEntry(contextEntry), disabled: origin === 'dnx', danger: true },
              ]}
            />
          )}

          <footer className="bioflow-file-browser-footer">
            <div className="relative flex min-w-0 flex-1 items-center gap-2">
              <span className="text-nowrap text-[11px] text-text-muted">
                {selectedEntries.length > 0 ? `${selectedEntries.length} selected` : `${visibleEntries.length} shown`}
              </span>
              <button
                type="button"
                onClick={() => setFiltersOpen((open) => !open)}
                className={classNames(
                  'interactive-row flex h-7 items-center gap-1.5 px-2 text-[11px]',
                  filtersOpen || typeFilter !== 'all' || !hideDotfiles ? 'text-text-primary' : 'text-text-muted',
                )}
              >
                <SlidersHorizontal size={12} />
                <span className="text-nowrap">Filters</span>
              </button>
              {filtersOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setFiltersOpen(false)} />
                  <div className="surface-popover absolute bottom-full left-0 z-50 mb-2 w-64 rounded-md p-2 shadow-xl">
                    <div className="mb-1 px-1 text-[10px] uppercase tracking-wide text-text-muted">File types</div>
                    <div className="flex flex-wrap gap-1">
                      {filterChips.map((option) => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => setTypeFilter(option)}
                          className={classNames(
                            'interactive-row h-7 px-2 text-[11px]',
                            typeFilter === option ? 'bg-accent/10 text-text-primary' : 'text-text-muted',
                          )}
                        >
                          <span className="text-nowrap">{filterLabel(option)}</span>
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => setHideDotfiles((prev) => !prev)}
                      className="interactive-row mt-2 flex h-7 w-full items-center gap-2 px-2 text-[11px] text-text-muted"
                    >
                      <EyeOff size={12} />
                      <span className="text-nowrap">{hideDotfiles ? 'Hidden files are hidden' : 'Hidden files are visible'}</span>
                    </button>
                  </div>
                </>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" onClick={onClose}>{browseOnly ? 'Close' : 'Cancel'}</Button>
              {browseOnly && (
                <Button
                  variant="primary"
                  onClick={() => addEntriesToCanvas(selectedEntries)}
                  disabled={selectedEntries.length === 0}
                >
                  <FilePlus2 size={12} />
                  Add to canvas{selectedEntries.length > 1 ? ` (${selectedEntries.length})` : ''}
                </Button>
              )}
              {!browseOnly && (
                <Button variant="primary" onClick={() => void confirmSelection()} disabled={!canSelect}>
                  Select{selected.length > 0 ? ` (${selected.length})` : ''}
                </Button>
              )}
            </div>
          </footer>
        </section>

        <BrowserPreviewPanel
          preview={preview}
          editMode={editMode}
          editDraft={editDraft}
          canEdit={origin !== 'dnx' && preview.kind !== 'empty' && preview.kind !== 'loading' && Boolean(preview.stat && preview.stat.size < 1024 * 1024) && (preview.kind === 'text' || preview.kind === 'table')}
          saving={savingEdit}
          pathCopied={pathCopied}
          pipelineInput={selectedPathIsPipelineInput}
          onEdit={() => setEditMode(true)}
          onDraftChange={setEditDraft}
          onSave={() => void savePreviewEdit()}
          onDiscard={() => {
            setEditMode(false)
            setEditDraft(preview.text)
          }}
          onCopyPath={() => void copyPreviewPath()}
          onOpenData={() => void openPreviewInDataPanel()}
          onOpenTerminal={openPreviewTerminal}
        />
      </div>
      <SplitFileTransferDialog open={splitOpen} onClose={() => setSplitOpen(false)} initialPanes={splitInitialPanes} />
    </Dialog>
  )
}

function SourceRailRow({
  icon,
  label,
  active = false,
  disabled = false,
  onClick,
}: {
  icon: ReactNode
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={classNames(
        'interactive-row flex h-7 w-full items-center gap-1.5 border-l-2 px-2 text-left text-[10px] disabled:cursor-not-allowed disabled:opacity-40',
        active ? 'border-accent bg-accent/10 text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary',
      )}
    >
      <span className={active ? 'text-accent' : 'text-text-muted'}>{icon}</span>
      <span className="text-nowrap min-w-0 flex-1 truncate" title={label}>{label}</span>
    </button>
  )
}

function BrowserToolbarIconButton({
  label,
  icon,
  onClick,
  disabled = false,
}: {
  label: string
  icon: ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="interactive-button flex h-6 min-w-6 items-center justify-center text-text-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
    >
      {icon}
    </button>
  )
}

function BrowserFileRow({
  entry,
  selected,
  onSelect,
  onActivate,
  onMenu,
}: {
  entry: RemoteFileEntry
  selected: boolean
  onSelect: (entry: RemoteFileEntry) => void
  onActivate: (entry: RemoteFileEntry) => void
  onMenu: (position: { x: number; y: number }) => void
}) {
  return (
    <div className="group relative px-2">
      <button
        type="button"
        onClick={() => onSelect(entry)}
        onDoubleClick={() => onActivate(entry)}
        className={classNames(
          'bioflow-file-browser-row interactive-row w-full text-left text-[11px]',
          selected ? 'bg-accent/10 text-text-primary' : 'text-text-secondary hover:text-text-primary',
        )}
        title={entry.path}
      >
        <span className={classNames(
          'flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 group-hover:opacity-100',
          selected && 'opacity-100',
        )}>
          <input type="checkbox" checked={selected} readOnly className="h-3 w-3 accent-accent" tabIndex={-1} />
        </span>
        <FileGlyph entry={entry} size="row" selected={selected} />
        <span className="text-nowrap min-w-0 flex-1">{entry.name}{entry.isDirectory ? '/' : ''}</span>
        <span className="text-nowrap w-[3.5rem] shrink-0 text-right font-mono text-[10px] text-text-muted">{entry.isDirectory ? '-' : formatBytes(entry.size)}</span>
        <span className="text-nowrap w-[4.5rem] shrink-0 text-right text-[10px] text-text-muted">{formatFileDate(entry.modified)}</span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            onMenu({ x: rect.right - 180, y: rect.bottom + 6 })
          }}
          className="interactive-button flex h-5 w-5 shrink-0 items-center justify-center text-text-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          aria-label={`Open actions for ${entry.name}`}
        >
          <MoreHorizontal size={12} />
        </button>
      </button>
    </div>
  )
}

function BrowserGridCard({
  entry,
  selected,
  onSelect,
  onActivate,
}: {
  entry: RemoteFileEntry
  selected: boolean
  onSelect: (entry: RemoteFileEntry) => void
  onActivate: (entry: RemoteFileEntry) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(entry)}
      onDoubleClick={() => onActivate(entry)}
      className={classNames(
        'flex h-[5.75rem] w-[5.75rem] flex-col items-center justify-start gap-1.5 rounded-md px-1.5 py-2 text-center text-[10px] transition-colors',
        selected ? 'bg-accent/10 text-text-primary' : 'text-text-secondary hover:bg-bg-hover/70 hover:text-text-primary',
      )}
      title={entry.path}
    >
      <FileGlyph entry={entry} size="grid" selected={selected} />
      <span
        className={classNames(
          'bioflow-file-grid-name w-full rounded px-1 leading-3',
          selected && 'bg-accent text-white',
        )}
      >
        {entry.name}{entry.isDirectory ? '/' : ''}
      </span>
    </button>
  )
}

function BrowserPreviewPanel({
  preview,
  editMode,
  editDraft,
  canEdit,
  saving,
  pathCopied,
  pipelineInput,
  onEdit,
  onDraftChange,
  onSave,
  onDiscard,
  onCopyPath,
  onOpenData,
  onOpenTerminal,
}: {
  preview: BrowserPreview
  editMode: boolean
  editDraft: string
  canEdit: boolean
  saving: boolean
  pathCopied: boolean
  pipelineInput: boolean
  onEdit: () => void
  onDraftChange: (value: string) => void
  onSave: () => void
  onDiscard: () => void
  onCopyPath: () => void
  onOpenData: () => void
  onOpenTerminal: () => void
}) {
  const lineCount = preview.text ? preview.text.split('\n').length : 0
  return (
    <aside className="bioflow-file-browser-preview">
      <header className="flex h-12 shrink-0 items-center gap-2 px-3">
        <div className="min-w-0 flex-1">
          <div className="text-nowrap text-xs font-semibold text-text-primary">{preview.name || 'Preview'}</div>
          <div className="text-nowrap font-mono text-xs text-text-muted">{preview.path || 'Select a file'}</div>
        </div>
        {canEdit && !editMode && (
          <button type="button" onClick={onEdit} className="interactive-button flex h-7 w-7 items-center justify-center text-text-muted hover:text-text-primary" title="Edit text file">
            <Pencil size={14} />
          </button>
        )}
      </header>
      <div className="scroll-region px-3 py-2">
        {preview.kind === 'empty' && (
          <div className="bioflow-empty-state flex h-full flex-col items-center justify-center gap-2 text-center">
            <FileText className="text-text-muted" strokeWidth={1.5} />
            <p className="text-sm text-text-muted">Select a file to preview</p>
          </div>
        )}
        {preview.kind === 'loading' && (
          <div className="flex flex-col gap-2">
            <div className="animate-shimmer h-7 rounded-md" />
            <div className="animate-shimmer h-7 rounded-md" />
            <div className="animate-shimmer h-7 rounded-md" />
          </div>
        )}
        {preview.kind === 'error' && (
          <div className="bioflow-empty-state flex h-full flex-col items-center justify-center gap-2 text-center">
            <AlertCircle className="text-error" />
            <p className="text-wrap text-xs text-error">{preview.error ?? 'Could not load preview.'}</p>
          </div>
        )}
        {(preview.kind === 'text' || preview.kind === 'table') && editMode && (
          <div className="flex h-full min-h-0 flex-col gap-2">
            {pipelineInput && (
              <div className="rounded-md bg-warning/10 px-2 py-1.5 text-[11px] text-warning">This file is used as a pipeline input. Edit carefully.</div>
            )}
            <textarea
              value={editDraft}
              onChange={(event) => onDraftChange(event.target.value)}
              className="bioflow-field scroll-region min-h-0 flex-1 resize-none rounded-md p-2 font-mono text-[11px] leading-5 text-text-primary outline-none"
              spellCheck={false}
            />
          </div>
        )}
        {preview.kind === 'text' && !editMode && <CodePreview text={preview.text} />}
        {preview.kind === 'table' && !editMode && preview.table && <MiniTablePreview table={preview.table} />}
        {preview.kind === 'binary' && (
          <div className="bioflow-empty-state flex h-full flex-col items-center justify-center gap-2 text-center">
            <FileText className="text-text-muted" strokeWidth={1.5} />
            <span className="bioflow-badge rounded bg-bg-tertiary px-2 py-0.5 text-xs text-text-muted">{preview.name ? inferFileType(preview.name) : 'file'}</span>
            <p className="text-sm text-text-muted">No preview available</p>
            {preview.stat && <p className="text-[11px] text-text-muted">{formatBytes(preview.stat.size)}</p>}
          </div>
        )}
      </div>
      <footer className="flex h-11 shrink-0 items-center gap-2 px-3 text-[11px] text-text-muted">
        {editMode ? (
          <>
            <button type="button" onClick={onSave} disabled={saving} className="interactive-row flex h-7 items-center gap-1 px-2 text-success disabled:opacity-50">
              <Check size={12} />
              <span className="text-nowrap">{saving ? 'Saving' : 'Save to remote'}</span>
            </button>
            <button type="button" onClick={onDiscard} className="interactive-row h-7 px-2 text-text-secondary">Discard</button>
          </>
        ) : (
          <>
            <span className="text-nowrap min-w-0 flex-1">
              {preview.kind === 'table' && preview.table ? `${preview.table.totalRows} rows x ${preview.table.headers.length} cols` : preview.text ? `${lineCount} lines` : preview.stat ? formatBytes(preview.stat.size) : ''}
            </span>
            <button type="button" onClick={onCopyPath} disabled={!preview.path} className="interactive-button flex h-7 w-7 items-center justify-center text-text-muted disabled:opacity-40" title="Copy path">
              {pathCopied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
            </button>
            <button type="button" onClick={onOpenTerminal} disabled={!preview.path} className="interactive-button flex h-7 w-7 items-center justify-center text-text-muted disabled:opacity-40" title="Open in terminal">
              <TerminalSquare size={13} />
            </button>
            <button type="button" onClick={onOpenData} disabled={!preview.path || preview.kind === 'binary'} className="interactive-button flex h-7 w-7 items-center justify-center text-text-muted disabled:opacity-40" title="Open in Data Preview">
              <Table2 size={13} />
            </button>
          </>
        )}
      </footer>
    </aside>
  )
}

function CodePreview({ text }: { text: string }) {
  const lines = text.split('\n').slice(0, 200)
  return (
    <div className="grid min-h-full min-w-max grid-cols-[2.75rem_minmax(0,1fr)] rounded-md bg-bg-primary font-mono text-[11px] leading-5">
      <div className="select-none py-2 text-right text-text-muted">
        {lines.map((_, index) => <div key={index} className="px-2">{index + 1}</div>)}
      </div>
      <pre className="m-0 overflow-visible whitespace-pre px-2 py-2 text-text-primary">{lines.join('\n') || ' '}</pre>
    </div>
  )
}

function MiniTablePreview({ table }: { table: NonNullable<BrowserPreview['table']> }) {
  return (
    <div className="bioflow-mini-table-preview rounded-md bg-bg-primary text-xs">
      <table>
        <thead className="sticky top-0 bg-bg-tertiary text-text-secondary">
          <tr>
            {table.headers.map((header) => (
              <th key={header} className="px-2 py-1 text-left font-medium" title={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.slice(0, 50).map((row, rowIndex) => (
            <tr key={rowIndex} className={rowIndex % 2 === 0 ? 'bg-bg-primary' : 'bg-bg-secondary'}>
              {table.headers.map((_, colIndex) => (
                <td key={colIndex} className="px-2 py-1 text-text-primary" title={row[colIndex] || '-'}>{row[colIndex] || '-'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function normalizeDnxPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return '/'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function normalizeSelectedPath(path: string, origin: FileOrigin, homeDir: string | null): string {
  return origin === 'dnx' ? normalizeDnxPath(path) : expandHomePath(path, homeDir)
}

function filterLabel(value: string): string {
  if (value === 'all') return 'All'
  if (value === 'tabular') return 'Tabular'
  if (value === 'variants') return 'Variants'
  if (value === 'plink') return 'PLINK'
  return value
}

function inferBrowserSplitKeys(entries: RemoteFileEntry[]): { axis: string; keys: string[]; rawKeys: string[] } {
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

function collapseBrowserPlinkFileEntries(entries: RemoteFileEntry[]): RemoteFileEntry[] {
  const passthrough: RemoteFileEntry[] = []
  const byPrefix = new Map<string, RemoteFileEntry[]>()
  for (const entry of entries) {
    const match = entry.name.match(/^(.*)\.(pgen|pvar|psam|bed|bim|fam)$/i)
    if (!match) {
      passthrough.push(entry)
      continue
    }
    const family = /^(pgen|pvar|psam)$/i.test(match[2]) ? 'pgen' : 'bed'
    const key = `${family}:${match[1]}`
    byPrefix.set(key, [...(byPrefix.get(key) ?? []), entry])
  }
  return [
    ...passthrough,
    ...[...byPrefix.values()].map((group) =>
      group.find((entry) => /\.pgen$/i.test(entry.name)) ??
      group.find((entry) => /\.bed$/i.test(entry.name)) ??
      group[0]),
  ]
}

function normalizeSplitKey(key: string): string {
  const numeric = Number(key)
  return Number.isFinite(numeric) ? String(numeric) : key.toLowerCase()
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_\-./~:]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function likelyLargeBioFile(name: string, size?: number | null): boolean {
  const lower = name.toLowerCase()
  return Boolean(size && size > 500 * 1024 * 1024)
    || /\.(bed|bim|fam|pgen|pvar|psam|bgen|vcf\.gz|bcf|bam|cram)$/i.test(lower)
}

function isTextPreviewName(name: string): boolean {
  return /\.(txt|log|out|err|sh|bash|r|py|csv|tsv|json|yaml|yml|md)$/i.test(name)
}

function detectMiniTable(text: string): BrowserPreview['table'] | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, 51)
  if (lines.length < 2) return null
  const delimiters = ['\t', ',', ';', '|']
  for (const delimiter of delimiters) {
    const counts = lines.slice(0, 8).map((line) => line.split(delimiter).length)
    const width = counts[0]
    if (width < 2) continue
    const consistent = counts.every((count) => Math.abs(count - width) <= 1)
    if (!consistent) continue
    const [headerLine, ...rowLines] = lines
    return {
      delimiter,
      headers: headerLine.split(delimiter).map((value, index) => value.trim() || `Column ${index + 1}`),
      rows: rowLines.map((line) => line.split(delimiter)),
      totalRows: Math.max(0, text.split(/\r?\n/).filter((line) => line.trim().length > 0).length - 1),
    }
  }
  return null
}

function formatFileDate(value: number): string {
  if (!value) return '-'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value))
}
