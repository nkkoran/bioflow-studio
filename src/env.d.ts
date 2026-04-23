/// <reference types="vite/client" />

// CSS module declarations
declare module '*.css' {
  const content: Record<string, string>
  export default content
}

declare module '@xterm/xterm/css/xterm.css'
declare module '@fontsource/jetbrains-mono/400.css'
declare module '@fontsource/jetbrains-mono/500.css'
declare module '@fontsource/jetbrains-mono/700.css'
declare module '@fontsource/inter/400.css'
declare module '@fontsource/inter/500.css'
declare module '@fontsource/inter/600.css'
declare module '@fontsource/inter/700.css'

// Preload API types
interface Window {
  api: {
    ssh: {
      connect: (config: import('./types/ssh').ConnectionConfig) => Promise<import('./types/ssh').ConnectionResult>
      disconnect: (id: string) => Promise<void>
      status: (id: string) => Promise<import('./types/ssh').ConnectionStatus | null>
      exec: (id: string, command: string) => Promise<import('./types/ssh').ExecResult>
      setupKey: (request: import('./types/ssh').SshKeySetupRequest) => Promise<import('./types/ssh').SshKeySetupResult>
      listConnections: () => Promise<Array<{ id: string; config: Omit<import('./types/ssh').ConnectionConfig, 'password' | 'passphrase'>; connectedAt: number; connected: boolean }>>
      onStatusChange: (callback: (event: any, data: { connectionId: string; status: string }) => void) => () => void
      onPrompt: (callback: (data: { promptId: string; title: string; message: string; detail?: string; isPassword: boolean; placeholder?: string }) => void) => () => void
      respondToPrompt: (promptId: string, value: string | null) => void
      onBanner: (callback: (data: { connectionId: string; message: string }) => void) => () => void
      onDebug: (callback: (data: import('./types/ssh').SshDebugEvent) => void) => () => void
    }
    sftp: {
      ls: (id: string, remotePath: string) => Promise<import('./types/files').RemoteFileEntry[]>
      stat: (id: string, remotePath: string) => Promise<import('./types/files').FileStat>
      read: (id: string, remotePath: string, offset?: number, length?: number) => Promise<string>
      readBase64: (id: string, remotePath: string, offset?: number, length?: number) => Promise<string>
      head: (id: string, remotePath: string, lines: number) => Promise<string>
      mkdir: (id: string, remotePath: string) => Promise<void>
      rename: (id: string, oldPath: string, newPath: string) => Promise<void>
      delete: (id: string, remotePath: string) => Promise<void>
      write: (id: string, remotePath: string, content: string) => Promise<void>
      upload: (id: string, localPath: string, remotePath: string) => Promise<void>
    }
    terminal: {
      create: (connectionId: string) => Promise<string>
      resize: (terminalId: string, cols: number, rows: number) => void
      write: (terminalId: string, data: string) => void
      close: (terminalId: string) => void
      onData: (terminalId: string, callback: (data: string) => void) => () => void
      onClose: (terminalId: string, callback: () => void) => () => void
    }
    store: {
      get: <T>(key: string) => Promise<T | undefined>
      set: <T>(key: string, value: T) => Promise<void>
      delete: (key: string) => Promise<void>
      getSecret: (key: string) => Promise<string | undefined>
      setSecret: (key: string, value: string) => Promise<void>
      deleteSecret: (key: string) => Promise<void>
    }
    local: {
      ls: (dirPath: string) => Promise<import('./types/files').RemoteFileEntry[]>
      stat: (filePath: string) => Promise<import('./types/files').FileStat>
      read: (filePath: string, offset?: number, length?: number) => Promise<string>
      readBase64: (filePath: string, offset?: number, length?: number) => Promise<string>
      head: (filePath: string, lines: number) => Promise<string>
      headGzip: (filePath: string, lines: number) => Promise<string>
      mkdir: (dirPath: string) => Promise<void>
      rename: (oldPath: string, newPath: string) => Promise<void>
      delete: (filePath: string) => Promise<void>
      write: (filePath: string, content: string) => Promise<void>
      homedir: () => Promise<string>
      pathForFile: (file: File) => string
    }
    dialog: {
      openFile: (options?: { filters?: { name: string; extensions: string[] }[]; defaultPath?: string }) => Promise<string | null>
      openDirectory: (options?: { defaultPath?: string }) => Promise<string | null>
    }
    pipeline: {
      run: (connectionId: string, snapshot: import('./types/pipeline').PipelineSnapshot, workDir?: string, workspace?: import('./types/pipeline').RunState['workspace']) => Promise<{ runId: string }>
      cancel: (runId: string) => Promise<void>
      cancelNode: (runId: string, nodeId: string) => Promise<void>
      cancelJob: (connectionId: string, jobId: string) => Promise<void>
      rerunNode: (runId: string, nodeId: string, snapshot: import('./types/pipeline').PipelineSnapshot) => Promise<void>
      listRuns: () => Promise<import('./types/pipeline').RunState[]>
      getRun: (runId: string) => Promise<import('./types/pipeline').RunState | null>
      listOutputs: (runId: string, nodeId: string) => Promise<Array<{ name: string; path: string; size: number; modified: number }>>
      generateScriptsDry: (connectionId: string, snapshot: import('./types/pipeline').PipelineSnapshot, workDir?: string) => Promise<import('./types/pipeline').DryRunScript[]>
      onNodeStatus: (callback: (data: { runId: string; nodeId: string; status: import('./types/pipeline').RunStatus | 'idle'; jobId?: string; error?: string; node?: import('./types/pipeline').NodeRunState }) => void) => () => void
      onRunStatus: (callback: (data: { runId: string; status: import('./types/pipeline').RunStatus }) => void) => () => void
      onJobLog: (callback: (data: { runId: string; nodeId: string; chunk: string; stream: 'stdout' | 'stderr' }) => void) => () => void
    }
    slurm: {
      queue: (connectionId: string) => Promise<Array<{
        jobId: string
        name: string
        state: string
        elapsed: string
        timeLimit: string
        partition: string
        reason: string
      }>>
    }
    cluster: {
      loginPolicy: (connectionId: string) => Promise<import('./types/ssh').LoginPolicy>
      listAccounts: (connectionId: string) => Promise<import('./types/ssh').ClusterAccountsResult>
      listModules: (connectionId: string, query?: string, options?: { force?: boolean }) => Promise<import('./types/ssh').ClusterModulesResult>
      getLearnedResources: (connectionId: string, toolId: string, options?: { force?: boolean }) => Promise<import('./types/ssh').LearnedResourceSummary | null>
      resetLearnedResources: (connectionId: string, toolId: string) => Promise<void>
      clearCaches: (connectionId: string) => Promise<{ ok: boolean }>
    }
    annovar: {
      status: (connectionId: string, humandbPath: string, buildver: string, databases: string[]) => Promise<import('./types/annotation').AnnovarStatusResult>
      install: (request: import('./types/annotation').AnnovarInstallRequest) => Promise<{ ok: boolean }>
      onInstallProgress: (callback: (data: import('./types/annotation').AnnovarInstallProgress) => void) => () => void
    }
    fs: {
      resolveSplit: (
        connectionId: string,
        pattern: import('./types/pipeline').SplitPattern,
        manualItems?: Array<{ key: string; path: string }>,
      ) => Promise<{ items: Array<{ key: string; path: string }>; missing: string[] }>
    }
    app: {
      onMenuCommand: (callback: (data: { command: 'new' | 'open' | 'save' | 'saveAs' }) => void) => () => void
    }
  }
}
