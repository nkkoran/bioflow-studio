import type {
  AxisAlignmentReport,
  CleanupPlan,
  DataArtifact,
  DataArtifactRole,
  DataSidecarCheck,
  DryRunScript,
  FileNodeData,
  FileType,
  MergeNodeData,
  PipelineSnapshot,
  ToolNodeData,
  TransformNodeData,
} from '../types/pipeline'
import type { RemoteFileEntry } from '../types/files'
import type { FileOrigin } from '../constants/connections'
import { inferFileType } from './fileTypeInference'

const PLINK_LEGACY_EXTS = ['.bed', '.bim', '.fam'] as const
const PLINK2_EXTS = ['.pgen', '.pvar', '.psam'] as const

export function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}

export function stripKnownPlinkExtension(path: string): { prefix: string; family: 'bed' | 'pgen' | null } {
  const lower = path.toLowerCase()
  for (const ext of PLINK_LEGACY_EXTS) {
    if (lower.endsWith(ext)) return { prefix: path.slice(0, -ext.length), family: 'bed' }
  }
  for (const ext of PLINK2_EXTS) {
    if (lower.endsWith(ext)) return { prefix: path.slice(0, -ext.length), family: 'pgen' }
  }
  return { prefix: path, family: null }
}

export function plinkSidecarsForPath(path: string): DataSidecarCheck[] {
  const { prefix, family } = stripKnownPlinkExtension(path)
  if (!family) return []
  const exts = family === 'bed' ? PLINK_LEGACY_EXTS : PLINK2_EXTS
  return exts.map((ext) => ({
    path: `${prefix}${ext}`,
    role: `plink-${ext.slice(1)}` as DataSidecarCheck['role'],
    required: true,
    status: 'unknown' as const,
  }))
}

export function isPlinkSidecarPath(path: string): boolean {
  return stripKnownPlinkExtension(path).family !== null
}

export function isLargeGeneticPath(path: string): boolean {
  const lower = path.toLowerCase()
  return isPlinkSidecarPath(lower)
    || /\.(bgen|sample|vcf\.gz|bcf|bam|cram)(\.csi|\.tbi|\.bai|\.crai)?$/i.test(lower)
}

function roleFromName(name: string, fileType: FileType): DataArtifactRole {
  const lower = name.toLowerCase()
  if (fileType === 'plink' || fileType === 'pgen' || fileType === 'bgen' || /\.(bed|bim|fam|pgen|pvar|psam|bgen)$/i.test(lower)) return 'genotypes'
  if (lower.includes('pheno')) return 'phenotype'
  if (lower.includes('covar')) return 'covariates'
  if (lower.includes('keep')) return 'keep'
  if (lower.includes('extract') || lower.includes('snp')) return 'extract'
  if (lower.includes('freq')) return 'read-freq'
  if (lower.includes('clump') || lower.includes('sumstat') || lower.includes('gwas')) return 'summary-stats'
  return 'other'
}

export function artifactFromEntry(entry: RemoteFileEntry, origin: FileOrigin): DataArtifact {
  const fileType = entry.isDirectory ? 'any' : inferFileType(entry.name || entry.path)
  const sidecars = entry.isDirectory ? [] : plinkSidecarsForPath(entry.path)
  const kind = entry.isDirectory
    ? 'directory'
    : sidecars.length > 0
      ? 'plink-fileset'
      : 'single-file'
  return {
    id: `${origin}:${entry.path}`,
    label: entry.name || basename(entry.path),
    kind,
    role: roleFromName(entry.name || entry.path, fileType),
    origin,
    path: entry.path,
    fileType,
    sidecars,
    size: entry.size,
    modified: entry.modified,
  }
}

export function protectedPathsForFileData(data: FileNodeData, opts: { includeSidecars?: boolean } = {}): string[] {
  const includeSidecars = opts.includeSidecars ?? true
  const paths = new Set<string>()
  if (data.path) paths.add(data.path)
  for (const item of data.split?.items ?? []) {
    if (item.path) paths.add(item.path)
  }
  if (includeSidecars) {
    for (const path of [...paths]) {
      for (const sidecar of plinkSidecarsForPath(path)) paths.add(sidecar.path)
    }
  }
  return [...paths].filter(Boolean)
}

export function collectProtectedInputPaths(snapshot: PipelineSnapshot, opts: { includeSidecars?: boolean } = {}): string[] {
  const protectedPaths = new Set<string>()
  for (const node of snapshot.nodes) {
    if (node.type !== 'file') continue
    const data = node.data as FileNodeData
    if (!data.isInput) continue
    for (const path of protectedPathsForFileData(data, opts)) protectedPaths.add(path)
  }
  return [...protectedPaths]
}

function splitKeys(data: FileNodeData | undefined): string[] {
  return (data?.split?.items ?? [])
    .map((item) => item.key || item.rawKey || '')
    .filter(Boolean)
}

export function buildAxisAlignmentReport(snapshot: PipelineSnapshot, nodeId: string): AxisAlignmentReport {
  const rows: AxisAlignmentReport['rows'] = []
  for (const edge of snapshot.edges) {
    if (edge.target !== nodeId) continue
    const source = snapshot.nodes.find((node) => node.id === edge.source)
    if (source?.type !== 'file') continue
    const data = source.data as FileNodeData
    const keys = splitKeys(data)
    if (keys.length === 0) continue
    rows.push({
      portId: edge.targetHandle ?? 'input',
      axis: data.split?.axis,
      keys,
      missingKeys: [],
      extraKeys: [],
    })
  }
  if (rows.length === 0) {
    return { nodeId, status: 'single', rows, message: 'No split inputs are connected.' }
  }
  if (rows.length === 1) {
    return {
      nodeId,
      status: 'ok',
      controllingPortId: rows[0].portId,
      axis: rows[0].axis,
      rows,
      message: `One split input controls the run (${rows[0].keys.length} items).`,
    }
  }

  const controlling = rows[0]
  const expected = new Set(controlling.keys)
  let mismatch = false
  for (const row of rows.slice(1)) {
    const actual = new Set(row.keys)
    row.missingKeys = controlling.keys.filter((key) => !actual.has(key))
    row.extraKeys = row.keys.filter((key) => !expected.has(key))
    if (row.axis !== controlling.axis || row.missingKeys.length > 0 || row.extraKeys.length > 0) mismatch = true
  }
  return {
    nodeId,
    status: mismatch ? 'mismatch' : 'ok',
    controllingPortId: controlling.portId,
    axis: controlling.axis,
    rows,
    message: mismatch
      ? 'Split inputs do not line up exactly. Choose the controlling input and review missing or extra keys.'
      : `All split inputs share ${controlling.keys.length} ${controlling.axis || 'axis'} keys.`,
  }
}

function addAxisOutputPaths(paths: Set<string>, value: unknown): void {
  if (!value || typeof value !== 'object') return
  const row = value as { kind?: unknown; path?: unknown; paths?: unknown }
  if (row.kind === 'single' && typeof row.path === 'string') paths.add(row.path)
  if (Array.isArray(row.paths)) {
    for (const path of row.paths) if (typeof path === 'string') paths.add(path)
  }
}

export function buildCleanupPlan(snapshot: PipelineSnapshot, scripts: DryRunScript[] = []): CleanupPlan {
  const policy = snapshot.execution?.fileLifecyclePolicy ?? 'keep-all'
  const generatedIntermediatePaths = new Set<string>()
  const protectedInputPaths = collectProtectedInputPaths(snapshot)
  const protectedSet = new Set(protectedInputPaths)

  const flaggedNodeIds = new Set<string>()
  for (const node of snapshot.nodes) {
    if (node.type === 'tool') {
      const data = node.data as ToolNodeData
      if (Object.values(data.outputIntermediate ?? {}).some(Boolean)) flaggedNodeIds.add(node.id)
    } else if (node.type === 'transform') {
      const data = node.data as TransformNodeData
      if (Object.values(data.outputIntermediate ?? {}).some(Boolean)) flaggedNodeIds.add(node.id)
    } else if (node.type === 'merge') {
      const data = node.data as MergeNodeData
      if (Object.values(data.outputIntermediate ?? {}).some(Boolean)) flaggedNodeIds.add(node.id)
    }
  }
  for (const script of scripts) {
    const paths = script.intermediatePaths?.length
      ? script.intermediatePaths
      : flaggedNodeIds.has(script.nodeId)
        ? script.outputPaths
        : []
    for (const path of paths) generatedIntermediatePaths.add(path)
  }
  const unsafe = [...generatedIntermediatePaths].filter((path) => protectedSet.has(path))
  return {
    policy,
    explicitDeleteRequested: policy !== 'keep-all',
    generatedIntermediatePaths: [...generatedIntermediatePaths].filter((path) => !protectedSet.has(path)),
    protectedInputPaths,
    warnings: unsafe.length > 0
      ? [`${unsafe.length} generated path(s) matched protected inputs and will never be deleted.`]
      : [],
  }
}
