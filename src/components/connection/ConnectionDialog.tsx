import { useState, useEffect, useMemo } from 'react'
import { useConnectionStore } from '@/stores/connectionStore'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { LocalPathField } from '@/components/file-browser/LocalPathField'
import { RemotePathField } from '@/components/file-browser/RemotePathField'
import { connectionConfigSchema } from '@/lib/validators'
import { Server, Lock, User, Eye, EyeOff, Loader2, FolderOpen, Sparkles } from 'lucide-react'
import type { ConnectionConfig } from '@/types'
import type { SshDebugEvent } from '@/types/ssh'
import type { ZodError } from 'zod'

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
  const [showPassword, setShowPassword] = useState(false)
  const [savedConnections, setSavedConnections] = useState<ConnectionConfig[]>([])
  const [setupOpen, setSetupOpen] = useState(false)
  const [setupPassword, setSetupPassword] = useState('')
  const [setupRunning, setSetupRunning] = useState(false)
  const [setupMessage, setSetupMessage] = useState<string | null>(null)
  const [setupAddAgent, setSetupAddAgent] = useState(true)
  const [setupAddKeychain, setSetupAddKeychain] = useState(true)
  const [setupOverwrite, setSetupOverwrite] = useState(false)

  const { connect, connectLocal } = useConnectionStore()
  const setupReady = useMemo(
    () => form.host.trim() && form.username.trim() && form.port > 0,
    [form.host, form.port, form.username],
  )
  const defaultAlias = useMemo(() => {
    const preferred = form.alias.trim() || form.name.trim() || form.host.trim().split('.')[0] || form.username.trim()
    return preferred.replace(/\s+/g, '-').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'bioflow'
  }, [form.alias, form.host, form.name, form.username])

  useEffect(() => {
    if (open) {
      void loadSavedConnections().then(hydrateRememberedPasswords).then(setSavedConnections).catch(() => {
        void hydrateRememberedPasswords(loadSavedConnectionsFallback()).then(setSavedConnections)
      })
      setErrors({})
      setConnectError(null)
      setConnectionEvents([])
      setIsConnecting(false)
      setShowPassword(false)
      setSetupOpen(false)
      setSetupPassword('')
      setSetupRunning(false)
      setSetupMessage(null)
    }
  }, [open])

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
    setErrors({})
    setConnectError(null)
    setConnectionEvents([])

    const config: ConnectionConfig = {
      name: form.name.trim(),
      host: form.host.trim(),
      port: form.port,
      username: form.username.trim(),
      authMethod: form.authMethod,
      ...(form.authMethod === 'key' && {
        privateKeyPath: form.privateKeyPath.trim(),
        passphrase: form.passphrase || undefined,
      }),
      ...(form.authMethod === 'password' && { password: form.password }),
      ...(form.authMethod === 'password' && { rememberPassword: form.rememberPassword }),
      ...(form.authMethod === 'key' && form.privateKeyPath.trim() && { generatedKeyPath: form.privateKeyPath.trim() }),
      ...(defaultAlias && { alias: defaultAlias }),
      ...(form.writeConfig ? { writeConfig: true } : {}),
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
      onClose()
      setForm(initialFormData)
    } catch (err) {
      setConnectError(
        err instanceof Error ? err.message : 'Connection failed',
      )
    } finally {
      setIsConnecting(false)
    }
  }

  const authMethods: { value: AuthMethod; label: string }[] = [
    { value: 'key', label: 'SSH Key' },
    { value: 'password', label: 'Password' },
    { value: 'agent', label: 'SSH Agent' },
  ]

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
      <Button variant="secondary" onClick={onClose} disabled={isConnecting}>
        Cancel
      </Button>
      <Button
        variant="primary"
        onClick={handleConnect}
        disabled={isConnecting}
        icon={isConnecting ? <Loader2 size={14} className="animate-spin" /> : undefined}
      >
        {isConnecting ? 'Connecting...' : 'Connect'}
      </Button>
    </>
  )

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect to Server"
      footer={footer}
      width="max-w-lg"
    >
      <div className="flex flex-col gap-4">
        {/* Browse Local */}
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="md"
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
            Browse Local Folder
          </Button>
          <Button
            variant="secondary"
            size="md"
            onClick={async () => {
              await connectLocal()
              onClose()
            }}
          >
            Home Folder
          </Button>
        </div>

        <div className="flex items-center gap-2 text-text-muted text-xs">
          <div className="h-px flex-1 bg-border" />
          <span>or connect to a remote server</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        {/* Saved Connections */}
        {savedConnections.length > 0 && (
          <div>
            <label className="text-text-secondary text-xs font-medium mb-1 block">
              Saved Connections
            </label>
            <div className="flex flex-wrap gap-1.5">
              {savedConnections.map((conn) => (
                <button
                  key={conn.name}
                  onClick={() => fillFromSaved(conn)}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md bg-bg-tertiary border border-border text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
                >
                  <Server size={12} />
                  {conn.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Connection Name */}
        <Input
          label="Connection Name"
          placeholder="e.g., rorqual"
          icon={<Server size={14} />}
          value={form.name}
          onChange={(e) => updateField('name', e.target.value)}
          error={errors.name}
        />

        {/* Host + Port */}
        <div className="grid grid-cols-[1fr_80px] gap-2">
          <Input
            label="Host"
            placeholder="rorqual.alliancecan.ca"
            value={form.host}
            onChange={(e) => updateField('host', e.target.value)}
            error={errors.host}
          />
          <Input
            label="Port"
            type="number"
            value={form.port}
            onChange={(e) => updateField('port', parseInt(e.target.value, 10) || 22)}
            error={errors.port}
          />
        </div>

        {/* Username */}
        <Input
          label="Username"
          placeholder="username"
          icon={<User size={14} />}
          value={form.username}
          onChange={(e) => updateField('username', e.target.value)}
          error={errors.username}
        />

        {/* Auth Method */}
        <div>
          <label className="text-text-secondary text-xs font-medium mb-1.5 block">
            Authentication Method
          </label>
          <div className="flex rounded-md border border-border overflow-hidden">
            {authMethods.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => updateField('authMethod', value)}
                className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                  form.authMethod === value
                    ? 'bg-accent text-white'
                    : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {!form.privateKeyPath.trim() && (
            <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-border bg-bg-secondary px-3 py-2 text-[11px] text-text-muted">
              <div className="min-w-0">
                <div className="font-medium text-text-primary">Auto-setup SSH key</div>
                <div>Generate a dedicated SSH key, install the public key on the host, and optionally write a reusable `ssh {defaultAlias}` alias with same-day OpenSSH session persistence.</div>
              </div>
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
        </div>

        {/* SSH Key fields */}
        {form.authMethod === 'key' && (
          <>
            <LocalPathField
              label="Private Key Path"
              placeholder="~/.ssh/id_rsa"
              value={form.privateKeyPath}
              onChange={(value) => updateField('privateKeyPath', value)}
              error={errors.privateKeyPath}
              mode="file"
            />
            <Input
              label="Passphrase (optional)"
              type="password"
              placeholder="Leave empty if none"
              icon={<Lock size={14} />}
              value={form.passphrase}
              onChange={(e) => updateField('passphrase', e.target.value)}
            />
          </>
        )}

        {/* Password field */}
        {form.authMethod === 'password' && (
          <div>
            <label className="text-text-secondary text-xs font-medium mb-1 block">
              Password
            </label>
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
                className="absolute right-2.5 top-[calc(50%+2px)] -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
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

        {/* Default Remote Directory */}
        <RemotePathField
          label="Default Remote Directory"
          placeholder="/home/username"
          value={form.defaultDirectory}
          onChange={(value) => updateField('defaultDirectory', value)}
          mode="directory"
          title="Choose default remote directory"
          error={errors.defaultDirectory}
        />

        {/* HPC MFA note */}
        {(form.authMethod === 'key' || form.authMethod === 'password') && (
          <div className="px-3 py-2 rounded-md bg-accent/10 border border-accent/20 text-text-secondary text-xs">
            <strong className="text-accent">HPC clusters with MFA:</strong> If your server requires multi-factor authentication
            (e.g., Compute Canada / Alliance), you'll be prompted for the exact response the cluster asks for after clicking Connect.
            {form.authMethod === 'password' && ' On Alliance, the follow-up "Password:" dialog is often the MFA step: enter your authenticator code, or type 1 for Duo Push when that option is shown.'}
          </div>
        )}

        <div className="rounded-md border border-border bg-bg-secondary px-3 py-2 text-[11px] text-text-secondary">
          <div className="font-medium text-text-primary">SSH key, alias, and app reuse are separate</div>
          <div className="mt-1">
            The generated SSH alias is for terminal use such as <code>ssh {defaultAlias}</code> and can keep one OpenSSH session warm for a few hours.
            BioFlow&apos;s own MFA reuse still comes from the app reusing its existing `ssh2` connection, not from `ControlPersist`.
          </div>
        </div>

        {setupMessage && (
          <div className="px-3 py-2 rounded-md bg-bg-secondary border border-border text-text-secondary text-xs">
            {setupMessage}
          </div>
        )}

        {/* Connection error */}
        {connectError && (
          <div className="whitespace-pre-wrap rounded-md border border-error/20 bg-error/10 px-3 py-2 text-xs text-error">
            {connectError}
          </div>
        )}

        {(isConnecting || connectionEvents.length > 0) && (
          <div className="rounded-md border border-border bg-bg-secondary px-3 py-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-medium text-text-primary">Connection trace</div>
              <div className="text-[10px] text-text-muted">{connectionEvents.length} events</div>
            </div>
            {connectionEvents.length === 0 ? (
              <div className="text-[11px] text-text-muted">Starting SSH connection...</div>
            ) : (
              <div className="flex max-h-36 flex-col gap-1 overflow-y-auto font-mono text-[10px]">
                {connectionEvents.map((event, index) => (
                  <div key={`${event.at}-${index}`} className="grid grid-cols-[4.5rem_1fr] gap-2 rounded border border-border/70 bg-bg-primary px-2 py-1">
                    <span className={traceStageClass(event.stage)}>{event.stage}</span>
                    <span className="whitespace-pre-wrap break-words text-text-secondary">{event.detail}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <Dialog
        open={setupOpen}
        onClose={() => !setupRunning && setSetupOpen(false)}
        title="Auto-setup SSH key"
        width="max-w-md"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setSetupOpen(false)} disabled={setupRunning}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleSetupKey()}
              disabled={setupRunning}
              icon={setupRunning ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            >
              {setupRunning ? 'Setting up…' : 'Generate and install'}
            </Button>
          </>
        )}
      >
        <div className="flex flex-col gap-3 text-xs text-text-secondary">
          <div className="rounded-md border border-border bg-bg-secondary p-3">
            <div><strong className="text-text-primary">Host:</strong> {form.host || 'Enter a host first'}</div>
            <div><strong className="text-text-primary">User:</strong> {form.username || 'Enter a username first'}</div>
            <div><strong className="text-text-primary">Port:</strong> {form.port}</div>
          </div>
          <p>
            BioFlow will generate a dedicated ed25519 key locally, append the public key to <code>~/.ssh/authorized_keys</code> on the remote host, and then switch this connection to key auth. Optionally it will also write a BioFlow-managed SSH config snippet so you can use <code>ssh {defaultAlias}</code> in Terminal.
          </p>
          <Input
            label="Current account password"
            type="password"
            value={setupPassword}
            onChange={(e) => setSetupPassword(e.target.value)}
            placeholder="Needed once to install the new key"
          />
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={setupAddAgent}
              onChange={(e) => setSetupAddAgent(e.target.checked)}
              className="accent-accent"
            />
            Ask ssh-agent to remember the new key for this session
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={setupAddKeychain}
              onChange={(e) => setSetupAddKeychain(e.target.checked)}
              className="accent-accent"
            />
            Add the key to the macOS keychain too
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={setupOverwrite}
              onChange={(e) => setSetupOverwrite(e.target.checked)}
              className="accent-accent"
            />
            Replace an existing BioFlow-generated key for this host/user
          </label>
          <Input
            label="SSH alias"
            value={defaultAlias}
            onChange={(e) => updateField('alias', e.target.value)}
            placeholder="rorqual"
          />
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.writeConfig}
              onChange={(e) => updateField('writeConfig', e.target.checked)}
              className="accent-accent"
            />
            Write a BioFlow-managed SSH config snippet so <code>ssh {defaultAlias}</code> works in Terminal
          </label>
          <div className="grid grid-cols-2 gap-2">
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
          <div className="rounded-md border border-border bg-bg-primary p-2 text-[11px] leading-relaxed">
            <div><strong className="text-text-primary">What these do:</strong> the SSH key proves this device can log in, the alias gives you a short terminal command, and the OpenSSH session settings can reduce repeated Duo/TOTP prompts during one workday in Terminal sessions.</div>
            <div className="mt-1">BioFlow also uses the keepalive interval for its in-app SSH socket so the already-authenticated session stays reusable while the app is open.</div>
          </div>
          <div className="rounded-md border border-accent/20 bg-accent/10 p-2 text-[11px]">
            Some clusters still require keyboard-interactive MFA after key auth. If that happens, BioFlow will keep showing the MFA prompt and will not claim the connection is fully passwordless.
          </div>
        </div>
      </Dialog>
    </Dialog>
  )
}

function traceStageClass(stage: SshDebugEvent['stage']): string {
  switch (stage) {
    case 'error': return 'text-error'
    case 'prompt': return 'text-warning'
    case 'banner': return 'text-accent'
    case 'auth': return 'text-blue-300'
    default: return 'text-text-muted'
  }
}
