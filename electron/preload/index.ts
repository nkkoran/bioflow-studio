import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DryRunScript, NodeRunState, PipelineSnapshot, RunState, RunStatus, SplitPattern } from '../../src/types/pipeline'
import type { AnnovarInstallRequest, AnnovarInstallProgress, AnnovarStatusResult } from '../../src/types/annotation'

// Types matching src/types/
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

export interface ConnectionStatus {
  connected: boolean
  host: string
  username: string
  uptime: number
}

export interface LoginPolicy {
  hostname: string
  cpuTimeLimitSeconds: number | null
  memLimitMB: number | null
  source: 'ulimit' | 'unknown'
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
  modified: number  // timestamp
  permissions: string
  extension: string
}

export interface FileStat {
  size: number
  modified: number
  isDirectory: boolean
  permissions: string
}

function normalizeRemoteFileEntries(value: unknown): RemoteFileEntry[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is RemoteFileEntry => {
    if (!entry || typeof entry !== 'object') return false
    const candidate = entry as Partial<RemoteFileEntry>
    return typeof candidate.name === 'string'
      && typeof candidate.path === 'string'
      && typeof candidate.isDirectory === 'boolean'
  })
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

export interface SlurmQueueEntry {
  jobId: string
  name: string
  state: string
  elapsed: string
  timeLimit: string
  partition: string
  reason: string
}

export interface SshDebugEvent {
  connectionId: string
  stage: 'connect' | 'auth' | 'prompt' | 'banner' | 'error'
  detail: string
  at: number
}

export interface SshPromptRequest {
  promptId: string
  title: string
  message: string
  detail?: string
  isPassword: boolean
  placeholder?: string
}

const api = {
  ssh: {
    connect: (config: ConnectionConfig): Promise<ConnectionResult> =>
      ipcRenderer.invoke('ssh:connect', config),
    disconnect: (id: string): Promise<void> =>
      ipcRenderer.invoke('ssh:disconnect', id),
    status: (id: string): Promise<ConnectionStatus | null> =>
      ipcRenderer.invoke('ssh:status', id),
    exec: (id: string, command: string): Promise<ExecResult> =>
      ipcRenderer.invoke('ssh:exec', id, command),
    setupKey: (request: SshKeySetupRequest): Promise<SshKeySetupResult> =>
      ipcRenderer.invoke('ssh:setup-key', request),
    /**
     * List every live SSH connection held by the main process. Used by the
     * renderer on mount to re-hydrate its connection store after a window
     * reload (main-process connections survive renderer reloads).
     */
    listConnections: (): Promise<Array<{ id: string; config: Omit<ConnectionConfig, 'password' | 'passphrase'>; connectedAt: number; connected: boolean }>> =>
      ipcRenderer.invoke('ssh:list-connections'),
    onStatusChange: (callback: (event: any, data: { connectionId: string; status: string }) => void): (() => void) => {
      const handler = (_event: any, data: any) => callback(_event, data)
      ipcRenderer.on('ssh:status-change', handler)
      return () => ipcRenderer.removeListener('ssh:status-change', handler)
    },
    /** Listen for MFA/2FA prompts from the main process */
    onPrompt: (callback: (data: SshPromptRequest) => void): (() => void) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('ssh:prompt', handler)
      return () => ipcRenderer.removeListener('ssh:prompt', handler)
    },
    /** Send the user's response to a prompt */
    respondToPrompt: (promptId: string, value: string | null): void => {
      ipcRenderer.send('ssh:prompt-response', { promptId, value })
    },
    /** Listen for server banners (e.g., MFA enrollment messages) */
    onBanner: (callback: (data: { connectionId: string; message: string }) => void): (() => void) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('ssh:banner', handler)
      return () => ipcRenderer.removeListener('ssh:banner', handler)
    },
    onDebug: (callback: (data: SshDebugEvent) => void): (() => void) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('ssh:debug', handler)
      return () => ipcRenderer.removeListener('ssh:debug', handler)
    },
  },
  sftp: {
    ls: async (id: string, remotePath: string): Promise<RemoteFileEntry[]> =>
      normalizeRemoteFileEntries(await ipcRenderer.invoke('sftp:ls', id, remotePath)),
    stat: (id: string, remotePath: string): Promise<FileStat> =>
      ipcRenderer.invoke('sftp:stat', id, remotePath),
    read: (id: string, remotePath: string, offset?: number, length?: number): Promise<string> =>
      ipcRenderer.invoke('sftp:read', id, remotePath, offset, length),
    readBase64: (id: string, remotePath: string, offset?: number, length?: number): Promise<string> =>
      ipcRenderer.invoke('sftp:read-base64', id, remotePath, offset, length),
    head: (id: string, remotePath: string, lines: number): Promise<string> =>
      ipcRenderer.invoke('sftp:head', id, remotePath, lines),
    mkdir: (id: string, remotePath: string): Promise<void> =>
      ipcRenderer.invoke('sftp:mkdir', id, remotePath),
    rename: (id: string, oldPath: string, newPath: string): Promise<void> =>
      ipcRenderer.invoke('sftp:rename', id, oldPath, newPath),
    delete: (id: string, remotePath: string): Promise<void> =>
      ipcRenderer.invoke('sftp:delete', id, remotePath),
    write: (id: string, remotePath: string, content: string): Promise<void> =>
      ipcRenderer.invoke('sftp:write', id, remotePath, content),
    upload: (id: string, localPath: string, remotePath: string): Promise<void> =>
      ipcRenderer.invoke('sftp:upload', id, localPath, remotePath)
  },
  terminal: {
    create: (connectionId: string): Promise<string> =>
      ipcRenderer.invoke('terminal:create', connectionId),
    resize: (terminalId: string, cols: number, rows: number): void => {
      ipcRenderer.send('terminal:resize', terminalId, cols, rows)
    },
    write: (terminalId: string, data: string): void => {
      ipcRenderer.send('terminal:write', terminalId, data)
    },
    close: (terminalId: string): void => {
      ipcRenderer.send('terminal:close', terminalId)
    },
    onData: (terminalId: string, callback: (data: string) => void): (() => void) => {
      const channel = `terminal:data:${terminalId}`
      const handler = (_event: any, data: string) => callback(data)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    onClose: (terminalId: string, callback: () => void): (() => void) => {
      const channel = `terminal:close:${terminalId}`
      const handler = () => callback()
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    }
  },
  store: {
    get: <T>(key: string): Promise<T | undefined> =>
      ipcRenderer.invoke('store:get', key),
    set: <T>(key: string, value: T): Promise<void> =>
      ipcRenderer.invoke('store:set', key, value),
    delete: (key: string): Promise<void> =>
      ipcRenderer.invoke('store:delete', key),
    getSecret: (key: string): Promise<string | undefined> =>
      ipcRenderer.invoke('store:get-secret', key),
    setSecret: (key: string, value: string): Promise<void> =>
      ipcRenderer.invoke('store:set-secret', key, value),
    deleteSecret: (key: string): Promise<void> =>
      ipcRenderer.invoke('store:delete-secret', key),
  },
  local: {
    ls: async (dirPath: string): Promise<RemoteFileEntry[]> =>
      normalizeRemoteFileEntries(await ipcRenderer.invoke('local:ls', dirPath)),
    stat: (filePath: string): Promise<FileStat> =>
      ipcRenderer.invoke('local:stat', filePath),
    read: (filePath: string, offset?: number, length?: number): Promise<string> =>
      ipcRenderer.invoke('local:read', filePath, offset, length),
    readBase64: (filePath: string, offset?: number, length?: number): Promise<string> =>
      ipcRenderer.invoke('local:read-base64', filePath, offset, length),
    head: (filePath: string, lines: number): Promise<string> =>
      ipcRenderer.invoke('local:head', filePath, lines),
    headGzip: (filePath: string, lines: number): Promise<string> =>
      ipcRenderer.invoke('local:head-gzip', filePath, lines),
    mkdir: (dirPath: string): Promise<void> =>
      ipcRenderer.invoke('local:mkdir', dirPath),
    rename: (oldPath: string, newPath: string): Promise<void> =>
      ipcRenderer.invoke('local:rename', oldPath, newPath),
    delete: (filePath: string): Promise<void> =>
      ipcRenderer.invoke('local:delete', filePath),
    write: (filePath: string, content: string): Promise<void> =>
      ipcRenderer.invoke('local:write', filePath, content),
    homedir: (): Promise<string> =>
      ipcRenderer.invoke('local:homedir'),
    pathForFile: (file: File): string =>
      webUtils.getPathForFile(file),
  },
  dialog: {
    openFile: (options?: { filters?: { name: string; extensions: string[] }[]; defaultPath?: string }): Promise<string | null> =>
      ipcRenderer.invoke('dialog:openFile', options),
    openDirectory: (options?: { defaultPath?: string }): Promise<string | null> =>
      ipcRenderer.invoke('dialog:openDirectory', options),
  },
  pipeline: {
    run: (connectionId: string, snapshot: PipelineSnapshot, workDir?: string, workspace?: RunState['workspace']): Promise<{ runId: string }> =>
      ipcRenderer.invoke('pipeline:run', { connectionId, snapshot, workDir, workspace }),
    cancel: (runId: string): Promise<void> =>
      ipcRenderer.invoke('pipeline:cancel', runId),
    cancelNode: (runId: string, nodeId: string): Promise<void> =>
      ipcRenderer.invoke('pipeline:cancel-node', { runId, nodeId }),
    cancelJob: (connectionId: string, jobId: string): Promise<void> =>
      ipcRenderer.invoke('pipeline:cancel-job', { connectionId, jobId }),
    rerunNode: (runId: string, nodeId: string, snapshot: PipelineSnapshot): Promise<void> =>
      ipcRenderer.invoke('pipeline:rerun-node', { runId, nodeId, snapshot }),
    listRuns: (): Promise<RunState[]> =>
      ipcRenderer.invoke('pipeline:list-runs'),
    getRun: (runId: string): Promise<RunState | null> =>
      ipcRenderer.invoke('pipeline:get-run', runId),
    listOutputs: (runId: string, nodeId: string): Promise<Array<{ name: string; path: string; size: number; modified: number }>> =>
      ipcRenderer.invoke('pipeline:list-outputs', { runId, nodeId }),
    generateScriptsDry: (connectionId: string, snapshot: PipelineSnapshot, workDir?: string): Promise<DryRunScript[]> =>
      ipcRenderer.invoke('pipeline:generate-scripts-dry', { connectionId, snapshot, workDir }),
    onNodeStatus: (callback: (data: { runId: string; nodeId: string; status: RunStatus | 'idle'; jobId?: string; error?: string; node?: NodeRunState }) => void): (() => void) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('pipeline:node-status', handler)
      return () => ipcRenderer.removeListener('pipeline:node-status', handler)
    },
    onRunStatus: (callback: (data: { runId: string; status: RunStatus }) => void): (() => void) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('pipeline:run-status', handler)
      return () => ipcRenderer.removeListener('pipeline:run-status', handler)
    },
    onJobLog: (callback: (data: { runId: string; nodeId: string; chunk: string; stream: 'stdout' | 'stderr' }) => void): (() => void) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('pipeline:job-log', handler)
      return () => ipcRenderer.removeListener('pipeline:job-log', handler)
    },
  },
  slurm: {
    queue: (connectionId: string): Promise<SlurmQueueEntry[]> =>
      ipcRenderer.invoke('slurm:queue', connectionId),
  },
  cluster: {
    loginPolicy: (connectionId: string): Promise<LoginPolicy> =>
      ipcRenderer.invoke('cluster:loginPolicy', connectionId),
    listAccounts: (connectionId: string): Promise<{ accounts: string[]; source: 'sacctmgr' | 'sshare' | 'groups'; cachedAt: number }> =>
      ipcRenderer.invoke('cluster:listAccounts', connectionId),
    listModules: (connectionId: string, query?: string, options?: { force?: boolean }) =>
      ipcRenderer.invoke('cluster:listModules', connectionId, query, options),
    getLearnedResources: (connectionId: string, toolId: string, options?: { force?: boolean }) =>
      ipcRenderer.invoke('cluster:getLearnedResources', connectionId, toolId, options),
    resetLearnedResources: (connectionId: string, toolId: string) =>
      ipcRenderer.invoke('cluster:resetLearnedResources', connectionId, toolId),
    clearCaches: (connectionId: string) =>
      ipcRenderer.invoke('cluster:clearCaches', connectionId),
  },
  annovar: {
    status: (connectionId: string, humandbPath: string, buildver: string, databases: string[]): Promise<AnnovarStatusResult> =>
      ipcRenderer.invoke('annovar:status', connectionId, humandbPath, buildver, databases),
    install: (request: AnnovarInstallRequest): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('annovar:install', request),
    onInstallProgress: (callback: (data: AnnovarInstallProgress) => void): (() => void) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('annovar:install-progress', handler)
      return () => ipcRenderer.removeListener('annovar:install-progress', handler)
    },
  },
  fs: {
    resolveSplit: (
      connectionId: string,
      pattern: SplitPattern,
      manualItems?: Array<{ key: string; path: string }>,
    ): Promise<{ items: Array<{ key: string; path: string }>; missing: string[] }> =>
      ipcRenderer.invoke('split:resolve', connectionId, pattern, manualItems),
  },
  app: {
    onMenuCommand: (callback: (data: { command: 'new' | 'open' | 'save' | 'saveAs' }) => void): (() => void) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('app:menu-command', handler)
      return () => ipcRenderer.removeListener('app:menu-command', handler)
    },
  }
}

contextBridge.exposeInMainWorld('api', api)

export type BioflowAPI = typeof api
