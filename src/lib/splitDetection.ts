import type { RemoteFileEntry } from '@/types/files'
import type { FileNodeSplit, FileType, SplitPattern } from '@/types/pipeline'
import { pathBasename } from '@/lib/utils'

export type SplitDetectMode = 'auto' | 'files' | 'folders'

export interface DetectedSplit {
  folderPath: string
  pattern: SplitPattern
  items: FileNodeSplit['items']
  missing: string[]
  summary: string
  quality: number
}

export interface SplitDetectionRequest {
  listFolder: (path: string) => Promise<RemoteFileEntry[]>
  folder: string
  mode: SplitDetectMode
  axis: string
  fileType: FileType
  seedPath: string
}

export async function detectSplitInFolder({
  listFolder,
  folder,
  mode,
  axis,
  fileType,
  seedPath,
}: SplitDetectionRequest): Promise<DetectedSplit> {
  const entries = await listFolder(folder)
  const candidates: DetectedSplit[] = []

  if (mode === 'auto' || mode === 'files') {
    const files = detectFilesInFolder(folder, entries, fileType, axis)
    if (files) candidates.push(files)
  }
  if (mode === 'auto' || mode === 'folders') {
    const folders = await detectFoldersInFolder(listFolder, folder, entries, fileType, seedPath, axis)
    if (folders) candidates.push(folders)
  }

  if (candidates.length === 0) {
    throw new Error('Could not infer a split pattern in that folder. Use the manual recipe below.')
  }
  return candidates.sort((a, b) => b.quality - a.quality || b.items.length - a.items.length)[0]
}

export function rangeTextFromItems(items: FileNodeSplit['items']): string {
  return rangeTextFromKeys(items.map((item) => item.key))
}

function detectFilesInFolder(
  folder: string,
  entries: RemoteFileEntry[],
  fileType: FileType,
  axis = 'item',
): DetectedSplit | null {
  const files = preferredFiles(entries.filter((entry) => !entry.isDirectory), fileType)
  const group = bestVariableGroup(files.map((entry) => ({ name: entry.name, path: entry.path })))
  if (!group || group.items.length < 2) return null
  const range = rangeTextFromItems(group.items)
  return {
    folderPath: folder,
    pattern: { kind: 'glob', template: `${folder.replace(/\/+$/, '')}/${group.prefix}*${group.suffix}`, capture: 'key' },
    items: group.items,
    missing: [],
    summary: `Detected ${group.items.length} split files (${axis} ${range}).`,
    quality: 60 + group.items.length + averageFileScore(group.items.map((item) => item.path), fileType),
  }
}

async function detectFoldersInFolder(
  listFolder: (path: string) => Promise<RemoteFileEntry[]>,
  folder: string,
  entries: RemoteFileEntry[],
  fileType: FileType,
  seedPath: string,
  axis = 'item',
): Promise<DetectedSplit | null> {
  const folders = entries.filter((entry) => entry.isDirectory)
  const group = bestVariableGroup(folders.map((entry) => ({ name: entry.name, path: entry.path })))
  if (!group || group.items.length < 2) return null

  const folderEntries = folders
    .filter((entry) => group.items.some((item) => item.path === entry.path))
    .slice(0, 100)
  const listings = await Promise.all(folderEntries.map(async (entry) => {
    try {
      return { folder: entry, entries: await listFolder(entry.path) }
    } catch {
      return { folder: entry, entries: [] as RemoteFileEntry[] }
    }
  }))
  const fileName = chooseCommonNestedFile(listings.map((listing) => listing.entries), fileType, pathBasename(seedPath))
  if (!fileName) {
    const fallbackItems = detectOneNestedFilePerFolder(listings, fileType)
    if (fallbackItems.length < 2) return null
    return {
      folderPath: folder,
      pattern: { kind: 'manual' },
      items: fallbackItems,
      missing: [],
      summary: `Detected ${fallbackItems.length} item folders (${axis} ${rangeTextFromItems(fallbackItems)}). The accepted rows are editable below.`,
      quality: 45 + fallbackItems.length + averageFileScore(fallbackItems.map((item) => item.path), fileType),
    }
  }

  const items = folderEntries.map((entry) => ({
    key: captureKeyFromName(entry.name),
    rawKey: rawKeyFromName(entry.name),
    path: `${entry.path.replace(/\/+$/, '')}/${fileName}`,
  }))
  return {
    folderPath: folder,
    pattern: {
      kind: 'crossFolder',
      parentDir: folder,
      childGlob: `${group.prefix}*${group.suffix}`,
      file: fileName,
    },
    items: sortSplitRows(items),
    missing: [],
    summary: `Detected ${items.length} item folders (${axis} ${rangeTextFromItems(items)}); each contains ${fileName}.`,
    quality: 80 + items.length + dataFileScore(fileName, fileType, pathBasename(seedPath)),
  }
}

function detectOneNestedFilePerFolder(
  listings: Array<{ folder: RemoteFileEntry; entries: RemoteFileEntry[] }>,
  fileType: FileType,
): FileNodeSplit['items'] {
  const items: FileNodeSplit['items'] = []
  for (const listing of listings) {
    const key = captureKeyFromName(listing.folder.name)
    const files = preferredFiles(listing.entries.filter((entry) => !entry.isDirectory), fileType)
    if (files.length === 0) continue
    const picked =
      files.find((file) => file.name.includes(key)) ??
      files.find((file) => captureKeyFromName(file.name) === key) ??
      files[0]
    items.push({ key, rawKey: rawKeyFromName(listing.folder.name), path: picked.path })
  }
  return sortSplitRows(items)
}

function preferredFiles(files: RemoteFileEntry[], fileType: FileType): RemoteFileEntry[] {
  const ranked = files
    .map((file) => ({ file, score: dataFileScore(file.name, fileType) }))
    .sort((a, b) => b.score - a.score || a.file.name.localeCompare(b.file.name))
  const nonLog = ranked.filter((entry) => !isLogLikeFile(entry.file.name))
  if (fileType === 'any') {
    const primaryDataFiles = nonLog.filter((entry) => isPrimaryDataFile(entry.file.name))
    if (primaryDataFiles.length > 0) return primaryDataFiles.map((entry) => entry.file)
  }
  const matching = nonLog.filter((entry) => fileMatchesType(entry.file.name, fileType))
  if (matching.length > 0) return matching.map((entry) => entry.file)
  if (nonLog.length > 0) return nonLog.map((entry) => entry.file)
  return ranked.map((entry) => entry.file)
}

function isPrimaryDataFile(name: string): boolean {
  return /\.(pgen|bed|bgen|bcf|bam|sam|cram|vcf|vcf\.gz|fastq|fastq\.gz|fq|fq\.gz)$/i.test(name)
}

function fileMatchesType(name: string, fileType: FileType): boolean {
  if (fileType === 'any') return true
  const lower = name.toLowerCase()
  const extensions: Partial<Record<FileType, string[]>> = {
    vcf: ['.vcf', '.vcf.gz'],
    bcf: ['.bcf'],
    fastq: ['.fastq', '.fastq.gz', '.fq', '.fq.gz'],
    fasta: ['.fasta', '.fa', '.fna'],
    bam: ['.bam'],
    sam: ['.sam'],
    cram: ['.cram'],
    bed: ['.bed'],
    gff: ['.gff', '.gff3'],
    gtf: ['.gtf'],
    plink: ['.bed', '.pgen'],
    pgen: ['.pgen'],
    bgen: ['.bgen'],
    tsv: ['.tsv', '.tsv.gz', '.pheno', '.phen', '.covar', '.sample', '.psam', '.eigenvec', '.profile'],
    csv: ['.csv'],
    txt: ['.txt'],
    json: ['.json'],
    yaml: ['.yaml', '.yml'],
  }
  return (extensions[fileType] ?? []).some((ext) => lower.endsWith(ext))
}

function isLogLikeFile(name: string): boolean {
  return /\.(log|out|err|stderr|stdout)$/i.test(name)
}

function dataFileScore(name: string, fileType: FileType, seedName = ''): number {
  const lower = name.toLowerCase()
  let score = seedName && name === seedName ? 30 : 0
  if (isLogLikeFile(name)) score -= 500

  if (lower.endsWith('.pgen')) score += fileType === 'pgen' || fileType === 'plink' || fileType === 'any' ? 120 : 60
  else if (lower.endsWith('.bed')) score += fileType === 'bed' || fileType === 'plink' || fileType === 'any' ? 105 : 45
  else if (lower.endsWith('.bgen')) score += fileType === 'bgen' || fileType === 'any' ? 100 : 45
  else if (/\.(pvar|psam|bim|fam)$/i.test(lower)) score += fileType === 'plink' || fileType === 'pgen' || fileType === 'any' ? 55 : 20
  else if (/\.(vcf\.gz|vcf|bcf)$/i.test(lower)) score += fileType === 'vcf' || fileType === 'bcf' || fileType === 'any' ? 95 : 35
  else if (/\.(tsv|txt|csv|phen|pheno|covar|sample)$/i.test(lower)) score += fileType === 'tsv' || fileType === 'csv' || fileType === 'txt' || fileType === 'any' ? 75 : 25
  else score += 10

  if (fileMatchesType(name, fileType)) score += 30
  return score
}

function averageFileScore(paths: string[], fileType: FileType): number {
  if (paths.length === 0) return 0
  return paths.reduce((sum, path) => sum + dataFileScore(pathBasename(path), fileType), 0) / paths.length
}

function bestVariableGroup(values: Array<{ name: string; path: string }>): { prefix: string; suffix: string; items: FileNodeSplit['items'] } | null {
  const groups = new Map<string, { prefix: string; suffix: string; items: FileNodeSplit['items']; score: number }>()
  for (const value of values) {
    const seenForValue = new Set<string>()
    for (const candidate of variableKeyCandidates(value.name).sort((a, b) => b.score - a.score)) {
      const id = `${candidate.prefix}\u0000${candidate.suffix}`
      if (seenForValue.has(id)) continue
      seenForValue.add(id)
      const group = groups.get(id) ?? { prefix: candidate.prefix, suffix: candidate.suffix, items: [], score: 0 }
      group.items.push({ key: normalizeSplitKey(candidate.key), rawKey: candidate.key, path: value.path })
      group.score += candidate.score
      groups.set(id, group)
    }
  }
  if (groups.size === 0) return null
  const best = [...groups.values()]
    .map((group) => ({ ...group, items: uniqueSplitRows(group.items) }))
    .filter((group) => group.items.length >= 2)
    .sort((a, b) =>
      variableGroupScore(b) - variableGroupScore(a) ||
      b.items.length - a.items.length ||
      b.score - a.score ||
      a.prefix.length - b.prefix.length,
    )[0]
  return best ? { ...best, items: sortSplitRows(best.items) } : null
}

function variableKeyCandidates(name: string): Array<{ prefix: string; key: string; suffix: string; score: number }> {
  const candidates: Array<{ prefix: string; key: string; suffix: string; score: number }> = []
  const chrRegex = /(?:^|[^A-Za-z0-9])(?:chr|chrom|chromosome|c)[._-]?([0-9]+|x|y|xy|m|mt)(?=$|[^A-Za-z0-9])/ig
  let match: RegExpExecArray | null
  while ((match = chrRegex.exec(name))) {
    const keyStart = match.index + match[0].lastIndexOf(match[1])
    const keyEnd = keyStart + match[1].length
    candidates.push({
      prefix: name.slice(0, keyStart),
      key: match[1],
      suffix: name.slice(keyEnd),
      score: 20,
    })
  }
  const numericRegex = /\d+/g
  while ((match = numericRegex.exec(name))) {
    candidates.push({
      prefix: name.slice(0, match.index),
      key: match[0],
      suffix: name.slice(match.index + match[0].length),
      score: 1,
    })
  }
  return candidates
}

function uniqueSplitRows(items: FileNodeSplit['items']): FileNodeSplit['items'] {
  const rows = new Map<string, FileNodeSplit['items'][number]>()
  for (const item of items) {
    if (!rows.has(item.key)) rows.set(item.key, item)
  }
  return [...rows.values()]
}

function variableGroupScore(group: { items: FileNodeSplit['items']; score: number }): number {
  const numericKeys = group.items
    .map((item) => Number(item.key))
    .filter((key) => Number.isInteger(key))
    .sort((a, b) => a - b)
  let rangeBonus = 0
  if (numericKeys.length >= 2) {
    const contiguous = numericKeys.every((key, index) => index === 0 || key === numericKeys[index - 1] + 1)
    const plausibleChromosomes = numericKeys.every((key) => key >= 1 && key <= 26)
    if (contiguous) rangeBonus += 250
    if (plausibleChromosomes) rangeBonus += 200
    if (numericKeys[0] === 1) rangeBonus += 100
    if (numericKeys.includes(22) || numericKeys.includes(23)) rangeBonus += 100
  }
  return group.items.length * 1000 + group.score + rangeBonus
}

function chooseCommonNestedFile(
  listings: RemoteFileEntry[][],
  fileType: FileType,
  seedName: string,
): string | null {
  const counts = new Map<string, number>()
  for (const entries of listings) {
    const names = new Set(entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name))
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  if (counts.size === 0) return null
  const minCount = listings.length <= 3 ? listings.length : Math.max(2, Math.ceil(listings.length * 0.8))
  const candidates = [...counts.entries()].filter(([, count]) => count >= minCount)
  const nonLogCandidates = candidates.filter(([name]) => !isLogLikeFile(name))
  const pool = nonLogCandidates.length > 0 ? nonLogCandidates : candidates
  const matching = pool.filter(([name]) => fileMatchesType(name, fileType))
  const ranked = (matching.length > 0 ? matching : pool)
    .sort(([nameA, countA], [nameB, countB]) => {
      const scoreA = dataFileScore(nameA, fileType, seedName)
      const scoreB = dataFileScore(nameB, fileType, seedName)
      return scoreB - scoreA || countB - countA || nameA.localeCompare(nameB)
    })
  if (ranked[0]) return ranked[0][0]
  return candidates.sort(([nameA, countA], [nameB, countB]) =>
    dataFileScore(nameB, fileType, seedName) - dataFileScore(nameA, fileType, seedName) ||
    countB - countA ||
    nameA.localeCompare(nameB),
  )[0]?.[0] ?? null
}

function captureKeyFromName(name: string): string {
  const numeric = name.match(/(\d+)/)
  return numeric ? normalizeSplitKey(numeric[1]) : name
}

function rawKeyFromName(name: string): string {
  return name.match(/(\d+)/)?.[1] ?? name
}

function normalizeSplitKey(key: string): string {
  const numeric = Number(key)
  return Number.isFinite(numeric) ? String(numeric) : key
}

function sortSplitRows(items: FileNodeSplit['items']): FileNodeSplit['items'] {
  return [...items].sort((a, b) => {
    const na = Number(a.key)
    const nb = Number(b.key)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
    return a.key.localeCompare(b.key)
  })
}

function rangeTextFromKeys(keys: string[]): string {
  const numeric = keys
    .filter((key) => /^\d+$/.test(key))
    .map(Number)
    .sort((a, b) => a - b)
  const other = keys.filter((key) => !/^\d+$/.test(key)).sort((a, b) => a.localeCompare(b))
  const parts: string[] = []
  for (let i = 0; i < numeric.length; i++) {
    const start = numeric[i]
    let end = start
    while (i + 1 < numeric.length && numeric[i + 1] === end + 1) {
      end = numeric[i + 1]
      i++
    }
    parts.push(start === end ? String(start) : `${start}-${end}`)
  }
  return [...parts, ...other].join(', ')
}
