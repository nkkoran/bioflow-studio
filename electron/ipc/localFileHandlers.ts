import { ipcMain } from 'electron'
import {
  readdirSync,
  statSync,
  readFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from 'fs'
import { join, extname, basename } from 'path'
import { homedir } from 'os'
import { gunzipSync } from 'zlib'
import type { RemoteFileEntry, FileStat } from '../ssh/types'

function modeToPermissions(mode: number): string {
  const types: Record<number, string> = {
    0o40000: 'd',
    0o120000: 'l',
    0o100000: '-',
  }
  const typeFlag = mode & 0o170000
  let result = types[typeFlag] ?? '-'
  const perms = ['r', 'w', 'x']
  for (let i = 2; i >= 0; i--) {
    const shift = i * 3
    for (let j = 2; j >= 0; j--) {
      result += mode & (1 << (shift + (2 - j))) ? perms[j] : '-'
    }
  }
  return result
}

function resolvePath(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(2))
  }
  return p
}

export function registerLocalFileHandlers(): void {
  ipcMain.handle('local:ls', async (_event, dirPath: string): Promise<RemoteFileEntry[]> => {
    const resolved = resolvePath(dirPath)
    const items = readdirSync(resolved, { withFileTypes: true })

    const entries: RemoteFileEntry[] = []
    for (const item of items) {
      // Skip hidden files by default (can be toggled later)
      if (item.name.startsWith('.')) continue

      const fullPath = join(resolved, item.name)
      try {
        const stats = statSync(fullPath)
        const isDir = item.isDirectory()
        const ext = !isDir ? extname(item.name).slice(1).toLowerCase() : ''

        entries.push({
          name: item.name,
          path: fullPath,
          isDirectory: isDir,
          size: stats.size,
          modified: stats.mtimeMs,
          permissions: modeToPermissions(stats.mode),
          extension: ext,
        })
      } catch {
        // Skip files we can't stat (broken symlinks, etc.)
      }
    }

    // Sort: directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    return entries
  })

  ipcMain.handle('local:stat', async (_event, filePath: string): Promise<FileStat> => {
    const resolved = resolvePath(filePath)
    const stats = statSync(resolved)
    return {
      size: stats.size,
      modified: stats.mtimeMs,
      isDirectory: stats.isDirectory(),
      permissions: modeToPermissions(stats.mode),
    }
  })

  ipcMain.handle('local:read', async (_event, filePath: string, offset?: number, length?: number): Promise<string> => {
    const resolved = resolvePath(filePath)
    const buffer = readFileSync(resolved)
    const start = offset ?? 0
    const end = length != null ? start + length : buffer.length
    return buffer.subarray(start, end).toString('utf-8')
  })

  ipcMain.handle('local:read-base64', async (_event, filePath: string, offset?: number, length?: number): Promise<string> => {
    const buffer = readFileSync(resolvePath(filePath))
    const start = offset ?? 0
    const end = length != null ? start + length : buffer.length
    return buffer.subarray(start, end).toString('base64')
  })

  ipcMain.handle('local:head', async (_event, filePath: string, lines: number): Promise<string> => {
    const resolved = resolvePath(filePath)
    // Read first 64KB then return first N lines
    const fd = readFileSync(resolved, { encoding: 'utf-8', flag: 'r' })
    const content = fd.length > 65536 ? fd.slice(0, 65536) : fd
    const allLines = content.split('\n')
    return allLines.slice(0, lines).join('\n')
  })

  ipcMain.handle('local:head-gzip', async (_event, filePath: string, lines: number): Promise<string> => {
    const buffer = gunzipSync(readFileSync(resolvePath(filePath)))
    const content = buffer.subarray(0, 256 * 1024).toString('utf-8')
    return content.split('\n').slice(0, lines).join('\n')
  })

  ipcMain.handle('local:mkdir', async (_event, dirPath: string): Promise<void> => {
    mkdirSync(resolvePath(dirPath), { recursive: true })
  })

  ipcMain.handle('local:rename', async (_event, oldPath: string, newPath: string): Promise<void> => {
    renameSync(resolvePath(oldPath), resolvePath(newPath))
  })

  ipcMain.handle('local:delete', async (_event, filePath: string): Promise<void> => {
    unlinkSync(resolvePath(filePath))
  })

  ipcMain.handle('local:write', async (_event, filePath: string, content: string): Promise<void> => {
    writeFileSync(resolvePath(filePath), content, 'utf-8')
  })

  ipcMain.handle('local:exists', async (_event, filePath: string): Promise<boolean> => {
    return existsSync(resolvePath(filePath))
  })

  ipcMain.handle('local:homedir', async (): Promise<string> => {
    return homedir()
  })
}
