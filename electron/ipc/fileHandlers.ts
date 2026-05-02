import { BrowserWindow, ipcMain } from 'electron'
import { SftpPool } from '../ssh/SftpPool'
import type { RemoteFileEntry } from '../ssh/types'

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

  ipcMain.handle('sftp:stat-many', async (_event, connectionId: string, remotePaths: string[]) => {
    const rows = []
    for (const path of remotePaths.slice(0, 200)) {
      try {
        rows.push({ path, ok: true, stat: await pool.stat(connectionId, path) })
      } catch (err) {
        rows.push({ path, ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return rows
  })

  ipcMain.handle('sftp:search', async (_event, connectionId: string, rootPath: string, query: string, opts?: { maxResults?: number; maxDepth?: number }) => {
    const maxResults = Math.min(Math.max(opts?.maxResults ?? 100, 1), 500)
    const maxDepth = Math.min(Math.max(opts?.maxDepth ?? 4, 0), 8)
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    const results: RemoteFileEntry[] = []
    async function walk(dir: string, depth: number): Promise<void> {
      if (results.length >= maxResults || depth > maxDepth) return
      let entries: RemoteFileEntry[]
      try {
        entries = await pool.ls(connectionId, dir)
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name.toLowerCase().includes(needle) || entry.path.toLowerCase().includes(needle)) {
          results.push(entry)
          if (results.length >= maxResults) return
        }
      }
      for (const entry of entries) {
        if (results.length >= maxResults) return
        if (entry.isDirectory) await walk(entry.path, depth + 1)
      }
    }
    await walk(rootPath, 0)
    return results
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
