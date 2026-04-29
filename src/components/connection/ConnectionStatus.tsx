import { useState, useRef, useEffect, useCallback } from 'react'
import { useConnectionStore, LOCAL_CONNECTION_ID } from '@/stores/connectionStore'
import { ConnectionDialog } from './ConnectionDialog'
import { Wifi, WifiOff, ChevronDown, Settings, Server, Bug, RefreshCcw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useUIStore } from '@/stores/uiStore'
import { useClusterInfoStore } from '@/stores/clusterInfoStore'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import { useFileSizeStore } from '@/stores/fileSizeStore'
import { ConnectionLogDrawer } from './ConnectionLogDrawer'
import { ClusterDoctorDialog } from './ClusterDoctorDialog'

interface ConnectionStatusProps {
  /** When true, collapse to an icon-only pill (used in narrow TopBar widths). */
  compact?: boolean
}

export function ConnectionStatus({ compact = false }: ConnectionStatusProps = {}) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dialogOpen = useUIStore((s) => s.connectionDialogOpen)
  const setDialogOpen = (open: boolean) => {
    if (open) useUIStore.getState().openConnectionDialog()
    else useUIStore.getState().closeConnectionDialog()
  }
  const [slurmOpen, setSlurmOpen] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const [doctorOpen, setDoctorOpen] = useState(false)
  const [cacheRefreshing, setCacheRefreshing] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const { connections, activeConnectionId, disconnect, connectLocal } = useConnectionStore()
  const clearClusterInfo = useClusterInfoStore((s) => s.clearConnection)
  const clearSchemas = useDataPreviewStore((s) => s.clearSchemas)
  const clearFileSizes = useFileSizeStore((s) => s.clear)
  const activeEntry = activeConnectionId ? connections[activeConnectionId] : null
  const status = activeEntry?.status ?? 'disconnected'
  const isLocal = activeConnectionId === LOCAL_CONNECTION_ID

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [dropdownOpen])

  const dotColor = (() => {
    switch (status) {
      case 'connected':
        return 'bg-success'
      case 'connecting':
      case 'reconnecting':
        return 'bg-warning'
      case 'error':
        return 'bg-error'
      default:
        return 'bg-text-muted'
    }
  })()

  const isAnimated = status === 'connecting' || status === 'reconnecting'

  function handleClick() {
    if (status === 'connected') {
      setDropdownOpen((prev) => !prev)
    } else if (status === 'disconnected' || status === 'error') {
      setDialogOpen(true)
    }
  }

  function handleDisconnect() {
    if (activeConnectionId) {
      disconnect(activeConnectionId)
      setDropdownOpen(false)
    }
  }

  const handleRefreshClusterCaches = useCallback(async () => {
    if (!activeConnectionId || isLocal) return
    setCacheRefreshing(true)
    try {
      await window.api.cluster.clearCaches(activeConnectionId)
      clearClusterInfo(activeConnectionId)
      clearFileSizes(activeConnectionId)
      clearSchemas()
      await Promise.allSettled([
        useClusterInfoStore.getState().loadAccounts(activeConnectionId, { force: true }),
        useClusterInfoStore.getState().loadModules(activeConnectionId, undefined, { force: true }),
      ])
    } finally {
      setCacheRefreshing(false)
    }
  }, [activeConnectionId, clearClusterInfo, clearFileSizes, clearSchemas, isLocal])

  return (
    <>
      <div className="relative flex items-center" ref={dropdownRef}>
        <button
          onClick={handleClick}
          className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-bg-hover transition-colors text-sm min-w-0"
          title={
            status === 'connected' && activeEntry
              ? `${activeEntry.config.name} (${activeEntry.config.username}@${activeEntry.config.host})`
              : undefined
          }
        >
          <span className="relative flex items-center shrink-0">
            <span
              className={`w-2 h-2 rounded-full ${dotColor} ${isAnimated ? 'animate-pulse' : ''}`}
            />
          </span>

          {status === 'connected' && activeEntry && (
            <>
              {compact ? (
                <>
                  <span className="text-text-primary text-xs font-mono truncate max-w-[120px]">
                    {activeEntry.config.name}
                  </span>
                  <ChevronDown size={12} className="text-text-muted shrink-0" />
                </>
              ) : (
                <>
                  <span className="text-text-primary truncate">
                    {activeEntry.config.name}
                  </span>
                  <span className="text-text-muted truncate">
                    ({activeEntry.config.username}@{activeEntry.config.host})
                  </span>
                  <ChevronDown size={14} className="text-text-muted shrink-0" />
                </>
              )}
            </>
          )}

          {status === 'connecting' && (
            <span className="text-text-secondary">{compact ? '...' : 'Connecting...'}</span>
          )}

          {status === 'reconnecting' && (
            <span className="text-text-secondary">{compact ? '...' : 'Reconnecting...'}</span>
          )}

          {status === 'error' && (
            <span className="text-error">{compact ? 'Err' : 'Connection error'}</span>
          )}

          {status === 'disconnected' && !compact && (
            <span className="text-text-muted">Not connected</span>
          )}
        </button>

        {/* Disconnected/Error: show Connect + Local buttons. In compact mode
            collapse the labels to icons to save space. */}
        {(status === 'disconnected' || status === 'error') && (
          <>
            <Button
              variant="ghost"
              size="sm"
              icon={<Wifi size={14} />}
              onClick={() => setDialogOpen(true)}
              className="ml-1 shrink-0"
              title="Connect"
            >
              {!compact && 'Connect'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => connectLocal()}
              className="ml-1 shrink-0"
              title="Use local filesystem"
            >
              {compact ? <Server size={14} /> : 'Local'}
            </Button>
          </>
        )}

        {/* Dropdown when connected */}
        {dropdownOpen && status === 'connected' && activeEntry && (
          <div className="absolute right-0 top-full mt-1 w-72 bg-bg-secondary border border-border rounded-lg shadow-lg z-50">
            <div className="px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                <Wifi size={14} className="text-success" />
                {activeEntry.config.name}
              </div>
              <div className="mt-1 text-xs text-text-muted">
                {activeEntry.config.username}@{activeEntry.config.host}:{activeEntry.config.port}
              </div>
              {activeEntry.config.defaultDirectory && (
                <div className="mt-0.5 text-xs text-text-muted">
                  {activeEntry.config.defaultDirectory}
                </div>
              )}
              {activeEntry.connectedAt && (
                <div className="mt-0.5 text-xs text-text-muted">
                  Connected {formatUptime(Date.now() - activeEntry.connectedAt)}
                </div>
              )}
              {activeEntry.reused && (
                <div className="mt-1 text-[11px] text-accent">
                  Reused existing session
                </div>
              )}
              {!isLocal && (
                <div className="mt-2 rounded border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
                  Keep heavy work on Slurm. Login-node actions are for setup, downloads, and quick checks only.
                </div>
              )}
            </div>
            <div className="p-2 flex flex-col gap-1">
              {!isLocal && (
                <button
                  onClick={() => setDoctorOpen(true)}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-hover rounded transition-colors"
                >
                  <Server size={14} />
                  Cluster doctor
                </button>
              )}
              {!isLocal && (
                <button
                  onClick={() => void handleRefreshClusterCaches()}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-hover rounded transition-colors"
                >
                  <RefreshCcw size={14} className={cacheRefreshing ? 'animate-spin' : ''} />
                  Refresh cached cluster info
                </button>
              )}
              {!isLocal && (
                <button
                  onClick={() => setLogOpen(true)}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-hover rounded transition-colors"
                >
                  <Bug size={14} />
                  SSH diagnostic log
                </button>
              )}
              {!isLocal && (
                <button
                  onClick={() => setSlurmOpen((v) => !v)}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-hover rounded transition-colors"
                >
                  <Server size={14} />
                  Slurm Settings
                  <ChevronDown
                    size={12}
                    className={`ml-auto transition-transform ${slurmOpen ? 'rotate-180' : ''}`}
                  />
                </button>
              )}
              {!isLocal && slurmOpen && activeConnectionId && (
                <SlurmSettings connectionId={activeConnectionId} />
              )}
              <button
                onClick={() => {
                  setDropdownOpen(false)
                  setDialogOpen(true)
                }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-hover rounded transition-colors"
              >
                <Settings size={14} />
                Connection Settings
              </button>
              <button
                onClick={handleDisconnect}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-error hover:bg-error/10 rounded transition-colors"
              >
                <WifiOff size={14} />
                Disconnect
              </button>
            </div>
          </div>
        )}
      </div>

      <ConnectionDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      <ConnectionLogDrawer open={logOpen} onClose={() => setLogOpen(false)} connectionId={activeConnectionId} />
      <ClusterDoctorDialog open={doctorOpen} onClose={() => setDoctorOpen(false)} connectionId={activeConnectionId} />
    </>
  )
}

/**
 * Per-connection Slurm settings. Writes directly to electron-store under
 * `connection:<id>:slurmAccount` / `slurmPartition` — those are the exact
 * keys PipelineRunner.loadConnectionDefaults() reads at run submission time.
 */
function SlurmSettings({ connectionId }: { connectionId: string }) {
  const [account, setAccount] = useState('')
  const [partition, setPartition] = useState('')
  const [analysisFolder, setAnalysisFolder] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const accountInfo = useClusterInfoStore((s) => s.accountsByConnection[connectionId])
  const accountsLoading = useClusterInfoStore((s) => s.loadingAccounts[connectionId])
  const accountError = useClusterInfoStore((s) => s.errorByConnection[connectionId])
  const loadAccounts = useClusterInfoStore((s) => s.loadAccounts)

  // Load current values once.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [a, p, f] = await Promise.all([
        window.api.store.get<string>(`connection:${connectionId}:slurmAccount`),
        window.api.store.get<string>(`connection:${connectionId}:slurmPartition`),
        window.api.store.get<string>(`connection:${connectionId}:defaultAnalysisFolder`),
      ])
      if (cancelled) return
      setAccount(a ?? '')
      setPartition(p ?? '')
      setAnalysisFolder(f ?? '')
      setLoaded(true)
      void loadAccounts(connectionId).then((result) => {
        if (!cancelled && !a && result.accounts.length === 1) setAccount(result.accounts[0])
      }).catch(() => undefined)
    })()
    return () => { cancelled = true }
  }, [connectionId, loadAccounts])

  const save = useCallback(async () => {
    // electron-store rejects undefined ("Use delete() to clear values"), so we
    // always write a string. Empty string is treated as "not set" by the
    // runner (which trims and checks truthiness).
    try {
      await Promise.all([
        window.api.store.set(`connection:${connectionId}:slurmAccount`, account.trim()),
        window.api.store.set(`connection:${connectionId}:slurmPartition`, partition.trim()),
        window.api.store.set(`connection:${connectionId}:defaultAnalysisFolder`, analysisFolder.trim()),
      ])
      setSaveMsg('Saved')
    } catch (err: any) {
      console.error('Slurm settings save failed:', err)
      setSaveMsg(`Error: ${err?.message ?? err}`)
    }
    setTimeout(() => setSaveMsg(null), 2500)
  }, [connectionId, account, partition, analysisFolder])

  if (!loaded) {
    return (
      <div className="px-3 py-2 text-xs text-text-muted">Loading...</div>
    )
  }

  return (
    <div className="px-3 py-2 flex flex-col gap-2 border border-border rounded bg-bg-tertiary/40">
      <div className="flex flex-col gap-1">
        <label className="text-text-secondary text-xs font-medium">Slurm account</label>
        <div className="flex items-center gap-1.5">
          <input
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder="rrg-xxxx"
            list={`slurm-accounts-${connectionId}`}
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-bg-secondary px-2 text-sm text-text-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            className="h-8 rounded-md border border-border bg-bg-secondary px-2 text-text-muted hover:bg-bg-hover hover:text-text-primary"
            title="Refresh Slurm accounts"
            onClick={() => void loadAccounts(connectionId, { force: true })}
          >
            <RefreshCcw size={13} className={accountsLoading ? 'animate-spin' : ''} />
          </button>
        </div>
        <datalist id={`slurm-accounts-${connectionId}`}>
          {(accountInfo?.accounts ?? []).map((candidate) => (
            <option key={candidate} value={candidate} />
          ))}
        </datalist>
        <div className="text-[10px] text-text-muted">
          {accountsLoading
            ? 'Looking up accounts...'
            : accountInfo
              ? `Source: ${accountInfo.source}${accountInfo.accounts.length ? ` · ${accountInfo.accounts.length} account${accountInfo.accounts.length === 1 ? '' : 's'}` : ''}`
              : 'Free text is still allowed if discovery is unavailable.'}
          {accountError ? ` Discovery failed: ${accountError}` : ''}
        </div>
      </div>
      <Input
        label="Default partition"
        value={partition}
        onChange={(e) => setPartition(e.target.value)}
        placeholder="(optional)"
      />
      <div className="flex flex-col gap-1">
        <label className="text-text-secondary text-xs font-medium">Default analysis folder</label>
        <div className="flex items-end gap-1.5">
          <Input
            value={analysisFolder}
            onChange={(e) => setAnalysisFolder(e.target.value)}
            placeholder="(optional, e.g. /scratch/username/bioflow)"
            className="flex-1"
          />
          <Button
            variant="secondary"
            size="sm"
            className="h-8 px-2 shrink-0"
            title="Browse folders in the sidebar"
            onClick={() =>
              useUIStore.getState().startFilePick({
                target: 'directory',
                requesterLabel: 'Default analysis folder',
                onResolve: ({ path }) => setAnalysisFolder(path),
              })
            }
          >
            Browse
          </Button>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-1">
        <Button variant="primary" size="sm" onClick={save} className="h-7 px-3 text-xs">
          Save
        </Button>
        {saveMsg && (
          <span className="text-[10px] text-accent animate-pulse">{saveMsg}</span>
        )}
      </div>
      <p className="text-[10px] text-text-muted leading-relaxed">
        Required before running pipelines. Used for the <code className="font-mono">--account</code>
        {' '}and <code className="font-mono">--partition</code> Slurm headers.
      </p>
    </div>
  )
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h ago`
}
