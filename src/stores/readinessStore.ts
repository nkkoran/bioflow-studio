import { create } from 'zustand'
import { LOCAL_CONNECTION_ID } from '@/stores/connectionStore'
import { analyzeDelimitedProbe, expandHomePath, fileProbeCacheKey, indexPathsFor, looksCompressedText, parseBimProbe, parseFamProbe, parseFastqRecordIds, plinkSidecarSuffixes, probePathKey, relatedSidecarPaths } from '@/lib/fileProbes'
import { evaluateWorkflowReadiness } from '@/lib/workflowReadiness'
import type { FileOrigin } from '@/constants/connections'
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

interface InputFileEntry {
  path: string
  fileType: string
  origin: FileOrigin
  projectId?: string
}

async function resolveHomeDir(connectionId: string): Promise<string> {
  if (connectionId === LOCAL_CONNECTION_ID) return window.api.local.homedir()
  const result = await window.api.ssh.exec(connectionId, 'printf %s "$HOME"')
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Could not resolve remote home directory.')
  return result.stdout.trim()
}

async function safeStat(connectionId: string, path: string): Promise<FileStatLike | null> {
  try {
    const stat = connectionId === LOCAL_CONNECTION_ID
      ? await window.api.local.stat(path)
      : await window.api.sftp.stat(connectionId, path)
    return stat
  } catch {
    if (connectionId === LOCAL_CONNECTION_ID) return null
    return statRemotePathViaShell(connectionId, path)
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
    if (connectionId === LOCAL_CONNECTION_ID) return null
    return previewRemoteTextViaShell(connectionId, path, lines)
  }
}

async function statRemotePathViaShell(connectionId: string, path: string): Promise<FileStatLike | null> {
  try {
    const result = await window.api.ssh.exec(
      connectionId,
      `p=${shellQuote(path)}; if [ ! -e "$p" ] && [ ! -L "$p" ]; then exit 1; fi; kind=file; [ -d "$p" ] && kind=dir; meta=$(stat -Lc '%s %Y %A' -- "$p" 2>/dev/null) || exit 1; printf '%s %s' "$meta" "$kind"`,
    )
    if (result.exitCode !== 0) return null
    const [sizeRaw, modifiedRaw, permissions = '', kind = 'file'] = result.stdout.trim().split(/\s+/)
    return {
      size: Number(sizeRaw) || 0,
      modified: (Number(modifiedRaw) || 0) * 1000,
      isDirectory: kind === 'dir',
      permissions,
    }
  } catch {
    return null
  }
}

async function previewRemoteTextViaShell(connectionId: string, path: string, lines: number): Promise<string | null> {
  try {
    const count = Math.max(1, Math.floor(lines))
    const result = await window.api.ssh.exec(connectionId, `head -n ${count} -- ${shellQuote(path)}`)
    if (result.exitCode !== 0 && !result.stdout) return null
    return result.stdout
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
        const bimProbe = parseBimProbe(variantText)
        probe.variantHeader = ['CHROM', 'ID', 'CM', 'POS', 'A1', 'A2']
        probe.variantPreviewRows = bimProbe.previewRows
        probe.recordIds = bimProbe.recordIds
      } else {
        const variantProbe = analyzeDelimitedProbe(variantPath, variantText)
        probe.variantHeader = variantProbe.header
        probe.variantPreviewRows = variantProbe.previewRows
        probe.recordIds = variantProbe.recordIds
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

async function safeDnxStat(projectId: string, path: string): Promise<FileStatLike | null> {
  try {
    return await window.api.dnx.stat({ projectId, path })
  } catch {
    return null
  }
}

async function dnxPreviewText(projectId: string, path: string, lines: number): Promise<string | null> {
  if (looksCompressedText(path)) return null
  try {
    return await window.api.dnx.head({ projectId, path, lines })
  } catch {
    return null
  }
}

async function probeDnxPath(
  projectId: string | undefined,
  rawPath: string,
  fileTypeHint?: string,
  cached?: FileProbeResult,
): Promise<FileProbeResult> {
  if (!projectId) {
    return {
      key: probePathKey(rawPath),
      path: rawPath,
      exists: false,
      fileTypeHint,
      errors: ['DNAnexus project is not configured for this file'],
    }
  }
  const stat = await safeDnxStat(projectId, rawPath)
  if (!stat) {
    return {
      key: probePathKey(rawPath),
      path: rawPath,
      exists: false,
      fileTypeHint,
      errors: ['DNAnexus file does not exist or is not accessible'],
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
    fileTypeHint: fileTypeHint ?? inferProbeFileType(rawPath),
    compression: looksCompressedText(rawPath) ? 'gzip' : 'none',
  }

  if (isDelimitedLike(rawPath, fileTypeHint)) {
    const text = await dnxPreviewText(projectId, rawPath, 30)
    if (text) Object.assign(probe, analyzeDelimitedProbe(rawPath, text))
  } else if (isFastqLike(rawPath, fileTypeHint)) {
    const text = await dnxPreviewText(projectId, rawPath, 24)
    if (text) probe.recordIds = parseFastqRecordIds(text)
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

export function inputFileNodes(snapshot: PipelineSnapshot): InputFileEntry[] {
  return snapshot.nodes
    .filter((node) => node.type === 'file' && (node.data as FileNodeData).isInput)
    .flatMap((node) => {
      const data = node.data as FileNodeData
      const origin = data.artifactRef?.origin ?? data.origin ?? (data.source === 'local' ? 'local' : 'ssh')
      const projectId = data.artifactRef?.projectId ?? (data as { dnxProjectId?: string }).dnxProjectId
      const rawSplitItems = (data.split as { items?: unknown } | undefined)?.items
      if (Array.isArray(rawSplitItems) && rawSplitItems.length > 0) {
        return rawSplitItems.map((item) => ({
          path: typeof (item as { path?: unknown }).path === 'string' ? (item as { path: string }).path : '',
          fileType: data.fileType,
          origin,
          projectId,
        }))
      }
      return [{ path: data.artifactRef?.path || data.path, fileType: data.fileType, origin, projectId }]
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

      await Promise.all(nodes.map(async ({ path, fileType, origin, projectId }) => {
        const cacheKey = origin === 'dnx' ? fileProbeCacheKey(`dnx:${projectId ?? 'unknown'}`, path) : fileProbeCacheKey(connectionId, path)
        const probe = origin === 'dnx'
          ? await probeDnxPath(projectId, path, fileType, options?.force ? undefined : nextCache[cacheKey])
          : await probePath(connectionId, path, homeDir, fileType, options?.force ? undefined : nextCache[cacheKey])
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
