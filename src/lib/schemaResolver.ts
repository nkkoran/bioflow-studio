import type {
  FileNodeData,
  PipelineSnapshot,
  TransferNodeData,
  ToolNodeData,
  TransformNodeData,
} from '@/types/pipeline'
import {
  detectDelimiter,
  delimiterForPath as preferredDelimiterForPath,
  parseHeaderLine as parseDelimitedHeader,
} from '@/lib/delimitedText'
import { getTool } from '@/lib/toolRegistry'
import { transformPresetOutputSchema } from '@/lib/transformPresets'

export interface ColumnSchema {
  columns: string[]
  delimiter: string
  sourcePath?: string
  roles?: Array<{ roleId: string; column: string }>
}

export type SchemaCache = Record<string, { columns: string[]; delimiter: string; fetchedAt: number; modified?: number }>

export function delimiterForPath(path: string): string {
  return preferredDelimiterForPath(path)
}

export function parseHeaderLine(text: string, delimiter?: string): string[] {
  return parseDelimitedHeader(text, delimiter === ',' || delimiter === '\t' || delimiter === ' ' || delimiter === ';' || delimiter === '|' ? delimiter : undefined).columns
}

export function parseHeader(text: string, path: string): ColumnSchema {
  const parsed = parseDelimitedHeader(text, detectDelimiter(text, preferredDelimiterForPath(path)))
  return { columns: parsed.columns, delimiter: parsed.delimiter, sourcePath: path }
}

export function connectedInputSchema(
  snapshot: PipelineSnapshot,
  nodeId: string,
  portId: string,
  schemas: SchemaCache,
): ColumnSchema | null {
  const edge = snapshot.edges.find((e) => e.target === nodeId && (e.targetHandle ?? 'input') === portId)
  if (!edge) return null
  return outputSchema(snapshot, edge.source, edge.sourceHandle ?? 'output', schemas)
}

export function connectedInputPath(
  snapshot: PipelineSnapshot,
  nodeId: string,
  portId: string,
): string | null {
  const edge = snapshot.edges.find((e) => e.target === nodeId && (e.targetHandle ?? 'input') === portId)
  if (!edge) return null
  return outputPath(snapshot, edge.source, edge.sourceHandle ?? 'output')
}

export function outputSchema(
  snapshot: PipelineSnapshot,
  nodeId: string,
  portId: string,
  schemas: SchemaCache,
): ColumnSchema | null {
  const node = snapshot.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return null

  if (node.type === 'file') {
    const data = node.data as FileNodeData
    const schemaPath = data.path || data.split?.items?.find((item) => item.path)?.path
    const cached = schemaPath ? schemas[schemaPath] : undefined
    if (!cached) return null
    return { columns: cached.columns, delimiter: cached.delimiter, sourcePath: schemaPath }
  }

  if (node.type === 'transform') {
    const upstream = connectedInputSchema(snapshot, nodeId, 'input', schemas)
    if (!upstream) return null
    const data = node.data as TransformNodeData
    const presetSchema = transformPresetOutputSchema(data, upstream.columns)
    if (presetSchema?.columns?.length) {
      return {
        columns: presetSchema.columns,
        delimiter: presetSchema.delimiter ?? (data.fileType === 'csv' ? ',' : upstream.delimiter),
        sourcePath: upstream.sourcePath,
        roles: presetSchema.roles,
      }
    }
    const selected = data.selectedColumns?.length ? data.selectedColumns : upstream.columns
    const renameMap = new Map((data.renames ?? []).map((rule) => [rule.from, rule.to.trim() || rule.from]))
    const outputColumns = selected.map((column) => renameMap.get(column) ?? column)
    return {
      columns: outputColumns,
      delimiter: data.fileType === 'csv' ? ',' : upstream.delimiter,
      sourcePath: upstream.sourcePath,
      roles: upstream.roles
        ?.filter((role) => selected.includes(role.column))
        .map((role) => ({ ...role, column: renameMap.get(role.column) ?? role.column })),
    }
  }

  if (node.type === 'tool') {
    const data = node.data as ToolNodeData
    const tool = getTool(data.toolId)
    const port = tool?.outputs.find((candidate) => candidate.id === portId)
    if (port?.outputSchema?.columns?.length) {
      return {
        columns: port.outputSchema.columns,
        delimiter: port.outputSchema.delimiter ?? '\t',
        roles: port.outputSchema.roles,
      }
    }
  }

  if (node.type === 'merge') {
    const firstEdge = snapshot.edges.find((edge) => edge.target === nodeId && (edge.targetHandle ?? 'input') === 'input')
    if (!firstEdge) return null
    return outputSchema(snapshot, firstEdge.source, firstEdge.sourceHandle ?? 'output', schemas)
  }

  if (node.type === 'transfer') {
    const firstEdge = snapshot.edges.find((edge) => edge.target === nodeId && (edge.targetHandle ?? 'input') === 'input')
    if (!firstEdge) return null
    return outputSchema(snapshot, firstEdge.source, firstEdge.sourceHandle ?? 'output', schemas)
  }

  return null
}

function outputPath(snapshot: PipelineSnapshot, nodeId: string, _portId: string): string | null {
  const node = snapshot.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return null
  if (node.type === 'file') return (node.data as FileNodeData).path || null
  if (node.type === 'transform') {
    return connectedInputPath(snapshot, nodeId, 'input')
  }
  if (node.type === 'transfer') {
    return connectedInputPath(snapshot, nodeId, 'input')
  }
  return null
}

export function columnParamValues(raw: unknown, options?: { whitespaceSeparated?: boolean }): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((v) => v.trim()).filter(Boolean)
  const splitter = options?.whitespaceSeparated ? /[,\s]+/ : /,/
  return String(raw ?? '')
    .split(splitter)
    .map((value) => value.trim())
    .filter(Boolean)
}

export function transformInputWarnings(
  snapshot: PipelineSnapshot,
  nodeId: string,
  schemas: SchemaCache,
): string[] {
  const schema = connectedInputSchema(snapshot, nodeId, 'input', schemas)
  if (!schema) return []
  const node = snapshot.nodes.find((candidate) => candidate.id === nodeId)
  if (!node || node.type !== 'transform') return []
  const data = node.data as TransformNodeData
  const available = new Set(schema.columns)
  const missing = new Set<string>()
  for (const column of data.selectedColumns ?? []) {
    if (!available.has(column)) missing.add(column)
  }
  for (const rule of data.filters ?? []) {
    if (rule.column && !available.has(rule.column)) missing.add(rule.column)
  }
  for (const rule of data.renames ?? []) {
    if (rule.from && !available.has(rule.from)) missing.add(rule.from)
  }
  return [...missing]
}

export function toolColumnWarnings(
  snapshot: PipelineSnapshot,
  nodeId: string,
  schemas: SchemaCache,
): Array<{ paramName: string; missing: string[] }> {
  const node = snapshot.nodes.find((candidate) => candidate.id === nodeId)
  if (!node || node.type !== 'tool') return []
  const data = node.data as ToolNodeData
  const tool = getTool(data.toolId)
  if (!tool) return []
  const warnings: Array<{ paramName: string; missing: string[] }> = []
  for (const param of tool.params) {
    if (!param.columnRef) continue
    const schema = connectedInputSchema(snapshot, nodeId, param.columnSourcePortId ?? 'input', schemas)
    if (!schema) continue
    const available = new Set(schema.columns)
    const missing = columnParamValues(data.paramValues?.[param.name], { whitespaceSeparated: param.columnMulti }).filter((column) => !available.has(column))
    if (missing.length > 0) warnings.push({ paramName: param.name, missing })
  }
  return warnings
}
