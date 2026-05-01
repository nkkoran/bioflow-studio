import { BrowserWindow, ipcMain } from 'electron'
import { SftpPool } from '../ssh/SftpPool'

function broadcastTransferProgress(payload: {
  connectionId: string
  direction: 'upload' | 'download'
  localPath: string
  remotePath: string
  bytesTransferred: number
  totalBytes?: number
}): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) win.webContents.send('sftp:transfer-progress', payload)
}

export function registerFileHandlers(): void {
  const pool = SftpPool.getInstance()

  ipcMain.handle('sftp:ls', async (_event, connectionId: string, remotePath: string, opts?: { force?: boolean }) => {
    return pool.ls(connectionId, remotePath, opts)
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
    return pool.upload(connectionId, localPath, remotePath, (bytesTransferred, totalBytes) => {
      broadcastTransferProgress({ connectionId, direction: 'upload', localPath, remotePath, bytesTransferred, totalBytes })
    })
  })

  ipcMain.handle('sftp:download', async (_event, connectionId: string, remotePath: string, localPath: string) => {
    return pool.download(connectionId, remotePath, localPath, (bytesTransferred, totalBytes) => {
      broadcastTransferProgress({ connectionId, direction: 'download', localPath, remotePath, bytesTransferred, totalBytes })
    })
  })
}
