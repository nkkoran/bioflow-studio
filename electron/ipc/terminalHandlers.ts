import { ipcMain, BrowserWindow } from 'electron'
import { SshManager } from '../ssh/SshManager'
import type { ClientChannel } from 'ssh2'
import { randomUUID } from 'crypto'

const terminals = new Map<string, ClientChannel>()

export function registerTerminalHandlers(): void {
  const manager = SshManager.getInstance()

  ipcMain.handle('terminal:create', async (_event, connectionId: string) => {
    const terminalId = randomUUID()
    const channel = await manager.shell(connectionId)
    terminals.set(terminalId, channel)

    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('No window available')

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
    const channel = terminals.get(terminalId)
    if (channel) channel.write(data)
  })

  ipcMain.on('terminal:resize', (_event, terminalId: string, cols: number, rows: number) => {
    const channel = terminals.get(terminalId)
    if (channel) {
      channel.setWindow(rows, cols, 0, 0)
    }
  })

  ipcMain.on('terminal:close', (_event, terminalId: string) => {
    const channel = terminals.get(terminalId)
    if (channel) {
      channel.close()
      terminals.delete(terminalId)
    }
  })
}
