import { ipcMain } from 'electron'
import { SftpPool } from '../ssh/SftpPool'

export function registerFileHandlers(): void {
  const pool = SftpPool.getInstance()

  ipcMain.handle('sftp:ls', async (_event, connectionId: string, remotePath: string) => {
    return pool.ls(connectionId, remotePath)
  })

  ipcMain.handle('sftp:stat', async (_event, connectionId: string, remotePath: string) => {
    return pool.stat(connectionId, remotePath)
  })

  ipcMain.handle('sftp:read', async (_event, connectionId: string, remotePath: string, offset?: number, length?: number) => {
    return pool.read(connectionId, remotePath, offset, length)
  })

  ipcMain.handle('sftp:read-base64', async (_event, connectionId: string, remotePath: string, offset?: number, length?: number) => {
    return pool.readBase64(connectionId, remotePath, offset, length)
  })

  ipcMain.handle('sftp:head', async (_event, connectionId: string, remotePath: string, lines: number) => {
    return pool.head(connectionId, remotePath, lines)
  })

  ipcMain.handle('sftp:mkdir', async (_event, connectionId: string, remotePath: string) => {
    return pool.mkdir(connectionId, remotePath)
  })

  ipcMain.handle('sftp:rename', async (_event, connectionId: string, oldPath: string, newPath: string) => {
    return pool.rename(connectionId, oldPath, newPath)
  })

  ipcMain.handle('sftp:delete', async (_event, connectionId: string, remotePath: string) => {
    return pool.remove(connectionId, remotePath)
  })

  ipcMain.handle('sftp:write', async (_event, connectionId: string, remotePath: string, content: string) => {
    return pool.write(connectionId, remotePath, content)
  })

  ipcMain.handle('sftp:upload', async (_event, connectionId: string, localPath: string, remotePath: string) => {
    return pool.upload(connectionId, localPath, remotePath)
  })
}
