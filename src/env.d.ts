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
      listConnections: () => Promise<Array<{ id: string; config: Omit<import('./types/ssh').ConnectionConfig, 'password' | 'passphrase'>; connectedAt: number; connected: boolean }>>
      onStatusChange: (callback: (event: any, data: { connectionId: string; status: string }) => void) => () => void
      onPrompt: (callback: (data: { promptId: string; title: string; message: string; isPassword: boolean }) => void) => () => void
      respondToPrompt: (promptId: string, value: string | null) => void
      onBanner: (callback: (data: { connectionId: string; message: string }) => void) => () => void
    }
    sftp: {
      ls: (id: string, remotePath: string) => Promise<import('./types/files').RemoteFileEntry[]>
      stat: (id: string, remotePath: string) => Promise<import('./types/files').FileStat>
      read: (id: string, remotePath: string, offset?: number, length?: number) => Promise<string>
      head: (id: string, remotePath: string, lines: number) => Promise<string>
      mkdir: (id: string, remotePath: string) => Promise<void>
      rename: (id: string, oldPath: string, newPath: string) => Promise<void>
      delete: (id: string, remotePath: string) => Promise<void>
      write: (id: string, remotePath: string, content: string) => Promise<void>
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
    }
    local: {
      ls: (dirPath: string) => Promise<import('./types/files').RemoteFileEntry[]>
      stat: (filePath: string) => Promise<import('./types/files').FileStat>
      read: (filePath: string, offset?: number, length?: number) => Promise<string>
      head: (filePath: string, lines: number) => Promise<string>
      mkdir: (dirPath: string) => Promise<void>
      rename: (oldPath: string, newPath: string) => Promise<void>
      delete: (filePath: string) => Promise<void>
      write: (filePath: string, content: string) => Promise<void>
      homedir: () => Promise<string>
    }
    dialog: {
      openFile: (options?: { filters?: { name: string; extensions: string[] }[]; defaultPath?: string }) => Promise<string | null>
      openDirectory: (options?: { defaultPath?: string }) => Promise<string | null>
    }
    pipeline: {
      run: (connectionId: string, snapshot: import('./types/pipeline').PipelineSnapshot, workDir?: string) => Promise<{ runId: string }>
      cancel: (runId: string) => Promise<void>
      cancelNode: (runId: string, nodeId: string) => Promise<void>
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
  }
}
