import { describe, expect, it } from 'vitest'
import { getTool } from '@/lib/toolRegistry'
import { ensureFlagBlocks } from '@/lib/flagRegistry'
import {
  analysisOptionsToParamValues,
  getAnalysisOptionDefs,
  getActiveToolInputs,
  normalizeAnalysisOptions,
  previewAnalysisCommand,
  validateAnalysisOptions,
} from '@/lib/analysisOptions'
import type { ToolNodeData } from '@/types/pipeline'

function toolOrThrow(id: string) {
  const tool = getTool(id)
  if (!tool) throw new Error(`missing tool ${id}`)
  return tool
}

describe('analysisOptions', () => {
  it('keeps optional PLINK file ports hidden until their option is enabled', () => {
    const tool = toolOrThrow('plink2.assoc')
    const nodeData: ToolNodeData = {
      toolId: tool.id,
      label: 'Assoc',
      paramValues: {},
      status: 'idle',
    }

    const defaultPorts = getActiveToolInputs(tool, {
      ...nodeData,
      analysisOptions: normalizeAnalysisOptions(tool, nodeData),
    }).map((port) => port.id)
    expect(defaultPorts).toContain('input')
    expect(defaultPorts).not.toContain('keep')

    const options = normalizeAnalysisOptions(tool, nodeData).map((option) =>
      option.optionId === 'keep'
        ? { ...option, enabled: true, source: { kind: 'upstream-file' as const, portId: 'keep' } }
        : option,
    )
    const enabledPorts = getActiveToolInputs(tool, { ...nodeData, analysisOptions: options }).map((port) => port.id)
    expect(enabledPorts).toContain('keep')
  })

  it('migrates legacy connected PLINK flag blocks into analysis options', () => {
    const tool = toolOrThrow('plink2.assoc')
    const legacy: ToolNodeData = {
      toolId: tool.id,
      label: 'Assoc',
      paramValues: { 'pheno-name': 'trait' },
      flagBlocks: ensureFlagBlocks(tool.id, undefined, { 'pheno-name': 'trait' }),
      status: 'idle',
    }
    const options = normalizeAnalysisOptions(tool, legacy, { connectedPortIds: ['input', 'pheno', 'keep'] })
    const keep = options.find((option) => option.optionId === 'keep')
    const phenoName = options.find((option) => option.optionId === 'pheno-name')

    expect(keep?.enabled).toBe(true)
    expect(keep?.source?.kind).toBe('upstream-file')
    expect(phenoName?.source?.value).toBe('trait')
  })

  it('does not re-enable an explicitly disabled optional file option from a stale edge', () => {
    const tool = toolOrThrow('plink2.assoc')
    const analysisOptions = normalizeAnalysisOptions(tool, { paramValues: {} }).map((option) =>
      option.optionId === 'keep'
        ? { ...option, enabled: false, source: { kind: 'upstream-file' as const, portId: 'keep' } }
        : option,
    )
    const normalized = normalizeAnalysisOptions(tool, { paramValues: {}, analysisOptions }, { connectedPortIds: ['input', 'keep'] })
    const ports = getActiveToolInputs(tool, { toolId: tool.id, label: 'Assoc', paramValues: {}, status: 'idle', analysisOptions: normalized }).map((port) => port.id)

    expect(normalized.find((option) => option.optionId === 'keep')?.enabled).toBe(false)
    expect(ports).not.toContain('keep')
  })

  it('does enable connected optional file options when migrating legacy nodes', () => {
    const tool = toolOrThrow('plink2.assoc')
    const normalized = normalizeAnalysisOptions(tool, { paramValues: {} }, { connectedPortIds: ['input', 'keep'] })

    expect(normalized.find((option) => option.optionId === 'keep')?.enabled).toBe(true)
  })

  it('folds compound PLINK options back into param values', () => {
    const tool = toolOrThrow('plink2.assoc')
    const options = normalizeAnalysisOptions(tool, { paramValues: {} }).map((option) =>
      option.optionId === 'glm'
        ? {
            ...option,
            enabled: true,
            value: 'firth-fallback',
            subOptions: {
              ...(option.subOptions ?? {}),
              'hide-covar': { enabled: true, value: true },
              'omit-ref': { enabled: true, value: true },
            },
          }
        : option,
    )

    const params = analysisOptionsToParamValues(tool, options, {})
    expect(params.glm).toBe('firth-fallback')
    expect(params['hide-covar']).toBe(true)
    expect(params['omit-ref']).toBe(true)
  })

  it('validates enabled canvas-file options without connected files', () => {
    const tool = toolOrThrow('plink2.score')
    const nodeData: ToolNodeData = {
      toolId: tool.id,
      label: 'Score',
      paramValues: {},
      analysisOptions: normalizeAnalysisOptions(tool, { paramValues: {} }).map((option) =>
        option.optionId === 'score'
          ? { ...option, enabled: true, source: { kind: 'upstream-file' as const, portId: 'score' } }
          : option,
      ),
      status: 'idle',
    }
    expect(validateAnalysisOptions(tool, nodeData, ['input']).some((issue) => issue.code === 'OPTION_FILE_MISSING')).toBe(true)
  })

  it('validates enabled file options with empty typed paths', () => {
    const tool = toolOrThrow('plink2.assoc')
    const nodeData: ToolNodeData = {
      toolId: tool.id,
      label: 'Assoc',
      paramValues: {},
      analysisOptions: normalizeAnalysisOptions(tool, { paramValues: {} }).map((option) =>
        option.optionId === 'keep'
          ? { ...option, enabled: true, source: { kind: 'path' as const, value: '' } }
          : option,
      ),
      status: 'idle',
    }

    expect(validateAnalysisOptions(tool, nodeData, ['input', 'pheno']).some((issue) => issue.optionId === 'keep' && issue.code === 'OPTION_FILE_MISSING')).toBe(true)
  })

  it('validates custom file options with empty typed paths', () => {
    const tool = toolOrThrow('plink2.assoc')
    const nodeData: ToolNodeData = {
      toolId: tool.id,
      label: 'Assoc',
      paramValues: {},
      analysisOptions: [
        ...normalizeAnalysisOptions(tool, { paramValues: {} }),
        {
          optionId: 'custom_file',
          enabled: true,
          customFlag: '--custom-file',
          customInputKind: 'file',
          source: { kind: 'path', value: '' },
        },
      ],
      status: 'idle',
    }

    expect(validateAnalysisOptions(tool, nodeData, ['input', 'pheno']).some((issue) => issue.optionId === 'custom_file' && issue.code === 'OPTION_FILE_MISSING')).toBe(true)
  })

  it('does not enable false boolean defaults on generic tools', () => {
    const tool = toolOrThrow('samtools.sort')
    const options = normalizeAnalysisOptions(tool, { paramValues: {} })
    const byName = new Map(options.map((option) => [option.optionId, option]))

    expect(byName.get('threads')?.enabled).toBe(true)
    expect(byName.get('memory')?.enabled).toBe(true)
    expect(byName.get('by-name')?.enabled).toBe(false)
  })

  it('keeps column options for inactive optional PLINK inputs out of the default set', () => {
    const tool = toolOrThrow('plink2.assoc')
    const options = normalizeAnalysisOptions(tool, { paramValues: {} })
    const byName = new Map(options.map((option) => [option.optionId, option]))

    expect(byName.get('pheno-name')?.enabled).toBe(true)
    expect(byName.get('covar')?.enabled).toBe(false)
    expect(byName.get('covar-name')?.enabled).toBe(false)
  })

  it('keeps required PLINK file options enabled while optional file options stay dynamic', () => {
    const scoreTool = toolOrThrow('plink2.score')
    const assocTool = toolOrThrow('plink2.assoc')
    const scoreDefs = new Map(getAnalysisOptionDefs(scoreTool).map((def) => [def.id, def]))
    const scoreOptions = normalizeAnalysisOptions(scoreTool, { paramValues: {} })
    const scorePorts = getActiveToolInputs(scoreTool, { toolId: scoreTool.id, label: 'Score', paramValues: {}, status: 'idle', analysisOptions: scoreOptions }).map((port) => port.id)
    const assocPorts = getActiveToolInputs(assocTool, { toolId: assocTool.id, label: 'Assoc', paramValues: {}, status: 'idle', analysisOptions: normalizeAnalysisOptions(assocTool, { paramValues: {} }) }).map((port) => port.id)

    expect(scoreDefs.get('score')?.required).toBe(true)
    expect(scorePorts).toContain('score')
    expect(scorePorts).not.toContain('extract')
    expect(assocPorts).not.toContain('covar')
    expect(assocPorts).not.toContain('keep')
  })

  it('previews non-file PLINK compound options as inline modifiers', () => {
    const tool = toolOrThrow('plink2.assoc')
    const options = normalizeAnalysisOptions(tool, { paramValues: {} })
    const preview = previewAnalysisCommand(
      tool,
      { toolId: tool.id, label: 'Assoc', paramValues: {}, status: 'idle', analysisOptions: options },
      (portId) => (portId === 'input' ? '/data/cohort.pgen' : null),
    )

    expect(preview).toContain('--glm firth-fallback hide-covar')
    expect(preview).not.toContain('--glm <')
  })
})
