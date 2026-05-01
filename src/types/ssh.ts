export interface ConnectionConfig {
  name: string
  host: string
  port: number
  username: string
  authMethod: 'key' | 'password' | 'agent'
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

export interface ClusterModuleCheck {
  requested: string
  ok: boolean
  suggestions: ClusterModuleSuggestion[]
  message?: string
}

export interface ClusterModuleCheckResult {
  checks: ClusterModuleCheck[]
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
  agentAdded: boolean
  keychainAdded: boolean
  alias?: string
  configPath?: string
  note?: string
}
