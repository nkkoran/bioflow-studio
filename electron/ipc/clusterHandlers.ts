import { ipcMain } from 'electron'
import { SshManager } from '../ssh/SshManager'

export function registerClusterHandlers(): void {
  const manager = SshManager.getInstance()

  ipcMain.handle('cluster:loginPolicy', async (_event, connectionId: string) => {
    return manager.getLoginPolicy(connectionId)
  })
}
