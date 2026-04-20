import { Client } from 'ssh2'
import type { ClientChannel, ConnectConfig } from 'ssh2'
import { readFileSync, existsSync } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { homedir } from 'os'
import { resolve as resolvePath } from 'path'
import { BrowserWindow, ipcMain } from 'electron'

import type { ConnectionConfig, ConnectionResult, ConnectionStatus, ExecResult, LoginPolicy } from './types'

interface ManagedConnection {
  client: Client
  config: ConnectionConfig
  connectedAt: number
  reconnecting: boolean
}

/**
 * Expand ~ to the user's home directory and resolve the path.
 */
function expandPath(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    return resolvePath(homedir(), filePath.slice(2))
  }
  return resolvePath(filePath)
}

function normalizeConnectionConfig(config: ConnectionConfig): ConnectionConfig {
  return {
    ...config,
    name: config.name.trim(),
    host: config.host.trim(),
    username: config.username.trim(),
    privateKeyPath: config.privateKeyPath?.trim(),
    defaultDirectory: config.defaultDirectory?.trim(),
  }
}

/** Standard algorithm lists for broad HPC server compatibility. */
const ALGORITHMS: ConnectConfig['algorithms'] = {
  kex: [
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256',
    'diffie-hellman-group14-sha256',
    'diffie-hellman-group16-sha512',
    'diffie-hellman-group18-sha512',
    'diffie-hellman-group14-sha1',
  ],
  serverHostKey: [
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'rsa-sha2-512',
    'rsa-sha2-256',
    'ssh-rsa',
  ],
  cipher: [
    'aes128-gcm',
    'aes128-gcm@openssh.com',
    'aes256-gcm',
    'aes256-gcm@openssh.com',
    'aes128-ctr',
    'aes192-ctr',
    'aes256-ctr',
    //'chacha20-poly1305@openssh.com', Removed because it was causing issues
  ],
  hmac: [
    'hmac-sha2-256-etm@openssh.com',
    'hmac-sha2-512-etm@openssh.com',
    'hmac-sha2-256',
    'hmac-sha2-512',
    'hmac-sha1',
  ],
}

const CHANNEL_OPEN_RETRY_DELAYS_MS = [150, 400, 900]

/**
 * Build ssh2 ConnectConfig from our ConnectionConfig.
 * Handles: key file (with ~ expansion), password, agent, keyboard-interactive.
 */
function buildConnectOptions(config: ConnectionConfig): ConnectConfig {
  const options: ConnectConfig = {
    host: config.host,
    port: config.port,
    username: config.username,
    readyTimeout: 30_000,
    tryKeyboard: true,
    algorithms: ALGORITHMS,
    // Uncomment for verbose debug (very noisy):
    // debug: (msg: string) => console.log(`[SSH debug] ${msg}`),
  }

  switch (config.authMethod) {
    case 'key': {
      const keyPath = expandPath(config.privateKeyPath!)
      if (!existsSync(keyPath)) {
        throw new Error(`SSH key file not found: ${keyPath}`)
      }
      const keyData = readFileSync(keyPath)
      options.privateKey = keyData
      if (config.passphrase) {
        options.passphrase = config.passphrase
      }
      // Also try agent as fallback
      if (process.env.SSH_AUTH_SOCK) {
        options.agent = process.env.SSH_AUTH_SOCK
      }
      console.log(`[SSH] Key file loaded: ${keyPath} (${keyData.length} bytes)`)
      break
    }
    case 'password':
      if (!config.password) {
        throw new Error('Password auth selected but no password was provided')
      }
      options.password = config.password
      console.log(`[SSH] Password auth configured (password length: ${config.password.length})`)
      break
    case 'agent':
      options.agent = process.env.SSH_AUTH_SOCK
      if (!options.agent) {
        throw new Error('SSH_AUTH_SOCK not set — is your SSH agent running?')
      }
      break
  }

  return options
}

/**
 * Ask the renderer to show a prompt dialog and return the user's input.
 * Used for MFA/2FA codes during keyboard-interactive auth.
 */
function promptUser(title: string, message: string, isPassword: boolean = false): Promise<string | null> {
  return new Promise((resolve) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) {
      resolve(null)
      return
    }

    const promptId = randomUUID()

    // Listen for the response
    const handler = (_event: Electron.IpcMainEvent, data: { promptId: string; value: string | null }) => {
      if (data.promptId === promptId) {
        ipcMain.removeListener('ssh:prompt-response', handler)
        resolve(data.value)
      }
    }
    ipcMain.on('ssh:prompt-response', handler)

    // Ask renderer to show prompt
    win.webContents.send('ssh:prompt', {
      promptId,
      title,
      message,
      isPassword,
    })

    // Timeout after 60 seconds
    setTimeout(() => {
      ipcMain.removeListener('ssh:prompt-response', handler)
      resolve(null)
    }, 60_000)
  })
}

function parseLoginPolicyFields(stdout: string): { host: string; cpu: string; mem: string } {
  const fields = { host: '', cpu: '', mem: '' }
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('__HOST__')) fields.host = line.slice('__HOST__'.length).trim()
    if (line.startsWith('__CPU__')) fields.cpu = line.slice('__CPU__'.length).trim()
    if (line.startsWith('__MEM__')) fields.mem = line.slice('__MEM__'.length).trim()
  }
  return fields
}

function parseUlimitNumber(value: string): number | null {
  const normalized = value.trim().toLowerCase()
  if (!normalized || normalized === 'unlimited') return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function parseUlimitKbAsMb(value: string): number | null {
  const kb = parseUlimitNumber(value)
  if (kb === null) return null
  return Math.ceil(kb / 1024)
}

function isChannelOpenFailure(err: unknown): boolean {
  const candidate = err as { reason?: unknown; message?: unknown } | null
  const message = typeof candidate?.message === 'string' ? candidate.message : ''
  return candidate?.reason === 2 || /channel open failure|open failed/i.test(message)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class SshManager {
  private static instance: SshManager
  private connections = new Map<string, ManagedConnection>()
  private loginPolicies = new Map<string, LoginPolicy>()
  private loginPolicyPromises = new Map<string, Promise<LoginPolicy>>()
  private connectionKeys = new Map<string, string>()

  private constructor() { }

  static getInstance(): SshManager {
    if (!SshManager.instance) {
      SshManager.instance = new SshManager()
    }
    return SshManager.instance
  }

  connect(config: ConnectionConfig): Promise<ConnectionResult> {
    return new Promise((resolve, reject) => {
      const cleanConfig = normalizeConnectionConfig(config)
      const dedupeKey = connectionDedupeKey(cleanConfig)
      const reusable = this.findReusableConnection(dedupeKey)
      if (reusable) {
        this.emitDebug(reusable.id, 'connect', `Reused existing SSH session for ${cleanConfig.username}@${cleanConfig.host}`)
        resolve({ id: reusable.id, host: cleanConfig.host, username: cleanConfig.username, reused: true })
        return
      }

      let connectOptions: ConnectConfig
      try {
        connectOptions = buildConnectOptions(cleanConfig)
      } catch (err) {
        reject(err)
        return
      }

      const client = new Client()
      const id = randomUUID()
      let resolved = false
      this.emitDebug(id, 'connect', `Connecting to ${cleanConfig.host}:${cleanConfig.port} as ${cleanConfig.username} with ${cleanConfig.authMethod}`)

      /**
       * Handle keyboard-interactive auth.
       *
       * HPC clusters (Compute Canada / Alliance) use multi-factor auth:
       *   1. publickey auth succeeds (partial success)
       *   2. Server then requires keyboard-interactive for MFA (TOTP code)
       *
       * When the prompt looks like a password prompt and we have a password,
       * auto-respond. Otherwise, show a dialog to the user asking for their
       * MFA/2FA verification code.
       */
      client.on('keyboard-interactive', (_name, instructions, _lang, prompts, finish) => {
        console.log(`[SSH] keyboard-interactive: instructions="${instructions}", prompts=${JSON.stringify(prompts.map(p => p.prompt))}`)
        this.emitDebug(id, 'auth', `Keyboard-interactive auth requested ${prompts.length} prompt(s)`)

        // Process all prompts, potentially async
        const processPrompts = async () => {
          const responses: string[] = []

          for (const prompt of prompts) {
            const promptText = prompt.prompt.toLowerCase()

            // If it's asking for a password and we have one, auto-respond
            if (promptText.includes('password') && cleanConfig.password) {
              this.emitDebug(id, 'prompt', 'Auto-responded to "password" prompt with the stored password')
              responses.push(cleanConfig.password)
            }
            // For MFA/verification/OTP prompts, or any unknown prompt, ask the user
            else {
              this.emitDebug(id, 'prompt', `Prompted user for: ${prompt.prompt || instructions || 'verification code'}`)
              const userInput = await promptUser(
                'Authentication Required',
                prompt.prompt || instructions || 'Enter verification code:',
                prompt.echo === false,
              )
              if (userInput === null) {
                // User cancelled — send empty to let auth fail gracefully
                responses.push('')
              } else {
                responses.push(userInput)
              }
            }
          }

          finish(responses)
        }

        processPrompts().catch((err) => {
          console.error('[SSH] Error processing keyboard-interactive prompts:', err)
          finish(prompts.map(() => ''))
        })
      })

      client.on('ready', () => {
        resolved = true
        this.connections.set(id, {
          client,
          config: cleanConfig,
          connectedAt: Date.now(),
          reconnecting: false,
        })
        this.connectionKeys.set(id, dedupeKey)
        this.emitDebug(id, 'connect', 'SSH session ready')
        this.sendStatusChange(id, true)
        void this.getLoginPolicy(id).catch((err) => {
          console.warn(`[SSH] login policy probe failed for ${id}:`, err instanceof Error ? err.message : err)
        })
        resolve({ id, host: cleanConfig.host, username: cleanConfig.username })
      })

      client.on('error', (err) => {
        console.error(`[SSH] Error:`, err.message, (err as any).level)
        this.emitDebug(id, 'error', err.message)
        if (!resolved) {
          resolved = true
          const enhanced = new Error(
            `SSH connection to ${cleanConfig.host} failed: ${err.message}\n` +
            `Auth method: ${cleanConfig.authMethod}, User: ${cleanConfig.username}`
          )
          reject(enhanced)
          return
        }
        const conn = this.connections.get(id)
        if (conn && !conn.reconnecting) {
          this.attemptReconnect(id)
        }
      })

      client.on('close', () => {
        console.log(`[SSH] Connection closed (resolved=${resolved})`)
        this.emitDebug(id, 'connect', 'SSH connection closed')
        if (!resolved) {
          resolved = true
          reject(new Error('Connection closed before ready'))
          return
        }
        const conn = this.connections.get(id)
        if (conn && !conn.reconnecting) {
          this.sendStatusChange(id, false)
          this.attemptReconnect(id)
        }
      })

      client.on('handshake', (negotiated) => {
        console.log(`[SSH] Handshake: kex=${negotiated.kex}, hostKey=${negotiated.serverHostKey}, cipher=${negotiated.cs.cipher}`)
        this.emitDebug(id, 'connect', `Handshake negotiated ${negotiated.kex} / ${negotiated.serverHostKey}`)
      })

      // Show server banner (HPC clusters often show MFA enrollment messages)
      client.on('banner', (message) => {
        console.log(`[SSH] Server banner:\n${message}`)
        this.emitDebug(id, 'banner', message.trim() || 'Server banner received')
        // Forward banner to renderer so user can see it
        const win = BrowserWindow.getAllWindows()[0]
        if (win) {
          win.webContents.send('ssh:banner', { connectionId: id, message })
        }
      })

      console.log(`[SSH] Connecting to ${cleanConfig.host}:${cleanConfig.port} as ${cleanConfig.username} (auth: ${cleanConfig.authMethod})`)
      client.connect(connectOptions)
    })
  }

  disconnect(id: string): void {
    const conn = this.connections.get(id)
    if (!conn) return
    conn.reconnecting = true
    conn.client.end()
    this.connections.delete(id)
    this.connectionKeys.delete(id)
    this.loginPolicies.delete(id)
    this.loginPolicyPromises.delete(id)
    this.sendStatusChange(id, false)
  }

  getStatus(id: string): ConnectionStatus | null {
    const conn = this.connections.get(id)
    if (!conn) return null
    return {
      connected: !conn.reconnecting,
      host: conn.config.host,
      username: conn.config.username,
      uptime: Date.now() - conn.connectedAt,
    }
  }

  getClient(id: string): Client | null {
    const conn = this.connections.get(id)
    return conn ? conn.client : null
  }

  getLoginPolicy(id: string): Promise<LoginPolicy> {
    const cached = this.loginPolicies.get(id)
    if (cached) return Promise.resolve(cached)

    const pending = this.loginPolicyPromises.get(id)
    if (pending) return pending

    const promise = this.probeLoginPolicy(id)
      .then((policy) => {
        this.loginPolicies.set(id, policy)
        this.loginPolicyPromises.delete(id)
        return policy
      })
      .catch((err) => {
        this.loginPolicyPromises.delete(id)
        const conn = this.connections.get(id)
        const fallback: LoginPolicy = {
          hostname: conn?.config.host ?? '',
          cpuTimeLimitSeconds: null,
          memLimitMB: null,
          source: 'unknown',
        }
        console.warn(`[SSH] login policy probe failed for ${id}:`, err instanceof Error ? err.message : err)
        this.loginPolicies.set(id, fallback)
        return fallback
      })

    this.loginPolicyPromises.set(id, promise)
    return promise
  }

  /**
   * Snapshot of every live connection. Used by the renderer on mount to
   * rehydrate its connection store after a window reload — the main process
   * keeps ssh2 Clients across renderer reloads, so there's no need to
   * re-authenticate; we just need to re-publish the list.
   *
   * Credentials (password / passphrase) are stripped so they never cross the
   * IPC boundary on list.
   */
  listConnections(): Array<{ id: string; config: Omit<ConnectionConfig, 'password' | 'passphrase'>; connectedAt: number; connected: boolean }> {
    const out: Array<{ id: string; config: Omit<ConnectionConfig, 'password' | 'passphrase'>; connectedAt: number; connected: boolean }> = []
    for (const [id, conn] of this.connections) {
      const { password: _p, passphrase: _pp, ...safeConfig } = conn.config
      out.push({
        id,
        config: safeConfig,
        connectedAt: conn.connectedAt,
        connected: !conn.reconnecting,
      })
    }
    return out
  }

  async exec(id: string, command: string): Promise<ExecResult> {
    for (let attempt = 0; attempt <= CHANNEL_OPEN_RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await this.execOnce(id, command)
      } catch (err) {
        if (!isChannelOpenFailure(err) || attempt >= CHANNEL_OPEN_RETRY_DELAYS_MS.length) {
          throw err
        }
        await delay(CHANNEL_OPEN_RETRY_DELAYS_MS[attempt])
      }
    }
    throw new Error('SSH exec failed')
  }

  private execOnce(id: string, command: string): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const conn = this.connections.get(id)
      if (!conn) {
        reject(new Error(`Connection ${id} not found`))
        return
      }

      conn.client.exec(command, (err, stream) => {
        if (err) {
          reject(err)
          return
        }

        let stdout = ''
        let stderr = ''

        stream.on('data', (data: Buffer) => {
          stdout += data.toString()
        })

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString()
        })

        stream.on('close', (code: number) => {
          resolve({ stdout, stderr, exitCode: code ?? 0 })
        })
      })
    })
  }

  private async probeLoginPolicy(id: string): Promise<LoginPolicy> {
    const result = await this.exec(
      id,
      'printf "__HOST__%s\\n" "$(hostname 2>/dev/null)"; printf "__CPU__%s\\n" "$(ulimit -t 2>/dev/null || true)"; printf "__MEM__%s\\n" "$(ulimit -v 2>/dev/null || true)"',
    )
    if (result.exitCode !== 0) {
      return {
        hostname: this.connections.get(id)?.config.host ?? '',
        cpuTimeLimitSeconds: null,
        memLimitMB: null,
        source: 'unknown',
      }
    }

    const fields = parseLoginPolicyFields(result.stdout)
    return {
      hostname: fields.host || this.connections.get(id)?.config.host || '',
      cpuTimeLimitSeconds: parseUlimitNumber(fields.cpu),
      memLimitMB: parseUlimitKbAsMb(fields.mem),
      source: 'ulimit',
    }
  }

  /**
   * Open a persistent exec channel and stream output chunks via a callback.
   * Unlike `exec()`, this does NOT buffer output — each chunk fires `onData`
   * as it arrives. Designed for long-running commands like `tail -F`.
   *
   * Returns a `cancel()` function. Calling it destroys the channel, which
   * sends SIGHUP to the remote process.
   */
  execStream(
    id: string,
    command: string,
    onData: (chunk: string, stream: 'stdout' | 'stderr') => void,
    onClose?: (exitCode: number | null) => void,
  ): { cancel: () => void } {
    const conn = this.connections.get(id)
    if (!conn) return { cancel: () => {} }

    let active = true
    let streamRef: ClientChannel | null = null

    conn.client.exec(command, (err, stream) => {
      if (err || !active) {
        if (active) onClose?.(null)
        return
      }
      streamRef = stream

      stream.on('data', (data: Buffer) => {
        if (active) onData(data.toString(), 'stdout')
      })
      stream.stderr.on('data', (data: Buffer) => {
        if (active) onData(data.toString(), 'stderr')
      })
      stream.on('close', (code: number | null) => {
        active = false
        streamRef = null
        onClose?.(code)
      })
    })

    return {
      cancel: () => {
        active = false
        if (streamRef) {
          try { streamRef.destroy() } catch { /* ignore */ }
          streamRef = null
        }
      },
    }
  }

  shell(id: string): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      const conn = this.connections.get(id)
      if (!conn) {
        reject(new Error(`Connection ${id} not found`))
        return
      }

      conn.client.shell({ term: 'xterm-256color' }, (err, stream) => {
        if (err) {
          reject(err)
          return
        }
        resolve(stream)
      })
    })
  }

  private attemptReconnect(id: string): void {
    const conn = this.connections.get(id)
    if (!conn || conn.reconnecting) return

    conn.reconnecting = true
    this.sendStatusChange(id, 'reconnecting')
    const { config } = conn
    const maxAttempts = 5
    const maxDelay = 30_000

    const tryReconnect = (attempt: number): void => {
      if (attempt > maxAttempts) {
        this.connections.delete(id)
        this.sendStatusChange(id, false)
        return
      }

      const delay = Math.min(1000 * Math.pow(2, attempt - 1), maxDelay)

      setTimeout(() => {
        if (!this.connections.has(id)) return

        let connectOptions: ConnectConfig
        try {
          connectOptions = buildConnectOptions(config)
        } catch {
          tryReconnect(attempt + 1)
          return
        }

        const newClient = new Client()

        // For reconnect, use same keyboard-interactive handler
        newClient.on('keyboard-interactive', (_name, instructions, _lang, prompts, finish) => {
          this.emitDebug(id, 'auth', `Re-authentication requested ${prompts.length} prompt(s)`)
          const processPrompts = async () => {
            const responses: string[] = []
            for (const prompt of prompts) {
              const promptText = prompt.prompt.toLowerCase()
              if (promptText.includes('password') && config.password) {
                this.emitDebug(id, 'prompt', 'Auto-responded to "password" prompt with the stored password')
                responses.push(config.password)
              } else {
                this.emitDebug(id, 'prompt', `Prompted user for: ${prompt.prompt || instructions || 'verification code'}`)
                const userInput = await promptUser(
                  'Re-authentication Required',
                  prompt.prompt || instructions || 'Enter verification code:',
                  prompt.echo === false,
                )
                responses.push(userInput ?? '')
              }
            }
            finish(responses)
          }
          processPrompts().catch(() => finish(prompts.map(() => '')))
        })

        newClient.on('ready', () => {
          const existing = this.connections.get(id)
          if (!existing) {
            newClient.end()
            return
          }
          existing.client = newClient
          existing.connectedAt = Date.now()
          existing.reconnecting = false
          this.emitDebug(id, 'connect', 'SSH session reconnected')
          this.sendStatusChange(id, true)
        })

        newClient.on('error', (err) => {
          this.emitDebug(id, 'error', err.message)
          tryReconnect(attempt + 1)
        })

        newClient.on('close', () => {
          const c = this.connections.get(id)
          if (c && !c.reconnecting) {
            this.sendStatusChange(id, false)
            this.attemptReconnect(id)
          }
        })

        newClient.connect(connectOptions)
      }, delay)
    }

    tryReconnect(1)
  }

  private sendStatusChange(id: string, status: boolean | string): void {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      const statusStr = typeof status === 'string' ? status :
        status ? 'connected' : 'disconnected'
      win.webContents.send('ssh:status-change', {
        connectionId: id,
        status: statusStr,
      })
    }
  }

  private findReusableConnection(dedupeKey: string): { id: string; conn: ManagedConnection } | null {
    for (const [id, conn] of this.connections) {
      if (conn.reconnecting) continue
      if (this.connectionKeys.get(id) === dedupeKey) return { id, conn }
    }
    return null
  }

  private emitDebug(connectionId: string, stage: 'connect' | 'auth' | 'prompt' | 'banner' | 'error', detail: string): void {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    win.webContents.send('ssh:debug', {
      connectionId,
      stage,
      detail,
      at: Date.now(),
    })
  }
}

function connectionDedupeKey(config: ConnectionConfig): string {
  return [
    config.host,
    config.port,
    config.username,
    authMethodId(config),
  ].join(':')
}

function authMethodId(config: ConnectionConfig): string {
  if (config.authMethod === 'agent') return 'agent'
  if (config.authMethod === 'password') return 'password'
  const raw = config.privateKeyPath ? expandPath(config.privateKeyPath) : ''
  return `key:${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`
}
