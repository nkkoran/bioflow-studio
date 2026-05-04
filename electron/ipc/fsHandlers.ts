import { ipcMain } from 'electron'
import { SftpPool } from '../ssh/SftpPool'
import { SshManager } from '../ssh/SshManager'
import type { SplitPattern } from '../../src/types/pipeline'

interface SplitItem {
  key: string
  path: string
}

const MAX_SPLIT_ITEMS = 10_000

export function registerFsHandlers(): void {
  const pool = SftpPool.getInstance()
  const ssh = SshManager.getInstance()

  ipcMain.handle(
    'split:resolve',
    async (_event, connectionId: string, pattern: SplitPattern, manualItems?: SplitItem[]) => {
      const home = await resolveHome(ssh, connectionId).catch(() => '')
      const resolvedPattern = expandPatternHome(pattern, home)
      const resolvedManual = (manualItems ?? []).map((item) => ({ ...item, path: expandHome(item.path, home) }))
      const items = await resolveSplitPattern(pool, connectionId, resolvedPattern, resolvedManual)
      const missing: string[] = []
      await Promise.all(items.map(async (item) => {
        const exists = await pathExistsForSplit(pool, ssh, connectionId, item.path)
        if (!exists) {
          missing.push(item.key)
        }
      }))
      return { items, missing }
    },
  )
}

async function resolveHome(ssh: SshManager, connectionId: string): Promise<string> {
  const result = await ssh.exec(connectionId, 'printf %s "$HOME"')
  if (result.exitCode !== 0) return ''
  return result.stdout.trim().replace(/\/+$/, '')
}

function expandPatternHome(pattern: SplitPattern, home: string): SplitPattern {
  if (!home) return pattern
  if (pattern.kind === 'manual') return pattern
  if (pattern.kind === 'brace') return { ...pattern, template: expandHome(pattern.template, home) }
  if (pattern.kind === 'glob') return { ...pattern, template: expandHome(pattern.template, home) }
  return {
    ...pattern,
    parentDir: expandHome(pattern.parentDir, home),
  }
}

function expandHome(path: string, home: string): string {
  if (!home) return path
  if (path === '~') return home
  if (path.startsWith('~/')) return `${home}/${path.slice(2)}`
  return path
}

async function pathExistsForSplit(
  pool: SftpPool,
  ssh: SshManager,
  connectionId: string,
  path: string,
): Promise<boolean> {
  try {
    const stat = await pool.stat(connectionId, path)
    return !stat.isDirectory
  } catch {
    try {
      const result = await ssh.exec(
        connectionId,
        `p=${shellQuote(path)}; if [ -e "$p" ] && [ ! -d "$p" ]; then printf yes; else printf no; fi`,
      )
      return result.exitCode === 0 && result.stdout.trim() === 'yes'
    } catch {
      return false
    }
  }
}

async function resolveSplitPattern(
  pool: SftpPool,
  connectionId: string,
  pattern: SplitPattern,
  manualItems: SplitItem[],
): Promise<SplitItem[]> {
  if (pattern.kind === 'manual') return manualItems

  if (pattern.kind === 'brace') {
    return sortSplitItems(dedupeKeys(
      expandBraceTemplate(pattern.template, MAX_SPLIT_ITEMS).map((path) => ({ key: captureKey(path), path })),
    ))
  }

  if (pattern.kind === 'glob') {
    const slashIdx = pattern.template.lastIndexOf('/')
    const dir = slashIdx >= 0 ? pattern.template.slice(0, slashIdx) : '.'
    const re = globToRegExp(pattern.template, pattern.capture)
    const entries = await pool.ls(connectionId, dir)
    return sortSplitItems(dedupeKeys(entries
      .filter((entry) => !entry.isDirectory)
      .flatMap((entry) => {
        const match = re.exec(entry.path)
        return match ? [{ key: match[1] ?? entry.name, path: entry.path }] : []
      })))
  }

  const parentEntries = await pool.ls(connectionId, pattern.parentDir)
  const childRe = globNameToRegExp(pattern.childGlob)
  const items = parentEntries
    .filter((entry) => entry.isDirectory && childRe.test(entry.name))
    .map((entry) => ({
      key: captureKey(entry.name),
      path: `${entry.path.replace(/\/+$/, '')}/${pattern.file.replace(/^\/+/, '')}`,
    }))
  return sortSplitItems(dedupeKeys(items))
}

function expandBraceTemplate(template: string, cap: number): string[] {
  const first = findFirstBrace(template)
  if (!first) return [template]
  const before = template.slice(0, first.start)
  const after = template.slice(first.end + 1)
  const options = expandBraceOptions(first.body)
  if (options.length === 0) return []
  const out: string[] = []
  for (const option of options) {
    if (out.length >= cap) break
    const suffixes = expandBraceTemplate(after, cap - out.length)
    for (const suffix of suffixes) {
      out.push(`${before}${option}${suffix}`)
      if (out.length >= cap) break
    }
  }
  return out
}

function findFirstBrace(value: string): { start: number; end: number; body: string } | null {
  let start = -1
  let depth = 0
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char === '{') {
      if (depth === 0) start = i
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        return { start, end: i, body: value.slice(start + 1, i) }
      }
      if (depth < 0) return null
    }
  }
  return null
}

function expandBraceOptions(body: string): string[] {
  const numeric = body.match(/^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/)
  if (numeric) {
    const start = Number(numeric[1])
    const end = Number(numeric[2])
    const rawStep = numeric[3] ? Math.abs(Number(numeric[3])) : 1
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(rawStep) || rawStep === 0) return []
    const width = Math.max(numeric[1].replace(/^-/, '').length, numeric[2].replace(/^-/, '').length)
    const step = start <= end ? rawStep : -rawStep
    const out: string[] = []
    for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
      const sign = value < 0 ? '-' : ''
      out.push(`${sign}${String(Math.abs(value)).padStart(width, '0')}`)
      if (out.length >= MAX_SPLIT_ITEMS) break
    }
    return out
  }
  return splitBraceList(body)
}

function splitBraceList(body: string): string[] {
  const values: string[] = []
  let depth = 0
  let current = ''
  for (const char of body) {
    if (char === ',' && depth === 0) {
      values.push(current)
      current = ''
      continue
    }
    if (char === '{') depth++
    if (char === '}') depth--
    current += char
  }
  values.push(current)
  return values.filter((value) => value.length > 0)
}

function globToRegExp(template: string, captureName: string): RegExp {
  const token = captureName.trim()
  if (token && !/^[A-Za-z][A-Za-z0-9_]*$/.test(token)) {
    throw new Error('Glob capture must be a simple token name such as chr or sample.')
  }
  let usedCapture = false
  const source = escapeRegExp(template).replace(/\\\*/g, () => {
    if (!usedCapture) {
      usedCapture = true
      return '([^/]+?)'
    }
    return '[^/]*'
  })
  return new RegExp(`^${source}$`)
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

function dedupeKeys(items: SplitItem[]): SplitItem[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const count = seen.get(item.key) ?? 0
    seen.set(item.key, count + 1)
    return count === 0 ? item : { ...item, key: `${item.key}-${count + 1}` }
  })
}

function sortSplitItems(items: SplitItem[]): SplitItem[] {
  return [...items].sort((a, b) => {
    const na = Number(a.key)
    const nb = Number(b.key)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
    return a.key.localeCompare(b.key)
  })
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
