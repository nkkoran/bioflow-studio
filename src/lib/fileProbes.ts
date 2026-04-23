import { detectDelimiter, parseHeaderLine, parseTabularData } from '@/lib/delimitedText'
import type { FileProbeResult } from '@/types/readiness'

export const SAMPLE_ID_ALIASES = ['IID', 'sample_id', 'sampleid', 'participant_id', 'subject_id', 'ID']
export const FAMILY_ID_ALIASES = ['FID', 'family_id', 'familyid']
export const VARIANT_ID_ALIASES = ['ID', 'SNP', 'RSID', 'variant_id']

export function fileProbeCacheKey(connectionId: string, path: string): string {
  return `${connectionId}::${path}`
}

export function probePathKey(path: string): string {
  return path
}

export function expandHomePath(path: string, homeDir: string): string {
  if (path === '~') return homeDir
  if (path.startsWith('~/')) return `${homeDir.replace(/\/+$/, '')}/${path.slice(2)}`
  return path
}

export function looksCompressedText(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith('.gz') || lower.endsWith('.bgz') || lower.endsWith('.bgzip')
}

export function plinkSidecarSuffixes(path: string): string[] {
  const lower = path.toLowerCase()
  if (/\.(bed|bim|fam)$/.test(lower)) return ['.bim', '.fam']
  if (/\.(pgen|pvar|psam)$/.test(lower)) return ['.pvar', '.psam']
  return []
}

export function plinkBasePath(path: string): string {
  return path.replace(/\.(bed|bim|fam|pgen|pvar|psam)$/i, '')
}

export function relatedSidecarPaths(path: string, suffixes: string[]): Record<string, string> {
  const base = plinkBasePath(path)
  return Object.fromEntries(suffixes.map((suffix) => [suffix, `${base}${suffix}`]))
}

export function indexPathsFor(path: string, suffixes: string[]): Record<string, string> {
  return Object.fromEntries(suffixes.map((suffix) => [suffix, `${path}${suffix}`]))
}

export function parseFastqRecordIds(text: string): string[] {
  const lines = text.split(/\r?\n/).filter(Boolean)
  const ids = new Set<string>()
  for (let i = 0; i < lines.length; i += 4) {
    const header = lines[i]
    if (!header.startsWith('@')) continue
    const token = header.slice(1).split(/\s+/, 1)[0]?.replace(/\/[12]$/, '').trim()
    if (token) ids.add(token)
  }
  return [...ids]
}

function firstMatchingColumn(header: string[], aliases: string[]): number {
  const normalized = header.map((column) => column.trim().toLowerCase())
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias.trim().toLowerCase())
    if (idx >= 0) return idx
  }
  return -1
}

export function sampleIdsFromTabular(header: string[], rows: string[][]): string[] {
  const sampleIdx = firstMatchingColumn(header, SAMPLE_ID_ALIASES)
  if (sampleIdx < 0) return []
  const ids = new Set<string>()
  for (const row of rows) {
    const value = row[sampleIdx]?.trim()
    if (value) ids.add(value)
  }
  return [...ids]
}

export function familyIdsFromTabular(header: string[], rows: string[][]): string[] {
  const familyIdx = firstMatchingColumn(header, FAMILY_ID_ALIASES)
  if (familyIdx < 0) return []
  const ids = new Set<string>()
  for (const row of rows) {
    const value = row[familyIdx]?.trim()
    if (value) ids.add(value)
  }
  return [...ids]
}

export function variantIdsFromTabular(header: string[], rows: string[][]): string[] {
  const variantIdx = firstMatchingColumn(header, VARIANT_ID_ALIASES)
  if (variantIdx < 0) return []
  const ids = new Set<string>()
  for (const row of rows) {
    const value = row[variantIdx]?.trim()
    if (value) ids.add(value)
  }
  return [...ids]
}

export function analyzeDelimitedProbe(path: string, text: string): Pick<FileProbeResult, 'delimiter' | 'header' | 'previewRows' | 'sampleIds' | 'recordIds' | 'compression'> {
  const delimiter = detectDelimiter(text)
  const { columns } = parseHeaderLine(text, delimiter)
  const { headers, rows } = parseTabularData(text, delimiter)
  return {
    delimiter,
    header: columns,
    previewRows: rows.slice(0, 20),
    sampleIds: sampleIdsFromTabular(headers, rows),
    recordIds: variantIdsFromTabular(headers, rows),
    compression: looksCompressedText(path) ? 'gzip' : 'none',
  }
}

export function parseFamProbe(text: string): Pick<FileProbeResult, 'previewRows' | 'sampleIds'> {
  const previewRows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((line) => line.split(/\s+/))
  const sampleIds = previewRows.map((row) => row[1]).filter(Boolean)
  return { previewRows, sampleIds }
}

export function parseBimProbe(text: string): Pick<FileProbeResult, 'previewRows' | 'recordIds'> {
  const previewRows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((line) => line.split(/\s+/))
  const recordIds = previewRows.map((row) => row[1]).filter(Boolean)
  return { previewRows, recordIds }
}
