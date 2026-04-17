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

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'
