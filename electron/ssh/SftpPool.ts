import type { SFTPWrapper, FileEntry as SshFileEntry } from 'ssh2'
import { SshManager } from './SshManager'
import type { RemoteFileEntry, FileStat } from './types'
import { createReadStream } from 'fs'

interface PoolEntry {
  available: SFTPWrapper[]
  inUse: Set<SFTPWrapper>
}

interface CacheEntry {
  entries: RemoteFileEntry[]
  timestamp: number
}

// HPC login nodes can have low SSH channel/session limits. Keep SFTP
// conservative so ordinary exec calls (script preview, mkdir, sbatch) still
// have room to open a channel on the same SSH connection.
const MAX_PER_CONNECTION = 1
const MAX_IDLE_PER_CONNECTION = 1
const CACHE_TTL = 30_000

export class SftpPool {
  private static instance: SftpPool
  private pool = new Map<string, PoolEntry>()
  private cache = new Map<string, CacheEntry>()
  private waitQueue = new Map<string, Array<(sftp: SFTPWrapper) => void>>()

  private constructor() {}

  static getInstance(): SftpPool {
    if (!SftpPool.instance) {
      SftpPool.instance = new SftpPool()
    }
    return SftpPool.instance
  }

  async acquire(connectionId: string): Promise<SFTPWrapper> {
    let entry = this.pool.get(connectionId)
    if (!entry) {
      entry = { available: [], inUse: new Set() }
      this.pool.set(connectionId, entry)
    }

    // Return an available session
    if (entry.available.length > 0) {
      const sftp = entry.available.pop()!
      entry.inUse.add(sftp)
      return sftp
    }

    // Create a new session if under the limit
    const totalCount = entry.available.length + entry.inUse.size
    if (totalCount < MAX_PER_CONNECTION) {
      const sftp = await this.createSftp(connectionId)
      entry.inUse.add(sftp)
      return sftp
    }

    // Wait for one to become available
    return new Promise((resolve) => {
      let queue = this.waitQueue.get(connectionId)
      if (!queue) {
        queue = []
        this.waitQueue.set(connectionId, queue)
      }
      queue.push((sftp) => {
        entry!.inUse.add(sftp)
        resolve(sftp)
      })
    })
  }

  release(connectionId: string, sftp: SFTPWrapper): void {
    const entry = this.pool.get(connectionId)
    if (!entry) return

    entry.inUse.delete(sftp)

    // Fulfill a waiting request if any
    const queue = this.waitQueue.get(connectionId)
    if (queue && queue.length > 0) {
      const next = queue.shift()!
      next(sftp)
      return
    }

    if (entry.available.length >= MAX_IDLE_PER_CONNECTION) {
      try { sftp.end() } catch { /* ignore */ }
      return
    }

    entry.available.push(sftp)
  }

  cleanup(connectionId: string): void {
    const entry = this.pool.get(connectionId)
    if (entry) {
      for (const sftp of entry.available) {
        sftp.end()
      }
      for (const sftp of entry.inUse) {
        sftp.end()
      }
      this.pool.delete(connectionId)
    }
    this.waitQueue.delete(connectionId)
    this.invalidateCache(connectionId)
  }

  invalidateCache(connectionId: string, path?: string): void {
    if (path) {
      this.cache.delete(`${connectionId}:${path}`)
    } else {
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${connectionId}:`)) {
          this.cache.delete(key)
        }
      }
    }
  }

  async ls(connectionId: string, remotePath: string): Promise<RemoteFileEntry[]> {
    const cacheKey = `${connectionId}:${remotePath}`
    const cached = this.cache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.entries
    }

    const sftp = await this.acquire(connectionId)
    try {
      const list = await new Promise<SshFileEntry[]>((resolve, reject) => {
        sftp.readdir(remotePath, (err, fileList) => {
          if (err) reject(err)
          else resolve(fileList)
        })
      })

      const entries: RemoteFileEntry[] = await Promise.all(list.map(async (item) => {
        const fullPath = remotePath.endsWith('/')
          ? `${remotePath}${item.filename}`
          : `${remotePath}/${item.filename}`
        const mode = item.attrs.mode ?? 0
        const typeBits = mode & 0o170000
        const longname = typeof (item as { longname?: unknown }).longname === 'string'
          ? String((item as { longname?: string }).longname)
          : ''
        const symlinkLike = typeBits === 0o120000 || longname.startsWith('l')
        let isDirectory = typeBits === 0o040000 || longname.startsWith('d')
        if (symlinkLike) {
          try {
            const attrs = await new Promise<{ mode: number }>((resolve, reject) => {
              sftp.stat(fullPath, (err, stats) => {
                if (err) reject(err)
                else resolve(stats as { mode: number })
              })
            })
            isDirectory = ((attrs.mode ?? 0) & 0o170000) === 0o040000
          } catch {
            isDirectory = false
          }
        }
        const name = item.filename
        const dotIndex = name.lastIndexOf('.')
        const extension = !isDirectory && dotIndex > 0 ? name.slice(dotIndex + 1) : ''

        return {
          name,
          path: fullPath,
          isDirectory,
          size: item.attrs.size,
          modified: item.attrs.mtime * 1000,
          permissions: modeToPermissions(item.attrs.mode),
          extension,
        }
      }))

      // Sort: directories first, then alphabetical by name
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })

      this.cache.set(cacheKey, { entries, timestamp: Date.now() })
      return entries
    } finally {
      this.release(connectionId, sftp)
    }
  }

  async stat(connectionId: string, remotePath: string): Promise<FileStat> {
    const sftp = await this.acquire(connectionId)
    try {
      const attrs = await new Promise<{ size: number; mtime: number; mode: number }>(
        (resolve, reject) => {
          sftp.stat(remotePath, (err, stats) => {
            if (err) reject(err)
            else resolve(stats as { size: number; mtime: number; mode: number })
          })
        },
      )

      return {
        size: attrs.size,
        modified: attrs.mtime * 1000,
        isDirectory: (attrs.mode & 0o40000) !== 0,
        permissions: modeToPermissions(attrs.mode),
      }
    } finally {
      this.release(connectionId, sftp)
    }
  }

  async read(
    connectionId: string,
    remotePath: string,
    offset?: number,
    length?: number,
  ): Promise<string> {
    const buffer = await this.readBuffer(connectionId, remotePath, offset, length)
    return buffer.toString('utf-8')
  }

  async readBase64(
    connectionId: string,
    remotePath: string,
    offset?: number,
    length?: number,
  ): Promise<string> {
    const buffer = await this.readBuffer(connectionId, remotePath, offset, length)
    return buffer.toString('base64')
  }

  private async readBuffer(
    connectionId: string,
    remotePath: string,
    offset?: number,
    length?: number,
  ): Promise<Buffer> {
    const sftp = await this.acquire(connectionId)
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        const readStream = sftp.createReadStream(remotePath, {
          start: offset,
          end: offset != null && length != null ? offset + length - 1 : undefined,
        })

        readStream.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })

        readStream.on('end', () => {
          resolve(Buffer.concat(chunks))
        })

        readStream.on('error', reject)
      })
    } finally {
      this.release(connectionId, sftp)
    }
  }

  async head(
    connectionId: string,
    remotePath: string,
    lines: number,
  ): Promise<string> {
    const sftp = await this.acquire(connectionId)
    try {
      const content = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = []
        const readStream = sftp.createReadStream(remotePath, {
          start: 0,
          end: 65535, // 64KB
        })

        readStream.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })

        readStream.on('end', () => {
          resolve(Buffer.concat(chunks).toString('utf-8'))
        })

        readStream.on('error', reject)
      })

      const allLines = content.split('\n')
      return allLines.slice(0, lines).join('\n')
    } finally {
      this.release(connectionId, sftp)
    }
  }

  async mkdir(connectionId: string, remotePath: string): Promise<void> {
    const sftp = await this.acquire(connectionId)
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(remotePath, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      this.invalidateCache(connectionId, parentDir(remotePath))
    } finally {
      this.release(connectionId, sftp)
    }
  }

  async rename(
    connectionId: string,
    oldPath: string,
    newPath: string,
  ): Promise<void> {
    const sftp = await this.acquire(connectionId)
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.rename(oldPath, newPath, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      this.invalidateCache(connectionId, parentDir(oldPath))
      this.invalidateCache(connectionId, parentDir(newPath))
    } finally {
      this.release(connectionId, sftp)
    }
  }

  async remove(connectionId: string, remotePath: string): Promise<void> {
    const sftp = await this.acquire(connectionId)
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(remotePath, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      this.invalidateCache(connectionId, parentDir(remotePath))
    } finally {
      this.release(connectionId, sftp)
    }
  }

  async write(
    connectionId: string,
    remotePath: string,
    content: string,
  ): Promise<void> {
    const sftp = await this.acquire(connectionId)
    try {
      await new Promise<void>((resolve, reject) => {
        const writeStream = sftp.createWriteStream(remotePath)
        writeStream.on('error', reject)
        writeStream.on('close', () => resolve())
        writeStream.end(Buffer.from(content, 'utf-8'))
      })
      this.invalidateCache(connectionId, parentDir(remotePath))
    } finally {
      this.release(connectionId, sftp)
    }
  }

  async upload(connectionId: string, localPath: string, remotePath: string): Promise<void> {
    const sftp = await this.acquire(connectionId)
    try {
      await new Promise<void>((resolve, reject) => {
        const readStream = createReadStream(localPath)
        const writeStream = sftp.createWriteStream(remotePath)
        readStream.on('error', reject)
        writeStream.on('error', reject)
        writeStream.on('finish', resolve)
        readStream.pipe(writeStream)
      })
      this.invalidateCache(connectionId, parentDir(remotePath))
    } finally {
      this.release(connectionId, sftp)
    }
  }

  private createSftp(connectionId: string): Promise<SFTPWrapper> {
    const client = SshManager.getInstance().getClient(connectionId)
    if (!client) {
      throw new Error(`SSH connection ${connectionId} not found`)
    }

    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) reject(err)
        else resolve(sftp)
      })
    })
  }
}

function parentDir(filePath: string): string {
  const idx = filePath.lastIndexOf('/')
  return idx <= 0 ? '/' : filePath.slice(0, idx)
}

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
