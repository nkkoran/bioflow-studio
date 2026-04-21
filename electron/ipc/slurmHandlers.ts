import { ipcMain } from 'electron'
import { SshManager } from '../ssh/SshManager'

export interface SlurmQueueEntry {
  jobId: string
  name: string
  state: string
  elapsed: string
  timeLimit: string
  partition: string
  reason: string
}

export function registerSlurmHandlers(): void {
  const ssh = SshManager.getInstance()

  ipcMain.handle('slurm:queue', async (_event, connectionId: string): Promise<SlurmQueueEntry[]> => {
    const { stdout, stderr, exitCode } = await ssh.exec(
      connectionId,
      'squeue -u "$USER" -h -o "%i|%j|%T|%M|%l|%P|%R" 2>/dev/null || true',
    )
    if (exitCode !== 0) {
      throw new Error((stderr || stdout || 'squeue failed').trim())
    }
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseQueueLine)
  })
}

function parseQueueLine(line: string): SlurmQueueEntry {
  const [jobId = '', name = '', state = '', elapsed = '', timeLimit = '', partition = '', ...reasonParts] = line.split('|')
  return {
    jobId,
    name,
    state,
    elapsed,
    timeLimit,
    partition,
    reason: reasonParts.join('|'),
  }
}
