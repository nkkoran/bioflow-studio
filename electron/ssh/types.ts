export interface ConnectionConfig {
  name: string
  host: string
  port: number
  username: string
  authMethod: 'key' | 'password' | 'agent'
  privateKeyPath?: string
  passphrase?: string
  password?: string
  defaultDirectory?: string
}

export interface ConnectionResult {
  id: string
  host: string
  username: string
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
