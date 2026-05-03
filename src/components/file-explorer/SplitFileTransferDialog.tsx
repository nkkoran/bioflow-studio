import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronUp, Copy, Loader2, MoveRight, PanelsLeftRight, RefreshCw, Upload } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { MenuSelect } from '@/components/ui/MenuSelect'
import { LOCAL_CONNECTION_ID, useConnectionStore } from '@/stores/connectionStore'
import { useDialogStore } from '@/stores/dialogStore'
import type { RemoteFileEntry } from '@/types/files'
import { inferFileType } from '@/lib/fileTypeInference'
import { FileGlyph } from './FileGlyph'
import { classNames } from '@/lib/utils'

type PaneOrigin = 'local' | 'ssh'

interface InitialPane {
  origin: PaneOrigin
  cwd?: string
}

interface PaneState {
  origin: PaneOrigin
  cwd: string
  entries: RemoteFileEntry[]
  selected: RemoteFileEntry | null
  loading: boolean
  error: string | null
  nonce: number
}

interface DragPayload {
  origin: PaneOrigin
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
  const confirmDialog = useDialogStore((s) => s.confirm)
  const canUseSsh = Boolean(activeConnectionId && activeConnectionId !== LOCAL_CONNECTION_ID)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [homeByOrigin, setHomeByOrigin] = useState<Record<PaneOrigin, string>>({ local: '/', ssh: '/' })
  const [panes, setPanes] = useState<[PaneState, PaneState]>(() => [
    emptyPane('local'),
    emptyPane('ssh'),
  ])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function init() {
      const localHome = await window.api.local.homedir().catch(() => '/')
      const sshHome = canUseSsh && activeConnectionId
        ? (await window.api.ssh.exec(activeConnectionId, 'printf %s "$HOME"').catch(() => ({ stdout: '' }))).stdout.trim()
        : ''
      if (cancelled) return
      setHomeByOrigin({ local: localHome || '/', ssh: sshHome || '/' })
      const fallbackByOrigin: Record<PaneOrigin, string> = { local: localHome || '/', ssh: sshHome || '/' }
      const left = initialPanes?.[0] ?? { origin: 'local' as const }
      const right = initialPanes?.[1] ?? { origin: 'ssh' as const }
      setPanes([
        { ...emptyPane(left.origin), cwd: left.cwd?.trim() || fallbackByOrigin[left.origin] || '/' },
        { ...emptyPane(right.origin), cwd: right.cwd?.trim() || fallbackByOrigin[right.origin] || '/' },
      ])
    }
    void init()
    return () => { cancelled = true }
  }, [activeConnectionId, canUseSsh, initialPanes, open])

  useEffect(() => {
    if (!open) return
    panes.forEach((pane, index) => {
      if (!pane.cwd) return
      if (pane.origin === 'ssh' && !canUseSsh) return
      void loadPane(index)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, panes[0].cwd, panes[0].origin, panes[0].nonce, panes[1].cwd, panes[1].origin, panes[1].nonce, canUseSsh])

  const updatePane = useCallback((index: number, patch: Partial<PaneState>) => {
    setPanes((current) => {
      const next = [...current] as [PaneState, PaneState]
      next[index] = { ...next[index], ...patch }
      return next
    })
  }, [])

  const loadPane = useCallback(async (index: number) => {
    const pane = panes[index]
    if (pane.origin === 'ssh' && !canUseSsh) {
      updatePane(index, { entries: [], loading: false, error: 'Connect to SSH before browsing remote files.' })
      return
    }
    updatePane(index, { loading: true, error: null })
    try {
      const entries = pane.origin === 'local'
        ? await window.api.local.ls(pane.cwd)
        : await window.api.sftp.ls(activeConnectionId!, pane.cwd)
      updatePane(index, { entries, loading: false, selected: null })
    } catch (err) {
      updatePane(index, { entries: [], loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  }, [activeConnectionId, canUseSsh, panes, updatePane])

  const refreshPane = (index: number) => updatePane(index, { nonce: panes[index].nonce + 1 })
  const other = (index: number) => index === 0 ? 1 : 0

  const selectedMove = async (fromIndex: number, move: boolean) => {
    const source = panes[fromIndex]
    const entry = source.selected
    if (!entry) return
    await transferEntry({ origin: source.origin, path: entry.path, name: entry.name, isDirectory: entry.isDirectory }, fromIndex, other(fromIndex), move)
  }

  const transferEntry = async (payload: DragPayload, fromIndex: number, toIndex: number, move: boolean) => {
    const target = panes[toIndex]
    if (target.origin === 'ssh' && !canUseSsh) {
      setMessage('Connect to SSH before transferring to the server pane.')
      return
    }
    if (payload.origin === target.origin && pathDir(payload.path) === target.cwd) {
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
        await copyDirectory(payload.origin, payload.path, target.origin, destination, activeConnectionId)
      } else {
        await copyFile(payload.origin, payload.path, target.origin, destination, activeConnectionId)
      }
      if (move) await deleteEntry(payload.origin, payload.path, payload.isDirectory, activeConnectionId)
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
              homeByOrigin={homeByOrigin}
              disabled={panes[index].origin === 'ssh' && !canUseSsh}
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
  homeByOrigin,
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
  homeByOrigin: Record<PaneOrigin, string>
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
  return (
    <div
      className="surface-card flex min-h-0 flex-col rounded-md bg-bg-secondary"
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = event.altKey ? 'move' : 'copy'
      }}
      onDrop={(event) => {
        event.preventDefault()
        const raw = event.dataTransfer.getData('application/x-bioflow-file-transfer')
        if (!raw) return
        const payload = JSON.parse(raw) as DragPayload
        if (payload.origin === pane.origin && pathDir(payload.path) === pane.cwd) return
        onDropPayload(payload, event.altKey)
      }}
    >
      <div className="flex items-center gap-2 border-b border-border-light px-2 py-2">
        <MenuSelect<PaneOrigin>
          value={pane.origin}
          onChange={(value) => {
            const nextOrigin = value || 'local'
            onPatch({ origin: nextOrigin, cwd: homeByOrigin[nextOrigin] || '/', entries: [], selected: null, nonce: pane.nonce + 1 })
          }}
          options={[
            { value: 'local', label: 'Local' },
            { value: 'ssh', label: 'Server' },
          ]}
          ariaLabel="Choose transfer side"
          className="w-24 shrink-0"
          buttonClassName="h-7 text-xs"
          menuClassName="w-28"
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
      <div className="min-h-0 flex-1 overflow-y-auto">
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

function emptyPane(origin: PaneOrigin): PaneState {
  return { origin, cwd: '', entries: [], selected: null, loading: false, error: null, nonce: 0 }
}

async function copyFile(from: PaneOrigin, source: string, to: PaneOrigin, destination: string, connectionId: string | null | undefined): Promise<void> {
  if (from === 'local' && to === 'local') {
    await window.api.local.copy(source, destination)
    return
  }
  if (from === 'ssh' && to === 'ssh') {
    await window.api.ssh.exec(connectionId!, `cp ${shellQuote(source)} ${shellQuote(destination)}`)
    return
  }
  if (from === 'local' && to === 'ssh') {
    await window.api.sftp.upload(connectionId!, source, destination)
    return
  }
  await window.api.sftp.download(connectionId!, source, destination)
}

async function copyDirectory(from: PaneOrigin, source: string, to: PaneOrigin, destination: string, connectionId: string | null | undefined): Promise<void> {
  if (from === 'ssh' && to === 'ssh') {
    await window.api.ssh.exec(connectionId!, `cp -R ${shellQuote(source)} ${shellQuote(destination)}`)
    return
  }
  await mkdirForOrigin(to, destination, connectionId)
  const entries = from === 'local'
    ? await window.api.local.ls(source)
    : await window.api.sftp.ls(connectionId!, source)
  for (const entry of entries) {
    const targetPath = joinPath(destination, entry.name)
    if (entry.isDirectory) {
      await copyDirectory(from, entry.path, to, targetPath, connectionId)
    } else {
      await copyFile(from, entry.path, to, targetPath, connectionId)
    }
  }
}

async function mkdirForOrigin(origin: PaneOrigin, path: string, connectionId: string | null | undefined): Promise<void> {
  if (origin === 'local') await window.api.local.mkdir(path)
  else await window.api.sftp.mkdir(connectionId!, path).catch(() => undefined)
}

async function deleteEntry(origin: PaneOrigin, path: string, isDirectory: boolean, connectionId: string | null | undefined): Promise<void> {
  if (origin === 'local') {
    if (isDirectory) await window.api.local.delete(path)
    else await window.api.local.delete(path)
  } else if (isDirectory) {
    await window.api.ssh.exec(connectionId!, `rm -rf -- ${shellQuote(path)}`)
  } else {
    await window.api.sftp.delete(connectionId!, path)
  }
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

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_\-./~:]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function likelyLargeBioFile(name: string): boolean {
  return /\.(bed|bim|fam|pgen|pvar|psam|bgen|vcf\.gz|bcf|bam|cram)$/i.test(name)
}
