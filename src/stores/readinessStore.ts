import { create } from 'zustand'
import { LOCAL_CONNECTION_ID } from '@/stores/connectionStore'
import { analyzeDelimitedProbe, expandHomePath, fileProbeCacheKey, indexPathsFor, looksCompressedText, parseBimProbe, parseFamProbe, parseFastqRecordIds, plinkSidecarSuffixes, probePathKey, relatedSidecarPaths } from '@/lib/fileProbes'
import { evaluateWorkflowReadiness } from '@/lib/workflowReadiness'
import type { FileNodeData, PipelineSnapshot } from '@/types/pipeline'
import type { FileProbeResult, WorkflowReadinessReport } from '@/types/readiness'

interface WorkflowReadinessStoreState {
  probeCache: Record<string, FileProbeResult>
  loading: boolean
  lastReport: WorkflowReadinessReport | null
  evaluateSnapshot: (connectionId: string, snapshot: PipelineSnapshot, options?: { force?: boolean }) => Promise<WorkflowReadinessReport>
  clearCache: (connectionId?: string) => void
}

interface FileStatLike {
  size: number
  modified: number
  isDirectory: boolean
  permissions: string
}

async function resolveHomeDir(connectionId: string): Promise<string> {
  if (connectionId === LOCAL_CONNECTION_ID) return window.api.local.homedir()
  const result = await window.api.ssh.exec(connectionId, 'printf %s "$HOME"')
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Could not resolve remote home directory.')
  return result.stdout.trim()
}

async function safeStat(connectionId: string, path: string): Promise<FileStatLike | null> {
  try {
    return connectionId === LOCAL_CONNECTION_ID
      ? await window.api.local.stat(path)
      : await window.api.sftp.stat(connectionId, path)
  } catch {
    return null
  }
}

async function previewText(connectionId: string, path: string, lines: number): Promise<string | null> {
  try {
    if (looksCompressedText(path)) {
      if (connectionId === LOCAL_CONNECTION_ID) return window.api.local.headGzip(path, lines)
      const result = await window.api.ssh.exec(connectionId, `gzip -cd -- ${shellQuote(path)} 2>/dev/null | head -n ${Math.max(1, Math.floor(lines))}`)
      if (result.exitCode !== 0 && !result.stdout) return null
      return result.stdout
    }
    return connectionId === LOCAL_CONNECTION_ID
      ? await window.api.local.head(path, lines)
      : await window.api.sftp.head(connectionId, path, lines)
  } catch {
    return null
  }
}

async function resolvePlinkPrimaryPath(connectionId: string, originalPath: string, fileTypeHint?: string): Promise<string> {
  if (/\.(bed|bim|fam|pgen|pvar|psam)$/i.test(originalPath)) return originalPath
  if (fileTypeHint !== 'plink' && fileTypeHint !== 'pgen') return originalPath
  const pgenStat = await safeStat(connectionId, `${originalPath}.pgen`)
  if (pgenStat) return `${originalPath}.pgen`
  const bedStat = await safeStat(connectionId, `${originalPath}.bed`)
  if (bedStat) return `${originalPath}.bed`
  return originalPath
}

async function probePath(
  connectionId: string,
  rawPath: string,
  homeDir: string,
  fileTypeHint?: string,
  cached?: FileProbeResult,
): Promise<FileProbeResult> {
  const expandedPath = expandHomePath(rawPath, homeDir)
  const primaryPath = await resolvePlinkPrimaryPath(connectionId, expandedPath, fileTypeHint)
  const stat = await safeStat(connectionId, primaryPath)
  if (!stat) {
    return {
      key: probePathKey(rawPath),
      path: rawPath,
      exists: false,
      fileTypeHint,
      errors: ['Path does not exist'],
    }
  }

  if (
    cached
    && cached.exists
    && cached.modified === stat.modified
    && cached.size === stat.size
    && cached.isDirectory === stat.isDirectory
  ) {
    return cached
  }

  const probe: FileProbeResult = {
    key: probePathKey(rawPath),
    path: rawPath,
    exists: true,
    modified: stat.modified,
    size: stat.size,
    isDirectory: stat.isDirectory,
    fileTypeHint: fileTypeHint ?? inferProbeFileType(primaryPath),
    compression: looksCompressedText(primaryPath) ? 'gzip' : 'none',
  }

  const sidecars: Record<string, boolean> = {}
  const indexes: Record<string, boolean> = {}

  if (probe.fileTypeHint === 'plink' || probe.fileTypeHint === 'pgen' || /\.(bed|bim|fam|pgen|pvar|psam)$/i.test(primaryPath)) {
    const sidecarPaths = relatedSidecarPaths(primaryPath, plinkSidecarSuffixes(primaryPath))
    for (const [suffix, sidecarPath] of Object.entries(sidecarPaths)) {
      sidecars[suffix] = Boolean(await safeStat(connectionId, sidecarPath))
    }
    probe.sidecars = sidecars

    const famPath = /\.(bed|bim|fam)$/i.test(primaryPath)
      ? `${primaryPath.replace(/\.(bed|bim|fam)$/i, '')}.fam`
      : `${primaryPath.replace(/\.(pgen|pvar|psam)$/i, '')}.psam`
    const famText = await previewText(connectionId, famPath, 20)
    if (famText) {
      if (famPath.endsWith('.fam')) {
        const famProbe = parseFamProbe(famText)
        probe.previewRows = famProbe.previewRows
        probe.sampleIds = famProbe.sampleIds
      } else {
        const psamProbe = analyzeDelimitedProbe(famPath, famText)
        probe.header = psamProbe.header
        probe.previewRows = psamProbe.previewRows
        probe.sampleIds = psamProbe.sampleIds
      }
    }

    const variantPath = /\.(bed|bim|fam)$/i.test(primaryPath)
      ? `${primaryPath.replace(/\.(bed|bim|fam)$/i, '')}.bim`
      : `${primaryPath.replace(/\.(pgen|pvar|psam)$/i, '')}.pvar`
    const variantText = await previewText(connectionId, variantPath, 20)
    if (variantText) {
      if (variantPath.endsWith('.bim')) {
        probe.recordIds = parseBimProbe(variantText).recordIds
      } else {
        probe.recordIds = analyzeDelimitedProbe(variantPath, variantText).recordIds
      }
    }
  } else {
    for (const [suffix, indexPath] of Object.entries(commonIndexPaths(primaryPath))) {
      indexes[suffix] = Boolean(await safeStat(connectionId, indexPath))
    }
    if (Object.keys(indexes).length > 0) probe.indexes = indexes
    if (primaryPath.toLowerCase().endsWith('.bgen')) {
      sidecars['.sample'] = Boolean(await safeStat(connectionId, `${primaryPath}.sample`))
      probe.sidecars = sidecars
    }

    if (isDelimitedLike(primaryPath, fileTypeHint)) {
      const text = await previewText(connectionId, primaryPath, 30)
      if (text) Object.assign(probe, analyzeDelimitedProbe(primaryPath, text))
      if (probe.header?.[0] === 'CHROM' && (probe.header.length ?? 0) > 9) {
        probe.sampleIds = probe.header.slice(9)
      }
    } else if (isFastqLike(primaryPath, fileTypeHint)) {
      const text = await previewText(connectionId, primaryPath, 24)
      if (text) probe.recordIds = parseFastqRecordIds(text)
    }
  }

  return probe
}

function inferProbeFileType(path: string): string {
  const lower = path.toLowerCase()
  if (/\.(tsv|txt|csv|vcf|vcf\.gz|pvar|psam)$/.test(lower)) return 'tsv'
  if (/\.(bed|bim|fam)$/.test(lower)) return 'plink'
  if (/\.(pgen)$/.test(lower)) return 'pgen'
  if (/\.(fastq|fq)(\.gz)?$/.test(lower)) return 'fastq'
  if (/\.(bam|cram|sam)$/.test(lower)) return 'bam'
  if (/\.(bcf)$/.test(lower)) return 'bcf'
  if (/\.(bgen)$/.test(lower)) return 'bgen'
  return 'any'
}

function isDelimitedLike(path: string, fileTypeHint?: string): boolean {
  const lower = path.toLowerCase()
  return ['tsv', 'csv', 'txt', 'vcf', 'any', 'bgen'].includes(fileTypeHint ?? '')
    || lower.endsWith('.tsv')
    || lower.endsWith('.txt')
    || lower.endsWith('.csv')
    || lower.endsWith('.vcf')
    || lower.endsWith('.vcf.gz')
    || lower.endsWith('.pvar')
    || lower.endsWith('.psam')
    || lower.endsWith('.sample')
}

function isFastqLike(path: string, fileTypeHint?: string): boolean {
  const lower = path.toLowerCase()
  return fileTypeHint === 'fastq' || lower.endsWith('.fastq') || lower.endsWith('.fq') || lower.endsWith('.fastq.gz') || lower.endsWith('.fq.gz')
}

function commonIndexPaths(path: string): Record<string, string> {
  const lower = path.toLowerCase()
  if (lower.endsWith('.vcf.gz') || lower.endsWith('.bcf')) {
    return indexPathsFor(path, ['.tbi', '.csi'])
  }
  if (lower.endsWith('.bam')) {
    return {
      '.bai': `${path}.bai`,
    }
  }
  if (lower.endsWith('.cram')) {
    return {
      '.crai': `${path}.crai`,
    }
  }
  return {}
}

export function inputFileNodes(snapshot: PipelineSnapshot): Array<{ path: string; fileType: string }> {
  return snapshot.nodes
    .filter((node) => node.type === 'file' && (node.data as FileNodeData).isInput)
    .flatMap((node) => {
      const data = node.data as FileNodeData
      const rawSplitItems = (data.split as { items?: unknown } | undefined)?.items
      if (Array.isArray(rawSplitItems) && rawSplitItems.length > 0) {
        return rawSplitItems.map((item) => ({
          path: typeof (item as { path?: unknown }).path === 'string' ? (item as { path: string }).path : '',
          fileType: data.fileType,
        }))
      }
      return [{ path: data.path, fileType: data.fileType }]
    })
    .filter((entry) => Boolean(entry.path?.trim()))
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export const useWorkflowReadinessStore = create<WorkflowReadinessStoreState>((set, get) => ({
  probeCache: {},
  loading: false,
  lastReport: null,

  evaluateSnapshot: async (connectionId, snapshot, options) => {
    set({ loading: true })
    try {
      const homeDir = await resolveHomeDir(connectionId)
      const nodes = inputFileNodes(snapshot)
      const nextCache = { ...get().probeCache }
      const probesByPath: Record<string, FileProbeResult> = {}

      await Promise.all(nodes.map(async ({ path, fileType }) => {
        const cacheKey = fileProbeCacheKey(connectionId, path)
        const probe = await probePath(connectionId, path, homeDir, fileType, options?.force ? undefined : nextCache[cacheKey])
        nextCache[cacheKey] = probe
        probesByPath[probePathKey(path)] = probe
      }))

      const report = evaluateWorkflowReadiness(snapshot, { probes: probesByPath })
      set({ probeCache: nextCache, lastReport: report, loading: false })
      return report
    } catch (error: any) {
      set({ loading: false })
      if (connectionId === LOCAL_CONNECTION_ID) {
        const report = evaluateWorkflowReadiness(snapshot, { probes: {} })
        set({ lastReport: report })
        return report
      }
      throw error
    }
  },

  clearCache: (connectionId) => set((state) => {
    if (!connectionId) return { probeCache: {}, lastReport: null }
    const prefix = `${connectionId}::`
    const probeCache = Object.fromEntries(
      Object.entries(state.probeCache).filter(([key]) => !key.startsWith(prefix)),
    )
    return { probeCache, lastReport: null }
  }),
}))
