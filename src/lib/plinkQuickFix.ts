import { analysisOptionsToParamValues, getAnalysisOptionDefs, normalizeAnalysisOptions } from '@/lib/analysisOptions'
import { ensureFlagBlocks, getFlagDef } from '@/lib/flagRegistry'
import { getTool } from '@/lib/toolRegistry'
import type { AnalysisOptionState, PipelineSnapshot, ToolNodeData } from '@/types/pipeline'

export function nodeDataWithAnalysisOptionEnabled(
  data: ToolNodeData,
  optionOrPortId: string,
  value: string | number | boolean = true,
): Partial<ToolNodeData> {
  const tool = getTool(data.toolId)
  const paramValues = { ...(data.paramValues ?? {}) }
  if (!tool) return { paramValues }

  const defs = getAnalysisOptionDefs(tool)
  const topLevelDef = defs.find((def) =>
    def.id === optionOrPortId
    || def.filePortId === optionOrPortId
    || def.sourcePortId === optionOrPortId
  )
  const parentDef = topLevelDef
    ? undefined
    : defs.find((def) => def.subOptions?.some((sub) => sub.id === optionOrPortId))
  const subDef = parentDef?.subOptions?.find((sub) => sub.id === optionOrPortId)
  const flagId = topLevelDef?.id ?? subDef?.id ?? optionOrPortId
  const paramName = topLevelDef?.paramName ?? subDef?.paramName ?? getFlagDef(data.toolId, flagId)?.paramName
  if (paramName) {
    if (value === false) delete paramValues[paramName]
    else paramValues[paramName] = value
  }

  const currentOptions = normalizeAnalysisOptions(tool, data)
  const analysisOptions = currentOptions.map((option): AnalysisOptionState => {
    if (topLevelDef && option.optionId === topLevelDef.id) {
      return patchOption(option, topLevelDef, value)
    }
    if (parentDef && subDef && option.optionId === parentDef.id) {
      return {
        ...patchOption(option, parentDef, option.value ?? parentDef.defaultValue ?? value),
        subOptions: {
          ...(option.subOptions ?? {}),
          [subDef.id]: {
            ...(option.subOptions?.[subDef.id] ?? {}),
            enabled: value !== false,
            value: subDef.kind === 'switch' ? value !== false : value,
          },
        },
      }
    }
    return option
  })

  const nextParamValues = analysisOptionsToParamValues(tool, analysisOptions, paramValues)
  return {
    flagBlocks: patchFlagBlocks(data, flagId, value),
    analysisOptions,
    paramValues: nextParamValues,
  }
}

export function nodeDataWithPlinkFlagEnabled(
  data: ToolNodeData,
  flagId: string,
  value: string | number | boolean = true,
): Partial<ToolNodeData> {
  return nodeDataWithAnalysisOptionEnabled(data, flagId, value)
}

function patchOption(
  option: AnalysisOptionState,
  def: ReturnType<typeof getAnalysisOptionDefs>[number],
  value: unknown,
): AnalysisOptionState {
  if (def.kind === 'file') {
    return {
      ...option,
      enabled: true,
      source: option.source ?? { kind: 'upstream-file', portId: def.filePortId ?? def.sourcePortId },
    }
  }
  if (def.kind === 'column') {
    return {
      ...option,
      enabled: true,
      source: option.source ?? { kind: 'literal', value: typeof value === 'string' ? value : '', portId: def.sourcePortId },
    }
  }
  if (def.kind === 'switch') {
    return { ...option, enabled: value !== false, value: value !== false }
  }
  return {
    ...option,
    enabled: value !== false,
    value: value === true && def.defaultValue !== undefined ? def.defaultValue : value,
  }
}

function patchFlagBlocks(data: ToolNodeData, flagId: string, value: string | number | boolean) {
  const blocks = [...ensureFlagBlocks(data.toolId, data.flagBlocks, data.paramValues)]
  if (blocks.length === 0 || !getFlagDef(data.toolId, flagId)) return data.flagBlocks
  const existing = blocks.find((block) => block.flagId === flagId)
  if (existing) {
    existing.enabled = value !== false
    existing.value = value
  } else {
    blocks.push({
      id: `${flagId}_quick_fix`,
      flagId,
      enabled: value !== false,
      value,
    })
  }
  return blocks
}

export function snapshotWithPlinkFlagEnabled(
  snapshot: PipelineSnapshot,
  nodeId: string,
  flagId: string,
  value: string | number | boolean = true,
): PipelineSnapshot {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => (
      node.id === nodeId && node.type === 'tool'
        ? { ...node, data: { ...node.data, ...nodeDataWithPlinkFlagEnabled(node.data as ToolNodeData, flagId, value) } }
        : node
    )),
    updatedAt: Date.now(),
  }
}

export function snapshotWithAnalysisOptionEnabled(
  snapshot: PipelineSnapshot,
  nodeId: string,
  optionOrPortId: string,
  value: string | number | boolean = true,
): PipelineSnapshot {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => (
      node.id === nodeId && node.type === 'tool'
        ? { ...node, data: { ...node.data, ...nodeDataWithAnalysisOptionEnabled(node.data as ToolNodeData, optionOrPortId, value) } }
        : node
    )),
    updatedAt: Date.now(),
  }
}
