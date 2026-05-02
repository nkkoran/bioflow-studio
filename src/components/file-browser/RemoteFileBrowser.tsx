import { useEffect, useMemo, useState } from 'react'
import { Clock3, EyeOff, FolderPlus, Grid2X2, List, PanelsLeftRight, RefreshCw, Star } from 'lucide-react'

import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { useConnectionStore, LOCAL_CONNECTION_ID } from '@/stores/connectionStore'
import { useDnxStore } from '@/stores/dnxStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useDialogStore } from '@/stores/dialogStore'
import { inferFileType } from '@/lib/fileTypeInference'
import { collapseHomePath, expandHomePath, pathDirname } from '@/lib/remotePath'
import { classNames } from '@/lib/utils'
import type { RemoteFileEntry } from '@/types'
import { RemotePathInput } from './RemotePathInput'
import type { FileOrigin } from '@/constants/connections'
import { SplitFileTransferDialog } from '@/components/file-explorer/SplitFileTransferDialog'
import { FileGlyph } from '@/components/file-explorer/FileGlyph'

const RECENTS_KEY = 'fileBrowser:recents:v1'
const FAVORITES_KEY = 'fileBrowser:favorites:v1'

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
  const defaultDirectory = useConnectionStore((s) => activeConnectionId ? s.connections[activeConnectionId]?.config.defaultDirectory ?? '' : '')
  const dnxDefaultProjectId = useDnxStore((s) => s.defaultProjectId)
  const dnxAvailableProjects = useDnxStore((s) => s.availableProjects)
  const devMode = useSettingsStore((s) => s.devMode)
  const fileExplorerViewMode = useSettingsStore((s) => s.settings.fileExplorerViewMode)
  const splitExplorerBasePane = useSettingsStore((s) => s.settings.splitExplorerBasePane)
  const setSetting = useSettingsStore((s) => s.setSetting)
  const refreshDnxProjects = useDnxStore((s) => s.refreshProjects)
  const confirmDialog = useDialogStore((s) => s.confirm)
  const promptDialog = useDialogStore((s) => s.prompt)
  const [cwd, setCwd] = useState(initialPath ?? '')
  const [origin, setOrigin] = useState<FileOrigin>('local')
  const [homeDir, setHomeDir] = useState<string | null>(null)
  const [entries, setEntries] = useState<RemoteFileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [hideDotfiles, setHideDotfiles] = useState(true)
  const [typeFilter, setTypeFilter] = useState<'all' | 'tabular' | 'variants' | 'plink'>('all')
  const [recents, setRecents] = useState<string[]>([])
  const [favoritePaths, setFavoritePaths] = useState<string[]>([])
  const [reloadNonce, setReloadNonce] = useState(0)
  const [backStack, setBackStack] = useState<string[]>([])
  const [forwardStack, setForwardStack] = useState<string[]>([])
  const [splitOpen, setSplitOpen] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | null>(null)

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
  }, [defaultDirectory, homeDir, initialPath, open, origin])

  useEffect(() => {
    if (!open || !cwd) return
    if (origin === 'ssh' && (!activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID)) {
      setEntries([])
      setLoading(false)
      setError('Connect to SSH before browsing remote files.')
      return
    }
    if (origin === 'dnx' && !dnxDefaultProjectId) return
    const path = origin === 'dnx' ? normalizeDnxPath(cwd) : expandHomePath(cwd, homeDir)
    let cancelled = false
    setLoading(true)
    setError(null)
    const promise = origin === 'local'
      ? window.api.local.ls(path)
      : origin === 'dnx'
        ? window.api.dnx.listFiles({ projectId: dnxDefaultProjectId!, path })
        : window.api.sftp.ls(activeConnectionId!, path)
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
  }, [activeConnectionId, cwd, dnxDefaultProjectId, homeDir, open, origin, reloadNonce])

  const favorites = useMemo(() => {
    const base = origin === 'dnx'
      ? ['/']
      : [
          homeDir ? collapseHomePath(homeDir, homeDir) : '',
          defaultDirectory ? collapseHomePath(defaultDirectory, homeDir) : '',
          '~/scratch',
          '~/projects',
        ].filter(Boolean)
    return [...new Set([...favoritePaths.map((path) => collapseHomePath(path, homeDir)), ...base])]
  }, [defaultDirectory, favoritePaths, homeDir, origin])

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
      return true
    })
    .filter((entry) => matchesAcceptedType(accept, entry))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true })
  }), [accept, entries, hideDotfiles, typeFilter])
  const selectedEntry = useMemo(() => entries.find((entry) => selected.includes(entry.path)) ?? null, [entries, selected])

  const navigateTo = (nextPath: string, opts: { pushHistory?: boolean } = {}) => {
    const normalized = origin === 'dnx'
      ? normalizeDnxPath(nextPath)
      : collapseHomePath(expandHomePath(nextPath, homeDir), homeDir)
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
      setForwardStack((forward) => [...forward, cwd].slice(-40))
      setCwd(next)
      return prev.slice(0, -1)
    })
  }

  const goForward = () => {
    setForwardStack((prev) => {
      const next = prev[prev.length - 1]
      if (!next) return prev
      setBackStack((back) => [...back, cwd].slice(-40))
      setCwd(next)
      return prev.slice(0, -1)
    })
  }

  const goUp = () => {
    const currentPath = origin === 'dnx' ? normalizeDnxPath(cwd) : expandHomePath(cwd, homeDir)
    const parent = pathDirname(currentPath)
    if (!parent || parent === currentPath) return
    navigateTo(parent)
  }

  const goHome = () => {
    if (origin === 'dnx') {
      navigateTo('/')
      return
    }
    if (!homeDir) return
    navigateTo(homeDir)
  }

  const refreshCurrentFolder = () => setReloadNonce((value) => value + 1)

  const splitInitialPanes = useMemo(() => {
    const baseOrigin = activeConnectionId && activeConnectionId !== LOCAL_CONNECTION_ID ? 'ssh' : 'local'
    const rawBase = baseOrigin === 'ssh' ? (defaultDirectory || homeDir || '/') : (homeDir || '/')
    const basePath = expandHomePath(rawBase, homeDir)
    const currentOrigin = origin === 'ssh' ? 'ssh' : 'local'
    const selectedFolder = selectedEntry?.isDirectory ? selectedEntry.path : ''
    const currentPath = origin === 'dnx'
      ? basePath
      : normalizeSelectedPath(selectedFolder || cwd, origin, homeDir)
    const base = { origin: baseOrigin as 'local' | 'ssh', cwd: basePath }
    const current = { origin: currentOrigin as 'local' | 'ssh', cwd: currentPath || basePath }
    return splitExplorerBasePane === 'left'
      ? [base, current] as [{ origin: 'local' | 'ssh'; cwd: string }, { origin: 'local' | 'ssh'; cwd: string }]
      : [current, base] as [{ origin: 'local' | 'ssh'; cwd: string }, { origin: 'local' | 'ssh'; cwd: string }]
  }, [activeConnectionId, cwd, defaultDirectory, homeDir, origin, selectedEntry, splitExplorerBasePane])

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
    const expanded = expandHomePath(cwd, homeDir)
    const prefix = homeDir && expanded.startsWith(homeDir) ? '~' : ''
    const relative = prefix && homeDir ? expanded.slice(homeDir.length).replace(/^\/+/, '') : expanded.replace(/^\/+/, '')
    const parts = relative ? relative.split('/').filter(Boolean) : []
    const crumbs: Array<{ label: string; path: string }> = [{ label: prefix || '/', path: prefix || '/' }]
    let running = prefix || ''
    for (const part of parts) {
      running = running === '/' ? `/${part}` : `${running}/${part}`.replace(/\/{2,}/g, '/')
      crumbs.push({ label: part, path: running })
    }
    return crumbs
  }, [cwd, homeDir, origin])

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

  const copySelected = async () => {
    if (!selectedEntry || origin === 'dnx' || actionBusy) return
    if (origin === 'local' && selectedEntry.isDirectory) {
      setActionMessage('Local folder copy is not available here. Use the split transfer view for file moves.')
      return
    }
    const destination = await promptDialog({
      title: 'Copy path',
      message: 'Choose the destination path.',
      defaultValue: `${normalizeSelectedPath(cwd, origin, homeDir).replace(/\/+$/, '')}/${selectedEntry.name}`,
      confirmLabel: 'Copy',
    })
    if (!destination?.trim()) return
    setActionBusy(true)
    setActionMessage(null)
    try {
      if (origin === 'local') await window.api.local.copy(selectedEntry.path, destination.trim())
      else await window.api.ssh.exec(activeConnectionId!, `cp -R ${shellQuote(selectedEntry.path)} ${shellQuote(destination.trim())}`)
      setActionMessage(`Copied ${selectedEntry.name}`)
      refreshCurrentFolder()
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setActionBusy(false)
    }
  }

  const moveSelected = async () => {
    if (!selectedEntry || origin === 'dnx' || actionBusy) return
    const destination = await promptDialog({
      title: 'Move or rename path',
      message: 'Choose the new path.',
      defaultValue: `${normalizeSelectedPath(cwd, origin, homeDir).replace(/\/+$/, '')}/${selectedEntry.name}`,
      confirmLabel: 'Move',
    })
    if (!destination?.trim()) return
    setActionBusy(true)
    setActionMessage(null)
    try {
      if (origin === 'local') await window.api.local.rename(selectedEntry.path, destination.trim())
      else await window.api.sftp.rename(activeConnectionId!, selectedEntry.path, destination.trim())
      setSelected([])
      setActionMessage(`Moved ${selectedEntry.name}`)
      refreshCurrentFolder()
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setActionBusy(false)
    }
  }

  const downloadSelected = async () => {
    if (!selectedEntry || origin !== 'ssh' || !activeConnectionId || actionBusy) return
    const folder = await window.api.dialog.openDirectory()
    if (!folder) return
    setActionBusy(true)
    setActionMessage(null)
    try {
      await window.api.sftp.download(activeConnectionId, selectedEntry.path, `${folder.replace(/\/+$/, '')}/${selectedEntry.name}`)
      setActionMessage(`Downloaded ${selectedEntry.name}`)
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setActionBusy(false)
    }
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
    const destination = `${normalizeSelectedPath(cwd, origin, homeDir).replace(/\/+$/, '')}/${name}`
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
    const basePath = normalizeSelectedPath(cwd, origin, homeDir).replace(/\/+$/, '')
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

  const confirmSelection = async () => {
    const picked = mode === 'directory'
      ? [selected[0] ? normalizeSelectedPath(selected[0], origin, homeDir) : normalizeSelectedPath(cwd, origin, homeDir)]
      : selected.length > 0 ? selected.map((path) => normalizeSelectedPath(path, origin, homeDir)) : []
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
        <aside className="bioflow-file-browser-sidebar p-3">
          <div className="mb-3 flex flex-col gap-1">
            {([
              { key: 'local', label: 'Local', disabled: false },
              { key: 'ssh', label: 'Rorqual (SSH)', disabled: !activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID },
              ...(devMode ? [{ key: 'dnx' as const, label: originLabel, disabled: !dnxDefaultProjectId }] : []),
            ] as const).map((tab) => (
              <button
                key={tab.key}
                type="button"
                disabled={tab.disabled}
                onClick={() => setOrigin(tab.key)}
                className={`rounded px-2 py-1 text-left text-xs ${
                  origin === tab.key
                    ? 'bg-accent/10 text-text-primary'
                    : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                } disabled:opacity-50`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="mb-3">
            <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-text-muted">
              <Star size={11} />
              Favorites
            </div>
            <div className="flex flex-col gap-1">
              {favorites.map((path) => (
                <button
                  key={path}
                  type="button"
                  onClick={() => navigateTo(path)}
                  className="truncate rounded px-2 py-1 text-left text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                >
                  {path}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-text-muted">
              <Clock3 size={11} />
              Recents
            </div>
            <div className="flex flex-col gap-1">
              {recents.length > 0 ? recents.map((path) => (
                <button
                  key={path}
                  type="button"
                  onClick={() => {
                    if (mode === 'directory') navigateTo(path)
                    else setSelected([path])
                  }}
                  className="truncate rounded px-2 py-1 text-left text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                >
                  {collapseHomePath(path, homeDir)}
                </button>
              )) : <div className="px-2 text-[11px] text-text-muted">No recent picks yet.</div>}
            </div>
          </div>
        </aside>

        <>
          <header className="bioflow-file-browser-header">
            <div className="min-w-0 flex-1 overflow-hidden">
              <div className="flex min-w-0 items-center gap-1 text-xs text-text-secondary">
                {breadcrumbs.map((crumb, index) => (
                  <button
                    key={`${crumb.path}-${index}`}
                    type="button"
                    className="text-nowrap min-w-0 max-w-[12rem] rounded px-1.5 py-1 hover:bg-bg-hover hover:text-text-primary"
                    onClick={() => navigateTo(crumb.path)}
                    title={crumb.path}
                  >
                    {crumb.label}
                  </button>
                ))}
              </div>
            </div>
            {showTransfer && (
              <Button
                variant="secondary"
                size="sm"
                className="h-7 shrink-0 gap-1.5 px-2"
                title="Open two-pane file explorer"
                onClick={() => setSplitOpen(true)}
              >
                <PanelsLeftRight size={14} />
                <span className="text-nowrap text-xs">Split</span>
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              className="h-7 min-w-7 px-0"
              title={fileExplorerViewMode === 'icons' ? 'Show list view' : 'Show icon grid'}
              onClick={() => void setSetting('settings:fileExplorerViewMode', fileExplorerViewMode === 'icons' ? 'list' : 'icons')}
            >
              {fileExplorerViewMode === 'icons' ? <List size={14} /> : <Grid2X2 size={14} />}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="h-7 min-w-7 px-0"
              title="New folder"
              disabled={origin === 'dnx' || actionBusy}
              onClick={() => void createFolderInCurrent()}
            >
              <FolderPlus size={14} />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="h-7 min-w-7 px-0"
              title="Refresh"
              onClick={refreshCurrentFolder}
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </Button>
          </header>

          <main className="bioflow-file-browser-list">
            {actionMessage && (
              <div className="animate-fade-up mx-3 mt-3 rounded-md bg-bg-secondary px-3 py-1.5 text-[11px] text-text-secondary shadow-sm">
                {actionMessage}
              </div>
            )}
            {error ? (
              <div className="p-3 text-xs text-error">{error}</div>
            ) : (
              <div>
                {loading && (
                  <div className="flex flex-col gap-2 p-3">
                    <div className="animate-shimmer h-8 rounded-md" />
                    <div className="animate-shimmer h-8 rounded-md" />
                    <div className="animate-shimmer h-8 rounded-md" />
                  </div>
                )}
                {fileExplorerViewMode === 'icons' ? (
                  <div className="grid grid-cols-[repeat(auto-fill,96px)] justify-start gap-x-3 gap-y-4 p-3">
                    {visibleEntries.map((entry) => {
                      const selectedHere = selected.includes(entry.path)
                      return (
                        <div key={entry.path} className="relative h-[112px] w-24">
                          <button
                            type="button"
                            onClick={() => selectEntry(entry)}
                            onDoubleClick={() => activateEntry(entry)}
                            className={classNames(
                              'flex h-full w-full flex-col items-center gap-1.5 rounded-md px-1.5 py-2 text-center text-xs transition-colors',
                              selectedHere
                                ? 'bg-accent/15 text-text-primary'
                                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                            )}
                            title={entry.path}
                          >
                            <FileGlyph entry={entry} size="grid" selected={selectedHere} />
                            <span
                              className="w-full overflow-hidden break-words text-[11px] leading-4"
                              style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 }}
                            >
                              {entry.name}{entry.isDirectory && '/'}
                            </span>
                            <span className="text-[10px] text-text-muted">{entry.isDirectory ? 'folder' : inferFileType(entry.name)}</span>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                ) : visibleEntries.map((entry) => {
                  const selectedHere = selected.includes(entry.path)
                  return (
                    <div key={entry.path} className="relative">
                      <button
                        type="button"
                        onClick={() => selectEntry(entry)}
                        onDoubleClick={() => activateEntry(entry)}
                        className={classNames(
                          'bioflow-file-browser-row w-full text-left text-xs',
                          selectedHere ? 'bg-accent/10 text-text-primary' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                        )}
                        title={entry.path}
                      >
                        <FileGlyph entry={entry} size="row" selected={selectedHere} />
                        <span className="text-nowrap min-w-0 flex-1">{entry.name}</span>
                        <span className="bioflow-badge text-nowrap w-12 shrink-0 text-right text-[10px] text-text-muted">
                          {entry.isDirectory ? 'folder' : inferFileType(entry.name)}
                        </span>
                      </button>
                    </div>
                  )
                })}
                {!loading && visibleEntries.length === 0 && (
                  <div className="p-4 text-xs text-text-muted">No matching files here.</div>
                )}
              </div>
            )}
          </main>

          <footer className="bioflow-file-browser-footer">
            <div className="flex min-w-0 flex-1 items-center gap-1">
              {(['all', 'tabular', 'variants', 'plink'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setTypeFilter(option)}
                  className={classNames(
                    'interactive-row h-7 px-2 text-[11px]',
                    typeFilter === option ? 'bg-accent/10 text-text-primary' : 'text-text-muted',
                  )}
                >
                  <span className="text-nowrap">{option}</span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => setHideDotfiles((prev) => !prev)}
                className="interactive-row flex h-7 items-center gap-1 px-2 text-[11px] text-text-muted"
              >
                <EyeOff size={11} />
                <span className="text-nowrap">{hideDotfiles ? 'Dotfiles off' : 'Dotfiles on'}</span>
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" onClick={onClose}>{browseOnly ? 'Close' : 'Cancel'}</Button>
              {!browseOnly && (
                <Button variant="primary" onClick={() => void confirmSelection()} disabled={!canSelect}>
                  Select
                </Button>
              )}
            </div>
          </footer>
        </>
      </div>
      <SplitFileTransferDialog open={splitOpen} onClose={() => setSplitOpen(false)} initialPanes={splitInitialPanes} />
    </Dialog>
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

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_\-./~:]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function likelyLargeBioFile(name: string, size?: number | null): boolean {
  const lower = name.toLowerCase()
  return Boolean(size && size > 500 * 1024 * 1024)
    || /\.(bed|bim|fam|pgen|pvar|psam|bgen|vcf\.gz|bcf|bam|cram)$/i.test(lower)
}
