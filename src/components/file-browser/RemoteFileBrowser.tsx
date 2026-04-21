import { useEffect, useMemo, useState } from 'react'
import { Folder, FileText, RefreshCw, Clock3, Star, EyeOff } from 'lucide-react'

import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { useConnectionStore, LOCAL_CONNECTION_ID } from '@/stores/connectionStore'
import { inferFileType } from '@/lib/fileTypeInference'
import { collapseHomePath, expandHomePath, pathDirname } from '@/lib/remotePath'
import type { RemoteFileEntry } from '@/types'
import { RemotePathInput } from './RemotePathInput'

const RECENTS_KEY = 'fileBrowser:recents:v1'
const FAVORITES_KEY = 'fileBrowser:favorites:v1'

interface RemoteFileBrowserProps {
  open: boolean
  onClose: () => void
  title?: string
  mode: 'file' | 'directory' | 'multi-file'
  initialPath?: string
  accept?: string[]
  onSelect: (paths: string[]) => void
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
  const [cwd, setCwd] = useState(initialPath ?? '')
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

  useEffect(() => {
    if (!open) return
    void window.api.store.get<string[]>(RECENTS_KEY).then((value) => setRecents(value ?? []))
    void window.api.store.get<string[]>(FAVORITES_KEY).then((value) => setFavoritePaths(value ?? []))
  }, [open])

  useEffect(() => {
    if (!open || !activeConnectionId) return
    let cancelled = false
    async function loadHome() {
      if (activeConnectionId === LOCAL_CONNECTION_ID) {
        const home = await window.api.local.homedir()
        if (!cancelled) setHomeDir(home)
        return
      }
      const result = await window.api.ssh.exec(activeConnectionId, 'printf %s "$HOME"')
      if (!cancelled) setHomeDir(result.stdout.trim() || null)
    }
    void loadHome().catch(() => {
      if (!cancelled) setHomeDir(null)
    })
    return () => { cancelled = true }
  }, [activeConnectionId, open])

  useEffect(() => {
    if (!open) return
    if (initialPath) {
      setCwd(mode === 'directory' ? initialPath : pathDirname(initialPath) || initialPath)
      return
    }
    if (defaultDirectory) {
      setCwd(defaultDirectory)
      return
    }
    if (homeDir) setCwd(collapseHomePath(homeDir, homeDir))
  }, [defaultDirectory, homeDir, initialPath, open])

  useEffect(() => {
    if (!open || !activeConnectionId || !cwd) return
    const path = expandHomePath(cwd, homeDir)
    setLoading(true)
    setError(null)
    const promise = activeConnectionId === LOCAL_CONNECTION_ID
      ? window.api.local.ls(path)
      : window.api.sftp.ls(activeConnectionId, path)
    void promise.then((next) => {
      setEntries(next)
      setLoading(false)
    }).catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
      setEntries([])
      setLoading(false)
    })
  }, [activeConnectionId, cwd, homeDir, open, reloadNonce])

  const favorites = useMemo(() => {
    const base = [
      homeDir ? collapseHomePath(homeDir, homeDir) : '',
      defaultDirectory ? collapseHomePath(defaultDirectory, homeDir) : '',
      '~/scratch',
      '~/projects',
    ].filter(Boolean)
    return [...new Set([...favoritePaths.map((path) => collapseHomePath(path, homeDir)), ...base])]
  }, [defaultDirectory, favoritePaths, homeDir])

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

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button
        variant="primary"
        onClick={async () => {
          const picked = mode === 'directory'
            ? [expandHomePath(cwd, homeDir)]
            : selected.length > 0 ? selected : []
          if (picked.length === 0) return
          const nextRecents = [...new Set([...picked, ...recents])].slice(0, 12)
          await window.api.store.set(RECENTS_KEY, nextRecents)
          onSelect(picked)
          onClose()
        }}
        disabled={mode !== 'directory' && selected.length === 0}
      >
        Select
      </Button>
    </>
  )

  return (
    <Dialog open={open} onClose={onClose} title={title} width="max-w-4xl" footer={footer}>
      <div className="grid min-h-[420px] grid-cols-[180px_1fr] gap-4">
        <div className="border-r border-border pr-3">
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
                  onClick={() => setCwd(path)}
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
                    if (mode === 'directory') setCwd(collapseHomePath(path, homeDir))
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
            <RemotePathInput
              value={cwd}
              onChange={setCwd}
              placeholder="~/project/data"
              mode="directory"
              minPrefixChars={2}
              className="flex-1"
            />
            <Button
              variant="secondary"
              size="sm"
              className="h-8 px-2"
              title={favoritePaths.includes(expandHomePath(cwd, homeDir)) ? 'Remove current folder from favorites' : 'Add current folder to favorites'}
              disabled={!cwd}
              onClick={() => void toggleFavorite(expandHomePath(cwd, homeDir))}
            >
              <Star size={12} className={favoritePaths.includes(expandHomePath(cwd, homeDir)) ? 'fill-current' : ''} />
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setReloadNonce((value) => value + 1)}>
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </Button>
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
                {visibleEntries.map((entry) => {
                  const selectedHere = selected.includes(entry.path)
                  return (
                    <div key={entry.path} className="relative border-b border-border/50">
                      <button
                        type="button"
                        onClick={() => {
                          if (entry.isDirectory) {
                            setCwd(collapseHomePath(entry.path, homeDir))
                            if (mode === 'directory') setSelected([entry.path])
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
                            setCwd(collapseHomePath(entry.path, homeDir))
                            return
                          }
                          setSelected([entry.path])
                          onSelect([entry.path])
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
              ? `Current folder: ${cwd || (homeDir ? collapseHomePath(homeDir, homeDir) : '/')}`
              : selected.length > 0
                ? selected.map((path) => collapseHomePath(path, homeDir)).join(', ')
                : 'Select a file to continue.'}
          </div>
        </div>
      </div>
    </Dialog>
  )
}
