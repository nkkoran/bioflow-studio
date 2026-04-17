import { Client } from 'ssh2'
import type { ClientChannel, ConnectConfig } from 'ssh2'
import { readFileSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { resolve as resolvePath } from 'path'
import { BrowserWindow, ipcMain } from 'electron'

import type { ConnectionConfig, ConnectionResult, ConnectionStatus, ExecResult } from './types'

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
      options.password = config.password
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

export class SshManager {
  private static instance: SshManager
  private connections = new Map<string, ManagedConnection>()

  private constructor() { }

  static getInstance(): SshManager {
    if (!SshManager.instance) {
      SshManager.instance = new SshManager()
    }
    return SshManager.instance
  }

  connect(config: ConnectionConfig): Promise<ConnectionResult> {
    return new Promise((resolve, reject) => {
      let connectOptions: ConnectConfig
      try {
        connectOptions = buildConnectOptions(config)
      } catch (err) {
        reject(err)
        return
      }

      const client = new Client()
      const id = randomUUID()
      let resolved = false

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

        // Process all prompts, potentially async
        const processPrompts = async () => {
          const responses: string[] = []

          for (const prompt of prompts) {
            const promptText = prompt.prompt.toLowerCase()

            // If it's asking for a password and we have one, auto-respond
            if (promptText.includes('password') && config.password) {
              responses.push(config.password)
            }
            // For MFA/verification/OTP prompts, or any unknown prompt, ask the user
            else {
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
          config,
          connectedAt: Date.now(),
          reconnecting: false,
        })
        this.sendStatusChange(id, true)
        resolve({ id, host: config.host, username: config.username })
      })

      client.on('error', (err) => {
        console.error(`[SSH] Error:`, err.message, (err as any).level)
        if (!resolved) {
          resolved = true
          const enhanced = new Error(
            `SSH connection to ${config.host} failed: ${err.message}\n` +
            `Auth method: ${config.authMethod}, User: ${config.username}`
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
      })

      // Show server banner (HPC clusters often show MFA enrollment messages)
      client.on('banner', (message) => {
        console.log(`[SSH] Server banner:\n${message}`)
        // Forward banner to renderer so user can see it
        const win = BrowserWindow.getAllWindows()[0]
        if (win) {
          win.webContents.send('ssh:banner', { connectionId: id, message })
        }
      })

      console.log(`[SSH] Connecting to ${config.host}:${config.port} as ${config.username} (auth: ${config.authMethod})`)
      client.connect(connectOptions)
    })
  }

  disconnect(id: string): void {
    const conn = this.connections.get(id)
    if (!conn) return
    conn.reconnecting = true
    conn.client.end()
    this.connections.delete(id)
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

  exec(id: string, command: string): Promise<ExecResult> {
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
          const processPrompts = async () => {
            const responses: string[] = []
            for (const prompt of prompts) {
              const promptText = prompt.prompt.toLowerCase()
              if (promptText.includes('password') && config.password) {
                responses.push(config.password)
              } else {
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
          this.sendStatusChange(id, true)
        })

        newClient.on('error', () => {
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
}
