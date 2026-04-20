import { ipcMain } from 'electron'
import { SshManager } from '../ssh/SshManager'

export function registerClusterHandlers(): void {
  const manager = SshManager.getInstance()

  ipcMain.handle('cluster:loginPolicy', async (_event, connectionId: string) => {
    return manager.getLoginPolicy(connectionId)
  })

  ipcMain.handle('cluster:listAccounts', async (_event, connectionId: string) => {
    const attempts: Array<{ source: 'sacctmgr' | 'sshare' | 'groups'; command: string }> = [
      {
        source: 'sacctmgr',
        command: 'sacctmgr -n -P show assoc user=$USER format=Account 2>/dev/null | awk -F"|" \'NF && $1 != "" {print $1}\' | sort -u',
      },
      {
        source: 'sshare',
        command: 'sshare -U -P -n -o Account 2>/dev/null | awk -F"|" \'NF && $1 != "" {print $1}\' | sort -u',
      },
      {
        source: 'groups',
        command: 'id -Gn 2>/dev/null | tr " " "\\n" | grep -E "^(def|rrg|ctb)-" | sort -u',
      },
    ]

    for (const attempt of attempts) {
      const result = await manager.exec(connectionId, attempt.command)
      if (result.exitCode !== 0) continue
      const accounts = uniqueLines(result.stdout)
      if (accounts.length > 0) {
        return { accounts, source: attempt.source, cachedAt: Date.now() }
      }
    }

    return { accounts: [], source: 'groups' as const, cachedAt: Date.now() }
  })
}

function uniqueLines(text: string): string[] {
  return [...new Set(text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean))]
}
