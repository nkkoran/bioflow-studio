import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, ChevronUp, Clock3, Copy, Download, FilePlus2, Home, Loader2, MoveRight, RefreshCw, Star, EyeOff, PanelsLeftRight, Upload } from 'lucide-react'

import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { useConnectionStore, LOCAL_CONNECTION_ID } from '@/stores/connectionStore'
import { useDnxStore } from '@/stores/dnxStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useDialogStore } from '@/stores/dialogStore'
import { usePipelineStore } from '@/stores/pipelineStore'
import { inferFileType } from '@/lib/fileTypeInference'
import { collapseHomePath, expandHomePath, pathDirname } from '@/lib/remotePath'
import { classNames } from '@/lib/utils'
import type { RemoteFileEntry } from '@/types'
import { RemotePathInput } from './RemotePathInput'
import type { FileOrigin } from '@/constants/connections'
import { SplitFileTransferDialog } from '@/components/file-explorer/SplitFileTransferDialog'
import { getFileIcon } from '@/components/file-explorer/fileIconMap'

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
  const refreshDnxProjects = useDnxStore((s) => s.refreshProjects)
  const confirmDialog = useDialogStore((s) => s.confirm)
  const promptDialog = useDialogStore((s) => s.prompt)
  const addFileNode = usePipelineStore((s) => s.addFileNode)
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
    if (origin === 'ssh' && !activeConnectionId) return
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
  const selectedEntries = useMemo(() => selected.map((path) => entries.find((entry) => entry.path === path)).filter((entry): entry is RemoteFileEntry => Boolean(entry)), [entries, selected])

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

  const selectEntry = (entry: RemoteFileEntry) => {
    if (entry.isDirectory) {
      setSelected([entry.path])
      return
    }
    if (mode === 'multi-file') {
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

  const addSelectionToCanvas = () => {
    const candidates = selectedEntries.length > 0
      ? selectedEntries
      : mode === 'directory'
        ? [{ name: cwd.split('/').filter(Boolean).pop() || cwd || 'Folder', path: normalizeSelectedPath(cwd, origin, homeDir), isDirectory: true, size: 0, modified: Date.now(), permissions: '', extension: '' } as RemoteFileEntry]
        : []
    if (candidates.length === 0) {
      setActionMessage('Select a file or folder first.')
      return
    }
    const nodeOrigin = origin === 'dnx' ? 'dnx' : origin
    const source = nodeOrigin === 'local' ? 'local' : 'remote'
    const offset = Date.now() % 96
    if (candidates.length === 1) {
      const entry = candidates[0]
      addFileNode(
        { x: 120 + offset, y: 160 + offset },
        {
          isInput: true,
          label: entry.name,
          path: normalizeSelectedPath(entry.path, origin, homeDir),
          fileType: entry.isDirectory ? 'any' : inferFileType(entry.name),
          source,
          origin: nodeOrigin,
        },
      )
      setActionMessage(`Added ${entry.name} to the canvas`)
      return
    }
    const items = candidates.map((entry) => ({ key: entry.name, path: normalizeSelectedPath(entry.path, origin, homeDir) }))
    addFileNode(
      { x: 120 + offset, y: 160 + offset },
      {
        isInput: true,
        label: `${items.length} selected paths`,
        path: '',
        fileType: 'any',
        source,
        origin: nodeOrigin,
        split: { axis: 'file', items, pattern: { kind: 'manual' } },
      },
    )
    setActionMessage(`Added ${items.length} selected paths as a split input`)
  }

  const footer = (
    browseOnly ? (
      <Button variant="secondary" onClick={onClose}>Close</Button>
    ) : (
      <>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          onClick={async () => {
            const picked = mode === 'directory'
              ? [selected[0] ? normalizeSelectedPath(selected[0], origin, homeDir) : normalizeSelectedPath(cwd, origin, homeDir)]
              : selected.length > 0 ? selected : []
            if (picked.length === 0) return
            const nextRecents = [...new Set([...picked, ...recents])].slice(0, 12)
            await window.api.store.set(RECENTS_KEY, nextRecents)
            onSelect(picked, origin)
            onClose()
          }}
          disabled={(mode !== 'directory' && selected.length === 0) || (mode === 'directory' && !cwd)}
        >
          Select
        </Button>
      </>
    )
  )

  return (
    <Dialog open={open} onClose={onClose} title={title} width="max-w-4xl" footer={footer}>
      <div className="grid min-h-[420px] grid-cols-[180px_1fr] gap-4">
        <div className="border-r border-border pr-3">
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
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" className="h-8 px-2" onClick={goBack} disabled={backStack.length === 0}>
              <ChevronLeft size={12} />
            </Button>
            <Button variant="secondary" size="sm" className="h-8 px-2" onClick={goForward} disabled={forwardStack.length === 0}>
              <ChevronRight size={12} />
            </Button>
            <Button variant="secondary" size="sm" className="h-8 px-2" onClick={goUp}>
              <ChevronUp size={12} />
            </Button>
            <Button variant="secondary" size="sm" className="h-8 px-2" onClick={goHome} disabled={origin !== 'dnx' && !homeDir}>
              <Home size={12} />
            </Button>
            <RemotePathInput
              value={cwd}
              onChange={setCwd}
              placeholder={origin === 'dnx' ? '/folder/on/project' : '~/project/data'}
              mode="directory"
              minPrefixChars={2}
              origin={origin}
              projectId={dnxDefaultProjectId}
              className="flex-1"
            />
            <Button
              variant="secondary"
              size="sm"
              className="h-8 px-2"
              title={favoritePaths.includes(normalizeSelectedPath(cwd, origin, homeDir)) ? 'Remove current folder from favorites' : 'Add current folder to favorites'}
              disabled={!cwd}
              onClick={() => void toggleFavorite(normalizeSelectedPath(cwd, origin, homeDir))}
            >
              <Star size={12} className={favoritePaths.includes(normalizeSelectedPath(cwd, origin, homeDir)) ? 'fill-current' : ''} />
            </Button>
            <Button variant="secondary" size="sm" onClick={refreshCurrentFolder}>
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </Button>
            {origin === 'ssh' && (
              <Button
                variant="secondary"
                size="sm"
                className="h-8 px-2"
                title="Upload a local file here"
                disabled={actionBusy}
                onClick={() => void uploadToCurrentFolder()}
              >
                <Upload size={12} className={actionBusy ? 'animate-pulse' : ''} />
              </Button>
            )}
            {selectedEntry && origin === 'ssh' && !selectedEntry.isDirectory && (
              <Button
                variant="secondary"
                size="sm"
                className="h-8 px-2"
                title="Download selected file"
                disabled={actionBusy}
                onClick={() => void downloadSelected()}
              >
                <Download size={12} />
              </Button>
            )}
            {selectedEntry && origin !== 'dnx' && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-8 px-2"
                  title="Copy selected path"
                  disabled={actionBusy}
                  onClick={() => void copySelected()}
                >
                  <Copy size={12} />
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-8 px-2"
                  title="Move or rename selected path"
                  disabled={actionBusy}
                  onClick={() => void moveSelected()}
                >
                  <MoveRight size={12} />
                </Button>
              </>
            )}
            <Button
              variant="secondary"
              size="sm"
              className="h-8 px-2 text-[11px]"
              title="Add selected path to the canvas"
              onClick={addSelectionToCanvas}
            >
              <FilePlus2 size={12} className="mr-1" />
              Add to canvas
            </Button>
            {showTransfer && (
              <Button
                variant="secondary"
                size="sm"
                className="h-8 px-2"
                title="Open split transfer view"
                onClick={() => setSplitOpen(true)}
              >
                <PanelsLeftRight size={12} />
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-bg-tertiary/30 px-2 py-1 text-[11px] text-text-muted">
            {breadcrumbs.map((crumb, index) => (
              <button
                key={`${crumb.path}-${index}`}
                type="button"
                className="truncate rounded px-1 py-0.5 hover:bg-bg-hover hover:text-text-primary"
                onClick={() => navigateTo(crumb.path)}
              >
                {crumb.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            {(['all', 'tabular', 'variants', 'plink'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setTypeFilter(option)}
                className={`rounded border px-2 py-0.5 ${
                  typeFilter === option ? 'border-accent/50 bg-accent/10 text-text-primary' : 'border-border text-text-muted'
                }`}
              >
                {option}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setHideDotfiles((prev) => !prev)}
              className="ml-auto inline-flex items-center gap-1 text-text-muted hover:text-text-primary"
            >
              <EyeOff size={11} />
              {hideDotfiles ? 'Show dotfiles' : 'Hide dotfiles'}
            </button>
          </div>

          {actionMessage && (
            <div className="rounded border border-border bg-bg-secondary px-3 py-1.5 text-[11px] text-text-secondary">
              {actionMessage}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border">
            {error ? (
              <div className="p-3 text-xs text-error">{error}</div>
            ) : (
              <div className="h-full overflow-y-auto">
                {loading && (
                  <div className="flex items-center gap-2 p-3 text-xs text-text-muted">
                    <Loader2 size={12} className="animate-spin" />
                    Loading files…
                  </div>
                )}
                {fileExplorerViewMode === 'icons' ? (
                  <div className="grid grid-cols-[repeat(auto-fill,96px)] justify-start gap-x-3 gap-y-4 p-3">
                    {visibleEntries.map((entry) => {
                      const selectedHere = selected.includes(entry.path)
                      const iconDef = getFileIcon(entry.extension, entry.isDirectory)
                      const Icon = iconDef.icon
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
                            <span className={classNames(
                              'flex h-12 w-12 items-center justify-center rounded-xl',
                              selectedHere ? 'bg-accent/20' : 'bg-bg-tertiary',
                            )}>
                              <Icon size={28} className={iconDef.color} />
                            </span>
                            <span
                              className="w-full overflow-hidden break-words text-[11px] leading-4"
                              style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 }}
                            >
                              {entry.name}{entry.isDirectory && '/'}
                            </span>
                            <span className="text-[10px] text-text-muted">{entry.isDirectory ? 'folder' : inferFileType(entry.name)}</span>
                          </button>
                          {entry.isDirectory && (
                            <button
                              type="button"
                              className={`absolute right-1 top-1 rounded p-1 ${favoritePaths.includes(entry.path) ? 'text-amber-300' : 'text-text-muted hover:text-amber-300'}`}
                              title={favoritePaths.includes(entry.path) ? 'Remove from favorites' : 'Add to favorites'}
                              onClick={() => void toggleFavorite(entry.path)}
                            >
                              <Star size={11} className={favoritePaths.includes(entry.path) ? 'fill-current' : ''} />
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ) : visibleEntries.map((entry) => {
                  const selectedHere = selected.includes(entry.path)
                  const iconDef = getFileIcon(entry.extension, entry.isDirectory)
                  const Icon = iconDef.icon
                  return (
                    <div key={entry.path} className="relative border-b border-border/50">
                      <button
                        type="button"
                        onClick={() => selectEntry(entry)}
                        onDoubleClick={() => activateEntry(entry)}
                        className={`flex w-full items-center gap-2 px-3 py-2 pr-16 text-left text-xs ${
                          selectedHere ? 'bg-accent/10 text-text-primary' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                        }`}
                      >
                        <Icon size={14} className={iconDef.color} />
                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                        <span className="shrink-0 text-[10px] text-text-muted">
                          {entry.isDirectory ? 'folder' : inferFileType(entry.name)}
                        </span>
                      </button>
                      {entry.isDirectory && (
                        <button
                          type="button"
                          className={`absolute right-8 top-1/2 -translate-y-1/2 rounded p-1 ${favoritePaths.includes(entry.path) ? 'text-amber-300' : 'text-text-muted hover:text-amber-300'}`}
                          title={favoritePaths.includes(entry.path) ? 'Remove from favorites' : 'Add to favorites'}
                          onClick={() => void toggleFavorite(entry.path)}
                        >
                          <Star size={11} className={favoritePaths.includes(entry.path) ? 'fill-current' : ''} />
                        </button>
                      )}
                    </div>
                  )
                })}
                {!loading && visibleEntries.length === 0 && (
                  <div className="p-4 text-xs text-text-muted">No matching files here.</div>
                )}
              </div>
            )}
          </div>

          <div className="rounded-md border border-border bg-bg-secondary px-3 py-2 text-[11px] text-text-muted">
            {mode === 'directory'
              ? `Current ${originLabel} folder: ${cwd || (homeDir ? collapseHomePath(homeDir, homeDir) : '/')}`
              : selected.length > 0
                ? selected.map((path) => collapseHomePath(path, homeDir)).join(', ')
                : 'Select a file to continue.'}
          </div>
        </div>
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
