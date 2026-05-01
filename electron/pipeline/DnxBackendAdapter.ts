import { app, safeStorage } from 'electron'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'

import { DnxBridgeManager } from '../dnx/DnxBridgeManager'
import { SftpPool } from '../ssh/SftpPool'
import { getSettingsStore } from '../store/settingsStore'

function normalizeFolder(folder: string | undefined, fallback: string): string {
  const value = (folder || fallback).trim()
  if (!value) return fallback
  return value.startsWith('/') ? value : `/${value}`
}

function decodeSecret(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const payload = raw as { scheme?: string; value?: string }
  if (typeof payload.value !== 'string') return undefined
  if (payload.scheme === 'safeStorage') {
    try {
      return safeStorage.decryptString(Buffer.from(payload.value, 'base64'))
    } catch {
      return undefined
    }
  }
  if (payload.scheme === 'plain') return payload.value
  return undefined
}

export class DnxBackendAdapter {
  private readonly bridge = DnxBridgeManager.getInstance()
  private readonly sftp = SftpPool.getInstance()

  async authenticate(projectId?: string | null): Promise<{ projectId: string }> {
    const store = getSettingsStore() as unknown as { get: (key: string) => unknown }
    const token = decodeSecret(store.get('secure:dnx:authToken'))
    const resolvedProjectId = projectId ?? (store.get('dnx:defaultProjectId') as string | undefined) ?? null
    if (!token) throw new Error('DNAnexus auth token is not configured.')
    if (!resolvedProjectId) throw new Error('DNAnexus default project is not configured.')
    await this.bridge.bootstrapEnvironment()
    await this.bridge.auth({ token, projectId: resolvedProjectId })
    return { projectId: resolvedProjectId }
  }

  async ensureApplet(projectId: string, args?: { folder?: string; appletName?: string }): Promise<{ appletId: string; hash: string }> {
    return this.bridge.ensureApplet({
      projectId,
      folder: args?.folder,
      appletName: args?.appletName,
    })
  }

  async resolveFile(projectId: string, path: string): Promise<{ fileId: string; path: string }> {
    const stat = await this.bridge.stat({ projectId, path })
    if (!stat.id) throw new Error(`DNAnexus file not found: ${path}`)
    return { fileId: stat.id, path }
  }

  async uploadLocalPath(projectId: string, localPath: string, folder: string, name?: string): Promise<{ fileId: string; path: string }> {
    const normalizedFolder = normalizeFolder(folder, '/BioFlow/uploads')
    let pathToUpload = localPath
    let tempDir: string | null = null
    try {
      if (name && name !== basename(localPath)) {
        tempDir = await mkdtemp(join(app.getPath('temp'), 'bioflow-dnx-name-'))
        pathToUpload = join(tempDir, name)
        await copyFile(localPath, pathToUpload)
      }
      const { fileId } = await this.bridge.upload({ projectId, localPath: pathToUpload, folder: normalizedFolder })
      return {
        fileId,
        path: posix.join(normalizedFolder, name || basename(localPath)),
      }
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true })
    }
  }

  async transferSshToDnx(
    connectionId: string,
    remotePath: string,
    projectId: string,
    folder: string,
    name?: string,
  ): Promise<{ fileId: string; path: string }> {
    const tmpDir = await mkdtemp(join(app.getPath('temp'), 'bioflow-dnx-'))
    const localPath = join(tmpDir, basename(remotePath))
    try {
      await this.sftp.download(connectionId, remotePath, localPath)
      return await this.uploadLocalPath(projectId, localPath, folder, name)
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  }

  async downloadDnxToLocal(
    projectId: string,
    dnxPath: string,
    localPath: string,
  ): Promise<string> {
    const resolved = await this.resolveFile(projectId, dnxPath)
    await this.bridge.download({ projectId, fileId: resolved.fileId, localPath })
    return localPath
  }

  async headText(projectId: string, dnxPath: string, lines: number): Promise<string> {
    const tmpDir = await mkdtemp(join(app.getPath('temp'), 'bioflow-dnx-head-'))
    const localPath = join(tmpDir, basename(dnxPath))
    try {
      await this.downloadDnxToLocal(projectId, dnxPath, localPath)
      const buffer = await readFile(localPath)
      const content = buffer.subarray(0, 256 * 1024).toString('utf-8')
      return content.split(/\r?\n/).slice(0, Math.max(1, Math.floor(lines))).join('\n')
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  }

  async transferDnxToSsh(
    connectionId: string,
    projectId: string,
    dnxPath: string,
    remotePath: string,
  ): Promise<string> {
    const tmpDir = await mkdtemp(join(app.getPath('temp'), 'bioflow-dnx-'))
    const localPath = join(tmpDir, basename(remotePath))
    try {
      const resolved = await this.resolveFile(projectId, dnxPath)
      await this.bridge.download({ projectId, fileId: resolved.fileId, localPath })
      const remoteDir = posix.dirname(remotePath)
      await this.sftp.mkdir(connectionId, remoteDir).catch(() => undefined)
      await this.sftp.upload(connectionId, localPath, remotePath)
      return remotePath
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  }

  async runSwissArmyKnife(args: {
    projectId: string
    outputFolder: string
    script: string
    inputPaths: string[]
    instanceType?: string
    name?: string
  }): Promise<{ jobId: string }> {
    const links = await Promise.all(args.inputPaths.map(async (path) => {
      const resolved = await this.resolveFile(args.projectId, path)
      return { '$dnanexus_link': resolved.fileId }
    }))
    return this.bridge.run({
      // Resolved by the bridge via dxpy.find_one_app(name=...).
      appletId: 'swiss-army-knife',
      projectId: args.projectId,
      folder: normalizeFolder(args.outputFolder, '/BioFlow/runs'),
      instanceType: args.instanceType,
      name: args.name,
      inputs: {
        cmd: stripSlurmPreamble(args.script),
        in: links,
      },
    })
  }

  async runSparkExtract(args: {
    projectId: string
    appletId: string
    fields: unknown[]
    renameMap: Record<string, string>
    codingValues: string
    outputName: string
    outputFolder: string
    instanceType?: string
  }): Promise<{ jobId: string }> {
    return this.bridge.sparkExtract({
      projectId: args.projectId,
      appletId: args.appletId,
      fields: args.fields,
      renameMap: args.renameMap,
      codingValues: args.codingValues,
      outputName: args.outputName,
      outputFolder: args.outputFolder,
      instanceType: args.instanceType,
    })
  }
}

export function stripSlurmPreamble(script: string): string {
  return script
    .split('\n')
    .filter((line) => !line.startsWith('#SBATCH') && line.trim() !== '#!/bin/bash')
    .join('\n')
    .trim()
}
