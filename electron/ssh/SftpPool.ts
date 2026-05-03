import type { SFTPWrapper, FileEntry as SshFileEntry } from 'ssh2'
import { SshManager } from './SshManager'
import { OpenSshTransport, isOpenSshSessionInactiveError, type OpenSshConnectionHandle } from './OpenSshTransport'
import type { RemoteFileEntry, FileStat } from './types'
import { createReadStream, createWriteStream } from 'fs'
import { promises as fs } from 'fs'

interface PoolEntry {
  available: SFTPWrapper[]
  inUse: Set<SFTPWrapper>
}

interface CacheEntry {
  entries: RemoteFileEntry[]
  timestamp: number
}

interface Waiter {
  resolve: (sftp: SFTPWrapper) => void
  reject: (err: unknown) => void
}

type OpenSshOperationResult<T> = { handled: true; value: T } | { handled: false }

// HPC login nodes can have low SSH channel/session limits. Keep SFTP
// conservative so ordinary exec calls (script preview, mkdir, sbatch) still
// have room to open a channel on the same SSH connection.
const MAX_PER_CONNECTION = 1
const MAX_IDLE_PER_CONNECTION = 1
const CACHE_TTL = 30_000
export type SftpProgressCallback = (bytesTransferred: number, totalBytes?: number) => void

export class SftpPool {
  private static instance: SftpPool
  private pool = new Map<string, PoolEntry>()
  private cache = new Map<string, CacheEntry>()
  private waitQueue = new Map<string, Waiter[]>()
  private deadSessions = new WeakSet<SFTPWrapper>()

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
    while (entry.available.length > 0) {
      const sftp = entry.available.pop()!
      if (this.deadSessions.has(sftp)) continue
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
    return new Promise((resolve, reject) => {
      let queue = this.waitQueue.get(connectionId)
      if (!queue) {
        queue = []
        this.waitQueue.set(connectionId, queue)
      }
      queue.push({ resolve, reject })
    })
  }

  release(connectionId: string, sftp: SFTPWrapper): void {
    const entry = this.pool.get(connectionId)
    if (!entry) return

    entry.inUse.delete(sftp)
    if (this.deadSessions.has(sftp)) {
      this.closeSftp(sftp)
      this.replaceDeadSessionForNextWaiter(connectionId, entry)
      return
    }

    // Fulfill a waiting request if any
    const queue = this.waitQueue.get(connectionId)
    if (queue && queue.length > 0) {
      const next = queue.shift()!
      entry.inUse.add(sftp)
      next.resolve(sftp)
      return
    }

    if (entry.available.length >= MAX_IDLE_PER_CONNECTION) {
      this.closeSftp(sftp)
      return
    }

    entry.available.push(sftp)
  }

  private discard(connectionId: string, sftp: SFTPWrapper): void {
    const entry = this.pool.get(connectionId)
    if (entry) entry.inUse.delete(sftp)
    this.deadSessions.add(sftp)
    this.closeSftp(sftp)
    if (entry) this.replaceDeadSessionForNextWaiter(connectionId, entry)
  }

  private closeSftp(sftp: SFTPWrapper): void {
    try { sftp.end() } catch { /* ignore */ }
  }

  private async withSftp<T>(
    connectionId: string,
    operation: (sftp: SFTPWrapper) => Promise<T>,
    opts: { retryOnSessionFailure?: boolean } = {},
  ): Promise<T> {
    const maxAttempts = opts.retryOnSessionFailure ? 2 : 1
    let lastError: unknown
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const sftp = await this.acquire(connectionId)
      let keep = true
      try {
        return await operation(sftp)
      } catch (err) {
        lastError = err
        if (isSftpSessionFailure(err)) {
          keep = false
          this.discard(connectionId, sftp)
          if (attempt + 1 < maxAttempts) continue
        }
        throw err
      } finally {
        if (keep) this.release(connectionId, sftp)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'SFTP operation failed'))
  }

  private replaceDeadSessionForNextWaiter(connectionId: string, entry: PoolEntry): void {
    const queue = this.waitQueue.get(connectionId)
    if (!queue || queue.length === 0) return
    const next = queue.shift()!
    this.createSftp(connectionId)
      .then((fresh) => {
        entry.inUse.add(fresh)
        next.resolve(fresh)
      })
      .catch((err) => next.reject(err))
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
    const queue = this.waitQueue.get(connectionId)
    if (queue) {
      for (const waiter of queue) {
        waiter.reject(new Error(`SSH connection ${connectionId} closed`))
      }
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

  async ls(connectionId: string, remotePath: string, opts: { force?: boolean } = {}): Promise<RemoteFileEntry[]> {
    const cacheKey = `${connectionId}:${remotePath}`
    const cached = this.cache.get(cacheKey)
    if (!opts.force && cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.entries
    }

    const openSshResult = await this.withOpenSsh(connectionId, async (openSsh) => {
      const entries = await OpenSshTransport.getInstance().ls(openSsh, remotePath)
      this.cache.set(cacheKey, { entries, timestamp: Date.now() })
      return entries
    })
    if (openSshResult.handled) return openSshResult.value

    return this.withSftp(connectionId, async (sftp) => {
      const list = await new Promise<SshFileEntry[]>((resolve, reject) => {
        sftp.readdir(remotePath, (err, fileList) => {
          if (err) reject(err)
          else resolve(Array.isArray(fileList) ? fileList : [])
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
    }, { retryOnSessionFailure: true })
  }

  async stat(connectionId: string, remotePath: string): Promise<FileStat> {
    const openSshResult = await this.withOpenSsh(connectionId, (openSsh) => OpenSshTransport.getInstance().stat(openSsh, remotePath))
    if (openSshResult.handled) return openSshResult.value

    return this.withSftp(connectionId, async (sftp) => {
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
    }, { retryOnSessionFailure: true })
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
    const openSshResult = await this.withOpenSsh(connectionId, (openSsh) => OpenSshTransport.getInstance().readBuffer(openSsh, remotePath, offset, length))
    if (openSshResult.handled) return openSshResult.value

    return this.withSftp(connectionId, async (sftp) => {
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
    }, { retryOnSessionFailure: true })
  }

  async head(
    connectionId: string,
    remotePath: string,
    lines: number,
  ): Promise<string> {
    const openSshResult = await this.withOpenSsh(connectionId, (openSsh) => OpenSshTransport.getInstance().head(openSsh, remotePath, lines))
    if (openSshResult.handled) return openSshResult.value

    return this.withSftp(connectionId, async (sftp) => {
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
    }, { retryOnSessionFailure: true })
  }

  async mkdir(connectionId: string, remotePath: string): Promise<void> {
    const openSshResult = await this.withOpenSsh(connectionId, async (openSsh) => {
      await OpenSshTransport.getInstance().mkdir(openSsh, remotePath)
      this.invalidateCache(connectionId, parentDir(remotePath))
    })
    if (openSshResult.handled) return openSshResult.value

    const sftp = await this.acquire(connectionId)
    try {
      await this.mkdirRecursive(sftp, remotePath)
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
    const openSshResult = await this.withOpenSsh(connectionId, async (openSsh) => {
      await OpenSshTransport.getInstance().rename(openSsh, oldPath, newPath)
      this.invalidateCache(connectionId, parentDir(oldPath))
      this.invalidateCache(connectionId, parentDir(newPath))
    })
    if (openSshResult.handled) return openSshResult.value

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
    const openSshResult = await this.withOpenSsh(connectionId, async (openSsh) => {
      await OpenSshTransport.getInstance().remove(openSsh, remotePath)
      this.invalidateCache(connectionId, parentDir(remotePath))
    })
    if (openSshResult.handled) return openSshResult.value

    const sftp = await this.acquire(connectionId)
    try {
      await this.removePath(sftp, remotePath)
      this.invalidateCache(connectionId, parentDir(remotePath))
    } finally {
      this.release(connectionId, sftp)
    }
  }

  private async mkdirRecursive(sftp: SFTPWrapper, remotePath: string): Promise<void> {
    const clean = remotePath.replace(/\/+$/, '')
    if (!clean || clean === '/' || clean === '.') return
    const parts = clean.split('/').filter(Boolean)
    let current = clean.startsWith('/') ? '' : '.'
    for (const part of parts) {
      current = current === '' ? `/${part}` : `${current.replace(/\/+$/, '')}/${part}`
      const exists = await new Promise<boolean>((resolve, reject) => {
        sftp.stat(current, (err, stats) => {
          if (!err) {
            const isDirectory = (((stats as { mode?: number }).mode ?? 0) & 0o170000) === 0o040000
            resolve(isDirectory)
            return
          }
          const message = String((err as Error).message ?? err)
          if (message.includes('No such file') || message.includes('not found') || (err as { code?: number }).code === 2) {
            resolve(false)
            return
          }
          reject(err)
        })
      })
      if (exists) continue
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(current, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
  }

  private async removePath(sftp: SFTPWrapper, remotePath: string): Promise<void> {
    const stat = await new Promise<{ mode: number }>((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => {
        if (err) reject(err)
        else resolve(stats as { mode: number })
      })
    })
    const isDirectory = ((stat.mode ?? 0) & 0o170000) === 0o040000
    if (!isDirectory) {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(remotePath, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      return
    }

    const entries = await new Promise<SshFileEntry[]>((resolve, reject) => {
      sftp.readdir(remotePath, (err, fileList) => {
        if (err) reject(err)
        else resolve(Array.isArray(fileList) ? fileList : [])
      })
    })
    for (const entry of entries) {
      if (entry.filename === '.' || entry.filename === '..') continue
      await this.removePath(sftp, `${remotePath.replace(/\/+$/, '')}/${entry.filename}`)
    }
    await new Promise<void>((resolve, reject) => {
      sftp.rmdir(remotePath, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  async write(
    connectionId: string,
    remotePath: string,
    content: string,
  ): Promise<void> {
    const openSshResult = await this.withOpenSsh(connectionId, async (openSsh) => {
      await OpenSshTransport.getInstance().write(openSsh, remotePath, content)
      this.invalidateCache(connectionId, parentDir(remotePath))
    })
    if (openSshResult.handled) return openSshResult.value

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

  async upload(connectionId: string, localPath: string, remotePath: string, onProgress?: SftpProgressCallback): Promise<void> {
    const openSshResult = await this.withOpenSsh(connectionId, async (openSsh) => {
      await OpenSshTransport.getInstance().upload(openSsh, localPath, remotePath, onProgress)
      this.invalidateCache(connectionId, parentDir(remotePath))
    })
    if (openSshResult.handled) return openSshResult.value

    const sftp = await this.acquire(connectionId)
    try {
      const total = await fs.stat(localPath).then((stat) => stat.size).catch(() => undefined)
      await new Promise<void>((resolve, reject) => {
        const readStream = createReadStream(localPath)
        const writeStream = sftp.createWriteStream(remotePath)
        let transferred = 0
        readStream.on('error', reject)
        readStream.on('data', (chunk: Buffer) => {
          transferred += chunk.length
          onProgress?.(transferred, total)
        })
        writeStream.on('error', reject)
        writeStream.on('finish', resolve)
        readStream.pipe(writeStream)
      })
      onProgress?.(total ?? 0, total)
      this.invalidateCache(connectionId, parentDir(remotePath))
    } finally {
      this.release(connectionId, sftp)
    }
  }

  async download(connectionId: string, remotePath: string, localPath: string, onProgress?: SftpProgressCallback): Promise<void> {
    const openSshResult = await this.withOpenSsh(connectionId, (openSsh) => OpenSshTransport.getInstance().download(openSsh, remotePath, localPath, onProgress))
    if (openSshResult.handled) return openSshResult.value

    const sftp = await this.acquire(connectionId)
    try {
      await fs.mkdir(localPath.replace(/\/[^/]+$/, ''), { recursive: true }).catch(() => undefined)
      const total = await new Promise<number | undefined>((resolve) => {
        sftp.stat(remotePath, (err, attrs) => {
          if (err) resolve(undefined)
          else resolve(Number((attrs as { size?: number }).size ?? 0))
        })
      })
      await new Promise<void>((resolve, reject) => {
        const readStream = sftp.createReadStream(remotePath)
        const writeStream = createWriteStream(localPath)
        let transferred = 0
        readStream.on('data', (chunk: Buffer) => {
          transferred += chunk.length
          onProgress?.(transferred, total)
        })
        readStream.on('error', reject)
        writeStream.on('error', reject)
        writeStream.on('finish', resolve)
        readStream.pipe(writeStream)
      })
      onProgress?.(total ?? 0, total)
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
        else {
          const markDead = () => this.deadSessions.add(sftp)
          sftp.on('close', markDead)
          sftp.on('end', markDead)
          sftp.on('error', markDead)
          resolve(sftp)
        }
      })
    })
  }

  private async withOpenSsh<T>(
    connectionId: string,
    operation: (openSsh: OpenSshConnectionHandle) => Promise<T>,
  ): Promise<OpenSshOperationResult<T>> {
    const manager = SshManager.getInstance()
    const openSsh = manager.getOpenSshConnection(connectionId)
    if (!openSsh) return { handled: false }

    try {
      return { handled: true, value: await operation(openSsh) }
    } catch (err) {
      if (isOpenSshSessionInactiveError(err)) {
        manager.markConnectionUnavailable(connectionId, 'OpenSSH ControlPersist session expired; reconnect manually before file operations continue.')
      }
      throw err
    }
  }
}

function parentDir(filePath: string): string {
  const idx = filePath.lastIndexOf('/')
  return idx <= 0 ? '/' : filePath.slice(0, idx)
}

function isSftpSessionFailure(err: unknown): boolean {
  const message = String(err instanceof Error ? err.message : err).toLowerCase()
  return /channel|socket|connection|session|closed|not open|econnreset|eof|no response/.test(message)
    && !/no such file|not found|permission denied/.test(message)
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
