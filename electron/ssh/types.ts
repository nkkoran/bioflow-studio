export interface ConnectionConfig {
  name: string
  host: string
  port: number
  username: string
  authMethod: 'key' | 'password' | 'agent'
  transport?: 'ssh2' | 'openssh-controlpersist'
  privateKeyPath?: string
  passphrase?: string
  password?: string
  rememberPassword?: boolean
  generatedKeyPath?: string
  setupNote?: string
  alias?: string
  writeConfig?: boolean
  controlPersistHours?: number
  serverAliveIntervalSeconds?: number
  defaultDirectory?: string
}

export interface ConnectionResult {
  id: string
  host: string
  username: string
  reused?: boolean
  transport?: NonNullable<ConnectionConfig['transport']>
}

export interface LoginPolicy {
  hostname: string
  cpuTimeLimitSeconds: number | null
  memLimitMB: number | null
  source: 'ulimit' | 'unknown'
}

export interface ConnectionStatus {
  connected: boolean
  host: string
  username: string
  uptime: number
  transport?: NonNullable<ConnectionConfig['transport']>
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface RemoteFileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modified: number
  permissions: string
  extension: string
}

export interface FileStat {
  size: number
  modified: number
  isDirectory: boolean
  permissions: string
}

export interface SshKeySetupRequest {
  host: string
  port: number
  username: string
  password: string
  comment?: string
  overwrite?: boolean
  addToAgent?: boolean
  addToKeychain?: boolean
  alias?: string
  writeConfig?: boolean
  controlPersistHours?: number
  serverAliveIntervalSeconds?: number
}

export interface SshKeySetupResult {
  keyPath: string
  publicKeyPath: string
  publicKey: string
  agentAdded: boolean
  keychainAdded: boolean
  alias?: string
  configPath?: string
  note?: string
}
