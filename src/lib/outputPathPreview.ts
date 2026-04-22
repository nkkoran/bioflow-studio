import type { FileNodeData, FileType, PipelineSnapshot, ToolNodeData, TransformNodeData } from '@/types/pipeline'
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
    const data = node.data as ToolNodeData
    const tool = getTool(data.toolId)
    const port = tool?.outputs[0]
    if (!port) return null
    const outputDir = previewOutputDir(data.outputDirOverride, outputRoot, slug)
    const sink = connectedOutputSink(snapshot, nodeId, port.id)
    return sink ? sinkPath(sink, outputDir, defaultOutputPath(outputDir, slug, port.id, port.fileType)) : defaultOutputPath(outputDir, slug, port.id, port.fileType)
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

  return null
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
  return joinRemotePath(outputDir, `${slug}.${portId}${extForFileType(fileType)}`)
}

function connectedOutputSink(snapshot: PipelineSnapshot, nodeId: string, portId: string): FileNodeData | null {
  const edge = snapshot.edges.find((candidate) => candidate.source === nodeId && (candidate.sourceHandle ?? 'output') === portId)
  if (!edge) return null
  const sink = snapshot.nodes.find((candidate) => candidate.id === edge.target)
  if (!sink || sink.type !== 'file') return null
  const data = sink.data as FileNodeData
  return data.isInput ? null : data
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
