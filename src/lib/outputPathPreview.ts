import type { FileNodeData, FileType, MergeStrategy, PipelineSnapshot, ToolNodeData, TransferNodeData, TransformNodeData } from '@/types/pipeline'
import type { FileOrigin } from '@/constants/connections'
import type { PathSettings } from '@/stores/settingsStore'
import { getTool } from '@/lib/toolRegistry'
import { joinRemotePath, pathBasename, pathDirname, trimTrailingSlash } from '@/lib/remotePath'

export function computeNodeOutputPreview(
  nodeId: string,
  snapshot: PipelineSnapshot,
  pathSettings: PathSettings,
): string | null {
  const node = snapshot.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return null
  const slug = buildNodeSlugs(snapshot).get(nodeId) ?? nodeId
  const runDir = pathSettings.runFolderTemplate || 'runs/{pipelineSlug}-{timestamp}'
  const outputRoot = pathSettings.createSubfolders
    ? joinRemotePath(trimTrailingSlash(runDir), cleanSegment(pathSettings.outputsSubfolder || 'outputs'))
    : trimTrailingSlash(runDir)

  if (node.type === 'tool') {
    const tool = getTool((node.data as ToolNodeData).toolId)
    const port = tool?.outputs[0]
    if (!port) return null
    const physicalPreviews = computeToolPortPhysicalOutputPreviews(nodeId, port.id, snapshot, pathSettings)
    if (physicalPreviews.length > 0) return physicalPreviews.join(' + ')
    return computeToolPortOutputPreview(nodeId, port.id, snapshot, pathSettings)
  }

  if (node.type === 'transform') {
    const data = node.data as TransformNodeData
    const outputDir = previewOutputDir(data.outputDirOverride, outputRoot, slug)
    const sink = connectedOutputSink(snapshot, nodeId, 'output')
    const fallback = defaultOutputPath(outputDir, slug, 'output', data.fileType)
    return sink ? sinkPath(sink, outputDir, fallback) : fallback
  }

  if (node.type === 'merge') {
    const outputDir = previewOutputDir((node.data as { outputDirOverride?: string }).outputDirOverride, outputRoot, slug)
    const sink = connectedOutputSink(snapshot, nodeId, 'output')
    const fallback = `${outputDir}/${slug}.output`
    return sink ? sinkPath(sink, outputDir, fallback) : fallback
  }

  if (node.type === 'transfer') {
    const data = node.data as TransferNodeData
    const targetFolder = data.to === 'local' ? data.localFolder : data.to === 'dnx' ? data.dnxFolder : data.sshFolder
    const outputDir = previewTransferOutputDir(targetFolder, outputRoot, slug, data.to)
    const name = data.outputName?.trim() || `${slug}.output`
    return `${outputDir}/${name}`
  }

  return null
}

export function computeToolPortOutputPreview(
  nodeId: string,
  portId: string,
  snapshot: PipelineSnapshot,
  pathSettings: PathSettings,
): string | null {
  const node = snapshot.nodes.find((candidate) => candidate.id === nodeId)
  if (!node || node.type !== 'tool') return null
  const data = node.data as ToolNodeData
  const tool = getTool(data.toolId)
  if (!tool) return null
  const port = tool.outputs.find((candidate) => candidate.id === portId)
  if (!port) return null

  const slug = buildNodeSlugs(snapshot).get(nodeId) ?? nodeId
  const runDir = pathSettings.runFolderTemplate || 'runs/{pipelineSlug}-{timestamp}'
  const outputRoot = pathSettings.createSubfolders
    ? joinRemotePath(trimTrailingSlash(runDir), cleanSegment(pathSettings.outputsSubfolder || 'outputs'))
    : trimTrailingSlash(runDir)
  const outputDir = previewOutputDir(data.outputDirOverride, outputRoot, slug)
  const sink = connectedOutputSink(snapshot, nodeId, port.id)
  const mergeMode = data.outputMerge?.[port.id]
  const autoMergeEnabled = mergeMode ? mergeMode.mode === 'auto-merge' : Boolean(port.autoMergeDefault)
  const mergeStrategy = resolvePreviewMergeStrategy(mergeMode?.strategy ?? port.autoMergeDefault, port.fileType)
  const hasSplitInput = toolHasSplitInput(snapshot, nodeId)
  const fallback = autoMergeEnabled && hasSplitInput && mergeStrategy
    ? joinRemotePath(outputDir, `${slug}.${port.id}.merged${mergeOutputExtPreview(mergeStrategy)}`)
    : defaultToolOutputPath(tool, data, outputDir, slug, port.id, port.fileType, connectedInputFilePath(snapshot, nodeId, 'input'))
  return sink ? sinkPath(sink, outputDir, fallback) : fallback
}

export function computeToolPortPhysicalOutputPreviews(
  nodeId: string,
  portId: string,
  snapshot: PipelineSnapshot,
  pathSettings: PathSettings,
): string[] {
  const node = snapshot.nodes.find((candidate) => candidate.id === nodeId)
  if (!node || node.type !== 'tool') return []
  const data = node.data as ToolNodeData
  const logical = computeToolPortOutputPreview(nodeId, portId, snapshot, pathSettings)
  if (!logical || !isLogicalPlotPort(data.toolId, portId)) return logical ? [logical] : []
  return physicalPlotOutputPaths(logical, data.paramValues?.outputFormats)
}

export function computeFileOutputPreview(
  nodeId: string,
  snapshot: PipelineSnapshot,
  pathSettings: PathSettings,
): string | null {
  const node = snapshot.nodes.find((candidate) => candidate.id === nodeId)
  if (!node || node.type !== 'file') return null
  const data = node.data as FileNodeData
  if (data.isInput) return null
  if (data.outputDir && data.outputFilename) return joinRemotePath(trimTrailingSlash(data.outputDir), data.outputFilename)
  if (data.path) return data.path
  const edge = snapshot.edges.find((candidate) => candidate.target === nodeId)
  if (!edge) return null
  return computeNodeOutputPreview(edge.source, snapshot, pathSettings)
}

function defaultOutputPath(outputDir: string, slug: string, portId: string, fileType: FileType): string {
  const ext = extForFileType(fileType)
  const stem = outputStem(slug, portId, fileType, ext)
  return joinRemotePath(outputDir, `${stem}${ext}`)
}

function defaultToolOutputPath(
  tool: NonNullable<ReturnType<typeof getTool>>,
  data: ToolNodeData,
  outputDir: string,
  slug: string,
  portId: string,
  fileType: FileType,
  inputPath: string,
): string {
  if (tool.id === 'fastqc' && portId === 'output') return outputDir
  if (tool.id === 'multiqc' && portId === 'output') {
    const filename = String(data.paramValues?.filename ?? '').trim() || `${slug}.multiqc_report.html`
    return joinRemotePath(outputDir, filename)
  }

  const dynamicExt = dynamicToolOutputExt(tool.id, data, portId, inputPath)
  if (!dynamicExt) return defaultOutputPath(outputDir, slug, portId, fileType)
  return joinRemotePath(outputDir, `${outputStem(slug, portId, fileType, dynamicExt)}${dynamicExt}`)
}

function isLogicalPlotPort(toolId: string, portId: string): boolean {
  return portId === 'plot' && (toolId === 'plot.manhattan' || toolId === 'plot.qq' || toolId === 'r.plot')
}

export function physicalPlotOutputPaths(plotManifestPath: string, rawFormats: unknown): string[] {
  const base = plotManifestPath.toLowerCase().endsWith('.txt')
    ? plotManifestPath.slice(0, -4)
    : plotManifestPath
  const formats = String(rawFormats ?? 'both').trim().toLowerCase()
  if (formats === 'png') return [`${base}.png`]
  if (formats === 'pdf') return [`${base}.pdf`]
  return [`${base}.png`, `${base}.pdf`]
}

function dynamicToolOutputExt(toolId: string, data: ToolNodeData, portId: string, inputPath: string): string | null {
  if ((toolId === 'bcftools.view' || toolId === 'bcftools.merge') && portId === 'output') {
    const outputType = String(data.paramValues?.['output-type'] ?? 'z')
    if (outputType === 'v') return '.vcf'
    if (outputType === 'b' || outputType === 'u') return '.bcf'
    return '.vcf.gz'
  }
  if (toolId === 'crossmap.liftover' && portId === 'output') {
    const format = normalizeCrossMapFormat(data.paramValues?.format, inputPath)
    if (format === 'vcf' || format === 'gvcf') return data.paramValues?.compress === false ? '.vcf' : '.vcf.gz'
    if (format === 'bed') return '.bed'
    if (format === 'gff') return '.gff'
    if (format === 'gtf') return '.gtf'
    if (format === 'bam') return '.bam'
    if (format === 'cram') return '.cram'
    if (format === 'sam') return '.sam'
  }
  if (toolId === 'regenie.step1' && portId === 'output') return '.pred.list'
  if (toolId === 'vep' && portId === 'output') return '.vcf.gz'
  return null
}

function normalizeCrossMapFormat(rawFormat: unknown, inputPath: string): string {
  const explicit = rawFormat === undefined || rawFormat === null ? '' : String(rawFormat).trim().toLowerCase()
  if (explicit && explicit !== 'auto') return explicit
  const lower = inputPath.toLowerCase()
  if (lower.endsWith('.vcf') || lower.endsWith('.vcf.gz')) return 'vcf'
  if (lower.endsWith('.gvcf') || lower.endsWith('.gvcf.gz')) return 'gvcf'
  if (lower.endsWith('.bed') || lower.endsWith('.bed.gz')) return 'bed'
  if (lower.endsWith('.bam')) return 'bam'
  if (lower.endsWith('.cram')) return 'cram'
  if (lower.endsWith('.sam')) return 'sam'
  if (lower.endsWith('.gff') || lower.endsWith('.gff.gz')) return 'gff'
  if (lower.endsWith('.gtf') || lower.endsWith('.gtf.gz')) return 'gtf'
  return 'bed'
}

function connectedInputFilePath(snapshot: PipelineSnapshot, nodeId: string, portId: string): string {
  const edge = snapshot.edges.find((candidate) => candidate.target === nodeId && (candidate.targetHandle ?? 'input') === portId)
  if (!edge) return ''
  const source = snapshot.nodes.find((candidate) => candidate.id === edge.source)
  if (source?.type !== 'file') return ''
  return (source.data as FileNodeData).path ?? ''
}

function outputStem(slug: string, portId: string, fileType: FileType, ext: string): string {
  const extWithoutDot = ext.replace(/^\./, '')
  const compressedBase = extWithoutDot.replace(/\.gz$/, '')
  return portId === fileType || portId === extWithoutDot || portId === compressedBase
    ? slug
    : `${slug}.${portId}`
}

function toolHasSplitInput(snapshot: PipelineSnapshot, nodeId: string): boolean {
  return snapshot.edges.some((edge) => {
    if (edge.target !== nodeId) return false
    const source = snapshot.nodes.find((candidate) => candidate.id === edge.source)
    if (!source || source.type !== 'file') return false
    const data = source.data as FileNodeData
    return (data.split?.items?.length ?? 0) > 0
  })
}

function resolvePreviewMergeStrategy(strategy: MergeStrategy | undefined, fileType: FileType): Exclude<MergeStrategy, 'auto'> | null {
  if (!strategy) return null
  if (strategy !== 'auto') return strategy
  if (fileType === 'tsv' || fileType === 'csv') return 'tsv-concat-header'
  if (fileType === 'vcf' || fileType === 'bcf') return 'bcftools-concat'
  if (fileType === 'plink' || fileType === 'pgen') return 'plink-pmerge-list'
  return 'cat'
}

function mergeOutputExtPreview(strategy: Exclude<MergeStrategy, 'auto'>): string {
  switch (strategy) {
    case 'bcftools-concat': return '.vcf.gz'
    case 'plink-pmerge-list': return ''
    case 'tsv-concat-header':
    case 'tabular-inner':
    case 'tabular-outer':
    case 'tabular-left':
      return '.tsv'
    default:
      return '.txt'
  }
}

function connectedOutputSink(snapshot: PipelineSnapshot, nodeId: string, portId: string): FileNodeData | null {
  const edge = snapshot.edges.find((candidate) => candidate.source === nodeId && (candidate.sourceHandle ?? 'output') === portId)
  if (!edge) return null
  const sink = snapshot.nodes.find((candidate) => candidate.id === edge.target)
  if (!sink || sink.type !== 'file') return null
  const data = sink.data as FileNodeData
  if (data.isInput) return null
  return fileOrigin(data) === sourceOutputOrigin(snapshot.nodes.find((candidate) => candidate.id === nodeId)) ? data : null
}

function fileOrigin(data: FileNodeData): FileOrigin {
  return data.artifactRef?.origin ?? data.origin ?? (data.source === 'local' ? 'local' : 'ssh')
}

function sourceOutputOrigin(node: PipelineSnapshot['nodes'][number] | undefined): FileOrigin {
  if (node?.type === 'tool') return (node.data as ToolNodeData).backend === 'dnx' ? 'dnx' : 'ssh'
  if (node?.type === 'transfer') return (node.data as TransferNodeData).to
  if (node?.type === 'file') return fileOrigin(node.data as FileNodeData)
  return 'ssh'
}

function sinkPath(sink: FileNodeData, fallbackDir: string, fallbackPath: string): string {
  const filename = sink.outputFilename?.trim() || pathBasename(sink.path) || pathBasename(fallbackPath)
  const folder = trimTrailingSlash(sink.outputDir?.trim() || pathDirname(sink.path) || fallbackDir)
  return joinRemotePath(folder, filename)
}

function previewOutputDir(override: string | undefined, outputRoot: string, slug: string): string {
  if (override?.trim()) return joinRemotePath(trimTrailingSlash(override.trim()), slug)
  return joinRemotePath(outputRoot, slug)
}

function previewTransferOutputDir(
  targetFolder: string | undefined,
  outputRoot: string,
  slug: string,
  targetOrigin: TransferNodeData['to'],
): string {
  const raw = targetFolder?.trim() || (targetOrigin === 'local' ? '~/BioFlow/transfers' : '')
  if (raw) return trimTrailingSlash(raw)
  return joinRemotePath(outputRoot, slug)
}

function cleanSegment(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, '') || 'outputs'
}

function extForFileType(ft: FileType): string {
  switch (ft) {
    case 'vcf': return '.vcf.gz'
    case 'bcf': return '.bcf'
    case 'bam': return '.bam'
    case 'sam': return '.sam'
    case 'cram': return '.cram'
    case 'fastq': return '.fastq.gz'
    case 'fasta': return '.fasta'
    case 'bed': return '.bed'
    case 'gff': return '.gff'
    case 'gtf': return '.gtf'
    case 'tsv': return '.tsv'
    case 'csv': return '.csv'
    case 'txt': return '.txt'
    case 'xlsx': return '.xlsx'
    case 'json': return '.json'
    case 'yaml': return '.yaml'
    case 'bgen': return '.bgen'
    default: return ''
  }
}

function buildNodeSlugs(snapshot: PipelineSnapshot): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const n of snapshot.nodes) {
    if (n.type === 'note') continue
    const data = n.data as { label?: string; toolId?: string; text?: string }
    const base = slugify(data.label || data.toolId || data.text?.slice(0, 20) || 'node')
    const tail = n.id.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toLowerCase() || 'x'
    let candidate = `${base}-${tail}`
    let i = 2
    while (used.has(candidate)) candidate = `${base}-${tail}-${i++}`
    used.add(candidate)
    out.set(n.id, candidate)
  }
  return out
}

function slugify(raw: string): string {
  const s = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s || 'node'
}
