import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig } from '@/types/ssh'

const mocks = vi.hoisted(() => ({
  clients: [] as Array<any>,
  sentEvents: [] as Array<{ channel: string; payload: any }>,
  ipcOn: vi.fn(),
  ipcRemoveListener: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          isDestroyed: () => false,
          send: (channel: string, payload: any) => mocks.sentEvents.push({ channel, payload }),
        },
      },
    ],
  },
  ipcMain: {
    on: mocks.ipcOn,
    removeListener: mocks.ipcRemoveListener,
  },
}))

vi.mock('ssh2', () => {
  class FakeEmitter {
    private handlers = new Map<string, Array<(...args: any[]) => void>>()

    on(event: string, handler: (...args: any[]) => void): this {
      const handlers = this.handlers.get(event) ?? []
      handlers.push(handler)
      this.handlers.set(event, handlers)
      return this
    }

    emit(event: string, ...args: any[]): boolean {
      const handlers = this.handlers.get(event) ?? []
      for (const handler of handlers) handler(...args)
      return handlers.length > 0
    }
  }

  class FakeStream extends FakeEmitter {
    stderr = new FakeEmitter()
  }

  class FakeClient extends FakeEmitter {
    connect = vi.fn(() => {
      queueMicrotask(() => this.emit('ready'))
    })

    exec = vi.fn((_command: string, callback: (err: Error | null, stream: FakeStream) => void) => {
      const stream = new FakeStream()
      callback(null, stream)
      queueMicrotask(() => {
        stream.emit('data', Buffer.from('__HOST__login\n__CPU__unlimited\n__MEM__unlimited\n'))
        stream.emit('close', 0)
      })
    })

    end = vi.fn(() => {
      this.emit('close')
    })

    constructor() {
      super()
      mocks.clients.push(this)
    }
  }

  return { Client: FakeClient }
})

function statusChanges(): string[] {
  return mocks.sentEvents
    .filter((event) => event.channel === 'ssh:status-change')
    .map((event) => event.payload.status)
}

describe('SshManager reconnect behavior', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    mocks.clients.length = 0
    mocks.sentEvents.length = 0
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not start an interactive background reconnect after a live ssh2 session closes', async () => {
    const { SshManager } = await import('../../electron/ssh/SshManager')
    const manager = SshManager.getInstance()
    const config: ConnectionConfig = {
      name: 'Rorqual',
      host: 'rorqual.alliancecan.ca',
      port: 22,
      username: 'nk',
      authMethod: 'password',
      password: 'secret',
      transport: 'ssh2',
    }

    const result = await manager.connect(config)

    expect(result.transport).toBe('ssh2')
    expect(mocks.clients).toHaveLength(1)

    mocks.clients[0].emit('close')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(mocks.clients).toHaveLength(1)
    expect(statusChanges()).toContain('disconnected')
    expect(statusChanges()).not.toContain('reconnecting')
    expect(mocks.ipcOn).not.toHaveBeenCalledWith('ssh:prompt-response', expect.any(Function))
  })
})
