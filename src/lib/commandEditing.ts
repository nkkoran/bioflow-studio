import { analysisOptionsToParamValues, getAnalysisOptionDefs, normalizeAnalysisOptions } from '@/lib/analysisOptions'
import type { AnalysisOptionState, ToolDef, ToolNodeData } from '@/types/pipeline'

export interface CommandParseResult {
  analysisOptions: AnalysisOptionState[]
  paramValues: Record<string, unknown>
  changes: string[]
}

export function parseToolCommand(tool: ToolDef, nodeData: ToolNodeData, command: string): CommandParseResult {
  const defs = getAnalysisOptionDefs(tool)
  const defsByFlag = new Map(defs.filter((def) => def.flag).map((def) => [def.flag!, def]))
  const base = normalizeAnalysisOptions(tool, { paramValues: {} }).map((option) => ({
    ...option,
    enabled: Boolean(defs.find((def) => def.id === option.optionId)?.required),
  }))
  const next = new Map(base.map((option) => [option.optionId, option]))
  const custom: AnalysisOptionState[] = []
  const tokens = tokenizeShell(command)
  let index = tokens.findIndex((token) => token === tool.command)
  if (index < 0) index = 0
  index += 1

  while (index < tokens.length) {
    const token = tokens[index]
    if (!token.startsWith('-')) {
      index += 1
      continue
    }
    if (token === '--out' || token === '--pfile' || token === '--bfile') {
      index += 2
      continue
    }
    const def = defsByFlag.get(token)
    if (!def) {
      const nextToken = tokens[index + 1]
      const hasValue = nextToken && !nextToken.startsWith('-')
      custom.push({
        optionId: `custom_${custom.length}_${token}`,
        enabled: true,
        customFlag: token,
        customInputKind: hasValue ? 'text' : 'text',
        value: hasValue ? nextToken : '',
      })
      index += hasValue ? 2 : 1
      continue
    }
    const current = next.get(def.id) ?? { optionId: def.id, enabled: false }
    if (tool.id === 'plink2.assoc' && def.id === 'glm') {
      const values: string[] = []
      index += 1
      while (index < tokens.length && !tokens[index].startsWith('-')) {
        values.push(tokens[index])
        index += 1
      }
      const main = values.find((value) => def.options?.includes(value)) ?? def.defaultValue ?? 'firth-fallback'
      const subOptions = Object.fromEntries((def.subOptions ?? []).map((sub) => [sub.id, { enabled: values.includes(sub.flagToken ?? sub.id), value: true }]))
      next.set(def.id, { ...current, enabled: true, value: main, subOptions })
      continue
    }
    if (tool.id === 'plink2.score' && def.id === 'score') {
      const values: string[] = []
      index += 1
      while (index < tokens.length && !tokens[index].startsWith('-')) {
        values.push(tokens[index])
        index += 1
      }
      const [path, ...rest] = values
      const scoreCols = rest.filter((value) => /^\d+$/.test(value)).slice(0, 3)
      const subOptions: Record<string, { enabled?: boolean; value?: unknown }> = {}
      if (scoreCols.length > 0) subOptions['score-col-nums'] = { enabled: true, value: scoreCols.join(' ') }
      subOptions.header = { enabled: rest.includes('header'), value: true }
      subOptions.center = { enabled: rest.includes('center'), value: true }
      subOptions['variance-standardize'] = { enabled: rest.includes('variance-standardize'), value: true }
      subOptions['no-mean-imputation'] = { enabled: rest.includes('no-mean-imputation'), value: true }
      next.set(def.id, {
        ...current,
        enabled: true,
        source: { kind: 'path', value: path },
        subOptions,
      })
      continue
    }
    if (def.kind === 'switch') {
      next.set(def.id, { ...current, enabled: true, value: true })
      index += 1
      continue
    }

    const values: string[] = []
    index += 1
    while (index < tokens.length && !tokens[index].startsWith('-')) {
      values.push(tokens[index])
      if (!(def.kind === 'list' || def.multiValue || def.kind === 'compound')) break
      index += 1
    }
    if (!(def.kind === 'list' || def.multiValue || def.kind === 'compound')) index += 1

    const joined = values.join(' ').trim()
    const param = def.paramName ? tool.params.find((candidate) => candidate.name === def.paramName) : undefined
    const value = def.kind === 'number' || param?.type === 'number' || typeof def.defaultValue === 'number'
      ? Number(joined)
      : joined
    if (def.kind === 'file' || def.filePortId) {
      next.set(def.id, { ...current, enabled: true, source: { kind: 'path', value: joined, portId: def.filePortId ?? def.sourcePortId } })
    } else {
      next.set(def.id, { ...current, enabled: true, value })
    }
  }

  const analysisOptions = [...next.values(), ...custom]
  const paramValues = analysisOptionsToParamValues(tool, analysisOptions, nodeData.paramValues)
  return {
    analysisOptions,
    paramValues,
    changes: summarizeCommandChanges(normalizeAnalysisOptions(tool, nodeData), analysisOptions, defs),
  }
}

export function tokenizeShell(command: string): string[] {
  const tokens: string[] = []
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|[^\s]+/g
  let match: RegExpExecArray | null
  while ((match = re.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[0])
  }
  return tokens
}

function summarizeCommandChanges(current: AnalysisOptionState[], next: AnalysisOptionState[], defs: ReturnType<typeof getAnalysisOptionDefs>): string[] {
  const defsById = new Map(defs.map((def) => [def.id, def]))
  const currentById = new Map(current.map((option) => [option.optionId, option]))
  const changes: string[] = []
  for (const option of next) {
    const previous = currentById.get(option.optionId)
    if (!previous || JSON.stringify(previous) !== JSON.stringify(option)) {
      changes.push(defsById.get(option.optionId)?.label ?? option.customFlag ?? option.optionId)
    }
  }
  return changes
}
