import { spawn } from 'child_process'
import { createServer, type Server } from 'http'
import { createHash, randomUUID } from 'crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'fs'
import { promises as fs } from 'fs'
import { homedir, tmpdir } from 'os'
import { resolve as resolvePath } from 'path'
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'child_process'
import type { ConnectionConfig, ExecResult, FileStat, RemoteFileEntry } from './types'
import { promptUser, type PromptRequestPayload } from './prompt'

export interface OpenSshConnectionHandle {
  connectionId: string
  config: ConnectionConfig
  alias: string
  controlPath: string
}

export type OpenSshDebugStage = 'connect' | 'auth' | 'prompt' | 'banner' | 'error'
export type OpenSshDebugSink = (stage: OpenSshDebugStage, detail: string) => void
export type OpenSshProgressCallback = (bytesTransferred: number, totalBytes?: number) => void

interface AskpassBridge {
  env: NodeJS.ProcessEnv
  cleanup: () => Promise<void>
}

interface PromptBridge {
  url: string
  cleanup: () => Promise<void>
}

interface AskpassState {
  passwordAutoResponded: boolean
}

interface SpawnResult {
  stdout: Buffer
  stderr: Buffer
  exitCode: number
}

interface OpenSshBaseArgOptions {
  batchMode?: boolean
}

export interface PtyInvocation {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
  cleanup?: () => Promise<void>
  resize?: (cols: number, rows: number) => void
}

export class OpenSshTransport {
  private static instance: OpenSshTransport

  static getInstance(): OpenSshTransport {
    if (!OpenSshTransport.instance) {
      OpenSshTransport.instance = new OpenSshTransport()
    }
    return OpenSshTransport.instance
  }

  async connect(config: ConnectionConfig, debug: OpenSshDebugSink): Promise<{ alias: string; reused: boolean; controlPath: string }> {
    if (process.platform === 'win32') {
      throw new Error('OpenSSH ControlPersist transport is currently supported on macOS and Linux. Disable OpenSSH persistence for this connection on Windows.')
    }

    const alias = bioflowOpenSshAlias(config)
    const controlPath = bioflowControlPath(config)
    const baseArgs = buildOpenSshBaseArgs(config, controlPath)
    const checkArgs = buildOpenSshMasterCheckArgs(config, controlPath)
    debug('connect', `Using OpenSSH ControlPersist socket "${controlPath}" for ${config.username}@${config.host}:${config.port}`)

    const check = await this.runLocalSsh(checkArgs, nonInteractiveOpenSshEnv())
    if (check.exitCode === 0) {
      debug('connect', `Reused existing OpenSSH ControlPersist master for ${config.host}`)
      return { alias, controlPath, reused: true }
    }

    debug('connect', `No OpenSSH master socket found for ${config.host}; starting one`)
    const start = await this.startMaster(config, baseArgs, debug)
    if (start.exitCode !== 0) {
      throw new Error(formatOpenSshFailure('Could not start OpenSSH ControlPersist master', start))
    }

    const verify = await this.runLocalSsh(checkArgs, nonInteractiveOpenSshEnv())
    if (verify.exitCode !== 0) {
      throw new Error(formatOpenSshFailure('OpenSSH ControlPersist master did not become available', verify))
    }

    debug('connect', `OpenSSH ControlPersist master ready for ${config.host}`)
    return { alias, controlPath, reused: false }
  }

  async disconnect(handle: OpenSshConnectionHandle): Promise<void> {
    const result = await this.runLocalSsh([...buildOpenSshBaseArgs(handle.config, handle.controlPath, { batchMode: true }), '-O', 'exit', handle.config.host], nonInteractiveOpenSshEnv())
    if (result.exitCode !== 0 && !/No such file|not running|Control socket connect/i.test(result.stderr.toString('utf8'))) {
      throw new Error(formatOpenSshFailure('Could not close OpenSSH ControlPersist master', result))
    }
  }

  async exec(handle: OpenSshConnectionHandle, command: string, debug?: OpenSshDebugSink): Promise<ExecResult> {
    const result = await this.runRemoteBuffered(handle, command, debug)
    return {
      stdout: result.stdout.toString('utf8'),
      stderr: result.stderr.toString('utf8'),
      exitCode: result.exitCode,
    }
  }

  execStream(
    handle: OpenSshConnectionHandle,
    command: string,
    onData: (chunk: string, stream: 'stdout' | 'stderr') => void,
    onClose?: (exitCode: number | null) => void,
    debug?: OpenSshDebugSink,
  ): { cancel: () => void } {
    let child: ChildProcessWithoutNullStreams | null = null
    let active = true

    const env = nonInteractiveOpenSshEnv()
    debug?.('connect', 'Starting OpenSSH stream in non-interactive ControlPersist mode')
    Promise.resolve().then(async () => {
      if (!active) return
      await this.ensureMasterAvailable(handle, debug)
      await new Promise<void>((resolve) => {
        child = spawn('ssh', this.remoteArgs(handle, command, { batchMode: true }), { env })
        child.stdout.on('data', (chunk: Buffer) => {
          if (active) onData(chunk.toString('utf8'), 'stdout')
        })
        child.stderr.on('data', (chunk: Buffer) => {
          if (active) onData(chunk.toString('utf8'), 'stderr')
        })
        child.stdin.on('error', () => undefined)
        child.on('error', (err) => {
          if (active) onData(err.message, 'stderr')
          if (active) onClose?.(null)
          active = false
          resolve()
        })
        child.on('close', (code) => {
          if (active) onClose?.(code)
          active = false
          resolve()
        })
        child.stdin.end()
      })
    }).catch((err) => {
      if (active) {
        onData(err instanceof Error ? err.message : String(err), 'stderr')
        onClose?.(null)
      }
    })

    return {
      cancel: () => {
        active = false
        child?.kill()
      },
    }
  }

  async ls(handle: OpenSshConnectionHandle, remotePath: string): Promise<RemoteFileEntry[]> {
    const command = [
      `dir=${openSshShellQuote(remotePath)}`,
      '[ -d "$dir" ] || exit 2',
      'find "$dir" -mindepth 1 -maxdepth 1 -printf \'%f\\0%p\\0%y\\0%Y\\0%s\\0%T@\\0%M\\0\'',
    ].join('; ')
    const result = await this.runRemoteBuffered(handle, command)
    assertRemoteSuccess('List remote directory', result)
    return parseOpenSshFindOutput(result.stdout)
  }

  async stat(handle: OpenSshConnectionHandle, remotePath: string): Promise<FileStat> {
    const command = `stat -Lc '%s\\t%Y\\t%f\\t%A' -- ${openSshShellQuote(remotePath)}`
    const result = await this.runRemoteBuffered(handle, command)
    assertRemoteSuccess('Stat remote path', result)
    return parseOpenSshStatOutput(result.stdout.toString('utf8'))
  }

  async readBuffer(handle: OpenSshConnectionHandle, remotePath: string, offset?: number, length?: number): Promise<Buffer> {
    const command = offset != null || length != null
      ? [
        `dd if=${openSshShellQuote(remotePath)} bs=1`,
        offset != null ? `skip=${Math.max(0, Math.floor(offset))}` : '',
        length != null ? `count=${Math.max(0, Math.floor(length))}` : '',
        'status=none',
      ].filter(Boolean).join(' ')
      : `cat -- ${openSshShellQuote(remotePath)}`
    const result = await this.runRemoteBuffered(handle, command)
    assertRemoteSuccess('Read remote file', result)
    return result.stdout
  }

  async head(handle: OpenSshConnectionHandle, remotePath: string, lines: number): Promise<string> {
    const count = Math.max(1, Math.floor(lines))
    const result = await this.runRemoteBuffered(handle, `head -n ${count} -- ${openSshShellQuote(remotePath)}`)
    assertRemoteSuccess('Read remote file head', result)
    return result.stdout.toString('utf8')
  }

  async mkdir(handle: OpenSshConnectionHandle, remotePath: string): Promise<void> {
    const result = await this.runRemoteBuffered(handle, `mkdir -p -- ${openSshShellQuote(remotePath)}`)
    assertRemoteSuccess('Create remote directory', result)
  }

  async rename(handle: OpenSshConnectionHandle, oldPath: string, newPath: string): Promise<void> {
    const result = await this.runRemoteBuffered(handle, `mv -- ${openSshShellQuote(oldPath)} ${openSshShellQuote(newPath)}`)
    assertRemoteSuccess('Rename remote path', result)
  }

  async remove(handle: OpenSshConnectionHandle, remotePath: string): Promise<void> {
    const result = await this.runRemoteBuffered(handle, `rm -rf -- ${openSshShellQuote(remotePath)}`)
    assertRemoteSuccess('Delete remote path', result)
  }

  async write(handle: OpenSshConnectionHandle, remotePath: string, content: string): Promise<void> {
    const result = await this.runRemoteWithInput(handle, `cat > ${openSshShellQuote(remotePath)}`, Buffer.from(content, 'utf8'))
    assertRemoteSuccess('Write remote file', result)
  }

  async upload(handle: OpenSshConnectionHandle, localPath: string, remotePath: string, onProgress?: OpenSshProgressCallback): Promise<void> {
    const total = await fs.stat(localPath).then((stat) => stat.size).catch(() => undefined)
    await this.ensureMasterAvailable(handle)
    const result = await new Promise<SpawnResult>((resolve, reject) => {
      const child = spawn('ssh', this.remoteArgs(handle, `cat > ${openSshShellQuote(remotePath)}`, { batchMode: true }), { env: nonInteractiveOpenSshEnv() })
      const stderr: Buffer[] = []
      let transferred = 0
      const input = createReadStream(localPath)
      input.on('data', (chunk: Buffer) => {
        transferred += chunk.length
        onProgress?.(transferred, total)
      })
      input.on('error', reject)
      child.stdin.on('error', reject)
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.on('error', reject)
      child.on('close', (code) => {
        resolve({ stdout: Buffer.alloc(0), stderr: Buffer.concat(stderr), exitCode: code ?? 0 })
      })
      input.pipe(child.stdin)
    })
    assertRemoteSuccess('Upload remote file', result)
    onProgress?.(total ?? 0, total)
  }

  async download(handle: OpenSshConnectionHandle, remotePath: string, localPath: string, onProgress?: OpenSshProgressCallback): Promise<void> {
    await fs.mkdir(parentDir(localPath), { recursive: true }).catch(() => undefined)
    const total = await this.stat(handle, remotePath).then((stat) => stat.size).catch(() => undefined)
    await this.ensureMasterAvailable(handle)
    const result = await new Promise<SpawnResult>((resolve, reject) => {
      const child = spawn('ssh', this.remoteArgs(handle, `cat -- ${openSshShellQuote(remotePath)}`, { batchMode: true }), { env: nonInteractiveOpenSshEnv() })
      const output = createWriteStream(localPath)
      const stderr: Buffer[] = []
      let transferred = 0
      let exitCode: number | null = null
      let outputFinished = false
      const maybeResolve = () => {
        if (exitCode === null || !outputFinished) return
        resolve({ stdout: Buffer.alloc(0), stderr: Buffer.concat(stderr), exitCode })
      }
      child.stdout.on('data', (chunk: Buffer) => {
        transferred += chunk.length
        onProgress?.(transferred, total)
      })
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.on('error', reject)
      output.on('error', reject)
      output.on('finish', () => {
        outputFinished = true
        maybeResolve()
      })
      child.on('close', (code) => {
        exitCode = code ?? 0
        maybeResolve()
      })
      child.stdout.pipe(output)
    })
    assertRemoteSuccess('Download remote file', result)
    onProgress?.(total ?? 0, total)
  }

  private async runRemoteBuffered(handle: OpenSshConnectionHandle, command: string, debug?: OpenSshDebugSink): Promise<SpawnResult> {
    debug?.('connect', 'Running OpenSSH command in non-interactive ControlPersist mode')
    await this.ensureMasterAvailable(handle, debug)
    return this.spawnBuffered('ssh', this.remoteArgs(handle, command, { batchMode: true }), { env: nonInteractiveOpenSshEnv() })
  }

  private async runRemoteWithInput(handle: OpenSshConnectionHandle, command: string, input: Buffer): Promise<SpawnResult> {
    await this.ensureMasterAvailable(handle)
    return this.spawnBuffered('ssh', this.remoteArgs(handle, command, { batchMode: true }), { env: nonInteractiveOpenSshEnv() }, input)
  }

  private async ensureMasterAvailable(handle: OpenSshConnectionHandle, debug?: OpenSshDebugSink): Promise<void> {
    const result = await this.runLocalSsh(buildOpenSshMasterCheckArgs(handle.config, handle.controlPath), nonInteractiveOpenSshEnv())
    if (result.exitCode === 0) return
    debug?.('error', 'OpenSSH ControlPersist master is not active; refusing background authentication.')
    throw new Error(formatOpenSshInactiveFailure(result))
  }

  private remoteArgs(handle: OpenSshConnectionHandle, command: string, options?: OpenSshBaseArgOptions): string[] {
    return [...buildOpenSshBaseArgs(handle.config, handle.controlPath, options), handle.config.host, '--', command]
  }

  private async runLocalSsh(args: string[], env?: NodeJS.ProcessEnv): Promise<SpawnResult> {
    return this.spawnBuffered('ssh', args, { env })
  }

  private async startMaster(config: ConnectionConfig, baseArgs: string[], debug: OpenSshDebugSink): Promise<SpawnResult> {
    const sshArgs = [...baseArgs, '-MNf', config.host]
    const promptBridge = await createPromptBridge(config, debug)
    try {
      const ptyInvocation = buildPtyInvocation('ssh', sshArgs, promptBridge.url)
      if (ptyInvocation) {
        debug('connect', 'Starting OpenSSH master through expect-managed pseudo-terminal for keyboard-interactive MFA')
        try {
          return await this.spawnPtyInteractive(ptyInvocation)
        } catch (err) {
          debug('connect', `Expect pseudo-terminal startup was unavailable (${err instanceof Error ? err.message : String(err)}); falling back to SSH_ASKPASS`)
        } finally {
          await ptyInvocation.cleanup?.()
        }
      }
    } finally {
      await promptBridge.cleanup()
    }

    debug('connect', 'Starting OpenSSH master with SSH_ASKPASS')
    return this.withAskpass(config, debug, (env) => this.runLocalSsh(sshArgs, env))
  }

  private spawnBuffered(command: string, args: string[], options: SpawnOptionsWithoutStdio = {}, input?: Buffer): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, options)
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.stdin.on('error', () => undefined)
      child.on('error', reject)
      child.on('close', (code) => {
        resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code ?? 0 })
      })
      child.stdin.end(input)
    })
  }

  private spawnPtyInteractive(invocation: PtyInvocation): Promise<SpawnResult> {
    return this.spawnBuffered(invocation.command, invocation.args, { env: invocation.env ?? process.env })
  }

  private async withAskpass<T>(
    config: ConnectionConfig,
    debug: OpenSshDebugSink,
    run: (env: NodeJS.ProcessEnv) => Promise<T>,
  ): Promise<T> {
    const bridge = await createAskpassBridge(config, debug)
    try {
      return await run(bridge.env)
    } finally {
      await bridge.cleanup()
    }
  }
}

export function ensureOpenSshConnectionConfig(config: ConnectionConfig): { alias: string; configPath: string } {
  const sshDir = resolvePath(homedir(), '.ssh')
  const configDir = resolvePath(sshDir, 'config.d', 'bioflow')
  const alias = bioflowOpenSshAlias(config)
  const configPath = resolvePath(configDir, `${alias}.conf`)
  const includeLine = 'Include ~/.ssh/config.d/bioflow/*.conf'
  const rootConfigPath = resolvePath(sshDir, 'config')

  mkdirSync(configDir, { recursive: true })
  mkdirSync(resolvePath(sshDir, 'controlmasters'), { recursive: true })

  writeFileSync(configPath, buildOpenSshHostBlock(config, alias), { encoding: 'utf8', mode: 0o600 })

  ensureBioFlowIncludeFirst(rootConfigPath, includeLine)

  return { alias, configPath }
}

export function buildOpenSshHostBlock(config: ConnectionConfig, alias = bioflowOpenSshAlias(config)): string {
  const controlPersist = `${Math.max(1, Math.round(config.controlPersistHours ?? 8))}h`
  const serverAliveInterval = Math.max(15, Math.round(config.serverAliveIntervalSeconds ?? 60))
  const lines = [
    '# Managed by BioFlow Studio',
    `Host ${alias}`,
    `  HostName ${config.host}`,
    `  User ${config.username}`,
    `  Port ${config.port}`,
    config.authMethod === 'key' && config.privateKeyPath ? `  IdentityFile ${expandPath(config.privateKeyPath)}` : '',
    config.authMethod === 'key' ? '  IdentitiesOnly yes' : '',
    `  PreferredAuthentications ${preferredAuthentications(config.authMethod)}`,
    '  ControlMaster auto',
    '  ControlPath ~/.ssh/controlmasters/%C',
    `  ControlPersist ${controlPersist}`,
    `  ServerAliveInterval ${serverAliveInterval}`,
    '  ServerAliveCountMax 6',
    process.platform === 'darwin' && config.authMethod === 'key' ? '  UseKeychain yes' : '',
    process.platform === 'darwin' && config.authMethod === 'key' ? '  AddKeysToAgent yes' : '',
    '',
  ]
  return lines.filter(Boolean).join('\n')
}

export function sanitizeOpenSshAlias(value: string): string {
  return value.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'bioflow'
}

export function bioflowOpenSshAlias(config: Pick<ConnectionConfig, 'host' | 'port' | 'username'>): string {
  return sanitizeOpenSshAlias(`bioflow-${config.username}-${config.host}-${config.port}`)
}

export function bioflowControlPath(config: Pick<ConnectionConfig, 'host' | 'port' | 'username'>): string {
  const sshDir = resolvePath(homedir(), '.ssh')
  const controlDir = resolvePath(sshDir, 'controlmasters')
  mkdirSync(controlDir, { recursive: true })
  const digest = createHash('sha256')
    .update(`${config.username}@${config.host}:${config.port}`)
    .digest('hex')
    .slice(0, 24)
  return resolvePath(controlDir, `bioflow-${digest}`)
}

export function buildOpenSshBaseArgs(config: ConnectionConfig, controlPath = bioflowControlPath(config), options: OpenSshBaseArgOptions = {}): string[] {
  const args = [
    '-F', '/dev/null',
    '-S', controlPath,
    '-l', config.username,
    '-p', String(config.port),
    '-o', 'ControlMaster=auto',
    '-o', `ControlPersist=${Math.max(1, Math.round(config.controlPersistHours ?? 8))}h`,
    '-o', `ServerAliveInterval=${Math.max(15, Math.round(config.serverAliveIntervalSeconds ?? 60))}`,
    '-o', 'ServerAliveCountMax=6',
    '-o', `NumberOfPasswordPrompts=${options.batchMode ? 0 : 3}`,
    '-o', `PreferredAuthentications=${preferredAuthentications(config.authMethod)}`,
  ]
  if (options.batchMode) {
    args.push(
      '-o', 'BatchMode=yes',
      '-o', 'PasswordAuthentication=no',
      '-o', 'KbdInteractiveAuthentication=no',
    )
  }
  if (config.authMethod === 'key' && config.privateKeyPath) {
    args.push('-i', expandPath(config.privateKeyPath), '-o', 'IdentitiesOnly=yes')
  }
  return args
}

export function buildOpenSshMasterCheckArgs(config: ConnectionConfig, controlPath = bioflowControlPath(config)): string[] {
  return [...buildOpenSshBaseArgs(config, controlPath, { batchMode: true }), '-O', 'check', config.host]
}

export function buildOpenSshTerminalArgs(handle: OpenSshConnectionHandle): string[] {
  return [
    ...buildOpenSshBaseArgs(handle.config, handle.controlPath),
    '-tt',
    handle.config.host,
  ]
}

export function buildPtyInvocation(command: string, args: string[], promptUrl = 'http://127.0.0.1:9/askpass'): PtyInvocation | null {
  const expectPath = findExpectCommand()
  if (!expectPath) return null

  const helperDir = mkdtempSync(resolvePath(tmpdir(), 'bioflow-expect-'))
  const scriptPath = resolvePath(helperDir, 'openssh-controlpersist.exp')
  writeFileSync(scriptPath, buildExpectScript(), { encoding: 'utf8', mode: 0o700 })

  return {
    command: expectPath,
    args: ['-f', scriptPath, '--', command, ...args],
    env: {
      ...process.env,
      BIOFLOW_PROMPT_URL: promptUrl,
    },
    cleanup: async () => {
      await fs.rm(helperDir, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

export function buildOpenSshTerminalPtyInvocation(command: string, args: string[], cols = 120, rows = 30): PtyInvocation | null {
  const expectPath = findExpectCommand()
  if (!expectPath) return null

  const helperDir = mkdtempSync(resolvePath(tmpdir(), 'bioflow-terminal-'))
  const scriptPath = resolvePath(helperDir, 'openssh-terminal.exp')
  const sizePath = resolvePath(helperDir, 'size')
  writeFileSync(sizePath, `${Math.max(20, Math.floor(cols))} ${Math.max(8, Math.floor(rows))}\n`, { encoding: 'utf8', mode: 0o600 })
  writeFileSync(scriptPath, buildOpenSshTerminalExpectScript(), { encoding: 'utf8', mode: 0o700 })

  return {
    command: expectPath,
    args: ['-f', scriptPath, '--', command, ...args],
    env: {
      ...process.env,
      TERM: process.env.TERM || 'xterm-256color',
      BIOFLOW_TERM_SIZE_FILE: sizePath,
    },
    resize: (nextCols, nextRows) => {
      writeFileSync(sizePath, `${Math.max(20, Math.floor(nextCols))} ${Math.max(8, Math.floor(nextRows))}\n`, { encoding: 'utf8', mode: 0o600 })
    },
    cleanup: async () => {
      await fs.rm(helperDir, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

export function buildExpectScript(): string {
  return [
    'log_user 1',
    'set timeout 180',
    'set prompt_url $env(BIOFLOW_PROMPT_URL)',
    '',
    'proc bioflow_prompt {prompt} {',
    '  global prompt_url',
    '  if {[catch {exec curl --silent --show-error --fail --max-time 190 --data-binary $prompt $prompt_url} answer]} {',
    '    puts stderr $answer',
    '    exit 255',
    '  }',
    '  return [string trimright $answer "\\r\\n"]',
    '}',
    '',
    'spawn {*}$argv',
    'expect {',
    '  -re {Passcode or option \\([^)]+\\): *$} {',
    '    send -- "[bioflow_prompt $expect_out(buffer)]\\r"',
    '    exp_continue',
    '  }',
    '  -re {Are you sure you want to continue connecting \\(yes/no([^)]*)?\\)\\? *$} {',
    '    send -- "[bioflow_prompt $expect_out(buffer)]\\r"',
    '    exp_continue',
    '  }',
    '  -re {Enter passphrase for key [^\\r\\n]+: *$} {',
    '    send -- "[bioflow_prompt $expect_out(buffer)]\\r"',
    '    exp_continue',
    '  }',
    '  -re {[^\\r\\n]{0,160}([Pp]assword|[Vv]erification code|[Pp]asscode|[Aa]uthenticator code|TOTP|OTP|[Tt]oken)[^:\\r\\n]*: *$} {',
    '    send -- "[bioflow_prompt $expect_out(buffer)]\\r"',
    '    exp_continue',
    '  }',
    '  timeout {',
    '    puts stderr "Timed out while waiting for OpenSSH ControlPersist master authentication"',
    '    exit 255',
    '  }',
    '  eof {',
    '    set result [wait]',
    '    if {[llength $result] >= 4} {',
    '      exit [lindex $result 3]',
    '    }',
    '    exit 0',
    '  }',
    '}',
    '',
  ].join('\n')
}

export function buildOpenSshTerminalExpectScript(): string {
  return [
    'log_user 0',
    'set timeout -1',
    '',
    'proc bioflow_apply_size {} {',
    '  global env spawn_out',
    '  if {![info exists env(BIOFLOW_TERM_SIZE_FILE)]} { return }',
    '  if {![info exists spawn_out(slave,name)]} { return }',
    '  if {[catch {open $env(BIOFLOW_TERM_SIZE_FILE) r} file]} { return }',
    '  set raw [string trim [read $file]]',
    '  close $file',
    '  if {[regexp {^([0-9]+)[[:space:]]+([0-9]+)$} $raw -> cols rows]} {',
    '    catch {stty rows $rows columns $cols < $spawn_out(slave,name)}',
    '  }',
    '}',
    '',
    'proc bioflow_schedule_size {} {',
    '  bioflow_apply_size',
    '  after 500 bioflow_schedule_size',
    '}',
    '',
    'spawn {*}$argv',
    'bioflow_schedule_size',
    'interact',
    'set result [wait]',
    'if {[llength $result] >= 4} {',
    '  exit [lindex $result 3]',
    '}',
    'exit 0',
    '',
  ].join('\n')
}

export function extractOpenSshInteractivePrompt(transcript: string): string | null {
  const tail = stripTerminalControls(transcript).slice(-4000)
  const patterns = [
    /((?:Duo two-factor login[\s\S]*?Passcode or option \([^)]+\):\s*))$/i,
    /((?:Enter a passcode[\s\S]*?Passcode or option \([^)]+\):\s*))$/i,
    /((?:Are you sure you want to continue connecting \(yes\/no(?:\/\[fingerprint\])?\)\?\s*))$/i,
    /((?:Enter passphrase for key ['"][^'"]+['"]:\s*))$/i,
    /((?:[^:\n\r]{0,120}(?:password|verification code|passcode|authenticator code|totp|otp|token)[^:\n\r]*:\s*))$/i,
  ]

  for (const pattern of patterns) {
    const match = tail.match(pattern)
    if (match?.[1]) return match[1].trimEnd()
  }
  return null
}

export function openSshShellQuote(value: string): string {
  if (/^[A-Za-z0-9_\-./~:=,%+@]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export function parseOpenSshFindOutput(buffer: Buffer): RemoteFileEntry[] {
  const fields = buffer.toString('utf8').split('\0')
  const entries: RemoteFileEntry[] = []
  for (let i = 0; i + 6 < fields.length; i += 7) {
    const [name, path, type, targetType, size, modified, permissions] = fields.slice(i, i + 7)
    if (!name || !path) continue
    const isDirectory = type === 'd' || targetType === 'd'
    const dotIndex = name.lastIndexOf('.')
    entries.push({
      name,
      path,
      isDirectory,
      size: Number(size) || 0,
      modified: Math.round((Number(modified) || 0) * 1000),
      permissions: permissions || (isDirectory ? 'drwx------' : '-rw-------'),
      extension: !isDirectory && dotIndex > 0 ? name.slice(dotIndex + 1) : '',
    })
  }
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return entries
}

export function parseOpenSshStatOutput(stdout: string): FileStat {
  const [sizeRaw, modifiedRaw, modeHexRaw, permissionsRaw] = stdout.trim().split('\t')
  const mode = Number.parseInt(modeHexRaw ?? '0', 16)
  return {
    size: Number(sizeRaw) || 0,
    modified: (Number(modifiedRaw) || 0) * 1000,
    isDirectory: (mode & 0o170000) === 0o040000,
    permissions: permissionsRaw || modeToPermissions(mode),
  }
}

export function shouldAutoRespondOpenSshPrompt(config: ConnectionConfig, prompt: string, state: AskpassState): boolean {
  const normalized = prompt.toLowerCase()
  if (state.passwordAutoResponded) return false
  if (config.authMethod !== 'password') return false
  if (!config.password) return false
  if (!/password/.test(normalized)) return false
  if (looksLikeVerificationPrompt(normalized) || looksLikeChoicePrompt(normalized)) return false
  state.passwordAutoResponded = true
  return true
}

async function createAskpassBridge(config: ConnectionConfig, debug: OpenSshDebugSink): Promise<AskpassBridge> {
  const promptBridge = await createPromptBridge(config, debug)
  const helperDir = await fs.mkdtemp(resolvePath(tmpdir(), 'bioflow-askpass-'))
  const helperPath = resolvePath(helperDir, 'askpass.sh')
  writeFileSync(helperPath, [
    '#!/bin/sh',
    'prompt="$*"',
    'if command -v curl >/dev/null 2>&1; then',
    `  printf '%s' "$prompt" | exec curl --silent --show-error --fail --max-time 75 --data-binary @- ${openSshShellQuote(promptBridge.url)}`,
    'fi',
    'printf "%s" ""',
    'exit 1',
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o700 })
  chmodSync(helperPath, 0o700)

  return {
    env: {
      ...process.env,
      SSH_ASKPASS: helperPath,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || 'bioflow',
    },
    cleanup: async () => {
      await promptBridge.cleanup()
      await fs.rm(helperDir, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

async function createPromptBridge(config: ConnectionConfig, debug: OpenSshDebugSink): Promise<PromptBridge> {
  const token = randomUUID()
  const state: AskpassState = { passwordAutoResponded: false }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'POST' || url.pathname !== '/askpass' || url.searchParams.get('token') !== token) {
      response.writeHead(403)
      response.end()
      return
    }

    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', async () => {
      const prompt = Buffer.concat(chunks).toString('utf8').trim() || 'OpenSSH authentication prompt'
      try {
        if (shouldAutoRespondOpenSshPrompt(config, prompt, state)) {
          debug('prompt', `Auto-responded to OpenSSH password prompt for ${config.username}@${config.host}`)
          response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
          response.end(`${config.password ?? ''}\n`)
          return
        }
        debug('prompt', `Prompted user for OpenSSH prompt: ${prompt}`)
        const answer = await promptUser(buildOpenSshInteractivePromptRequest(config, prompt))
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end(`${answer ?? ''}\n`)
      } catch (err) {
        response.writeHead(500)
        response.end(err instanceof Error ? err.message : String(err))
      }
    })
  })
  await listenLocal(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not start OpenSSH askpass bridge')
  const url = `http://127.0.0.1:${address.port}/askpass?token=${token}`

  return {
    url,
    cleanup: async () => {
      await closeServer(server)
    },
  }
}

function buildOpenSshInteractivePromptRequest(config: ConnectionConfig, prompt: string): PromptRequestPayload {
  const normalized = prompt.toLowerCase()
  const choicePrompt = looksLikeChoicePrompt(normalized)
  const verificationPrompt = choicePrompt || looksLikeVerificationPrompt(normalized)
  const host = `${config.username}@${config.host}`

  if (/are you sure you want to continue connecting/i.test(prompt)) {
    return {
      title: 'Confirm SSH Host Key',
      message: 'OpenSSH needs confirmation before connecting to this host.',
      detail: prompt,
      isPassword: false,
      placeholder: 'Type yes to continue',
    }
  }

  if (choicePrompt) {
    return {
      title: 'OpenSSH MFA Required',
      message: 'Choose an authentication option to continue.',
      detail: `${host} is using OpenSSH ControlPersist.\n\n${prompt}`,
      isPassword: false,
      placeholder: 'Enter 1 for Duo Push, or type a passcode',
    }
  }

  if (verificationPrompt) {
    return {
      title: 'OpenSSH MFA Required',
      message: 'Enter the requested multi-factor authentication response.',
      detail: `${host} is using OpenSSH ControlPersist.\n\n${prompt}`,
      isPassword: false,
      placeholder: 'Enter code or choice',
    }
  }

  return {
    title: 'OpenSSH Authentication Required',
    message: 'Enter the response requested by OpenSSH.',
    detail: `${host} is using OpenSSH ControlPersist.\n\n${prompt}`,
    isPassword: /passphrase|password/i.test(prompt),
    placeholder: /passphrase|password/i.test(prompt) ? 'Enter password or passphrase' : 'Enter response',
  }
}

function summarizeInteractivePrompt(prompt: string): string {
  if (/duo|passcode or option|select one/i.test(prompt)) return 'Prompted user for OpenSSH Duo/MFA option'
  if (/passphrase/i.test(prompt)) return 'Prompted user for OpenSSH key passphrase'
  if (/password/i.test(prompt)) return 'Prompted user for OpenSSH password'
  if (/are you sure you want to continue connecting/i.test(prompt)) return 'Prompted user to confirm SSH host key'
  return 'Prompted user for OpenSSH authentication response'
}

function describeSubmittedInteractiveAnswer(prompt: string, answer: string): string {
  if (/are you sure you want to continue connecting/i.test(prompt)) return 'Submitted OpenSSH host-key confirmation response'
  if (/duo|passcode or option|select one/i.test(prompt) && /^\d+$/.test(answer)) {
    return `Submitted OpenSSH MFA menu option ${answer}; waiting for server response`
  }
  return 'Submitted OpenSSH authentication response; waiting for server response'
}

function normalizeInteractiveAnswer(prompt: string, answer: string): string {
  if (/duo|passcode|verification|authenticator|totp|otp|token|password|passphrase/i.test(prompt)) {
    return answer.trim()
  }
  return answer.trim()
}

function shouldRedactInteractiveAnswer(prompt: string, answer: string): boolean {
  if (!answer) return false
  if (/duo|passcode or option|select one/i.test(prompt) && /^\d$/.test(answer)) return false
  return /passcode|verification|authenticator|totp|otp|token|password|passphrase/i.test(prompt) || answer.length >= 4
}

function sanitizeTerminalTranscript(value: string, sensitiveAnswers: string[]): string {
  let next = stripTerminalControls(value)
  for (const answer of sensitiveAnswers) {
    if (!answer) continue
    next = next.split(answer).join('[redacted]')
  }
  return next
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
    .replace(/\u0004/g, '')
    .replace(/\^D\b\b/g, '')
}

function findExpectCommand(): string | null {
  for (const candidate of ['/usr/bin/expect', '/bin/expect']) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function listenLocal(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

function nonInteractiveOpenSshEnv(): NodeJS.ProcessEnv {
  const {
    SSH_ASKPASS: _sshAskpass,
    SSH_ASKPASS_REQUIRE: _sshAskpassRequire,
    BIOFLOW_PROMPT_URL: _bioflowPromptUrl,
    ...env
  } = process.env
  return env
}

function preferredAuthentications(authMethod: ConnectionConfig['authMethod']): string {
  if (authMethod === 'password') return 'password,keyboard-interactive'
  return 'publickey,keyboard-interactive,password'
}

function expandPath(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    return resolvePath(homedir(), filePath.slice(2))
  }
  return resolvePath(filePath)
}

function fsReadFileSyncUtf8(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function ensureBioFlowIncludeFirst(rootConfigPath: string, includeLine: string): void {
  if (!existsSync(rootConfigPath)) {
    writeFileSync(rootConfigPath, `${includeLine}\n`, { encoding: 'utf8', mode: 0o600 })
    return
  }

  const current = fsReadFileSyncUtf8(rootConfigPath)
  const lines = current.split(/\r?\n/)
  const withoutManagedInclude = lines.filter((line) => line.trim() !== includeLine)
  if (lines[0]?.trim() === includeLine && withoutManagedInclude.length === lines.length - 1) return
  const body = withoutManagedInclude.join('\n').replace(/^\n+/, '')
  const next = body ? `${includeLine}\n${body.endsWith('\n') ? body : `${body}\n`}` : `${includeLine}\n`
  writeFileSync(rootConfigPath, next, { encoding: 'utf8', mode: 0o600 })
}

function assertRemoteSuccess(action: string, result: SpawnResult): void {
  if (result.exitCode !== 0) throw new Error(formatOpenSshFailure(action, result))
}

function formatOpenSshFailure(action: string, result: SpawnResult): string {
  const stderr = result.stderr.toString('utf8').trim()
  const stdout = result.stdout.toString('utf8').trim()
  return `${action} failed via OpenSSH ControlPersist (exit ${result.exitCode}). ${stderr || stdout || 'No error output'}`
}

export function isOpenSshSessionInactiveError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('OpenSSH ControlPersist session is not active')
}

function formatOpenSshInactiveFailure(result: SpawnResult): string {
  const stderr = result.stderr.toString('utf8').trim()
  const stdout = result.stdout.toString('utf8').trim()
  const detail = stderr || stdout
  return `OpenSSH ControlPersist session is not active. Reconnect before browsing files or running cluster operations.${detail ? ` ${detail}` : ''}`
}

function looksLikeChoicePrompt(text: string): boolean {
  return /(duo|push|phone call|sms|select one|choice|option|1\.)/i.test(text)
}

function looksLikeVerificationPrompt(text: string): boolean {
  return /(verification|authenticator|otp|totp|token|passcode|code|duo)/i.test(text)
}

function parentDir(filePath: string): string {
  const idx = filePath.lastIndexOf('/')
  return idx <= 0 ? '/' : filePath.slice(0, idx)
}

function modeToPermissions(mode: number): string {
  const types: Record<number, string> = {
    0o40000: 'd',
    0o120000: 'l',
    0o100000: '-',
  }

  const typeFlag = mode & 0o170000
  let result = types[typeFlag] ?? '-'
  const perms = ['r', 'w', 'x']
  for (let i = 2; i >= 0; i--) {
    const shift = i * 3
    for (let j = 2; j >= 0; j--) {
      result += mode & (1 << (shift + (2 - j))) ? perms[j] : '-'
    }
  }
  return result
}
