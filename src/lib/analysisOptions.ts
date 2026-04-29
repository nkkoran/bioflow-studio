import type {
  AnalysisOptionGroup,
  AnalysisOptionKind,
  AnalysisOptionState,
  AnalysisSubOptionState,
  ToolDef,
  ToolFlagBlock,
  ToolFlagDef,
  ToolNodeData,
  ToolParam,
  ToolPort,
  ValueSource,
} from '../types/pipeline'
import {
  blockFlag,
  buildDefaultFlagBlocks,
  CUSTOM_FLAG_ID,
  getFlagDef,
  getToolFlagDefs,
  toolUsesFlagBuilder,
} from './flagRegistry'

export interface AnalysisSubOptionDef {
  id: string
  label: string
  kind: Exclude<AnalysisOptionKind, 'compound' | 'custom' | 'file'>
  flagToken?: string
  paramName?: string
  defaultEnabled?: boolean
  defaultValue?: unknown
  options?: string[]
  placeholder?: string
}

export interface AnalysisOptionDef {
  id: string
  label: string
  group: AnalysisOptionGroup
  kind: AnalysisOptionKind
  advanced?: boolean
  recommendedFor?: string[]
  rank?: number
  custom?: boolean
  flag?: string
  paramName?: string
  description?: string
  docUrl?: string
  defaultEnabled?: boolean
  defaultValue?: unknown
  requiredValue?: boolean
  required?: boolean
  options?: string[]
  placeholder?: string
  filePortId?: string
  sourcePortId?: string
  multiValue?: boolean
  conflicts?: string[]
  requires?: string[]
  subOptions?: AnalysisSubOptionDef[]
}

export interface AnalysisValidationIssue {
  optionId: string
  code: 'OPTION_VALUE_MISSING' | 'OPTION_FILE_MISSING' | 'OPTION_CONFLICT' | 'OPTION_REQUIRED'
  message: string
}

const PLINK_ASSOC_GLM_MODIFIERS = ['hide-covar', 'allow-no-covars', 'omit-ref', 'skip-invalid-pheno']
const PLINK_SCORE_MODIFIERS = ['score-col-nums', 'header', 'center', 'variance-standardize', 'no-mean-imputation']
const PLINK_OPTIONAL_FILE_DEFAULT_OFF = new Set(['keep', 'remove', 'keep-fam', 'remove-fam', 'extract'])

function source(kind: ValueSource['kind'], value?: string, portId?: string): ValueSource {
  return { kind, value, portId }
}

export function isValueSource(value: unknown): value is ValueSource {
  return Boolean(value) && typeof value === 'object' && 'kind' in (value as Record<string, unknown>)
}

function valueSourceFrom(value: unknown, fallbackKind: ValueSource['kind'], portId?: string): ValueSource {
  if (isValueSource(value)) return { ...value, portId: value.portId ?? portId }
  return {
    kind: fallbackKind,
    value: value === undefined || value === null ? '' : String(value),
    portId,
  }
}

function optionKindFromFlag(def: ToolFlagDef): AnalysisOptionKind {
  if (def.kind === 'toggle') return 'switch'
  if (def.kind === 'enum') return 'enum'
  if (def.kind === 'list') return 'list'
  if (def.kind === 'columnRef') return 'column'
  if (def.kind === 'fileInput') return 'file'
  return 'text'
}

function optionKindFromParam(param: ToolParam): AnalysisOptionKind {
  if (param.type === 'boolean') return 'switch'
  if (param.type === 'number') return 'number'
  if (param.type === 'select') return 'enum'
  if (param.type === 'multi-select') return 'list'
  if (param.type === 'file') return 'file'
  if (param.columnRef) return 'column'
  return 'text'
}

function optionGroupFromParam(param: ToolParam): AnalysisOptionGroup {
  if (param.section === 'Inputs') return 'Input'
  if (param.section === 'Analysis') return 'Model'
  if (param.section === 'Filters') return 'Filters'
  if (param.section === 'Output') return 'Output'
  if (param.section === 'Runtime') return 'Resources'
  if (param.advanced) return 'Advanced'
  return 'Model'
}

function plinkDefaultEnabled(def: ToolFlagDef, tool: ToolDef): boolean {
  if (def.kind === 'fileInput') {
    const portId = def.sourcePortId
    const port = portId ? tool.inputs.find((candidate) => candidate.id === portId) : undefined
    if (port?.required) return true
    if (PLINK_OPTIONAL_FILE_DEFAULT_OFF.has(def.id)) return false
    if (def.id === 'covar') return false
  }
  return Boolean(def.defaultEnabled)
}

function flagDefToOptionDef(tool: ToolDef, def: ToolFlagDef): AnalysisOptionDef {
  const boundPortId = def.kind === 'fileInput' ? def.sourcePortId : undefined
  const boundPort = boundPortId ? tool.inputs.find((port) => port.id === boundPortId) : undefined
  return {
    id: def.id,
    label: def.label,
    group: def.group,
    kind: optionKindFromFlag(def),
    flag: def.flag,
    paramName: def.paramName,
    description: def.description,
    docUrl: def.docUrl,
    defaultEnabled: plinkDefaultEnabled(def, tool),
    defaultValue: def.defaultValue,
    requiredValue: def.requiredValue,
    required: Boolean(boundPort?.required),
    options: def.options,
    placeholder: def.placeholder,
    filePortId: boundPortId,
    sourcePortId: def.sourcePortId,
    multiValue: def.multiValue,
    conflicts: def.conflicts,
    requires: def.requires,
  }
}

function paramToOptionDef(param: ToolParam): AnalysisOptionDef {
  const hasEnabledDefault = param.type === 'boolean'
    ? param.default === true
    : param.default !== undefined
  return {
    id: param.name,
    label: param.label,
    group: optionGroupFromParam(param),
    kind: optionKindFromParam(param),
    advanced: param.advanced,
    flag: param.flag,
    paramName: param.name,
    description: param.description,
    docUrl: param.docUrl,
    defaultEnabled: Boolean(param.required || hasEnabledDefault),
    defaultValue: param.default,
    requiredValue: param.required,
    required: param.required,
    options: param.options,
    placeholder: param.placeholder,
    sourcePortId: param.columnSourcePortId,
    multiValue: param.columnMulti,
  }
}

function plinkOptionDefs(tool: ToolDef): AnalysisOptionDef[] {
  const rawDefs = getToolFlagDefs(tool.id)
  const skip = new Set<string>()
  if (tool.id === 'plink2.assoc') for (const id of PLINK_ASSOC_GLM_MODIFIERS) skip.add(id)
  if (tool.id === 'plink2.score') for (const id of PLINK_SCORE_MODIFIERS) skip.add(id)

  return rawDefs.flatMap((flagDef) => {
    if (skip.has(flagDef.id)) return []
    const option = flagDefToOptionDef(tool, flagDef)
    if (flagDef.kind === 'columnRef' && flagDef.sourcePortId) {
      const fileInputDef = rawDefs.find((candidate) => candidate.kind === 'fileInput' && candidate.sourcePortId === flagDef.sourcePortId)
      if (fileInputDef) option.defaultEnabled = plinkDefaultEnabled(fileInputDef, tool)
    }
    if (tool.id === 'plink2.assoc' && flagDef.id === 'glm') {
      option.kind = 'compound'
      option.requiredValue = true
      option.defaultEnabled = true
      option.defaultValue = flagDef.defaultValue ?? 'firth-fallback'
      option.subOptions = PLINK_ASSOC_GLM_MODIFIERS.map((id) => {
        const sub = getFlagDef(tool.id, id)
        return {
          id,
          label: sub?.label ?? id,
          kind: 'switch',
          flagToken: sub?.flag ?? id,
          paramName: sub?.paramName,
          defaultEnabled: id === 'hide-covar',
          defaultValue: id === 'hide-covar',
        }
      })
    }
    if (tool.id === 'plink2.score' && flagDef.id === 'score') {
      option.kind = 'compound'
      option.requiredValue = true
      option.defaultEnabled = true
      option.subOptions = PLINK_SCORE_MODIFIERS.map((id) => {
        const sub = getFlagDef(tool.id, id)
        return {
          id,
          label: sub?.label ?? id,
          kind: id === 'score-col-nums' ? 'list' : 'switch',
          flagToken: sub?.flag ?? id,
          paramName: sub?.paramName,
          defaultEnabled: Boolean(sub?.defaultEnabled),
          defaultValue: sub?.defaultValue,
          placeholder: sub?.placeholder,
        }
      })
    }
    return [option]
  })
}

export function getAnalysisOptionDefs(tool: ToolDef): AnalysisOptionDef[] {
  const base = toolUsesFlagBuilder(tool.id) ? plinkOptionDefs(tool) : tool.params.filter((p) => !p.internal).map(paramToOptionDef)
  const boundPorts = new Set(base.map((def) => def.filePortId ?? def.sourcePortId).filter(Boolean))
  const optionalInputOptions: AnalysisOptionDef[] = tool.inputs
    .filter((port) => !port.required && !boundPorts.has(port.id))
    .map((port) => ({
      id: `input:${port.id}`,
      label: port.label,
      group: 'Input' as const,
      kind: 'file' as const,
      description: port.description,
      defaultEnabled: false,
      filePortId: port.id,
      sourcePortId: port.id,
    }))
  return [...base, ...optionalInputOptions]
}

function stateValueFromFlagBlock(block: ToolFlagBlock, def: AnalysisOptionDef): Pick<AnalysisOptionState, 'value' | 'source'> {
  if (def.kind === 'file') return { source: valueSourceFrom(block.value, 'upstream-file', def.filePortId ?? def.sourcePortId) }
  if (def.kind === 'column') return { source: valueSourceFrom(block.value, 'literal', def.sourcePortId) }
  return { value: block.value }
}

function customStateFromFlagBlock(block: ToolFlagBlock): AnalysisOptionState {
  const state: AnalysisOptionState = {
    optionId: block.id,
    enabled: block.enabled,
    customFlag: block.customFlag,
    customLabel: block.customLabel,
    customInputKind: block.customInputKind ?? 'text',
    value: block.value,
  }
  if (block.customInputKind === 'file') {
    state.source = valueSourceFrom(block.value, 'path')
    state.value = undefined
  }
  return state
}

function statesFromFlagBlocks(tool: ToolDef, flagBlocks: ToolFlagBlock[] | undefined, paramValues: Record<string, unknown>): AnalysisOptionState[] {
  if (!toolUsesFlagBuilder(tool.id)) return []
  const hasExplicitBlocks = Boolean(flagBlocks && flagBlocks.length > 0)
  const blocks = hasExplicitBlocks ? flagBlocks! : buildDefaultFlagBlocks(tool.id, paramValues)
  const byId = new Map(blocks.map((block) => [block.flagId, block]))
  const defs = getAnalysisOptionDefs(tool)
  const states: AnalysisOptionState[] = []

  for (const def of defs) {
    const block = byId.get(def.id)
    const fromBlock = block ? stateValueFromFlagBlock(block, def) : {}
    const raw = def.paramName ? paramValues[def.paramName] : undefined
    const hasParamValue = raw !== undefined && raw !== null && raw !== '' && raw !== false
    const state: AnalysisOptionState = {
      optionId: def.id,
      enabled: block && hasExplicitBlocks ? block.enabled : Boolean(def.defaultEnabled || hasParamValue),
      value: def.kind === 'file' || def.kind === 'column' ? undefined : structuredClone(def.defaultValue),
      source: def.kind === 'file' ? source('upstream-file', undefined, def.filePortId ?? def.sourcePortId) : undefined,
      ...fromBlock,
    }
    if (block && def.kind === 'file' && def.defaultEnabled === false && !isValueSource(block.value)) {
      state.enabled = false
    }
    if (block && def.kind === 'file' && def.defaultEnabled === false && isValueSource(block.value) && block.value.kind === 'upstream-file' && !block.value.value) {
      state.enabled = false
    }
    if (def.kind === 'compound') {
      state.subOptions = {}
      for (const sub of def.subOptions ?? []) {
        const subBlock = byId.get(sub.id)
        state.subOptions[sub.id] = {
          enabled: subBlock ? subBlock.enabled : Boolean(sub.defaultEnabled),
          value: subBlock?.value ?? structuredClone(sub.defaultValue),
        }
      }
    }
    states.push(state)
  }

  for (const block of blocks) {
    if (block.flagId === CUSTOM_FLAG_ID) states.push(customStateFromFlagBlock(block))
  }

  return states
}

function stateFromParam(def: AnalysisOptionDef, paramValues: Record<string, unknown>, connectedPortIds: Set<string>): AnalysisOptionState {
  const raw = def.paramName ? paramValues[def.paramName] : undefined
  const hasRaw = raw !== undefined && raw !== null && raw !== '' && raw !== false
  const connected = def.filePortId ? connectedPortIds.has(def.filePortId) : false
  const enabled = hasRaw || connected || Boolean(def.defaultEnabled || def.required)
  if (def.kind === 'file') {
    return {
      optionId: def.id,
      enabled,
      source: valueSourceFrom(raw, def.filePortId ? 'upstream-file' : 'path', def.filePortId ?? def.sourcePortId),
    }
  }
  if (def.kind === 'column') {
    return {
      optionId: def.id,
      enabled,
      source: valueSourceFrom(raw ?? def.defaultValue, 'literal', def.sourcePortId),
    }
  }
  return {
    optionId: def.id,
    enabled,
    value: raw ?? structuredClone(def.defaultValue),
  }
}

export function normalizeAnalysisOptions(
  tool: ToolDef,
  nodeData: Pick<ToolNodeData, 'analysisOptions' | 'flagBlocks' | 'paramValues'>,
  opts: { connectedPortIds?: Iterable<string> } = {},
): AnalysisOptionState[] {
  const defs = getAnalysisOptionDefs(tool)
  const connectedPortIds = new Set(opts.connectedPortIds ?? [])
  const existing = nodeData.analysisOptions ?? statesFromFlagBlocks(tool, nodeData.flagBlocks, nodeData.paramValues ?? {})
  const hasExplicitAnalysisOptions = Boolean(nodeData.analysisOptions)
  const byId = new Map(existing.map((state) => [state.optionId, state]))
  const next = defs.map((def) => {
    const current = byId.get(def.id)
    const fallback = stateFromParam(def, nodeData.paramValues ?? {}, connectedPortIds)
    const state: AnalysisOptionState = current
      ? {
          ...fallback,
          ...current,
          enabled: current.enabled || (!hasExplicitAnalysisOptions && Boolean(def.filePortId) && connectedPortIds.has(def.filePortId!)),
          source: current.source ?? fallback.source,
          subOptions: { ...(fallback.subOptions ?? {}), ...(current.subOptions ?? {}) },
        }
      : fallback
    if (def.required) state.enabled = true
    return state
  })
  for (const state of existing) {
    if (state.customFlag !== undefined || state.customInputKind !== undefined) next.push(state)
  }
  return next
}

export function getEnabledAnalysisOptions(tool: ToolDef, nodeData: ToolNodeData, opts: { connectedPortIds?: Iterable<string> } = {}): AnalysisOptionState[] {
  return normalizeAnalysisOptions(tool, nodeData, opts).filter((state) => state.enabled)
}

export function getActiveToolInputs(tool: ToolDef, nodeData: ToolNodeData, opts: { connectedPortIds?: Iterable<string> } = {}): ToolPort[] {
  const options = normalizeAnalysisOptions(tool, nodeData, opts)
  const enabledFilePorts = new Set<string>()
  const defsById = new Map(getAnalysisOptionDefs(tool).map((def) => [def.id, def]))
  for (const option of options) {
    if (!option.enabled) continue
    const def = defsById.get(option.optionId)
    const portId = def?.filePortId ?? def?.sourcePortId
    if (def?.kind === 'file' || def?.kind === 'compound') {
      if (portId) enabledFilePorts.add(portId)
    }
  }
  return tool.inputs.filter((port) => port.required || enabledFilePorts.has(port.id))
}

export function isToolInputActive(tool: ToolDef, nodeData: ToolNodeData, portId: string, opts: { connectedPortIds?: Iterable<string> } = {}): boolean {
  return getActiveToolInputs(tool, nodeData, opts).some((port) => port.id === portId)
}

export function analysisOptionsToParamValues(
  tool: ToolDef,
  options: AnalysisOptionState[],
  previous: Record<string, unknown> = {},
): Record<string, unknown> {
  const defs = getAnalysisOptionDefs(tool)
  const defsById = new Map(defs.map((def) => [def.id, def]))
  const next: Record<string, unknown> = { ...previous }
  for (const def of defs) {
    if (def.paramName) delete next[def.paramName]
    for (const sub of def.subOptions ?? []) {
      if (sub.paramName) delete next[sub.paramName]
    }
  }
  for (const option of options) {
    const def = defsById.get(option.optionId)
    if (!def || !option.enabled) continue
    const value = optionValue(option)
    if (def.paramName) {
      if (def.kind === 'switch') next[def.paramName] = true
      else if (value !== undefined && value !== null && value !== '') next[def.paramName] = value
    }
    for (const sub of def.subOptions ?? []) {
      const subState = option.subOptions?.[sub.id]
      if (!sub.paramName || !subState?.enabled) continue
      next[sub.paramName] = sub.kind === 'switch' ? true : subState.value
    }
  }
  return next
}

export function optionValue(option: AnalysisOptionState): unknown {
  return option.source ? option.source.value ?? '' : option.value
}

export function optionHasValue(option: AnalysisOptionState): boolean {
  if (option.source) {
    if (option.source.kind === 'upstream-file') return true
    return Boolean(option.source.value?.trim())
  }
  if (typeof option.value === 'boolean') return option.value
  if (Array.isArray(option.value)) return option.value.length > 0
  return !(option.value === undefined || option.value === null || option.value === '')
}

export function validateAnalysisOptions(tool: ToolDef, nodeData: ToolNodeData, connectedPortIds: Iterable<string> = []): AnalysisValidationIssue[] {
  const connected = new Set(connectedPortIds)
  const options = normalizeAnalysisOptions(tool, nodeData, { connectedPortIds: connected })
  const defs = getAnalysisOptionDefs(tool)
  const defsById = new Map(defs.map((def) => [def.id, def]))
  const enabled = new Set(options.filter((option) => option.enabled).map((option) => option.optionId))
  const issues: AnalysisValidationIssue[] = []
  for (const option of options) {
    if (!option.enabled) continue
    const def = defsById.get(option.optionId)
    if (!def) {
      if (option.customFlag !== undefined && !option.customFlag.trim()) {
        issues.push({ optionId: option.optionId, code: 'OPTION_VALUE_MISSING', message: 'Custom flag needs an exact flag name.' })
      }
      if (option.customInputKind === 'file') {
        const source = option.source ?? (isValueSource(option.value) ? option.value : undefined)
        if (source?.kind === 'upstream-file') {
          const portId = source.portId
          if (!portId || !connected.has(portId)) {
            issues.push({ optionId: option.optionId, code: 'OPTION_FILE_MISSING', message: 'Custom file flag is enabled but no upstream file is connected.' })
          }
        } else {
          const value = source?.value ?? (typeof option.value === 'string' ? option.value : '')
          if (!value.trim()) {
            issues.push({ optionId: option.optionId, code: 'OPTION_FILE_MISSING', message: 'Custom file flag is enabled but no file path is selected.' })
          }
        }
      }
      continue
    }
    if (def.requiredValue && !optionHasValue(option)) {
      issues.push({ optionId: option.optionId, code: 'OPTION_VALUE_MISSING', message: `${def.label} needs a value.` })
    }
    const isFileOption = def.kind === 'file' || def.kind === 'compound'
    if (isFileOption && def.filePortId && option.source?.kind === 'upstream-file' && !connected.has(def.filePortId)) {
      issues.push({ optionId: option.optionId, code: 'OPTION_FILE_MISSING', message: `${def.label} is enabled but no file is connected to ${def.filePortId}.` })
    }
    if (isFileOption && option.source && option.source.kind !== 'upstream-file' && !option.source.value?.trim()) {
      issues.push({ optionId: option.optionId, code: 'OPTION_FILE_MISSING', message: `${def.label} is enabled but no file path is selected.` })
    }
    for (const conflictId of def.conflicts ?? []) {
      if (enabled.has(conflictId)) issues.push({ optionId: option.optionId, code: 'OPTION_CONFLICT', message: `${def.label} conflicts with ${defsById.get(conflictId)?.label ?? conflictId}.` })
    }
    for (const requiredId of def.requires ?? []) {
      if (!enabled.has(requiredId)) issues.push({ optionId: option.optionId, code: 'OPTION_REQUIRED', message: `${def.label} requires ${defsById.get(requiredId)?.label ?? requiredId}.` })
    }
  }
  return issues
}

export function analysisStateToLegacyFlagBlock(toolId: string, option: AnalysisOptionState): ToolFlagBlock | null {
  if (option.customFlag !== undefined || option.customInputKind !== undefined) {
    return {
      id: option.optionId,
      flagId: CUSTOM_FLAG_ID,
      enabled: option.enabled,
      customFlag: option.customFlag,
      customLabel: option.customLabel,
      customInputKind: option.customInputKind,
      value: option.source ?? option.value,
    }
  }
  const def = getFlagDef(toolId, option.optionId)
  if (!def) return null
  return {
    id: `${option.optionId}_legacy`,
    flagId: option.optionId,
    enabled: option.enabled,
    value: option.source ?? option.value,
  }
}

export function previewAnalysisCommand(tool: ToolDef, nodeData: ToolNodeData, connectedPathForPort: (portId: string) => string | null): string {
  if (nodeData.commandOverride?.trim()) return nodeData.commandOverride.trim()
  const defsById = new Map(getAnalysisOptionDefs(tool).map((def) => [def.id, def]))
  const options = normalizeAnalysisOptions(tool, nodeData)
  const parts = [tool.command]
  const mainInput = tool.inputs.find((port) => port.id === 'input')
  if (mainInput) {
    const path = connectedPathForPort(mainInput.id)
    if (path) parts.push(`${tool.command.includes('plink') ? '--pfile' : ''} ${path}`.trim())
  }
  for (const option of options) {
    if (!option.enabled) continue
    const def = defsById.get(option.optionId)
    if (!def?.flag) continue
    if (def.kind === 'switch') {
      parts.push(def.flag)
    } else if (def.kind === 'file' || (def.kind === 'compound' && def.filePortId)) {
      const portPath = def.filePortId ? connectedPathForPort(def.filePortId) : null
      const value = option.source?.kind === 'upstream-file' ? portPath : option.source?.value
      const extras = def.kind === 'compound'
        ? (def.subOptions ?? []).flatMap((sub) => {
            const subState = option.subOptions?.[sub.id]
            if (!subState?.enabled) return []
            if (sub.kind === 'switch') return [sub.flagToken ?? sub.id]
            return subState.value === undefined || subState.value === null || subState.value === '' ? [] : [String(subState.value)]
          })
        : []
      parts.push(`${def.flag} ${value || `<${def.filePortId ?? 'file'}>`}${extras.length ? ` ${extras.join(' ')}` : ''}`)
    } else if (def.kind === 'compound') {
      const value = optionValue(option)
      const tokens = [
        ...(value === undefined || value === null || value === '' ? [] : [String(value)]),
        ...(def.subOptions ?? []).flatMap((sub) => {
          const subState = option.subOptions?.[sub.id]
          if (!subState?.enabled) return []
          if (sub.kind === 'switch') return [sub.flagToken ?? sub.id]
          return subState.value === undefined || subState.value === null || subState.value === '' ? [] : [String(subState.value)]
        }),
      ]
      parts.push(`${def.flag}${tokens.length ? ` ${tokens.join(' ')}` : ''}`)
    } else {
      const value = optionValue(option)
      if (value !== undefined && value !== null && value !== '') parts.push(`${def.flag} ${value}`)
    }
  }
  parts.push('--out <output-prefix>')
  return parts.filter(Boolean).join(' \\\n  ')
}

export function legacyFlagForAnalysisOption(toolId: string, option: AnalysisOptionState): string {
  if (option.customFlag?.trim()) return option.customFlag.trim()
  return blockFlag(toolId, analysisStateToLegacyFlagBlock(toolId, option) ?? { id: option.optionId, flagId: option.optionId, enabled: option.enabled })
}
