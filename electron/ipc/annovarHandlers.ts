import { BrowserWindow, ipcMain } from 'electron'
import { basename } from 'path'

import { SftpPool } from '../ssh/SftpPool'
import { SshManager } from '../ssh/SshManager'
import { annovarEstimatedSizeGB, annovarExpectedFiles } from '../../src/lib/annovarCatalog'
import type { AnnovarDatabaseStatus, AnnovarInstallProgress, AnnovarInstallRequest, AnnovarStatusResult } from '../../src/types/annotation'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function registerAnnovarHandlers(): void {
  const ssh = SshManager.getInstance()
  const sftp = SftpPool.getInstance()

  ipcMain.handle(
    'annovar:status',
    async (_event, connectionId: string, humandbPath: string, buildver: string, databases: string[]): Promise<AnnovarStatusResult> => {
      const entries = await sftp.ls(connectionId, humandbPath).catch(() => [])
      const entryNames = new Set(entries.map((entry) => entry.name))
      const rows: AnnovarDatabaseStatus[] = await Promise.all(databases.map(async (database) => {
        const expected = annovarExpectedFiles(buildver, database)
        let foundPath = `${humandbPath.replace(/\/+$/, '')}/${expected[0]}`
        let installed = false
        for (const relative of expected) {
          if (entryNames.has(basename(relative))) {
            foundPath = `${humandbPath.replace(/\/+$/, '')}/${relative}`
            installed = true
            break
          }
        }
        const prefix = `${buildver}_${database}`
        const stale = !installed && entries.some((entry) => entry.name.startsWith(prefix))
        return {
          database,
          buildver,
          estimatedSizeGB: annovarEstimatedSizeGB(database),
          status: installed ? 'installed' : stale ? 'stale' : 'missing',
          expectedPath: foundPath,
        }
      }))
      return {
        databases: rows,
        totalDownloadSizeGB: rows.filter((row) => row.status !== 'installed').reduce((sum, row) => sum + row.estimatedSizeGB, 0),
        checkedAt: Date.now(),
      }
    },
  )

  ipcMain.handle('annovar:install', async (_event, request: AnnovarInstallRequest) => {
    const win = BrowserWindow.getAllWindows()[0]
    const sendProgress = (payload: AnnovarInstallProgress) => {
      win?.webContents.send('annovar:install-progress', payload)
    }

    const scriptsPath = request.scriptsPath.replace(/\/+$/, '')
    const downloader = `${scriptsPath}/annotate_variation.pl`
    const mkdir = `mkdir -p ${shellQuote(request.humandbPath)}`
    const mkdirResult = await ssh.exec(request.connectionId, mkdir)
    if (mkdirResult.exitCode !== 0) {
      throw new Error((mkdirResult.stderr || mkdirResult.stdout || 'Could not create ANNOVAR database folder').trim())
    }

    for (const database of request.databases) {
      sendProgress({
        connectionId: request.connectionId,
        buildver: request.buildver,
        database,
        phase: 'starting',
      })
      await new Promise<void>((resolve, reject) => {
        const command = `perl ${shellQuote(downloader)} -buildver ${shellQuote(request.buildver)} -downdb -webfrom annovar ${shellQuote(database)} ${shellQuote(request.humandbPath)}`
        ssh.execStream(
          request.connectionId,
          command,
          (chunk, stream) => {
            sendProgress({
              connectionId: request.connectionId,
              buildver: request.buildver,
              database,
              phase: 'running',
              chunk: `[${stream}] ${chunk}`,
            })
          },
          (exitCode) => {
            if (exitCode === 0) {
              sendProgress({
                connectionId: request.connectionId,
                buildver: request.buildver,
                database,
                phase: 'done',
              })
              resolve()
              return
            }
            sendProgress({
              connectionId: request.connectionId,
              buildver: request.buildver,
              database,
              phase: 'error',
              chunk: `annotate_variation.pl exited with code ${exitCode ?? -1}`,
            })
            reject(new Error(`ANNOVAR database install failed for ${database}`))
          },
        )
      })
    }

    return { ok: true }
  })
}
