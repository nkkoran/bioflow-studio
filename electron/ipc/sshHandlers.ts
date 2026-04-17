import { ipcMain } from 'electron'
import { SshManager } from '../ssh/SshManager'
import { SftpPool } from '../ssh/SftpPool'

export function registerSshHandlers(): void {
  const manager = SshManager.getInstance()
  const pool = SftpPool.getInstance()

  ipcMain.handle('ssh:connect', async (_event, config) => {
    return manager.connect(config)
  })

  ipcMain.handle('ssh:disconnect', async (_event, id: string) => {
    pool.cleanup(id)
    return manager.disconnect(id)
  })

  ipcMain.handle('ssh:status', async (_event, id: string) => {
    return manager.getStatus(id)
  })

  ipcMain.handle('ssh:exec', async (_event, id: string, command: string) => {
    return manager.exec(id, command)
  })
}
