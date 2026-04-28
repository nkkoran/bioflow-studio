import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import { PythonEnvBootstrap } from './PythonEnvBootstrap'
import type {
  DnxAppletInstallProgress,
  DnxBridgeStatusEvent,
  DnxFileStat,
  DnxInstanceSpec,
  DnxJobStatus,
  DnxProject,
  DnxRemoteFileEntry,
  DnxTransferProgress,
} from '../../src/types/dnx'

type BridgeOp =
  | 'auth'
  | 'ping'
  | 'list_projects'
  | 'list_files'
  | 'stat'
  | 'upload'
  | 'download'
  | 'run'
  | 'status'
  | 'cancel'
  | 'ensure_applet'
  | 'spark_extract'
  | 'list_instance_types'
  | 'status_batch'

interface BridgeRequest {
  id: string
  op: BridgeOp
  args?: Record<string, unknown>
}

interface BridgeProgressEnvelope {
  id: string
  event: 'progress' | 'status'
  data: Record<string, unknown>
}

interface BridgeResultEnvelope {
  id: string
  ok: boolean
  result?: unknown
  error?: { type?: string; message?: string }
}

interface InFlightRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: NodeJS.Timeout
}

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000  // 10 minutes; dx build/upload can be slow.

export class DnxBridgeManager extends EventEmitter {
  private static instance: DnxBridgeManager | null = null
  private readonly bootstrap = PythonEnvBootstrap.getInstance()
  private process: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private requestCounter = 0
  private inFlight = new Map<string, InFlightRequest>()
  private restartTimestamps: number[] = []
  private starting: Promise<void> | null = null
  private lastAuth: { token?: string; projectId?: string } | null = null

  static getInstance(): DnxBridgeManager {
    if (!this.instance) this.instance = new DnxBridgeManager()
    return this.instance
  }

  async bootstrapEnvironment(options?: { force?: boolean }): Promise<void> {
    await this.bootstrap.ensureReady(options)
  }

  async ping(): Promise<void> {
    await this.request('ping')
  }

  async auth(args: { token?: string; projectId?: string }): Promise<void> {
    await this.request('auth', args)
    this.lastAuth = {
      token: args.token ?? this.lastAuth?.token,
      projectId: args.projectId ?? this.lastAuth?.projectId,
    }
  }

  async listProjects(): Promise<DnxProject[]> {
    return this.request('list_projects') as Promise<DnxProject[]>
  }

  async listInstanceTypes(): Promise<DnxInstanceSpec[]> {
    return this.request('list_instance_types') as Promise<DnxInstanceSpec[]>
  }

  async listFiles(args: { projectId: string; path: string }): Promise<DnxRemoteFileEntry[]> {
    return this.request('list_files', args) as Promise<DnxRemoteFileEntry[]>
  }

  async stat(args: { projectId: string; path: string }): Promise<DnxFileStat> {
    return this.request('stat', args) as Promise<DnxFileStat>
  }

  async upload(args: { projectId: string; localPath: string; folder: string }): Promise<{ fileId: string }> {
    return this.request('upload', args) as Promise<{ fileId: string }>
  }

  async download(args: { projectId: string; fileId: string; localPath: string }): Promise<{ path: string }> {
    return this.request('download', args) as Promise<{ path: string }>
  }

  async run(args: Record<string, unknown>): Promise<{ jobId: string }> {
    return this.request('run', args) as Promise<{ jobId: string }>
  }

  async jobStatus(args: { jobId: string }): Promise<DnxJobStatus> {
    return this.request('status', args) as Promise<DnxJobStatus>
  }

  async jobStatusBatch(jobIds: string[]): Promise<{ results: DnxJobStatus[]; errors: Array<{ jobId: string; message: string }> }> {
    return this.request('status_batch', { jobIds }) as Promise<{ results: DnxJobStatus[]; errors: Array<{ jobId: string; message: string }> }>
  }

  async cancel(args: { jobId: string }): Promise<void> {
    await this.request('cancel', args)
  }

  async ensureApplet(args: Record<string, unknown>): Promise<{ appletId: string; hash: string }> {
    return this.request('ensure_applet', args) as Promise<{ appletId: string; hash: string }>
  }

  async sparkExtract(args: Record<string, unknown>): Promise<{ jobId: string }> {
    return this.request('spark_extract', args) as Promise<{ jobId: string }>
  }

  private async request(op: BridgeOp, args?: Record<string, unknown>): Promise<unknown> {
    await this.ensureStarted()
    const id = `dnx_${Date.now()}_${++this.requestCounter}`
    const payload: BridgeRequest = { id, op, args }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inFlight.delete(id)
        reject(new Error(`DNAnexus bridge request '${op}' timed out after ${REQUEST_TIMEOUT_MS / 1000}s`))
      }, REQUEST_TIMEOUT_MS)
      this.inFlight.set(id, { resolve, reject, timer })
      const encoded = JSON.stringify(payload)
      const proc = this.process
      if (!proc || proc.killed || !proc.stdin.writable) {
        clearTimeout(timer)
        this.inFlight.delete(id)
        reject(new Error('DNAnexus bridge process is not available.'))
        return
      }
      proc.stdin.write(`${encoded}\n`)
    })
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && !this.process.killed) return
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null
      })
    }
    await this.starting
  }

  private async start(): Promise<void> {
    const python = await this.bootstrap.ensureReady()
    const bridgePath = resolveResourcePath('python-bridge/bridge.py')
    if (!existsSync(bridgePath)) {
      throw new Error(`DNAnexus bridge script not found at ${bridgePath}`)
    }

    this.process = spawn(python, [bridgePath], {
      stdio: 'pipe',
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
    })
    this.buffer = ''

    this.process.stdout.on('data', (chunk: Buffer) => {
      this.handleStdout(chunk.toString('utf-8'))
    })
    this.process.stderr.on('data', (chunk: Buffer) => {
      console.error(`[DNX bridge] ${chunk.toString('utf-8').trim()}`)
    })
    this.process.on('exit', (code, signal) => {
      const wasRunning = this.process != null
      this.process = null
      if (!wasRunning) return
      this.rejectAllPending(new Error(`DNAnexus bridge exited (${signal ?? code ?? 'unknown'})`))
      void this.handleUnexpectedExit(code, signal)
    })

    await this.ping()
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      this.handleEnvelope(line)
    }
  }

  private handleEnvelope(line: string): void {
    try {
      const payload = JSON.parse(line) as BridgeProgressEnvelope | BridgeResultEnvelope
      if ('event' in payload) {
        this.handleProgress(payload)
        return
      }
      const request = this.inFlight.get(payload.id)
      if (!request) return
      this.inFlight.delete(payload.id)
      if (request.timer) clearTimeout(request.timer)
      if (payload.ok) {
        request.resolve(payload.result)
        return
      }
      request.reject(new Error(payload.error?.message || payload.error?.type || 'DNAnexus bridge request failed'))
    } catch (error) {
      this.emitStatus({
        level: 'error',
        code: 'BRIDGE_PARSE_ERROR',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private handleProgress(payload: BridgeProgressEnvelope): void {
    if (payload.event === 'progress') {
      const direction = typeof payload.data.direction === 'string' && payload.data.direction === 'download'
        ? 'download'
        : 'upload'
      this.emit('transfer-progress', {
        direction,
        bytes: Number(payload.data.bytes ?? 0),
        total: payload.data.total == null ? undefined : Number(payload.data.total),
        path: typeof payload.data.path === 'string' ? payload.data.path : undefined,
        projectId: typeof payload.data.project_id === 'string' ? payload.data.project_id : undefined,
        fileId: typeof payload.data.file_id === 'string' ? payload.data.file_id : undefined,
      } satisfies DnxTransferProgress)
      return
    }

    if (payload.event === 'status') {
      const kind = typeof payload.data.kind === 'string' ? payload.data.kind : ''
      if (kind === 'applet-install') {
        this.emit('applet-install-progress', {
          stage: normalizeAppletStage(payload.data.stage),
          percent: payload.data.percent == null ? undefined : Number(payload.data.percent),
          message: typeof payload.data.message === 'string' ? payload.data.message : undefined,
        } satisfies DnxAppletInstallProgress)
        return
      }
      this.emitStatus({
        level: normalizeLevel(payload.data.level),
        message: typeof payload.data.message === 'string' ? payload.data.message : 'DNAnexus bridge update',
        code: typeof payload.data.code === 'string' ? payload.data.code : undefined,
      })
    }
  }

  private async handleUnexpectedExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const now = Date.now()
    this.restartTimestamps = [...this.restartTimestamps.filter((value) => now - value < 60_000), now]
    if (this.restartTimestamps.length > 3) {
      this.emitStatus({
        level: 'error',
        code: 'BRIDGE_RESTART_LIMIT',
        message: `DNAnexus bridge stopped unexpectedly (${signal ?? code ?? 'unknown'}) and could not be restarted.`,
      })
      return
    }
    this.emitStatus({
      level: 'warning',
      code: 'BRIDGE_RESTART',
      message: 'DNAnexus bridge stopped unexpectedly. Restarting it now.',
    })
    try {
      await this.start()
      // Re-apply credentials so subsequent ops don't error with "auth not set".
      if (this.lastAuth?.token || this.lastAuth?.projectId) {
        try {
          await this.request('auth', this.lastAuth)
        } catch (error) {
          this.emitStatus({
            level: 'warning',
            code: 'BRIDGE_REAUTH_FAILED',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } catch (error) {
      this.emitStatus({
        level: 'error',
        code: 'BRIDGE_RESTART_FAILED',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private rejectAllPending(error: Error): void {
    for (const request of this.inFlight.values()) {
      if (request.timer) clearTimeout(request.timer)
      request.reject(error)
    }
    this.inFlight.clear()
  }

  private emitStatus(payload: DnxBridgeStatusEvent): void {
    this.emit('bridge-status', payload)
  }
}

function normalizeLevel(level: unknown): DnxBridgeStatusEvent['level'] {
  return level === 'warning' || level === 'error' ? level : 'info'
}

function normalizeAppletStage(stage: unknown): DnxAppletInstallProgress['stage'] {
  return stage === 'building' || stage === 'uploading' || stage === 'verifying' || stage === 'done'
    ? stage
    : 'building'
}

function resolveResourcePath(relativePath: string): string {
  const candidates = [
    join(app.getAppPath(), 'resources', relativePath),
    join(process.resourcesPath, 'resources', relativePath),
    join(process.resourcesPath, relativePath),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]
}
