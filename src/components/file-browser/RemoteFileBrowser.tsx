import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, ChevronUp, Clock3, FileText, Folder, Home, Loader2, RefreshCw, Star, EyeOff } from 'lucide-react'

import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { useConnectionStore, LOCAL_CONNECTION_ID } from '@/stores/connectionStore'
import { useDnxStore } from '@/stores/dnxStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { inferFileType } from '@/lib/fileTypeInference'
import { collapseHomePath, expandHomePath, pathDirname } from '@/lib/remotePath'
import type { RemoteFileEntry } from '@/types'
import { RemotePathInput } from './RemotePathInput'
import type { FileOrigin } from '@/constants/connections'

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
}: RemoteFileBrowserProps) {
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const defaultDirectory = useConnectionStore((s) => activeConnectionId ? s.connections[activeConnectionId]?.config.defaultDirectory ?? '' : '')
  const dnxDefaultProjectId = useDnxStore((s) => s.defaultProjectId)
  const dnxAvailableProjects = useDnxStore((s) => s.availableProjects)
  const devMode = useSettingsStore((s) => s.devMode)
  const refreshDnxProjects = useDnxStore((s) => s.refreshProjects)
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

  const footer = (
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
            <Button variant="secondary" size="sm" onClick={() => setReloadNonce((value) => value + 1)}>
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </Button>
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
                {visibleEntries.map((entry) => {
                  const selectedHere = selected.includes(entry.path)
                  return (
                    <div key={entry.path} className="relative border-b border-border/50">
                      <button
                        type="button"
                        onClick={() => {
                          if (entry.isDirectory) {
                            setSelected([entry.path])
                            return
                          }
                          if (mode === 'multi-file') {
                            setSelected((prev) => selectedHere ? prev.filter((path) => path !== entry.path) : [...prev, entry.path])
                          } else {
                            setSelected([entry.path])
                          }
                        }}
                        onDoubleClick={() => {
                          if (entry.isDirectory) {
                            navigateTo(entry.path)
                            return
                          }
                          setSelected([entry.path])
                          onSelect([entry.path], origin)
                          onClose()
                        }}
                        className={`flex w-full items-center gap-2 px-3 py-2 pr-16 text-left text-xs ${
                          selectedHere ? 'bg-accent/10 text-text-primary' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                        }`}
                      >
                        {entry.isDirectory ? <Folder size={14} className="text-amber-300" /> : <FileText size={14} className="text-text-muted" />}
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
