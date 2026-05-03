import { useState, useEffect, useMemo } from 'react'
import { useConnectionStore } from '@/stores/connectionStore'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { LocalPathField } from '@/components/file-browser/LocalPathField'
import { RemotePathField } from '@/components/file-browser/RemotePathField'
import { connectionConfigSchema } from '@/lib/validators'
import { useSettingsStore } from '@/stores/settingsStore'
import { Server, Lock, User, Eye, EyeOff, Loader2, FolderOpen, Sparkles, Copy, KeyRound, ChevronRight } from 'lucide-react'
import type { ConnectionConfig } from '@/types'
import type { SshDebugEvent, SshKeySetupResult } from '@/types/ssh'
import type { ZodError } from 'zod'
import { classNames } from '@/lib/utils'

interface ConnectionDialogProps {
  open: boolean
  onClose: () => void
}

type AuthMethod = 'key' | 'password' | 'agent'

interface FormData {
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  privateKeyPath: string
  passphrase: string
  password: string
  rememberPassword: boolean
  alias: string
  writeConfig: boolean
  controlPersistHours: number
  serverAliveIntervalSeconds: number
  defaultDirectory: string
}

interface ExistingSetupKey {
  keyPath: string
  publicKeyPath: string
  privateExists: boolean
  publicExists: boolean
}

const initialFormData: FormData = {
  name: '',
  host: '',
  port: 22,
  username: '',
  authMethod: 'key',
  privateKeyPath: '',
  passphrase: '',
  password: '',
  rememberPassword: false,
  alias: '',
  writeConfig: true,
  controlPersistHours: 8,
  serverAliveIntervalSeconds: 60,
  defaultDirectory: '',
}

// Saved connections stored locally for quick access
const STORAGE_KEY = 'bioflow-saved-connections'

function slugifyKeySegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'host'
}

function loadSavedConnectionsFallback(): ConnectionConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

async function loadSavedConnections(): Promise<ConnectionConfig[]> {
  try {
    const stored = await window.api.store.get<ConnectionConfig[]>(STORAGE_KEY)
    if (Array.isArray(stored)) return stored
  } catch {
    // Fall through to the legacy localStorage value.
  }
  const fallback = loadSavedConnectionsFallback()
  if (fallback.length > 0) {
    await window.api.store.set(STORAGE_KEY, fallback).catch(() => undefined)
  }
  return fallback
}

function connectionSecretKey(config: Pick<ConnectionConfig, 'host' | 'port' | 'username'>): string {
  return `connection-secret:${config.username}@${config.host}:${config.port}`
}

async function hydrateRememberedPasswords(configs: ConnectionConfig[]): Promise<ConnectionConfig[]> {
  return Promise.all(configs.map(async (config) => {
    if (!config.rememberPassword) return config
    const password = await window.api.store.getSecret(connectionSecretKey(config))
    return { ...config, password }
  }))
}

async function saveConnection(config: ConnectionConfig) {
  const existing = await loadSavedConnections()
  const filtered = existing.filter((c) => c.name !== config.name)
  if (config.authMethod === 'password' && config.rememberPassword && config.password) {
    await window.api.store.setSecret(connectionSecretKey(config), config.password)
  } else {
    await window.api.store.deleteSecret(connectionSecretKey(config))
  }
  // Strip password/passphrase before saving; password persistence is explicit.
  const { password: _pw, passphrase: _pp, ...safe } = config
  const next = [safe as ConnectionConfig, ...filtered].slice(0, 10)
  await window.api.store.set(STORAGE_KEY, next)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // App store is the source of truth; localStorage is only a migration fallback.
  }
}

export function ConnectionDialog({ open, onClose }: ConnectionDialogProps) {
  const [form, setForm] = useState<FormData>(initialFormData)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [connectError, setConnectError] = useState<string | null>(null)
  const [connectionEvents, setConnectionEvents] = useState<SshDebugEvent[]>([])
  const [isConnecting, setIsConnecting] = useState(false)
  const [connectSucceeded, setConnectSucceeded] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [savedConnections, setSavedConnections] = useState<ConnectionConfig[]>([])
  const [setupOpen, setSetupOpen] = useState(false)
  const [setupPassword, setSetupPassword] = useState('')
  const [setupRunning, setSetupRunning] = useState(false)
  const [setupMessage, setSetupMessage] = useState<string | null>(null)
  const [setupAddAgent, setSetupAddAgent] = useState(true)
  const [setupAddKeychain, setSetupAddKeychain] = useState(true)
  const [setupOverwrite, setSetupOverwrite] = useState(false)
  const [setupExistingKey, setSetupExistingKey] = useState<ExistingSetupKey | null>(null)
  const [setupResult, setSetupResult] = useState<SshKeySetupResult | null>(null)
  const [setupCopied, setSetupCopied] = useState<'public-key' | 'key-path' | null>(null)

  const { connect, connectLocal } = useConnectionStore()
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const loadSettings = useSettingsStore((s) => s.load)
  const useOpenSshControlPersist = useSettingsStore((s) => s.settings.useOpenSshControlPersist)
  const selectedTransport: NonNullable<ConnectionConfig['transport']> = useOpenSshControlPersist ? 'openssh-controlpersist' : 'ssh2'
  const setupReady = useMemo(
    () => Boolean(form.host.trim() && form.username.trim() && form.port > 0),
    [form.host, form.port, form.username],
  )
  const defaultAlias = useMemo(() => {
    const preferred = form.alias.trim() || form.name.trim() || form.host.trim().split('.')[0] || form.username.trim()
    return preferred.replace(/\s+/g, '-').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'bioflow'
  }, [form.alias, form.host, form.name, form.username])

  useEffect(() => {
    if (open) {
      if (!settingsLoaded) void loadSettings().catch(() => undefined)
      void loadSavedConnections().then(hydrateRememberedPasswords).then(setSavedConnections).catch(() => {
        void hydrateRememberedPasswords(loadSavedConnectionsFallback()).then(setSavedConnections)
      })
      setErrors({})
      setConnectError(null)
      setConnectionEvents([])
      setIsConnecting(false)
      setConnectSucceeded(false)
      setShowPassword(false)
      setSetupOpen(false)
      setSetupPassword('')
      setSetupRunning(false)
      setSetupMessage(null)
      setSetupExistingKey(null)
      setSetupResult(null)
      setSetupCopied(null)
    }
  }, [loadSettings, open, settingsLoaded])

  useEffect(() => {
    if (!open || !setupReady) {
      setSetupExistingKey(null)
      return
    }

    let cancelled = false
    async function checkExistingKey() {
      try {
        const home = await window.api.local.homedir()
        const keyPath = `${home}/.ssh/bioflow_${slugifyKeySegment(form.host.trim())}_${slugifyKeySegment(form.username.trim())}`
        const publicKeyPath = `${keyPath}.pub`
        const rows = await window.api.local.statMany([keyPath, publicKeyPath])
        if (cancelled) return
        const privateExists = Boolean(rows.find((row) => row.path === keyPath)?.ok)
        const publicExists = Boolean(rows.find((row) => row.path === publicKeyPath)?.ok)
        setSetupExistingKey(privateExists || publicExists ? { keyPath, publicKeyPath, privateExists, publicExists } : null)
      } catch {
        if (!cancelled) setSetupExistingKey(null)
      }
    }

    void checkExistingKey()
    return () => {
      cancelled = true
    }
  }, [form.host, form.username, open, setupReady])

  useEffect(() => {
    if (!open || !window.api.ssh.onDebug) return
    return window.api.ssh.onDebug((event) => {
      setConnectionEvents((prev) => [...prev, event].slice(-12))
    })
  }, [open])

  function updateField<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
    setErrors((prev) => {
      const { [key]: _, ...rest } = prev
      return rest
    })
    setConnectError(null)
  }

  async function copySetupText(value: string, kind: 'public-key' | 'key-path') {
    if (!value) return
    await navigator.clipboard.writeText(value)
    setSetupCopied(kind)
    window.setTimeout(() => setSetupCopied(null), 1600)
  }

  async function useExistingSetupKey() {
    if (!setupExistingKey?.privateExists) return
    let publicKey = ''
    if (setupExistingKey.publicExists) {
      publicKey = await window.api.local.read(setupExistingKey.publicKeyPath).then((value) => value.trim()).catch(() => '')
    }
    const existingResult: SshKeySetupResult = {
      keyPath: setupExistingKey.keyPath,
      publicKeyPath: setupExistingKey.publicKeyPath,
      publicKey,
      agentAdded: false,
      keychainAdded: false,
      alias: defaultAlias,
      note: `Using existing BioFlow key at ${setupExistingKey.keyPath}.`,
    }
    setForm((prev) => ({
      ...prev,
      authMethod: 'key',
      privateKeyPath: setupExistingKey.keyPath,
      passphrase: '',
      alias: defaultAlias || prev.alias,
    }))
    setSetupResult(existingResult)
    setSetupMessage(existingResult.note ?? null)
    setSetupOpen(false)
  }

  function fillFromSaved(config: ConnectionConfig) {
    setForm({
      name: config.name,
      host: config.host,
      port: config.port,
      username: config.username,
      authMethod: config.authMethod,
      privateKeyPath: config.privateKeyPath ?? '',
      passphrase: config.passphrase ?? '',
      password: config.password ?? '',
      rememberPassword: Boolean(config.rememberPassword),
      alias: config.alias ?? '',
      writeConfig: config.writeConfig ?? true,
      controlPersistHours: config.controlPersistHours ?? 8,
      serverAliveIntervalSeconds: config.serverAliveIntervalSeconds ?? 60,
      defaultDirectory: config.defaultDirectory ?? '',
    })
    setErrors({})
    setConnectError(null)
  }

  async function handleConnect() {
    if (isConnecting || connectSucceeded) return
    setErrors({})
    setConnectError(null)
    setConnectionEvents([])
    setConnectSucceeded(false)

    const config: ConnectionConfig = {
      name: form.name.trim() || defaultAlias,
      host: form.host.trim(),
      port: form.port,
      username: form.username.trim(),
      authMethod: form.authMethod,
      transport: selectedTransport,
      ...(form.authMethod === 'key' && {
        privateKeyPath: form.privateKeyPath.trim(),
        passphrase: form.passphrase || undefined,
      }),
      ...(form.authMethod === 'password' && { password: form.password }),
      ...(form.authMethod === 'password' && { rememberPassword: form.rememberPassword }),
      ...(form.authMethod === 'key' && form.privateKeyPath.trim() && { generatedKeyPath: form.privateKeyPath.trim() }),
      ...(defaultAlias && { alias: defaultAlias }),
      ...((form.writeConfig || selectedTransport === 'openssh-controlpersist') ? { writeConfig: true } : {}),
      ...(form.controlPersistHours > 0 ? { controlPersistHours: form.controlPersistHours } : {}),
      ...(form.serverAliveIntervalSeconds > 0 ? { serverAliveIntervalSeconds: form.serverAliveIntervalSeconds } : {}),
      ...(form.defaultDirectory.trim() && { defaultDirectory: form.defaultDirectory.trim() }),
    }

    const result = connectionConfigSchema.safeParse(config)
    if (!result.success) {
      const fieldErrors: Record<string, string> = {}
      for (const issue of (result.error as ZodError).issues) {
        const path = issue.path.join('.')
        if (path) {
          fieldErrors[path] = issue.message
        } else {
          setConnectError(issue.message)
        }
      }
      setErrors(fieldErrors)
      return
    }

    setIsConnecting(true)
    try {
      await connect(config)
      await saveConnection(config)
      setConnectSucceeded(true)
      await new Promise((resolve) => window.setTimeout(resolve, 500))
      onClose()
      setForm(initialFormData)
    } catch (err) {
      setConnectError(userFacingConnectionError(err))
    } finally {
      setIsConnecting(false)
    }
  }

  const authMethods: { value: AuthMethod; label: string }[] = [
    { value: 'key', label: 'SSH key' },
    { value: 'password', label: 'Password' },
    { value: 'agent', label: 'SSH agent' },
  ]
  const activeSavedName = savedConnections.some((conn) => conn.name === form.name) ? form.name : ''

  async function handleSetupKey() {
    if (!setupReady) return
    if (!setupPassword.trim()) {
      setSetupMessage('Enter the current account password to install the generated key.')
      return
    }
    setSetupRunning(true)
    setSetupMessage('Generating key and installing it on the remote host...')
    try {
      const result = await window.api.ssh.setupKey({
        host: form.host.trim(),
        port: form.port,
        username: form.username.trim(),
        password: setupPassword,
        comment: `bioflow_${form.username.trim()}@${form.host.trim()}`,
        overwrite: setupOverwrite,
        addToAgent: setupAddAgent,
        addToKeychain: setupAddKeychain,
        alias: defaultAlias,
        writeConfig: form.writeConfig,
        controlPersistHours: form.controlPersistHours,
        serverAliveIntervalSeconds: form.serverAliveIntervalSeconds,
      })
      setForm((prev) => ({
        ...prev,
        authMethod: 'key',
        privateKeyPath: result.keyPath,
        passphrase: '',
        alias: result.alias ?? prev.alias,
      }))
      setSetupResult(result)
      setSetupMessage(result.note ?? `Key installed at ${result.keyPath}`)
      setSetupOpen(false)
    } catch (err) {
      setSetupMessage(err instanceof Error ? err.message : 'Key setup failed')
    } finally {
      setSetupRunning(false)
      setSetupPassword('')
    }
  }

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={isConnecting || connectSucceeded}>
        Cancel
      </Button>
      <Button
        variant="primary"
        onClick={handleConnect}
        disabled={isConnecting}
        className={classNames(
          'min-w-[8rem] flex-1',
          connectSucceeded && 'bg-success hover:bg-success',
        )}
      >
        {isConnecting ? (
          <span className="inline-flex min-w-[6rem] items-center justify-center gap-1.5">
            <Loader2 size={14} className="animate-spin" />
            Connecting
          </span>
        ) : connectSucceeded ? (
          <span className="inline-flex min-w-[6rem] items-center justify-center">Connected</span>
        ) : (
          <span className="inline-flex min-w-[6rem] items-center justify-center">Connect</span>
        )}
      </Button>
    </>
  )

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect to cluster"
      subtitle="SSH connection"
      icon={<Server size={20} />}
      footer={footer}
    >
      <div className="flex flex-col gap-3">
        {savedConnections.length > 0 && (
          <div className="rounded-md bg-bg-secondary/80 p-3 shadow-sm">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
              Saved presets
            </div>
            <div className="grid max-h-40 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setForm(initialFormData)}
                className={classNames(
                  'interactive-row flex min-h-14 min-w-0 flex-col items-start justify-center px-3 py-2 text-left shadow-sm',
                  !activeSavedName ? 'bg-accent/10 text-text-primary' : 'bg-bg-tertiary/70 text-text-secondary hover:text-text-primary',
                )}
              >
                <span className="text-nowrap text-xs font-medium">New connection</span>
                <span className="text-nowrap mt-0.5 text-xs text-text-muted">Start blank</span>
              </button>
              {savedConnections.map((conn) => (
                <button
                  key={conn.name}
                  type="button"
                  onClick={() => fillFromSaved(conn)}
                  className={classNames(
                    'interactive-row flex min-h-14 min-w-0 flex-col items-start justify-center px-3 py-2 text-left shadow-sm',
                    activeSavedName === conn.name ? 'bg-accent/10 text-text-primary' : 'bg-bg-tertiary/70 text-text-secondary hover:text-text-primary',
                  )}
                >
                  <span className="text-nowrap max-w-full text-xs font-medium">{conn.name}</span>
                  <span className="text-nowrap mt-0.5 max-w-full font-mono text-xs text-text-muted" title={`${conn.username}@${conn.host}`}>
                    {conn.username}@{conn.host}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-md bg-bg-secondary/80 p-2 shadow-sm">
          <div className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-text-muted">
            Authentication
          </div>
          <div className="grid grid-cols-3 gap-1 rounded-md bg-bg-primary p-1 shadow-inner">
            {authMethods.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => updateField('authMethod', value)}
                className={classNames(
                  'interactive-button h-7 rounded px-2 text-xs font-medium transition-colors',
                  form.authMethod === value
                    ? 'bg-accent text-white'
                    : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {connectError && (
          <div className="rounded-md bg-error/10 px-3 py-2 text-xs leading-5 text-error shadow-sm">
            {connectError}
          </div>
        )}

        <Input
          label="Host or IP"
          placeholder="rorqual.mcgill.ca"
          value={form.host}
          onChange={(e) => updateField('host', e.target.value)}
          error={errors.host}
        />
        <Input
          label="Username"
          placeholder="username"
          icon={<User size={14} />}
          value={form.username}
          onChange={(e) => updateField('username', e.target.value)}
          error={errors.username}
        />
        {form.authMethod === 'key' && (
          <LocalPathField
            label="Private key path"
            placeholder="~/.ssh/id_rsa"
            value={form.privateKeyPath}
            onChange={(value) => {
              updateField('authMethod', 'key')
              updateField('privateKeyPath', value)
            }}
            error={errors.privateKeyPath}
            mode="file"
          />
        )}
        {form.authMethod === 'password' && (
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">Password</label>
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                placeholder="Enter password"
                icon={<Lock size={14} />}
                value={form.password}
                onChange={(e) => updateField('password', e.target.value)}
                error={errors.password}
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                className="interactive-button absolute right-2.5 top-[calc(50%+2px)] -translate-y-1/2 text-text-muted transition-colors hover:text-text-secondary"
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <label className="mt-2 flex items-center gap-2 text-[11px] text-text-secondary">
              <input
                type="checkbox"
                checked={form.rememberPassword}
                onChange={(e) => updateField('rememberPassword', e.target.checked)}
                className="accent-accent"
              />
              Remember password on this machine
            </label>
          </div>
        )}
        {form.authMethod === 'agent' && (
          <div className="rounded-md bg-bg-secondary px-3 py-2 text-xs text-text-secondary shadow-sm">
            SSH agent identities will be offered for this connection.
          </div>
        )}

        <details className="bioflow-more-options rounded-md bg-bg-secondary px-3 py-2 text-xs text-text-secondary shadow-sm">
          <summary className="flex cursor-pointer select-none items-center gap-2 text-text-primary">
            <ChevronRight size={13} className="bioflow-details-chevron text-text-muted" />
            More options
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {form.authMethod === 'key' && (
              <Input
                label="Passphrase"
                type="password"
                placeholder="Leave empty if none"
                icon={<Lock size={14} />}
                value={form.passphrase}
                onChange={(e) => {
                  updateField('authMethod', 'key')
                  updateField('passphrase', e.target.value)
                }}
              />
            )}
            <RemotePathField
              label="Remote directory"
              placeholder="/home/username"
              value={form.defaultDirectory}
              onChange={(value) => updateField('defaultDirectory', value)}
              mode="directory"
              title="Choose default remote directory"
              error={errors.defaultDirectory}
            />
            {form.authMethod === 'key' && (
              <div className="rounded-md bg-bg-tertiary/60 px-3 py-2 shadow-inner">
                <div className="mb-2 text-xs uppercase tracking-wide text-text-muted">Key generation</div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!setupReady || setupRunning}
                  onClick={() => {
                    setSetupMessage(null)
                    setSetupOpen(true)
                  }}
                  icon={<Sparkles size={12} />}
                >
                  Auto-setup key
                </Button>
              </div>
            )}
            <div className="rounded-md bg-bg-tertiary/60 px-3 py-2 text-[11px] text-text-muted shadow-inner">
              MFA tip: Alliance clusters may label a one-time-code prompt as Password.
            </div>
            <details className="rounded-md bg-bg-tertiary/60 px-3 py-2 shadow-inner">
              <summary className="cursor-pointer select-none text-text-primary">Advanced SSH</summary>
              <div className="mt-3 flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<FolderOpen size={14} />}
                    onClick={async () => {
                      const dir = await window.api.dialog.openDirectory()
                      if (dir) {
                        await connectLocal(dir)
                        onClose()
                      }
                    }}
                    className="flex-1"
                  >
                    Browse local
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={async () => {
                      await connectLocal()
                      onClose()
                    }}
                  >
                    Home
                  </Button>
                </div>
                <Input
                  label="Connection name"
                  placeholder={defaultAlias}
                  icon={<Server size={14} />}
                  value={form.name}
                  onChange={(e) => updateField('name', e.target.value)}
                  error={errors.name}
                />
                <Input
                  label="Port"
                  type="number"
                  value={form.port}
                  onChange={(e) => updateField('port', parseInt(e.target.value, 10) || 22)}
                  error={errors.port}
                />
              </div>
            </details>
          </div>
        </details>

        {setupMessage && (
          <div className="px-3 py-2 rounded-md bg-bg-secondary text-text-secondary text-xs shadow-sm">
            {setupMessage}
          </div>
        )}

        {setupResult && (
          <div className="rounded-md bg-accent/10 p-3 text-xs text-text-secondary shadow-sm">
            <div className="mb-2 flex items-center gap-2 font-medium text-text-primary">
              <KeyRound size={14} className="text-accent" />
              SSH key ready
            </div>
            <div className="space-y-1 text-[11px]">
              <div><strong className="text-text-primary">Private key:</strong> <code className="break-all">{setupResult.keyPath}</code></div>
              <div><strong className="text-text-primary">Public key:</strong> <code className="break-all">{setupResult.publicKeyPath}</code></div>
            </div>
            {setupResult.publicKey ? (
              <textarea
                readOnly
                value={setupResult.publicKey}
                className="mt-2 h-20 w-full resize-none rounded border border-border bg-bg-primary p-2 font-mono text-xs text-text-secondary"
                aria-label="Generated SSH public key"
              />
            ) : (
              <div className="mt-2 rounded border border-warning/25 bg-warning/10 p-2 text-[11px] text-warning">
                Public key text could not be read locally. The path above is still available for manual inspection.
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              {setupResult.publicKey && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Copy size={12} />}
                  onClick={() => void copySetupText(setupResult.publicKey, 'public-key')}
                >
                  {setupCopied === 'public-key' ? 'Copied' : 'Copy public key'}
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                icon={<Copy size={12} />}
                onClick={() => void copySetupText(setupResult.keyPath, 'key-path')}
              >
                {setupCopied === 'key-path' ? 'Copied' : 'Copy private key path'}
              </Button>
            </div>
          </div>
        )}

        {(isConnecting || connectionEvents.length > 0) && (
          <details className="rounded-md bg-bg-secondary px-3 py-2 text-xs text-text-secondary shadow-sm">
            <summary className="flex cursor-pointer select-none items-center justify-between gap-3 text-text-primary">
              <span>Connection trace</span>
              <span className="text-text-muted">{connectionEvents.length} events</span>
            </summary>
            {connectionEvents.length === 0 ? (
              <div className="mt-2 text-[11px] text-text-muted">Starting SSH connection...</div>
            ) : (
              <pre className="mt-2 max-h-32 overflow-auto rounded bg-bg-primary px-2 py-1.5 font-mono text-[10px] leading-4 text-text-secondary shadow-inner">{connectionEvents.map(traceEventLine).join('\n')}</pre>
            )}
          </details>
        )}
      </div>
      <Dialog
        open={setupOpen}
        onClose={() => !setupRunning && setSetupOpen(false)}
        title="Auto-setup SSH key"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setSetupOpen(false)} disabled={setupRunning}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleSetupKey()}
              disabled={setupRunning || Boolean(setupExistingKey && !setupOverwrite)}
              icon={setupRunning ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            >
              {setupRunning ? 'Setting up…' : setupOverwrite ? 'Replace and install' : 'Generate and install'}
            </Button>
          </>
        )}
      >
        <div className="flex flex-col gap-3 text-xs text-text-secondary">
          <div className="rounded-md bg-bg-secondary p-3 shadow-sm">
            <div><strong className="text-text-primary">Host:</strong> {form.host || 'Enter a host first'}</div>
            <div><strong className="text-text-primary">User:</strong> {form.username || 'Enter a username first'}</div>
            <div><strong className="text-text-primary">Port:</strong> {form.port}</div>
          </div>
          {setupExistingKey && (
            <div className="rounded-md bg-warning/10 p-3 text-[11px] text-text-secondary shadow-sm">
              <div className="font-medium text-warning">Existing BioFlow key found</div>
              <div className="mt-1 break-all"><strong className="text-text-primary">Private:</strong> {setupExistingKey.keyPath}</div>
              <div className="break-all"><strong className="text-text-primary">Public:</strong> {setupExistingKey.publicKeyPath}</div>
              {setupExistingKey.privateExists && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  icon={<KeyRound size={12} />}
                  onClick={() => void useExistingSetupKey()}
                >
                  Use existing key
                </Button>
              )}
            </div>
          )}
          <Input
            label="Current account password"
            type="password"
            value={setupPassword}
            onChange={(e) => setSetupPassword(e.target.value)}
            placeholder="Needed once to install the new key"
          />
          <details className="rounded-md bg-bg-secondary px-3 py-2 shadow-sm">
            <summary className="cursor-pointer select-none text-text-primary">Keychain and alias</summary>
            <div className="mt-3 flex flex-col gap-3">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={setupAddAgent} onChange={(e) => setSetupAddAgent(e.target.checked)} className="accent-accent" />
                Add to ssh-agent for this session
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={setupAddKeychain} onChange={(e) => setSetupAddKeychain(e.target.checked)} className="accent-accent" />
                Add to macOS keychain
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={setupOverwrite} onChange={(e) => setSetupOverwrite(e.target.checked)} className="accent-accent" />
                Replace existing BioFlow key
              </label>
              <Input label="SSH alias" value={defaultAlias} onChange={(e) => updateField('alias', e.target.value)} placeholder="rorqual" />
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.writeConfig} onChange={(e) => updateField('writeConfig', e.target.checked)} className="accent-accent" />
                Write SSH config alias
              </label>
            </div>
          </details>
          <details className="rounded-md bg-bg-secondary px-3 py-2 shadow-sm">
            <summary className="cursor-pointer select-none text-text-primary">Session persistence</summary>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Input
                label="Keep session open (hours)"
                type="number"
                min={1}
                value={String(form.controlPersistHours)}
                onChange={(e) => updateField('controlPersistHours', Math.max(1, Number(e.target.value) || 8))}
              />
              <Input
                label="Keepalive (seconds)"
                type="number"
                min={15}
                value={String(form.serverAliveIntervalSeconds)}
                onChange={(e) => updateField('serverAliveIntervalSeconds', Math.max(15, Number(e.target.value) || 60))}
              />
            </div>
          </details>
        </div>
      </Dialog>
    </Dialog>
  )
}

function traceEventLine(event: SshDebugEvent): string {
  const time = new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return `[${time}] ${event.stage.padEnd(7)} ${event.detail}`
}

function userFacingConnectionError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err || 'Connection failed')
  return raw
    .replace(/^Error invoking remote method 'ssh:connect':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim() || 'Connection failed'
}
