import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronUp, Copy, Loader2, MoveRight, PanelsLeftRight, RefreshCw, Upload } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { MenuSelect, type MenuSelectOption } from '@/components/ui/MenuSelect'
import { LOCAL_CONNECTION_ID, useConnectionStore } from '@/stores/connectionStore'
import { useDialogStore } from '@/stores/dialogStore'
import type { RemoteFileEntry } from '@/types/files'
import { inferFileType } from '@/lib/fileTypeInference'
import { FileGlyph } from './FileGlyph'
import { classNames } from '@/lib/utils'

type PaneOrigin = 'local' | 'ssh'

interface InitialPane {
  origin: PaneOrigin
  connectionId?: string | null
  cwd?: string
}

interface PaneState {
  origin: PaneOrigin
  connectionId: string | null
  cwd: string
  entries: RemoteFileEntry[]
  selected: RemoteFileEntry | null
  loading: boolean
  error: string | null
  nonce: number
}

interface DragPayload {
  origin: PaneOrigin
  connectionId?: string | null
  path: string
  name: string
  isDirectory: boolean
  paneIndex?: number
}

export function SplitFileTransferDialog({
  open,
  onClose,
  initialPanes,
}: {
  open: boolean
  onClose: () => void
  initialPanes?: [InitialPane, InitialPane]
}) {
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const connections = useConnectionStore((s) => s.connections)
  const confirmDialog = useDialogStore((s) => s.confirm)
  const serverOptions = useMemo(
    () => Object.entries(connections)
      .filter(([, entry]) => !entry.isLocal)
      .map(([id, entry]) => ({
        id,
        label: entry.config.name || entry.config.host || id,
        status: entry.status,
        defaultDirectory: entry.config.defaultDirectory,
      })),
    [connections],
  )
  const defaultServerId = activeConnectionId && activeConnectionId !== LOCAL_CONNECTION_ID
    ? activeConnectionId
    : serverOptions.find((entry) => entry.status === 'connected')?.id ?? null
  const locationOptions = useMemo<Array<MenuSelectOption<string>>>(() => [
    { value: 'local', label: 'Local' },
    ...serverOptions.map((entry) => ({
      value: entry.id,
      label: entry.label,
      description: entry.status === 'connected' ? 'Server' : `Server (${entry.status})`,
    })),
  ], [serverOptions])
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [homeByLocation, setHomeByLocation] = useState<Record<string, string>>({ local: '/' })
  const [panes, setPanes] = useState<[PaneState, PaneState]>(() => [
    emptyPane('local'),
    emptyPane('ssh'),
  ])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function init() {
      const localHome = await window.api.local.homedir().catch(() => '/')
      const homes: Record<string, string> = { local: localHome || '/' }
      for (const option of serverOptions) {
        homes[option.id] = option.defaultDirectory?.trim() || (
          option.status === 'connected'
            ? (await window.api.ssh.exec(option.id, 'printf %s "$HOME"').catch(() => ({ stdout: '' }))).stdout.trim()
            : ''
        ) || '/'
      }
      if (cancelled) return
      setHomeByLocation(homes)
      const left = initialPanes?.[0] ?? { origin: 'local' as const }
      const right = initialPanes?.[1] ?? { origin: 'ssh' as const }
      const normalizeInitialPane = (pane: InitialPane): PaneState => {
        const connectionId = pane.origin === 'ssh' ? (pane.connectionId || defaultServerId) : null
        const key = pane.origin === 'local' ? 'local' : connectionId || ''
        return {
          ...emptyPane(pane.origin, connectionId),
          cwd: pane.cwd?.trim() || homes[key] || '/',
        }
      }
      setPanes([normalizeInitialPane(left), normalizeInitialPane(right)])
    }
    void init()
    return () => { cancelled = true }
  }, [defaultServerId, initialPanes, open, serverOptions])

  useEffect(() => {
    if (!open) return
    panes.forEach((pane, index) => {
      if (!pane.cwd) return
      if (pane.origin === 'ssh' && !paneUsable(pane, connections)) return
      void loadPane(index)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, panes[0].connectionId, panes[0].cwd, panes[0].origin, panes[0].nonce, panes[1].connectionId, panes[1].cwd, panes[1].origin, panes[1].nonce, connections])

  const updatePane = useCallback((index: number, patch: Partial<PaneState>) => {
    setPanes((current) => {
      const next = [...current] as [PaneState, PaneState]
      next[index] = { ...next[index], ...patch }
      return next
    })
  }, [])

  const loadPane = useCallback(async (index: number) => {
    const pane = panes[index]
    if (pane.origin === 'ssh' && !paneUsable(pane, connections)) {
      updatePane(index, { entries: [], loading: false, error: 'Connect to SSH before browsing remote files.' })
      return
    }
    updatePane(index, { loading: true, error: null })
    try {
      const entries = pane.origin === 'local'
        ? await window.api.local.ls(pane.cwd)
        : await window.api.sftp.ls(pane.connectionId!, pane.cwd)
      updatePane(index, { entries, loading: false, selected: null })
    } catch (err) {
      updatePane(index, { entries: [], loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  }, [connections, panes, updatePane])

  const refreshPane = (index: number) => updatePane(index, { nonce: panes[index].nonce + 1 })
  const other = (index: number) => index === 0 ? 1 : 0

  const selectedMove = async (fromIndex: number, move: boolean) => {
    const source = panes[fromIndex]
    const entry = source.selected
    if (!entry) return
    await transferEntry({ origin: source.origin, connectionId: source.connectionId, path: entry.path, name: entry.name, isDirectory: entry.isDirectory }, fromIndex, other(fromIndex), move)
  }

  const transferEntry = async (payload: DragPayload, fromIndex: number, toIndex: number, move: boolean) => {
    const target = panes[toIndex]
    if (target.origin === 'ssh' && !paneUsable(target, connections)) {
      setMessage('Connect to SSH before transferring to the server pane.')
      return
    }
    if (sameEndpoint(payload, target) && pathDir(payload.path) === target.cwd) {
      setMessage('Source and destination are the same folder.')
      return
    }
    const destination = joinPath(target.cwd, payload.name)
    if (target.origin === 'ssh' && likelyLargeBioFile(payload.name) && !(await confirmDialog({
      title: 'Large genomic file upload',
      message: `Copy ${payload.name} to the server pane?`,
      detail: 'For RAP/DNAnexus analyses, genotype files usually should be referenced where they already exist instead of uploaded again.',
      confirmLabel: move ? 'Move' : 'Copy',
      cancelLabel: 'Cancel',
    }))) {
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      if (payload.isDirectory) {
        await copyDirectory(endpointFromPayload(payload), payload.path, endpointFromPane(target), destination)
      } else {
        await copyFile(endpointFromPayload(payload), payload.path, endpointFromPane(target), destination)
      }
      if (move) await deleteEntry(endpointFromPayload(payload), payload.path, payload.isDirectory)
      setMessage(`${move ? 'Moved' : 'Copied'} ${payload.name}`)
      refreshPane(fromIndex)
      refreshPane(toIndex)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <Button variant="secondary" onClick={onClose}>
      Close
    </Button>
  )

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Split transfer"
      subtitle="Local and cluster panes"
      icon={<PanelsLeftRight size={20} />}
      className="bioflow-split-transfer-dialog"
      bodyClassName="bioflow-split-transfer-body"
      footer={footer}
    >
      <div className="bioflow-split-transfer-shell">
        <div className="mx-4 my-3 flex items-center gap-2 rounded-md bg-bg-tertiary px-3 py-2 text-[11px] text-text-muted shadow-inner">
          <Upload size={12} />
          <span className="text-wrap">Drag across panes to copy. Hold Option while dropping, or use Move, to move instead.</span>
        </div>
        <div className="bioflow-split-transfer-panes">
          {[0, 1].map((index) => (
            <FilePane
              key={index}
              index={index}
              pane={panes[index]}
              homeByLocation={homeByLocation}
              locationOptions={locationOptions}
              disabled={panes[index].origin === 'ssh' && !paneUsable(panes[index], connections)}
              busy={busy}
              onPatch={(patch) => updatePane(index, patch)}
              onRefresh={() => refreshPane(index)}
              onCopy={() => void selectedMove(index, false)}
              onMove={() => void selectedMove(index, true)}
              onDropPayload={(payload, move) => void transferEntry(payload, payload.paneIndex ?? other(index), index, move)}
            />
          ))}
        </div>
        {message && <div className="mx-4 mb-3 rounded-md bg-bg-secondary px-3 py-2 text-xs text-text-secondary shadow-sm">{message}</div>}
      </div>
    </Dialog>
  )
}

function FilePane({
  index,
  pane,
  homeByLocation,
  locationOptions,
  disabled,
  busy,
  onPatch,
  onRefresh,
  onCopy,
  onMove,
  onDropPayload,
}: {
  index: number
  pane: PaneState
  homeByLocation: Record<string, string>
  locationOptions: Array<MenuSelectOption<string>>
  disabled: boolean
  busy: boolean
  onPatch: (patch: Partial<PaneState>) => void
  onRefresh: () => void
  onCopy: () => void
  onMove: () => void
  onDropPayload: (payload: DragPayload, move: boolean) => void
}) {
  const sorted = useMemo(() => [...pane.entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true })
  }), [pane.entries])
  const canAct = Boolean(pane.selected) && !busy && !disabled
  const locationValue = pane.origin === 'local' ? 'local' : pane.connectionId ?? ''
  return (
    <div
      className="surface-card flex min-h-0 flex-col overflow-visible rounded-md bg-bg-secondary"
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = event.altKey ? 'move' : 'copy'
      }}
      onDrop={(event) => {
        event.preventDefault()
        const raw = event.dataTransfer.getData('application/x-bioflow-file-transfer')
        if (!raw) return
        const payload = JSON.parse(raw) as DragPayload
        if (sameEndpoint(payload, pane) && pathDir(payload.path) === pane.cwd) return
        onDropPayload(payload, event.altKey)
      }}
    >
      <div className="flex items-center gap-2 overflow-visible border-b border-border-light px-2 py-2">
        <MenuSelect<string>
          value={locationValue}
          onChange={(value) => {
            const nextValue = value || 'local'
            const nextOrigin: PaneOrigin = nextValue === 'local' ? 'local' : 'ssh'
            const nextConnectionId = nextOrigin === 'ssh' ? nextValue : null
            const homeKey = nextOrigin === 'local' ? 'local' : nextConnectionId
            onPatch({
              origin: nextOrigin,
              connectionId: nextConnectionId,
              cwd: homeByLocation[homeKey ?? ''] || '/',
              entries: [],
              selected: null,
              error: null,
              nonce: pane.nonce + 1,
            })
          }}
          options={locationOptions}
          ariaLabel="Choose transfer side"
          className="w-32 shrink-0"
          buttonClassName="h-7 text-xs"
          menuClassName="w-56"
        />
        <input
          value={pane.cwd}
          disabled={disabled}
          onChange={(event) => onPatch({ cwd: event.target.value })}
          className="bioflow-field h-7 min-w-0 flex-1 rounded-md border border-border-light bg-bg-primary px-2 text-xs text-text-primary outline-none"
        />
        <Button variant="ghost" size="sm" disabled={disabled || !pane.cwd} onClick={() => onPatch({ cwd: pathDir(pane.cwd) || pane.cwd })}>
          <ChevronUp size={12} />
        </Button>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={onRefresh}>
          <RefreshCw size={12} className={pane.loading ? 'animate-spin' : ''} />
        </Button>
      </div>
      <div className="flex items-center gap-1 border-b border-border-light px-2 py-1.5">
        <Button variant="secondary" size="sm" disabled={!canAct} icon={<Copy size={12} />} onClick={onCopy}>Copy</Button>
        <Button variant="secondary" size="sm" disabled={!canAct} icon={<MoveRight size={12} />} onClick={onMove}>Move</Button>
        <div className="ml-auto text-[10px] text-text-muted">
          {index === 0 ? 'Left pane' : 'Right pane'} · {pane.origin === 'ssh' ? 'server' : 'local'}
        </div>
      </div>
      <div className="scroll-region min-h-0 flex-1">
        {disabled ? (
          <div className="p-4 text-xs text-text-muted">Connect to SSH to use the server pane.</div>
        ) : pane.loading ? (
          <div className="flex items-center gap-2 p-4 text-xs text-text-muted"><Loader2 size={13} className="animate-spin" />Loading...</div>
        ) : pane.error ? (
          <div className="p-4 text-xs text-error">{pane.error}</div>
        ) : sorted.length === 0 ? (
          <div className="p-4 text-xs text-text-muted">No files here.</div>
        ) : sorted.map((entry) => (
          <button
            key={entry.path}
            type="button"
            draggable
            onDragStart={(event) => {
              const payload: DragPayload = { origin: pane.origin, path: entry.path, name: entry.name, isDirectory: entry.isDirectory, paneIndex: index }
              payload.connectionId = pane.connectionId
              event.dataTransfer.setData('application/x-bioflow-file-transfer', JSON.stringify(payload))
              event.dataTransfer.effectAllowed = 'copyMove'
            }}
            onClick={() => onPatch({ selected: entry })}
            onDoubleClick={() => {
              if (entry.isDirectory) onPatch({ cwd: entry.path })
            }}
            className={classNames(
              'interactive-row flex w-full items-center gap-2 rounded-none px-3 py-2 text-left text-xs',
              pane.selected?.path === entry.path ? 'bg-accent/10 text-text-primary' : 'text-text-secondary hover:text-text-primary',
            )}
          >
            <FileGlyph entry={entry} size="split" selected={pane.selected?.path === entry.path} />
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            <span className="shrink-0 text-[10px] text-text-muted">{entry.isDirectory ? 'folder' : inferFileType(entry.name)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

interface TransferEndpoint {
  origin: PaneOrigin
  connectionId?: string | null
}

function emptyPane(origin: PaneOrigin, connectionId: string | null = null): PaneState {
  return { origin, connectionId: origin === 'ssh' ? connectionId : null, cwd: '', entries: [], selected: null, loading: false, error: null, nonce: 0 }
}

function paneUsable(pane: Pick<PaneState, 'origin' | 'connectionId'>, connections: ReturnType<typeof useConnectionStore.getState>['connections']): boolean {
  if (pane.origin === 'local') return true
  if (!pane.connectionId) return false
  return connections[pane.connectionId]?.status === 'connected'
}

function endpointFromPane(pane: Pick<PaneState, 'origin' | 'connectionId'>): TransferEndpoint {
  return { origin: pane.origin, connectionId: pane.connectionId }
}

function endpointFromPayload(payload: Pick<DragPayload, 'origin' | 'connectionId'>): TransferEndpoint {
  return { origin: payload.origin, connectionId: payload.connectionId ?? null }
}

function sameEndpoint(a: Pick<DragPayload, 'origin' | 'connectionId'>, b: Pick<PaneState, 'origin' | 'connectionId'>): boolean {
  if (a.origin !== b.origin) return false
  if (a.origin === 'local') return true
  return (a.connectionId ?? null) === (b.connectionId ?? null)
}

async function copyFile(from: TransferEndpoint, source: string, to: TransferEndpoint, destination: string): Promise<void> {
  if (from.origin === 'local' && to.origin === 'local') {
    await window.api.local.copy(source, destination)
    return
  }
  if (from.origin === 'ssh' && to.origin === 'ssh' && from.connectionId === to.connectionId) {
    await window.api.ssh.exec(requiredConnectionId(from), `cp ${shellQuote(source)} ${shellQuote(destination)}`)
    return
  }
  if (from.origin === 'local' && to.origin === 'ssh') {
    await window.api.sftp.upload(requiredConnectionId(to), source, destination)
    return
  }
  if (from.origin === 'ssh' && to.origin === 'local') {
    await window.api.sftp.download(requiredConnectionId(from), source, destination)
    return
  }

  const tmpPath = temporaryTransferPath(source)
  try {
    await window.api.sftp.download(requiredConnectionId(from), source, tmpPath)
    await window.api.sftp.upload(requiredConnectionId(to), tmpPath, destination)
  } finally {
    await window.api.local.delete(tmpPath).catch(() => undefined)
  }
}

async function copyDirectory(from: TransferEndpoint, source: string, to: TransferEndpoint, destination: string): Promise<void> {
  if (from.origin === 'ssh' && to.origin === 'ssh' && from.connectionId === to.connectionId) {
    await window.api.ssh.exec(requiredConnectionId(from), `cp -R ${shellQuote(source)} ${shellQuote(destination)}`)
    return
  }
  await mkdirForEndpoint(to, destination)
  const entries = from.origin === 'local'
    ? await window.api.local.ls(source)
    : await window.api.sftp.ls(requiredConnectionId(from), source)
  for (const entry of entries) {
    const targetPath = joinPath(destination, entry.name)
    if (entry.isDirectory) {
      await copyDirectory(from, entry.path, to, targetPath)
    } else {
      await copyFile(from, entry.path, to, targetPath)
    }
  }
}

async function mkdirForEndpoint(endpoint: TransferEndpoint, path: string): Promise<void> {
  if (endpoint.origin === 'local') await window.api.local.mkdir(path)
  else await window.api.sftp.mkdir(requiredConnectionId(endpoint), path).catch(() => undefined)
}

async function deleteEntry(endpoint: TransferEndpoint, path: string, isDirectory: boolean): Promise<void> {
  if (endpoint.origin === 'local') {
    if (isDirectory) await window.api.local.delete(path)
    else await window.api.local.delete(path)
  } else if (isDirectory) {
    await window.api.ssh.exec(requiredConnectionId(endpoint), `rm -rf -- ${shellQuote(path)}`)
  } else {
    await window.api.sftp.delete(requiredConnectionId(endpoint), path)
  }
}

function requiredConnectionId(endpoint: TransferEndpoint): string {
  if (!endpoint.connectionId) throw new Error('No server connection selected for this transfer pane.')
  return endpoint.connectionId
}

function pathDir(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  if (index <= 0) return '/'
  return trimmed.slice(0, index)
}

function joinPath(folder: string, name: string): string {
  return `${folder.replace(/\/+$/, '')}/${name}`
}

function temporaryTransferPath(source: string): string {
  const name = source.split('/').pop()?.replace(/[^A-Za-z0-9._-]/g, '_') || 'bioflow-transfer'
  return `/tmp/bioflow-transfer-${Date.now()}-${Math.random().toString(16).slice(2)}-${name}`
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_\-./~:]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function likelyLargeBioFile(name: string): boolean {
  return /\.(bed|bim|fam|pgen|pvar|psam|bgen|vcf\.gz|bcf|bam|cram)$/i.test(name)
}
