import { ipcMain } from 'electron'
import { SftpPool } from '../ssh/SftpPool'
import type { SplitPattern } from '../../src/types/pipeline'

interface SplitItem {
  key: string
  path: string
}

export function registerFsHandlers(): void {
  const pool = SftpPool.getInstance()

  ipcMain.handle(
    'split:resolve',
    async (_event, connectionId: string, pattern: SplitPattern, manualItems?: SplitItem[]) => {
      const items = await resolveSplitPattern(pool, connectionId, pattern, manualItems ?? [])
      const missing: string[] = []
      await Promise.all(items.map(async (item) => {
        try {
          const stat = await pool.stat(connectionId, item.path)
          if (stat.isDirectory) missing.push(item.key)
        } catch {
          missing.push(item.key)
        }
      }))
      return { items, missing }
    },
  )
}

async function resolveSplitPattern(
  pool: SftpPool,
  connectionId: string,
  pattern: SplitPattern,
  manualItems: SplitItem[],
): Promise<SplitItem[]> {
  if (pattern.kind === 'manual') return manualItems

  if (pattern.kind === 'brace') {
    const match = pattern.template.match(/^(.*)\{(\d+)\.\.(\d+)\}(.*)$/)
    if (!match) return []
    const [, prefix, startS, endS, suffix] = match
    const start = Number(startS)
    const end = Number(endS)
    const step = start <= end ? 1 : -1
    const items: SplitItem[] = []
    for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
      items.push({ key: String(value), path: `${prefix}${value}${suffix}` })
    }
    return items
  }

  if (pattern.kind === 'glob') {
    const slashIdx = pattern.template.lastIndexOf('/')
    const dir = slashIdx >= 0 ? pattern.template.slice(0, slashIdx) : '.'
    const re = globToRegExp(pattern.template)
    const entries = await pool.ls(connectionId, dir)
    return sortSplitItems(entries
      .filter((entry) => !entry.isDirectory)
      .flatMap((entry) => {
        const match = re.exec(entry.path)
        return match ? [{ key: match[1] ?? entry.name, path: entry.path }] : []
      }))
  }

  const parentEntries = await pool.ls(connectionId, pattern.parentDir)
  const childRe = globNameToRegExp(pattern.childGlob)
  const items = parentEntries
    .filter((entry) => entry.isDirectory && childRe.test(entry.name))
    .map((entry) => ({
      key: captureKey(entry.name),
      path: `${entry.path.replace(/\/+$/, '')}/${pattern.file.replace(/^\/+/, '')}`,
    }))
  return sortSplitItems(items)
}

function globToRegExp(template: string): RegExp {
  return new RegExp('^' + escapeRegExp(template).replace(/\\\*/g, '(.+)') + '$')
}

function globNameToRegExp(template: string): RegExp {
  return new RegExp('^' + escapeRegExp(template).replace(/\\\*/g, '.*') + '$')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

function captureKey(name: string): string {
  const numeric = name.match(/(\d+)/)
  return numeric ? numeric[1] : name
}

function sortSplitItems(items: SplitItem[]): SplitItem[] {
  return [...items].sort((a, b) => {
    const na = Number(a.key)
    const nb = Number(b.key)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
    return a.key.localeCompare(b.key)
  })
}
