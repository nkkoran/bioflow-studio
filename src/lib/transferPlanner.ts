import type {
  ArtifactRef,
  FileNodeData,
  FileType,
  PipelineSnapshot,
  ToolNodeData,
  TransferNodeData,
  TransferPlan,
} from '../types/pipeline'
import type { FileOrigin } from '../constants/connections'
import { getTool } from './toolRegistry'

type SnapshotNode = PipelineSnapshot['nodes'][number]

export function artifactRefForFileNode(data: FileNodeData): ArtifactRef {
  const origin = data.artifactRef?.origin ?? data.origin ?? (data.source === 'local' ? 'local' : 'ssh')
  return {
    ...data.artifactRef,
    origin,
    path: data.artifactRef?.path || data.path,
    fileType: data.artifactRef?.fileType ?? data.fileType,
    genomeBuild: data.artifactRef?.genomeBuild ?? data.genomeBuild,
  }
}

export function nodeBackend(node: SnapshotNode, direction: 'input' | 'output'): FileOrigin | null {
  if (node.type === 'file') return artifactRefForFileNode(node.data as FileNodeData).origin
  if (node.type === 'tool') return (node.data as ToolNodeData).backend === 'dnx' ? 'dnx' : 'ssh'
  if (node.type === 'transfer') {
    const data = node.data as TransferNodeData
    return direction === 'input' ? data.from : data.to
  }
  if (node.type === 'merge' || node.type === 'transform') return 'ssh'
  return null
}

export function sourcePortFileType(node: SnapshotNode, portId: string): FileType {
  if (node.type === 'file') return (node.data as FileNodeData).fileType
  if (node.type === 'tool') {
    const tool = getTool((node.data as ToolNodeData).toolId)
    return tool?.outputs.find((port) => port.id === portId)?.fileType ?? 'any'
  }
  if (node.type === 'transform') return String(node.data.fileType || 'any') as FileType
  return 'any'
}

export function planPipelineTransfers(snapshot: PipelineSnapshot): TransferPlan[] {
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]))
  const plans: TransferPlan[] = []

  for (const node of snapshot.nodes) {
    if (node.type !== 'transfer') continue
    const data = node.data as TransferNodeData
    if (data.from === data.to) continue
    const incoming = snapshot.edges.find((edge) => edge.target === node.id)
    const source = incoming ? nodeById.get(incoming.source) : undefined
    const fileType = source ? sourcePortFileType(source, incoming?.sourceHandle ?? 'output') : 'any'
    plans.push({
      id: `transfer-node:${node.id}`,
      edgeId: incoming?.id,
      nodeId: node.id,
      source: source ? artifactForNode(source, data.from, fileType) : artifactForNode(node, data.from, fileType),
      target: transferTargetArtifact(data, fileType),
      route: `${data.from}->${data.to}`,
      mode: 'explicit',
      status: 'planned',
      warnings: transferWarnings(data.from, data.to, true, fileType),
    })
  }

  for (const edge of snapshot.edges) {
    const source = nodeById.get(edge.source)
    const target = nodeById.get(edge.target)
    if (!source || !target) continue
    const sourceOrigin = nodeBackend(source, 'output')
    const targetOrigin = nodeBackend(target, 'input')
    if (!sourceOrigin || !targetOrigin || sourceOrigin === targetOrigin) continue

    const explicit = source.type === 'transfer' || target.type === 'transfer'
    const fileType = sourcePortFileType(source, edge.sourceHandle ?? 'output')
    plans.push({
      id: explicit ? `transfer-node:${source.type === 'transfer' ? source.id : target.id}` : `implicit:${edge.id}`,
      edgeId: edge.id,
      nodeId: source.type === 'transfer' ? source.id : target.type === 'transfer' ? target.id : undefined,
      source: artifactForNode(source, sourceOrigin, fileType),
      target: artifactForNode(target, targetOrigin, fileType),
      route: `${sourceOrigin}->${targetOrigin}`,
      mode: explicit ? 'explicit' : 'implicit',
      status: 'planned',
      warnings: transferWarnings(sourceOrigin, targetOrigin, explicit, fileType),
    })
  }

  return dedupePlans(plans)
}

function artifactForNode(node: SnapshotNode, origin: FileOrigin, fileType: FileType): ArtifactRef {
  if (node.type === 'file') return artifactRefForFileNode(node.data as FileNodeData)
  const label = typeof node.data.label === 'string' ? node.data.label : node.id
  return {
    origin,
    path: label,
    fileType,
  }
}

function transferTargetArtifact(data: TransferNodeData, fileType: FileType): ArtifactRef {
  const folder = data.to === 'dnx' ? data.dnxFolder : data.to === 'ssh' ? data.sshFolder : data.localFolder
  return {
    origin: data.to,
    path: data.outputName
      ? (folder ? `${folder}/${data.outputName}`.replace(/\/+/g, '/') : data.outputName)
      : folder || data.label,
    projectId: data.dnxProjectId,
    fileType,
  }
}

function transferWarnings(source: FileOrigin, target: FileOrigin, explicit: boolean, fileType: FileType): string[] {
  const warnings: string[] = []
  if (!explicit) warnings.push('This cross-backend handoff will be staged automatically unless you insert a Transfer node.')
  if ((source === 'dnx' || target === 'dnx') && ['vcf', 'bcf', 'bam', 'cram', 'plink', 'pgen', 'bgen'].includes(fileType)) {
    warnings.push('Large genomic files may be slow or costly to stage between RAP and the cluster.')
  }
  if (source === 'local' || target === 'local') warnings.push('Local transfers depend on this desktop being online until the copy finishes.')
  return warnings
}

function dedupePlans(plans: TransferPlan[]): TransferPlan[] {
  const seen = new Set<string>()
  return plans.filter((plan) => {
    const key = `${plan.id}:${plan.route}:${plan.source.path}:${plan.target.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
