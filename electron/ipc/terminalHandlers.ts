import { ipcMain, BrowserWindow } from 'electron'
import { SshManager } from '../ssh/SshManager'
import {
  buildOpenSshTerminalArgs,
  buildOpenSshTerminalPtyInvocation,
  type OpenSshConnectionHandle,
  type PtyInvocation,
} from '../ssh/OpenSshTransport'
import type { ClientChannel } from 'ssh2'
import { randomUUID } from 'crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'

interface TerminalSession {
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  close: () => void
}

const terminals = new Map<string, TerminalSession>()

export function registerTerminalHandlers(): void {
  const manager = SshManager.getInstance()

  ipcMain.handle('terminal:create', async (_event, connectionId: string) => {
    const terminalId = randomUUID()
    const win = getAppWindow()
    if (!win) throw new Error('No window available')

    const openSsh = manager.getOpenSshConnection(connectionId)
    if (openSsh) {
      const session = createOpenSshTerminalSession(openSsh, terminalId, win, () => terminals.delete(terminalId))
      terminals.set(terminalId, session)
      return terminalId
    }

    const channel = await manager.shell(connectionId)
    terminals.set(terminalId, createSsh2TerminalSession(channel))

    channel.on('data', (data: Buffer) => {
      win.webContents.send(`terminal:data:${terminalId}`, data.toString('utf-8'))
    })

    channel.on('close', () => {
      terminals.delete(terminalId)
      win.webContents.send(`terminal:close:${terminalId}`)
    })

    channel.stderr.on('data', (data: Buffer) => {
      win.webContents.send(`terminal:data:${terminalId}`, data.toString('utf-8'))
    })

    return terminalId
  })

  ipcMain.on('terminal:write', (_event, terminalId: string, data: string) => {
    terminals.get(terminalId)?.write(data)
  })

  ipcMain.on('terminal:resize', (_event, terminalId: string, cols: number, rows: number) => {
    terminals.get(terminalId)?.resize(cols, rows)
  })

  ipcMain.on('terminal:close', (_event, terminalId: string) => {
    terminals.get(terminalId)?.close()
    terminals.delete(terminalId)
  })
}

function getAppWindow(): BrowserWindow | undefined {
  const windows = BrowserWindow.getAllWindows()
  return windows.find((win) => !win.webContents.getURL().startsWith('devtools://')) ?? windows[0]
}

function createSsh2TerminalSession(channel: ClientChannel): TerminalSession {
  return {
    write: (data) => channel.write(data),
    resize: (cols, rows) => channel.setWindow(rows, cols, 0, 0),
    close: () => channel.close(),
  }
}

function createOpenSshTerminalSession(
  handle: OpenSshConnectionHandle,
  terminalId: string,
  win: BrowserWindow,
  onClose: () => void,
): TerminalSession {
  const sshArgs = buildOpenSshTerminalArgs(handle)
  const ptyInvocation = buildOpenSshTerminalPtyInvocation('ssh', sshArgs)
  const child: ChildProcessWithoutNullStreams = ptyInvocation
    ? spawn(ptyInvocation.command, ptyInvocation.args, { env: ptyInvocation.env ?? process.env })
    : spawn('ssh', sshArgs, {
      env: {
        ...process.env,
        TERM: process.env.TERM || 'xterm-256color',
        COLUMNS: '120',
        LINES: '30',
      },
    })
  let closed = false

  const send = (chunk: Buffer | string) => {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(`terminal:data:${terminalId}`, Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
    }
  }

  if (!ptyInvocation) {
    send('\x1b[33m[OpenSSH terminal is running without the local PTY helper; command echo and wrapping may be degraded.]\x1b[0m\r\n')
  }

  const cleanupPty = async (invocation: PtyInvocation | null) => {
    await invocation?.cleanup?.().catch(() => undefined)
  }

  child.stdout.on('data', send)
  child.stderr.on('data', send)
  child.on('error', (err) => {
    send(`\r\n\x1b[31m[OpenSSH terminal failed: ${err.message}]\x1b[0m\r\n`)
    void cleanupPty(ptyInvocation)
  })
  child.on('close', async () => {
    if (closed) return
    closed = true
    await cleanupPty(ptyInvocation)
    onClose()
    if (!win.webContents.isDestroyed()) win.webContents.send(`terminal:close:${terminalId}`)
  })

  return {
    write: (data) => {
      if (!child.stdin.destroyed) child.stdin.write(data)
    },
    resize: (cols, rows) => {
      if (!ptyInvocation?.resize) return
      ptyInvocation.resize(cols, rows)
    },
    close: () => {
      if (!child.killed) child.kill()
    },
  }
}
