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
  reused?: boolean
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

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface SshDebugEvent {
  connectionId: string
  stage: 'connect' | 'auth' | 'prompt' | 'banner' | 'error'
  detail: string
  at: number
}

export interface ClusterAccountsResult {
  accounts: string[]
  source: 'sacctmgr' | 'sshare' | 'groups'
  cachedAt: number
}

export interface ClusterModuleSuggestion {
  name: string
  versions: string[]
  description?: string
  details?: string
}

export interface ClusterModulesResult {
  modules: ClusterModuleSuggestion[]
  source: 'module-spider' | 'module-avail'
  cachedAt: number
}

export interface LearnedResourceSummary {
  toolId: string
  sampleCount: number
  p50RuntimeHours: number
  p90RuntimeHours: number
  p90MemoryGB: number
  sourceJobIds: string[]
  lastUpdated: number
}
