import { useState, useEffect } from 'react'
import { useConnectionStore } from '@/stores/connectionStore'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { connectionConfigSchema } from '@/lib/validators'
import { Server, Key, Lock, User, Eye, EyeOff, Loader2, Plus, FolderOpen } from 'lucide-react'
import type { ConnectionConfig } from '@/types'
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
  defaultDirectory: '',
}

// Saved connections stored locally for quick access
const STORAGE_KEY = 'bioflow-saved-connections'

function loadSavedConnections(): ConnectionConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveConnection(config: ConnectionConfig) {
  const existing = loadSavedConnections()
  const filtered = existing.filter((c) => c.name !== config.name)
  // Strip password/passphrase before saving
  const { password: _pw, passphrase: _pp, ...safe } = config
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([safe, ...filtered].slice(0, 10)),
  )
}

export function ConnectionDialog({ open, onClose }: ConnectionDialogProps) {
  const [form, setForm] = useState<FormData>(initialFormData)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [connectError, setConnectError] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [savedConnections, setSavedConnections] = useState<ConnectionConfig[]>([])

  const { connect, connectLocal } = useConnectionStore()

  useEffect(() => {
    if (open) {
      setSavedConnections(loadSavedConnections())
      setErrors({})
      setConnectError(null)
      setIsConnecting(false)
      setShowPassword(false)
    }
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
      defaultDirectory: config.defaultDirectory ?? '',
    })
    setErrors({})
    setConnectError(null)
  }

  async function handleBrowseKey() {
    try {
      const result = await window.api.dialog.openFile()
      if (result) {
        updateField('privateKeyPath', result)
      }
    } catch {
      // User cancelled or dialog unavailable
    }
  }

  async function handleConnect() {
    setErrors({})
    setConnectError(null)

    const config: ConnectionConfig = {
      name: form.name,
      host: form.host,
      port: form.port,
      username: form.username,
      authMethod: form.authMethod,
      ...(form.authMethod === 'key' && {
        privateKeyPath: form.privateKeyPath,
        passphrase: form.passphrase || undefined,
      }),
      ...(form.authMethod === 'password' && { password: form.password }),
      ...(form.defaultDirectory && { defaultDirectory: form.defaultDirectory }),
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
      saveConnection(config)
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
            placeholder="rorqual.mcgill.ca"
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
        </div>

        {/* SSH Key fields */}
        {form.authMethod === 'key' && (
          <>
            <div>
              <label className="text-text-secondary text-xs font-medium mb-1 block">
                Private Key Path
              </label>
              <div className="flex gap-2">
                <div className="flex-1">
                  <Input
                    placeholder="~/.ssh/id_rsa"
                    icon={<Key size={14} />}
                    value={form.privateKeyPath}
                    onChange={(e) => updateField('privateKeyPath', e.target.value)}
                    error={errors.privateKeyPath}
                  />
                </div>
                <Button
                  variant="secondary"
                  size="md"
                  onClick={handleBrowseKey}
                  className="shrink-0"
                >
                  Browse
                </Button>
              </div>
            </div>
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
          </div>
        )}

        {/* Default Remote Directory */}
        <Input
          label="Default Remote Directory"
          placeholder="/home/username"
          value={form.defaultDirectory}
          onChange={(e) => updateField('defaultDirectory', e.target.value)}
          error={errors.defaultDirectory}
        />

        {/* HPC MFA note */}
        {form.authMethod === 'key' && (
          <div className="px-3 py-2 rounded-md bg-accent/10 border border-accent/20 text-text-secondary text-xs">
            <strong className="text-accent">HPC clusters with MFA:</strong> If your server requires multi-factor authentication
            (e.g., Compute Canada / Alliance), you'll be prompted for your verification code after clicking Connect.
          </div>
        )}

        {/* Connection error */}
        {connectError && (
          <div className="px-3 py-2 rounded-md bg-error/10 border border-error/20 text-error text-xs">
            {connectError}
          </div>
        )}
      </div>
    </Dialog>
  )
}
