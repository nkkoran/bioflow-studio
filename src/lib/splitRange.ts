import type { FileNodeSplit, SplitPattern } from '@/types/pipeline'

const KEY_TOKEN = '__BIOFLOW_SPLIT_KEY__'

export interface SplitRangeResolution {
  items: FileNodeSplit['items']
  error?: string
}

export function parseRangeKeys(text: string): string[] {
  const keys: string[] = []
  for (const token of text.split(/[,\s]+/).map((part) => part.trim()).filter(Boolean)) {
    const range = token.match(/^(\d+)\s*(?:-|\.\.)\s*(\d+)$/)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      const step = start <= end ? 1 : -1
      for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
        keys.push(String(value))
      }
    } else {
      keys.push(token)
    }
  }
  return [...new Set(keys)]
}

export function resolveSplitItemsForRange(
  rangeText: string,
  currentItems: FileNodeSplit['items'],
  pattern: SplitPattern,
  axis = 'items',
): SplitRangeResolution {
  const keys = parseRangeKeys(rangeText)
  if (keys.length === 0) {
    return { items: currentItems, error: 'Enter keys like 1-22, 1..22, or 1,2,3.' }
  }

  const existing = new Map(currentItems.map((item) => [item.key, item]))
  const inferred = pattern.kind === 'manual' ? inferPathTemplate(currentItems) : null
  const nextItems: FileNodeSplit['items'] = []
  const missingKeys: string[] = []

  for (const key of keys) {
    const existingItem = existing.get(key)
    const generatedPath = existingItem?.path?.trim()
      || pathForSplitKey(pattern, key)
      || inferred?.(key)

    if (!generatedPath) {
      missingKeys.push(key)
      continue
    }
    nextItems.push({ ...existingItem, key, path: generatedPath })
  }

  if (missingKeys.length > 0) {
    const label = axis.trim() || 'items'
    return {
      items: currentItems,
      error: `Cannot apply ${label} ${missingKeys.join(', ')} because BioFlow cannot infer their paths. Detect or preview the split recipe first, or add one accepted row with the same filename pattern.`,
    }
  }

  return { items: nextItems }
}

export function pathForSplitKey(pattern: SplitPattern, key: string): string {
  if (pattern.kind === 'brace') return pattern.template.replace(/\{[^{}]*\}/, key)
  if (pattern.kind === 'glob') return pattern.template.replace('*', key)
  if (pattern.kind === 'crossFolder') {
    const parent = pattern.parentDir.replace(/\/+$/, '')
    const child = pattern.childGlob.replace('*', key).replace(/^\/+|\/+$/g, '')
    const file = pattern.file.replace(/^\/+/, '')
    if (!parent || !child || !file) return ''
    return `${parent}/${child}/${file}`
  }
  return ''
}

function inferPathTemplate(items: FileNodeSplit['items']): ((key: string) => string) | null {
  const candidates: Array<{ render: (key: string) => string; score: number }> = []
  const usable = items.filter((item) => item.key.trim() && item.path.trim())

  for (const item of usable) {
    for (const template of templatesForItem(item.path, item.key)) {
      const render = (key: string) => template.split(KEY_TOKEN).join(key)
      const score = usable.reduce((count, candidate) => render(candidate.key) === candidate.path ? count + 1 : count, 0)
      candidates.push({ render, score })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.render ?? null
}

function templatesForItem(path: string, key: string): string[] {
  const templates: string[] = []
  const ranges: Array<{ start: number; end: number }> = []
  const addRange = (start: number, end: number) => {
    if (ranges.some((range) => range.start === start && range.end === end)) return
    ranges.push({ start, end })
  }
  const escaped = escapeRegExp(key)
  const chromosomeToken = new RegExp(`(^|[^A-Za-z0-9])((?:chr|chrom|chromosome|c)[._-]?${escaped})(?=$|[^A-Za-z0-9])`, 'ig')
  for (const match of path.matchAll(chromosomeToken)) {
    const token = match[2]
    const tokenStart = (match.index ?? 0) + match[1].length
    const keyStartInToken = token.toLowerCase().lastIndexOf(key.toLowerCase())
    if (keyStartInToken < 0) continue
    addRange(tokenStart + keyStartInToken, tokenStart + keyStartInToken + key.length)
  }

  const bareToken = new RegExp(`(^|[^A-Za-z0-9])(${escaped})(?=$|[^A-Za-z0-9])`, 'g')
  for (const match of path.matchAll(bareToken)) {
    const tokenStart = (match.index ?? 0) + match[1].length
    addRange(tokenStart, tokenStart + key.length)
  }

  for (const range of ranges) {
    templates.push(templateFromRanges(path, [range]))
  }

  if (ranges.length > 1) templates.push(templateFromRanges(path, ranges))
  return [...new Set(templates)]
}

function templateFromRanges(path: string, ranges: Array<{ start: number; end: number }>): string {
  let rendered = path
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    rendered = rendered.slice(0, range.start) + KEY_TOKEN + rendered.slice(range.end)
  }
  return rendered
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
