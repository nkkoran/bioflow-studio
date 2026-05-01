import { BrowserWindow, ipcMain } from 'electron'

import { DnxBridgeManager } from '../dnx/DnxBridgeManager'
import { PythonEnvBootstrap } from '../dnx/PythonEnvBootstrap'
import { DnxBackendAdapter } from '../pipeline/DnxBackendAdapter'

let listenersRegistered = false

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

export function registerDnanexusHandlers(): void {
  const bridge = DnxBridgeManager.getInstance()
  const bootstrap = PythonEnvBootstrap.getInstance()
  const adapter = new DnxBackendAdapter()

  if (!listenersRegistered) {
    listenersRegistered = true
    bootstrap.on('progress', (payload) => {
      broadcast('dnx:bootstrap-progress', payload)
    })
    bridge.on('bridge-status', (payload) => {
      broadcast('dnx:bridge-status', payload)
    })
    bridge.on('transfer-progress', (payload) => {
      broadcast('dnx:transfer-progress', payload)
    })
    bridge.on('applet-install-progress', (payload) => {
      broadcast('dnx:applet-install-progress', payload)
    })
  }

  ipcMain.handle('dnx:bootstrap', async (_event, options?: { force?: boolean }) => {
    await bridge.bootstrapEnvironment(options)
    return { ok: true }
  })

  ipcMain.handle('dnx:auth', async (_event, args: { token?: string; projectId?: string }) => {
    await bridge.auth(args)
    return { ok: true }
  })

  ipcMain.handle('dnx:list-projects', async () => {
    return bridge.listProjects()
  })

  ipcMain.handle('dnx:list-instance-types', async () => {
    return bridge.listInstanceTypes()
  })

  ipcMain.handle('dnx:list-files', async (_event, args: { projectId: string; path: string }) => {
    return bridge.listFiles(args)
  })

  ipcMain.handle('dnx:stat', async (_event, args: { projectId: string; path: string }) => {
    return bridge.stat(args)
  })

  ipcMain.handle('dnx:head', async (_event, args: { projectId: string; path: string; lines: number }) => {
    return adapter.headText(args.projectId, args.path, args.lines)
  })

  ipcMain.handle('dnx:upload', async (_event, args: { projectId: string; localPath: string; folder: string }) => {
    return bridge.upload(args)
  })

  ipcMain.handle('dnx:download', async (_event, args: { projectId: string; fileId: string; localPath: string }) => {
    return bridge.download(args)
  })

  ipcMain.handle('dnx:run', async (_event, args: Record<string, unknown>) => {
    return bridge.run(args)
  })

  ipcMain.handle('dnx:job-status', async (_event, args: { jobId: string }) => {
    return bridge.jobStatus(args)
  })

  ipcMain.handle('dnx:cancel', async (_event, args: { jobId: string }) => {
    await bridge.cancel(args)
    return { ok: true }
  })

  ipcMain.handle('dnx:ensure-applet', async (_event, args: Record<string, unknown>) => {
    return bridge.ensureApplet(args)
  })

  ipcMain.handle('dnx:spark-extract', async (_event, args: Record<string, unknown>) => {
    return bridge.sparkExtract(args)
  })
}
