import { ipcMain } from 'electron'
import { SshManager } from '../ssh/SshManager'
import { getSettingsStore } from '../store/settingsStore'
import type { RunState } from '../../src/types/pipeline'
import type { ClusterModuleSuggestion } from '../../src/types/ssh'
import {
  parseSacctElapsedHours,
  parseSacctMemoryGB,
  summarizeSacctSamples,
} from '../../src/lib/resourceLearning'

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

  ipcMain.handle('cluster:listModules', async (_event, connectionId: string, query?: string) => {
    const needle = String(query ?? '').trim()
    const commands: Array<{ source: 'module-spider' | 'module-avail'; command: string }> = [
      {
        source: 'module-spider',
        command: needle
          ? `module spider ${shellWord(needle)} 2>&1`
          : 'module -t avail 2>&1',
      },
      {
        source: 'module-avail',
        command: needle
          ? `module -t avail ${shellWord(needle)} 2>&1`
          : 'module -t avail 2>&1',
      },
    ]

    for (const attempt of commands) {
      const result = await manager.exec(connectionId, attempt.command)
      const text = `${result.stdout}\n${result.stderr}`.trim()
      const modules = parseModuleSuggestions(text, needle)
      if (modules.length > 0) {
        return { modules, source: attempt.source, cachedAt: Date.now() }
      }
    }

    return { modules: [], source: 'module-avail' as const, cachedAt: Date.now() }
  })

  ipcMain.handle('cluster:getLearnedResources', async (_event, connectionId: string, toolId: string, options?: { force?: boolean }) => {
    const store = getSettingsStore() as unknown as { get: (key: string) => unknown; set: (key: string, value: unknown) => void }
    const key = learnedKey(connectionId, toolId)
    const cached = store.get(key)
    const runs = readPersistedRuns(store)
    const newestMatchingRun = latestRunUpdateForTool(runs, connectionId, toolId)
    if (!options?.force && isLearnedSummary(cached) && cached.lastUpdated >= newestMatchingRun) return cached
    const jobIds = collectJobIdsForTool(runs, connectionId, toolId)
    if (jobIds.length === 0) return null

    const result = await manager.exec(
      connectionId,
      `sacct -X -P -n -j ${jobIds.join(',')} --format=JobIDRaw,State,Elapsed,MaxRSS 2>/dev/null`,
    )
    const summary = summarizeSacctRows(toolId, result.stdout, jobIds)
    if (summary) store.set(key, summary)
    return summary
  })

  ipcMain.handle('cluster:resetLearnedResources', async (_event, connectionId: string, toolId: string) => {
    const store = getSettingsStore() as unknown as { delete: (key: string) => void }
    store.delete(learnedKey(connectionId, toolId))
  })
}

function uniqueLines(text: string): string[] {
  return [...new Set(text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean))]
}

function shellWord(value: string): string {
  if (/^[A-Za-z0-9._+\-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function parseModuleSuggestions(text: string, query: string): ClusterModuleSuggestion[] {
  const grouped = new Map<string, ClusterModuleSuggestion>()
  const details: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('-') || line.startsWith('Where:') || line.startsWith('You will need')) continue
    const matches = line.match(/[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)+/g)
    if (matches?.length) {
      for (const name of matches) {
        if (query && !name.toLowerCase().includes(query.toLowerCase())) continue
        const [base, ...versionParts] = name.split('/')
        const version = versionParts.join('/')
        const current = grouped.get(base) ?? { name: base, versions: [], description: details.at(-1) }
        if (version && !current.versions.includes(version)) current.versions.push(version)
        grouped.set(base, current)
      }
      continue
    }
    if (/^[A-Za-z]/.test(line)) details.push(line)
  }
  return [...grouped.values()]
    .map((entry) => ({ ...entry, versions: entry.versions.sort(), details: entry.description }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 30)
}

function learnedKey(connectionId: string, toolId: string): string {
  return `resource-learning:${connectionId}:${toolId}`
}

function isLearnedSummary(value: unknown): value is NonNullable<ReturnType<typeof summarizeSacctSamples>> {
  return Boolean(value && typeof value === 'object' && 'toolId' in value && 'sampleCount' in value && 'lastUpdated' in value)
}

function readPersistedRuns(store: { get: (key: string) => unknown }): RunState[] {
  const raw = store.get('pipeline:runs:v1')
  return Array.isArray(raw) ? raw as RunState[] : []
}

function collectJobIdsForTool(runs: RunState[], connectionId: string, toolId: string): string[] {
  const ids = new Set<string>()
  for (const run of runs) {
    if (run.connectionId !== connectionId) continue
    for (const node of Object.values(run.nodes)) {
      if (node.toolId !== toolId) continue
      if (node.status !== 'done') continue
      if (!node.jobId || !/^\d+([_.-]\d+)?$/.test(node.jobId)) continue
      ids.add(node.jobId)
    }
  }
  return [...ids].slice(-25)
}

function latestRunUpdateForTool(runs: RunState[], connectionId: string, toolId: string): number {
  let newest = 0
  for (const run of runs) {
    if (run.connectionId !== connectionId) continue
    if (!Object.values(run.nodes).some((node) => node.toolId === toolId)) continue
    newest = Math.max(newest, run.updatedAt || run.createdAt || 0)
  }
  return newest
}

function summarizeSacctRows(toolId: string, stdout: string, requestedJobIds: string[]) {
  const requested = new Set(requestedJobIds.map((jobId) => jobId.replace(/\..*$/, '')))
  const samples = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [jobIdRaw, state, elapsed, maxRss] = line.split('|')
      const jobId = String(jobIdRaw ?? '').trim()
      const baseJobId = jobId.replace(/\..*$/, '')
      if (!requested.has(baseJobId)) return []
      if (!/^COMPLETED/i.test(String(state ?? '').trim())) return []
      const runtimeHours = parseSacctElapsedHours(String(elapsed ?? ''))
      const maxMemoryGB = parseSacctMemoryGB(String(maxRss ?? ''))
      if (runtimeHours <= 0 && maxMemoryGB <= 0) return []
      return [{ jobId: baseJobId, runtimeHours, maxMemoryGB }]
    })
  return summarizeSacctSamples(toolId, dedupeSamples(samples))
}

function dedupeSamples(samples: Array<{ jobId: string; runtimeHours: number; maxMemoryGB: number }>) {
  const byJob = new Map<string, { jobId: string; runtimeHours: number; maxMemoryGB: number }>()
  for (const sample of samples) {
    const current = byJob.get(sample.jobId)
    if (!current || sample.runtimeHours > current.runtimeHours || sample.maxMemoryGB > current.maxMemoryGB) {
      byJob.set(sample.jobId, sample)
    }
  }
  return [...byJob.values()]
}
