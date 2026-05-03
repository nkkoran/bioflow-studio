import { Client } from 'ssh2'
import type { ClientChannel, ConnectConfig, Prompt } from 'ssh2'
import { readFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync, appendFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { resolve as resolvePath } from 'path'
import { BrowserWindow } from 'electron'
import { execFile } from 'child_process'

import type { ConnectionConfig, ConnectionResult, ConnectionStatus, ExecResult, LoginPolicy, SshKeySetupRequest, SshKeySetupResult } from './types'
import { promptUser, type PromptRequestPayload } from './prompt'
import { OpenSshTransport, isOpenSshSessionInactiveError, type OpenSshConnectionHandle } from './OpenSshTransport'

interface ManagedConnection {
  client: Client | null
  config: ConnectionConfig
  connectedAt: number
  reconnecting: boolean
  transport: NonNullable<ConnectionConfig['transport']>
  openSshAlias?: string
  openSshControlPath?: string
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
    transport: config.transport ?? 'ssh2',
    name: config.name.trim(),
    host: config.host.trim(),
    username: config.username.trim(),
    privateKeyPath: config.privateKeyPath?.trim(),
    alias: config.alias?.trim(),
    defaultDirectory: config.defaultDirectory?.trim(),
  }
}

interface KeyboardInteractiveState {
  passwordAutoResponded: boolean
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
function buildConnectOptions(config: ConnectionConfig, onAuthDebug?: (detail: string) => void): ConnectConfig {
  const options: ConnectConfig = {
    host: config.host,
    port: config.port,
    username: config.username,
    readyTimeout: 90_000,
    tryKeyboard: true,
    keepaliveInterval: Math.max(15, Math.round(config.serverAliveIntervalSeconds ?? 60)) * 1000,
    keepaliveCountMax: 6,
    algorithms: ALGORITHMS,
    debug: (msg: string) => {
      if (/local ident|remote ident|handshake|kex|auth|offer|keyboard|ready|error|timeout|trying|connect|socket/i.test(msg)) {
        onAuthDebug?.(`ssh2: ${msg}`)
      }
    },
  }

  if (shouldForceIPv4ForHost(config.host)) {
    options.forceIPv4 = true
    onAuthDebug?.('Alliance / Compute Canada host detected; forcing IPv4 for the SSH socket before authentication starts.')
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
      console.log('[SSH] Password auth configured')
      onAuthDebug?.('Password auth configured. Using ssh2 default auth order with keyboard-interactive fallback enabled.')
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

function slugifySegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'host'
}

function sanitizeHostAlias(value: string): string {
  return value.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'bioflow'
}

function defaultAliasForRequest(request: SshKeySetupRequest): string {
  const preferred = request.alias?.trim()
  if (preferred) return sanitizeHostAlias(preferred)
  const nameLikeAlias = sanitizeHostAlias(request.host.split('.')[0] || request.username || request.host)
  return nameLikeAlias || `${slugifySegment(request.username)}-${slugifySegment(request.host)}`
}

function ensureBioflowSshConfig(request: SshKeySetupRequest & { keyPath: string }): { alias: string; configPath: string } {
  const sshDir = resolvePath(homedir(), '.ssh')
  const configDir = resolvePath(sshDir, 'config.d', 'bioflow')
  const configPath = resolvePath(configDir, `${defaultAliasForRequest(request)}.conf`)
  const includeLine = 'Include ~/.ssh/config.d/bioflow/*.conf'
  const rootConfigPath = resolvePath(sshDir, 'config')
  const alias = defaultAliasForRequest(request)
  const controlPersist = `${Math.max(1, Math.round(request.controlPersistHours ?? 8))}h`
  const serverAliveInterval = Math.max(15, Math.round(request.serverAliveIntervalSeconds ?? 60))

  mkdirSync(configDir, { recursive: true })
  mkdirSync(resolvePath(sshDir, 'controlmasters'), { recursive: true })

  const hostBlock = [
    '# Managed by BioFlow Studio',
    `Host ${alias}`,
    `  HostName ${request.host}`,
    `  User ${request.username}`,
    `  Port ${request.port}`,
    `  IdentityFile ${request.keyPath}`,
    '  IdentitiesOnly yes',
    '  PreferredAuthentications publickey,keyboard-interactive',
    '  ControlMaster auto',
    '  ControlPath ~/.ssh/controlmasters/%C',
    `  ControlPersist ${controlPersist}`,
    `  ServerAliveInterval ${serverAliveInterval}`,
    process.platform === 'darwin' ? '  UseKeychain yes' : '',
    process.platform === 'darwin' ? '  AddKeysToAgent yes' : '',
    '',
  ].filter(Boolean).join('\n')
  writeFileSync(configPath, hostBlock, { encoding: 'utf8', mode: 0o600 })

  if (!existsSync(rootConfigPath)) {
    writeFileSync(rootConfigPath, `${includeLine}\n`, { encoding: 'utf8', mode: 0o600 })
  } else {
    const current = readFileSync(rootConfigPath, 'utf8')
    if (!current.includes(includeLine)) {
      const suffix = current.endsWith('\n') ? '' : '\n'
      appendFileSync(rootConfigPath, `${suffix}${includeLine}\n`, { encoding: 'utf8' })
    }
  }

  return { alias, configPath }
}

function execFilePromise(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || stdout).trim()))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function shouldAutoRespondPasswordPrompt(
  config: ConnectionConfig,
  promptText: string,
  instructions: string,
  state: KeyboardInteractiveState,
): boolean {
  if (!promptText.includes('password')) return false
  if (!config.password) return false
  if (config.authMethod !== 'password') return false
  if (state.passwordAutoResponded) return false

  const combinedText = `${instructions}\n${promptText}`
  if (looksLikeChoicePrompt(combinedText) || looksLikeVerificationPrompt(combinedText)) {
    return false
  }

  return true
}

function looksLikeChoicePrompt(text: string): boolean {
  return /(duo|push|passcode|phone call|sms|select one|choice|option|1\.)/i.test(text)
}

function looksLikeVerificationPrompt(text: string): boolean {
  return /(verification|authenticator|otp|totp|token|passcode|code|duo)/i.test(text)
}

function hostSuggestion(host: string): string | null {
  const normalized = host.trim().toLowerCase()
  if (normalized === 'rorqual.mcgill.ca') return 'rorqual.alliancecan.ca'
  if (normalized === 'rorqual.digitalalliance.ca') return 'rorqual.alliancecan.ca'
  if (normalized.endsWith('.digitalalliance.ca')) {
    return host.replace(/\.digitalalliance\.ca$/i, '.alliancecan.ca')
  }
  return null
}

function shouldForceIPv4ForHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === 'rorqual.alliancecan.ca' ||
    normalized.endsWith('.alliancecan.ca') ||
    normalized.endsWith('.computecanada.ca')
}

interface ErrorLike {
  message?: unknown
  name?: unknown
  code?: unknown
  errno?: unknown
  syscall?: unknown
  address?: unknown
  port?: unknown
  level?: unknown
  errors?: unknown[]
  cause?: unknown
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberField(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}

function formatSingleError(err: unknown): string {
  if (err instanceof Error) {
    const like = err as ErrorLike
    const prefix = [
      stringField(like.code),
      stringField(like.level) ? `level=${stringField(like.level)}` : null,
      stringField(like.syscall) ? `syscall=${stringField(like.syscall)}` : null,
      stringField(like.address) ? `address=${stringField(like.address)}${numberField(like.port) ? `:${numberField(like.port)}` : ''}` : null,
    ].filter(Boolean)
    const message = err.message.trim()
    if (message) return [...prefix, message].join(' ')
    return prefix.join(' ') || err.name || 'Unknown error'
  }
  if (typeof err === 'string') return err
  return String(err)
}

function collectErrorDetails(err: unknown, seen = new Set<unknown>()): string[] {
  if (err === null || err === undefined || seen.has(err)) return []
  if (typeof err === 'object') seen.add(err)

  const like = err as ErrorLike
  const details: string[] = []
  const current = formatSingleError(err)
  if (current && current !== 'AggregateError') details.push(current)

  if (Array.isArray(like.errors)) {
    for (const nested of like.errors) {
      details.push(...collectErrorDetails(nested, seen))
    }
  }
  if (like.cause) {
    details.push(...collectErrorDetails(like.cause, seen))
  }

  return details
}

function describeSystemError(err: unknown): string {
  const unique = Array.from(new Set(collectErrorDetails(err).map((line) => line.trim()).filter(Boolean)))
  return unique.length > 0 ? unique.join('\n') : String(err)
}

function systemErrorBlock(err: unknown): string {
  const detail = describeSystemError(err)
  if (!detail.includes('\n')) return `System error: ${detail}`
  return `System error:\n${detail.split('\n').map((line) => `- ${line}`).join('\n')}`
}

function buildConnectionFailureMessage(err: Error, config: ConnectionConfig): string {
  const message = err.message || String(err)
  const code = typeof (err as NodeJS.ErrnoException).code === 'string'
    ? (err as NodeJS.ErrnoException).code
    : ''
  const level = typeof (err as { level?: unknown }).level === 'string'
    ? String((err as { level?: unknown }).level)
    : ''
  const systemDetails = describeSystemError(err)
  const text = `${code} ${level} ${message} ${systemDetails}`.toLowerCase()
  const target = `${config.username}@${config.host}:${config.port}`
  const suggestion = hostSuggestion(config.host)

  if (/enotfound|getaddrinfo|notfound/.test(text)) {
    return [
      `Could not find the host ${config.host}.`,
      '',
      'This failed before password or MFA authentication started, so changing the password will not fix this particular error.',
      suggestion ? `For Rorqual, try host: ${suggestion}` : 'Check the host spelling, your DNS/network connection, and whether the cluster requires VPN or campus network access.',
      '',
      `Target: ${target}`,
      systemErrorBlock(err),
    ].join('\n')
  }

  if (/etimeout|timed out|ehostunreach|enetunreach/.test(text)) {
    return [
      `Could not reach ${config.host}:${config.port}.`,
      '',
      'The hostname resolved, but the network connection did not complete. Check your internet/VPN, campus firewall rules, and whether the cluster is currently accepting SSH connections.',
      '',
      `Target: ${target}`,
      systemErrorBlock(err),
    ].join('\n')
  }

  if (/aggregateerror|client-socket|econnreset|econnaborted|econnhostunreach|eaddrnotavail/.test(text)) {
    return [
      `Could not open a complete SSH session to ${config.host}:${config.port}.`,
      '',
      'The app reached the socket layer, but the server did not complete the SSH identification/handshake step. This happens before password or MFA, so a missing MFA prompt here is a connection or server-availability problem rather than a wrong password.',
      shouldForceIPv4ForHost(config.host)
        ? 'For this Alliance / Compute Canada host, BioFlow forced IPv4. If it still fails here, check the connection trace for the nested socket error and the current cluster status.'
        : 'Check the nested socket error below, then confirm the hostname, port, VPN/firewall path, and cluster status.',
      '',
      `Target: ${target}`,
      `Auth method: ${config.authMethod}`,
      systemErrorBlock(err),
    ].join('\n')
  }

  if (/econnrefused|connection refused/.test(text)) {
    return [
      `The host ${config.host} refused SSH on port ${config.port}.`,
      '',
      'The host is reachable, but nothing accepted the SSH connection on that port. Check the port and the cluster login hostname.',
      '',
      `Target: ${target}`,
      systemErrorBlock(err),
    ].join('\n')
  }

  if (/configured authentication methods failed|all configured methods failed|permission denied|authentication failed/.test(text)) {
    return [
      'SSH authentication failed.',
      '',
      config.authMethod === 'password'
        ? 'Check the account password first. If no MFA prompt appeared, the server likely rejected password auth before it reached the second-factor step, or password login is not enabled for this host. For Alliance clusters, key auth plus keyboard-interactive MFA is often the more reliable path.'
        : 'Check the selected authentication method and any MFA prompt from the cluster.',
      '',
      `Target: ${target}`,
      `Auth method: ${config.authMethod}`,
      systemErrorBlock(err),
    ].join('\n')
  }

  if (/handshake|algorithm|kex|cipher|host key/.test(text)) {
    return [
      'SSH reached the host but could not complete the cryptographic handshake.',
      '',
      'This usually means the server only supports algorithms outside BioFlow\'s allowlist, or the SSH service is not the expected cluster login node.',
      '',
      `Target: ${target}`,
      systemErrorBlock(err),
    ].join('\n')
  }

  return [
    `SSH connection to ${config.host} failed.`,
    '',
    `Target: ${target}`,
    `Auth method: ${config.authMethod}`,
    systemErrorBlock(err),
  ].join('\n')
}

function buildPromptRequest(
  config: ConnectionConfig,
  title: string,
  instructions: string,
  prompt: Prompt,
): PromptRequestPayload {
  const promptLabel = prompt.prompt.trim() || 'Authentication response'
  const normalizedInstructions = instructions.trim()
  const combined = [normalizedInstructions, promptLabel].filter(Boolean).join('\n')
  const passwordPrompt = /password/i.test(promptLabel)
  const choicePrompt = looksLikeChoicePrompt(combined)
  const verificationPrompt =
    choicePrompt ||
    looksLikeVerificationPrompt(combined) ||
    (config.authMethod === 'password' && passwordPrompt)

  const detailParts: string[] = []
  if (normalizedInstructions) detailParts.push(normalizedInstructions)
  if (promptLabel) detailParts.push(`Prompt: ${promptLabel}`)

  if (choicePrompt) {
    return {
      title,
      message: 'Choose an authentication option to continue.',
      detail: detailParts.join('\n\n'),
      isPassword: false,
      placeholder: 'Enter 1 for push, or type a passcode',
    }
  }

  if (verificationPrompt) {
    const detail = [
      ...detailParts,
      passwordPrompt
        ? 'Alliance / Compute Canada often labels the MFA step as "Password:". Enter your authenticator code or a menu choice such as 1 for Duo Push when offered.'
        : '',
    ].filter(Boolean).join('\n\n')
    return {
      title,
      message: 'Enter the requested multi-factor authentication response.',
      detail,
      isPassword: false,
      placeholder: passwordPrompt ? 'Code or menu choice (for example 1 for push)' : 'Enter code or choice',
    }
  }

  return {
    title,
    message: 'Enter the authentication response requested by the server.',
    detail: detailParts.join('\n\n') || undefined,
    isPassword: prompt.echo === false,
    placeholder: prompt.echo === false ? 'Enter password' : 'Enter response',
  }
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

  async setupKey(request: SshKeySetupRequest): Promise<SshKeySetupResult> {
    if (!request.password) {
      throw new Error('A password is required to install the generated SSH key on the remote host.')
    }

    const sshDir = resolvePath(homedir(), '.ssh')
    mkdirSync(sshDir, { recursive: true })
    const filename = `bioflow_${slugifySegment(request.host)}_${slugifySegment(request.username)}`
    const keyPath = resolvePath(sshDir, filename)
    const publicKeyPath = `${keyPath}.pub`

    if (!request.overwrite && (existsSync(keyPath) || existsSync(publicKeyPath))) {
      throw new Error(`A BioFlow key already exists at ${keyPath}. Enable overwrite to replace it.`)
    }
    if (request.overwrite) {
      if (existsSync(keyPath)) unlinkSync(keyPath)
      if (existsSync(publicKeyPath)) unlinkSync(publicKeyPath)
    }

    await execFilePromise('ssh-keygen', [
      '-t', 'ed25519',
      '-N', '',
      '-f', keyPath,
      '-C', request.comment?.trim() || `bioflow_${request.username}@${request.host}`,
    ])

    const publicKey = readFileSync(publicKeyPath, 'utf8').trim()
    const tempName = `setup-${request.username}@${request.host}`
    const temp = await this.connect({
      name: tempName,
      host: request.host,
      port: request.port,
      username: request.username,
      authMethod: 'password',
      password: request.password,
    })
    try {
      const installCommand = [
        'umask 077',
        'mkdir -p ~/.ssh',
        'touch ~/.ssh/authorized_keys',
        `grep -qxF ${shellQuote(publicKey)} ~/.ssh/authorized_keys || printf '%s\\n' ${shellQuote(publicKey)} >> ~/.ssh/authorized_keys`,
        'chmod 700 ~/.ssh',
        'chmod 600 ~/.ssh/authorized_keys',
      ].join(' && ')
      const install = await this.exec(temp.id, installCommand)
      if (install.exitCode !== 0) {
        throw new Error((install.stderr || install.stdout || 'Could not install SSH key on remote host').trim())
      }
    } finally {
      await this.disconnect(temp.id)
    }

    let agentAdded = false
    let keychainAdded = false
    if (request.addToAgent && process.env.SSH_AUTH_SOCK) {
      await execFilePromise('ssh-add', [keyPath])
      agentAdded = true
    }
    if (request.addToKeychain && process.platform === 'darwin') {
      await execFilePromise('ssh-add', ['--apple-use-keychain', keyPath])
      keychainAdded = true
    } else if (request.addToKeychain && process.env.SSH_AUTH_SOCK && !agentAdded) {
      await execFilePromise('ssh-add', [keyPath]).catch(() => undefined)
      agentAdded = true
    }

    let alias: string | undefined
    let configPath: string | undefined
    if (request.writeConfig !== false) {
      const configResult = ensureBioflowSshConfig({ ...request, keyPath })
      alias = configResult.alias
      configPath = configResult.configPath
    }

    const noteParts = [
      `Key installation succeeded at ${keyPath}.`,
      alias ? `OpenSSH alias ready: ssh ${alias}` : '',
      configPath ? `BioFlow wrote ${configPath}.` : '',
      'Some clusters may still prompt for a TOTP code even with key-based auth.',
    ].filter(Boolean)

    return {
      keyPath,
      publicKeyPath,
      publicKey,
      agentAdded,
      keychainAdded,
      alias,
      configPath,
      note: noteParts.join(' '),
    }
  }

  async connect(config: ConnectionConfig): Promise<ConnectionResult> {
    const cleanConfig = normalizeConnectionConfig(config)
    if (cleanConfig.transport === 'openssh-controlpersist') {
      return this.connectOpenSsh(cleanConfig)
    }
    return this.connectSsh2(cleanConfig)
  }

  private async connectOpenSsh(cleanConfig: ConnectionConfig): Promise<ConnectionResult> {
    const dedupeKey = connectionDedupeKey(cleanConfig)
    const reusable = this.findReusableConnection(dedupeKey)
    if (reusable) {
      this.emitDebug(reusable.id, 'connect', `Reused existing OpenSSH ControlPersist connection for ${cleanConfig.username}@${cleanConfig.host}`)
      return {
        id: reusable.id,
        host: cleanConfig.host,
        username: cleanConfig.username,
        reused: true,
        transport: 'openssh-controlpersist',
      }
    }

    const id = randomUUID()
    this.emitDebug(id, 'connect', `Connecting to ${cleanConfig.host}:${cleanConfig.port} as ${cleanConfig.username} with OpenSSH ControlPersist`)
    try {
      const result = await OpenSshTransport.getInstance().connect(cleanConfig, (stage, detail) => this.emitDebug(id, stage, detail))
      const nextConfig = { ...cleanConfig, alias: result.alias, writeConfig: true }
      this.connections.set(id, {
        client: null,
        config: nextConfig,
        connectedAt: Date.now(),
        reconnecting: false,
        transport: 'openssh-controlpersist',
        openSshAlias: result.alias,
        openSshControlPath: result.controlPath,
      })
      this.connectionKeys.set(id, dedupeKey)
      this.emitDebug(id, 'connect', result.reused ? 'OpenSSH ControlPersist master reused' : 'OpenSSH ControlPersist master ready')
      this.sendStatusChange(id, true)
      void this.getLoginPolicy(id).catch((err) => {
        console.warn(`[SSH] login policy probe failed for ${id}:`, err instanceof Error ? err.message : err)
      })
      return {
        id,
        host: cleanConfig.host,
        username: cleanConfig.username,
        reused: result.reused,
        transport: 'openssh-controlpersist',
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emitDebug(id, 'error', `${message}. Disable OpenSSH persistence for this connection to use the legacy ssh2 transport.`)
      throw err
    }
  }

  private connectSsh2(cleanConfig: ConnectionConfig): Promise<ConnectionResult> {
    return new Promise((resolve, reject) => {
      const dedupeKey = connectionDedupeKey(cleanConfig)
      const reusable = this.findReusableConnection(dedupeKey)
      if (reusable) {
        this.emitDebug(reusable.id, 'connect', `Reused existing SSH session for ${cleanConfig.username}@${cleanConfig.host}`)
        resolve({ id: reusable.id, host: cleanConfig.host, username: cleanConfig.username, reused: true, transport: 'ssh2' })
        return
      }

      const client = new Client()
      const id = randomUUID()
      let resolved = false
      const keyboardInteractiveState: KeyboardInteractiveState = { passwordAutoResponded: false }

      let connectOptions: ConnectConfig
      try {
        connectOptions = buildConnectOptions(cleanConfig, (detail) => this.emitDebug(id, 'auth', detail))
      } catch (err) {
        reject(err)
        return
      }

      this.emitDebug(id, 'connect', `Connecting to ${cleanConfig.host}:${cleanConfig.port} as ${cleanConfig.username} with ${cleanConfig.authMethod}`)
      if (cleanConfig.alias) {
        this.emitDebug(
          id,
          'connect',
          `OpenSSH alias "${cleanConfig.alias}" is configured for Terminal use. BioFlow uses an in-app ssh2 session for exec/SFTP, so OpenSSH ControlPersist sockets are not shared with BioFlow yet; keeping this app connection open is the current in-app MFA reuse path.`,
        )
      }
      if (cleanConfig.authMethod === 'password') {
        this.emitDebug(id, 'auth', 'Password auth selected. BioFlow will send the account password to ssh2, then ask you for any MFA code or Duo choice requested through keyboard-interactive.')
      }

      /**
       * Handle keyboard-interactive auth.
       *
       * HPC clusters (Compute Canada / Alliance) use multi-factor auth:
       *   1. publickey auth succeeds (partial success)
       *   2. Server then requires keyboard-interactive for MFA (TOTP code)
       *
       * In password-auth mode, the first keyboard-interactive "Password:"
       * prompt is often the account password step. After that, later prompts
       * are typically MFA choices/codes. For key auth, the keyboard-interactive
       * prompts are usually MFA-only and are shown to the user.
       */
      client.on('keyboard-interactive', (_name, instructions, _lang, prompts, finish) => {
        console.log(`[SSH] keyboard-interactive: instructions="${instructions}", prompts=${JSON.stringify(prompts.map(p => p.prompt))}`)
        this.emitDebug(id, 'auth', `Keyboard-interactive auth requested ${prompts.length} prompt(s)`)

        // Process all prompts, potentially async
        const processPrompts = async () => {
          const responses: string[] = []

          for (const prompt of prompts) {
            const promptText = prompt.prompt.toLowerCase()

            // In password-auth mode, some hosts ask for the account password
            // via keyboard-interactive before they prompt for MFA choices/codes.
            if (shouldAutoRespondPasswordPrompt(cleanConfig, promptText, instructions, keyboardInteractiveState)) {
              this.emitDebug(id, 'prompt', 'Auto-responded to "password" prompt with the stored password')
              responses.push(cleanConfig.password!)
              keyboardInteractiveState.passwordAutoResponded = true
            }
            // For MFA/verification/OTP prompts, or any unknown prompt, ask the user
            else {
              this.emitDebug(id, 'prompt', `Prompted user for: ${prompt.prompt || instructions || 'verification code'}`)
              const userInput = await promptUser(
                buildPromptRequest(cleanConfig, 'Authentication Required', instructions, prompt),
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
          transport: 'ssh2',
        })
        this.connectionKeys.set(id, dedupeKey)
        this.emitDebug(id, 'connect', 'SSH session ready')
        this.sendStatusChange(id, true)
        void this.getLoginPolicy(id).catch((err) => {
          console.warn(`[SSH] login policy probe failed for ${id}:`, err instanceof Error ? err.message : err)
        })
        resolve({ id, host: cleanConfig.host, username: cleanConfig.username, transport: 'ssh2' })
      })

      client.on('error', (err) => {
        console.error(`[SSH] Error:`, describeSystemError(err), (err as any).level)
        const failureMessage = buildConnectionFailureMessage(err, cleanConfig)
        this.emitDebug(id, 'error', failureMessage)
        if (!resolved) {
          resolved = true
          const enhanced = new Error(failureMessage)
          reject(enhanced)
          return
        }
        const conn = this.connections.get(id)
        if (conn && !conn.reconnecting) {
          this.markConnectionUnavailable(id, 'SSH session hit an error; background reconnect is disabled to avoid surprise MFA prompts.')
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
          this.markConnectionUnavailable(id, 'SSH session closed; reconnect manually when you need cluster access again.')
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
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.webContents.isDestroyed()) {
            win.webContents.send('ssh:banner', { connectionId: id, message })
          }
        }
      })

      console.log(`[SSH] Connecting to ${cleanConfig.host}:${cleanConfig.port} as ${cleanConfig.username} (auth: ${cleanConfig.authMethod})`)
      this.emitDebug(id, 'connect', 'Opening TCP connection to SSH server; waiting up to 90 seconds for SSH ready/auth completion')
      client.connect(connectOptions)
    })
  }

  async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id)
    if (!conn) return
    conn.reconnecting = true
    try {
      if (conn.transport === 'openssh-controlpersist' && conn.openSshAlias && conn.openSshControlPath) {
        this.emitDebug(id, 'connect', 'Detached BioFlow from the OpenSSH ControlPersist session; the master socket remains available for quick reconnect.')
      } else {
        conn.client?.end()
      }
    } catch (err) {
      this.emitDebug(id, 'error', err instanceof Error ? err.message : String(err))
    }
    this.connections.delete(id)
    this.connectionKeys.delete(id)
    this.loginPolicies.delete(id)
    this.loginPolicyPromises.delete(id)
    this.sendStatusChange(id, false)
  }

  clearCachedState(id: string): void {
    this.loginPolicies.delete(id)
    this.loginPolicyPromises.delete(id)
  }

  getStatus(id: string): ConnectionStatus | null {
    const conn = this.connections.get(id)
    if (!conn) return null
    return {
      connected: !conn.reconnecting,
      host: conn.config.host,
      username: conn.config.username,
      uptime: Date.now() - conn.connectedAt,
      transport: conn.transport,
    }
  }

  getClient(id: string): Client | null {
    const conn = this.connections.get(id)
    return conn && !conn.reconnecting && conn.transport === 'ssh2' ? conn.client : null
  }

  isConnectionReady(id: string): boolean {
    const conn = this.connections.get(id)
    return Boolean(conn && !conn.reconnecting)
  }

  getOpenSshConnection(id: string): OpenSshConnectionHandle | null {
    const conn = this.connections.get(id)
    if (!conn || conn.reconnecting || conn.transport !== 'openssh-controlpersist' || !conn.openSshAlias || !conn.openSshControlPath) return null
    return {
      connectionId: id,
      config: conn.config,
      alias: conn.openSshAlias,
      controlPath: conn.openSshControlPath,
    }
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

  private async execOnce(id: string, command: string): Promise<ExecResult> {
    const openSsh = this.getOpenSshConnection(id)
    if (openSsh) {
      try {
        return await OpenSshTransport.getInstance().exec(openSsh, command, (stage, detail) => this.emitDebug(id, stage, detail))
      } catch (err) {
        if (isOpenSshSessionInactiveError(err)) {
          this.markConnectionUnavailable(id, 'OpenSSH ControlPersist session expired; reconnect manually before cluster operations continue.')
        }
        throw err
      }
    }

    return new Promise((resolve, reject) => {
      const conn = this.connections.get(id)
      if (!conn) {
        reject(new Error(`Connection ${id} not found`))
        return
      }
      if (conn.reconnecting) {
        reject(new Error(`Connection ${id} is reconnecting`))
        return
      }
      if (!conn.client) {
        reject(new Error(`Connection ${id} does not have an ssh2 client`))
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
    const openSsh = this.getOpenSshConnection(id)
    if (openSsh) {
      return OpenSshTransport.getInstance().execStream(
        openSsh,
        command,
        onData,
        onClose,
        (stage, detail) => this.emitDebug(id, stage, detail),
      )
    }

    const conn = this.connections.get(id)
    if (!conn) return { cancel: () => {} }
    if (conn.reconnecting) return { cancel: () => {} }
    if (!conn.client) return { cancel: () => {} }

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
      if (conn.transport === 'openssh-controlpersist') {
        reject(new Error('The in-app terminal still uses ssh2 in this release. Open a system terminal with the generated ssh alias for OpenSSH persisted sessions.'))
        return
      }
      if (conn.reconnecting) {
        reject(new Error(`Connection ${id} is reconnecting`))
        return
      }
      if (!conn.client) {
        reject(new Error(`Connection ${id} does not have an ssh2 client`))
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

  markConnectionUnavailable(id: string, detail: string): void {
    const conn = this.connections.get(id)
    if (!conn || conn.reconnecting) return
    conn.reconnecting = true
    this.emitDebug(id, 'connect', detail)
    this.sendStatusChange(id, false)
  }

  private sendStatusChange(id: string, status: boolean | string): void {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      const statusStr = typeof status === 'string' ? status :
        status ? 'connected' : 'disconnected'
      const conn = this.connections.get(id)
      win.webContents.send('ssh:status-change', {
        connectionId: id,
        status: statusStr,
        transport: conn?.transport,
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
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.isDestroyed()) continue
      win.webContents.send('ssh:debug', {
        connectionId,
        stage,
        detail,
        at: Date.now(),
      })
    }
  }
}

function connectionDedupeKey(config: ConnectionConfig): string {
  return [
    config.transport ?? 'ssh2',
    config.host,
    config.port,
    config.username,
  ].join(':')
}
