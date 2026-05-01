import { describe, expect, it } from 'vitest'
import { ensureFlagBlocks } from '@/lib/flagRegistry'
import { getActiveToolInputs, normalizeAnalysisOptions } from '@/lib/analysisOptions'
import { nodeDataWithAnalysisOptionEnabled, nodeDataWithPlinkFlagEnabled } from '@/lib/plinkQuickFix'
import { getTool } from '@/lib/toolRegistry'
import type { ToolNodeData } from '@/types/pipeline'
import type { AxisPlan } from '../../electron/pipeline/axisPlanner'
import { generateToolScript } from '../../electron/pipeline/ScriptGenerator'

function singleAxisPlan(inputs: AxisPlan['inputs'], outputs: AxisPlan['outputs']): AxisPlan {
  return {
    nodeId: 'assoc',
    nodeType: 'tool',
    mode: 'single',
    dependsOnArrayNodeIds: [],
    inputs,
    outputs,
  }
}

describe('plinkQuickFix', () => {
  it('adds --1 without resetting existing GWAS phenotype, covariate, and keep options', () => {
    const tool = getTool('plink2.assoc')
    if (!tool) throw new Error('missing plink2.assoc tool')
    const paramValues = {
      glm: 'hide-covar',
      maf: 0.01,
      'pheno-name': 'cad_mi',
      'covar-name': 'age sexM PC1 PC2',
    }
    const flagBlocks = ensureFlagBlocks('plink2.assoc', undefined, { glm: 'hide-covar' })
    const nodeData: ToolNodeData = {
      toolId: 'plink2.assoc',
      label: 'Assoc',
      paramValues,
      flagBlocks,
      analysisOptions: normalizeAnalysisOptions(tool, { paramValues }, { connectedPortIds: ['input', 'pheno', 'covar', 'keep'] }),
      status: 'idle',
    }

    const patch = nodeDataWithPlinkFlagEnabled(nodeData, 'one', true)
    const patchedData: ToolNodeData = { ...nodeData, ...patch }

    expect(patchedData.paramValues?.one).toBe(true)
    expect(patchedData.paramValues?.['pheno-name']).toBe('cad_mi')
    expect(patchedData.paramValues?.['covar-name']).toBe('age sexM PC1 PC2')
    expect(patchedData.flagBlocks?.find((block) => block.flagId === 'one')?.enabled).toBe(true)
    expect(patchedData.analysisOptions?.find((option) => option.optionId === 'one')?.enabled).toBe(true)
    expect(patchedData.analysisOptions?.find((option) => option.optionId === 'pheno-name')?.source?.value).toBe('cad_mi')
    expect(patchedData.analysisOptions?.find((option) => option.optionId === 'covar-name')?.source?.value).toBe('age sexM PC1 PC2')
    expect(getActiveToolInputs(tool, patchedData, { connectedPortIds: ['input', 'pheno', 'covar', 'keep'] }).map((port) => port.id)).toContain('keep')

    const generated = generateToolScript({
      nodeId: 'assoc',
      tool,
      nodeData: patchedData,
      axisPlan: singleAxisPlan(
        {
          input: { kind: 'single', path: '/data/cohort.pgen' },
          pheno: { kind: 'single', path: '/data/pheno.tsv' },
          covar: { kind: 'single', path: '/data/covar.tsv' },
          keep: { kind: 'single', path: '/data/keep.txt' },
        },
        { output: { kind: 'single', path: '/work/assoc.tsv' } },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('--1')
    expect(generated.script).toContain('--pheno-name cad_mi')
    expect(generated.script).toContain('--covar-name age sexM PC1 PC2')
    expect(generated.script).toContain('--keep /data/keep.txt')
  })

  it('enables a connected optional input without closing over stale flag blocks', () => {
    const tool = getTool('plink2.assoc')
    if (!tool) throw new Error('missing plink2.assoc tool')
    const nodeData: ToolNodeData = {
      toolId: 'plink2.assoc',
      label: 'Assoc',
      paramValues: {
        glm: 'hide-covar',
        'pheno-name': 'cad_mi',
      },
      flagBlocks: ensureFlagBlocks('plink2.assoc', undefined, { glm: 'hide-covar' }),
      analysisOptions: normalizeAnalysisOptions(tool, {
        paramValues: {
          glm: 'hide-covar',
          'pheno-name': 'cad_mi',
        },
      }).map((option) => option.optionId === 'keep' ? { ...option, enabled: false } : option),
      status: 'idle',
    }

    const patch = nodeDataWithAnalysisOptionEnabled(nodeData, 'keep', true)
    const patchedData: ToolNodeData = { ...nodeData, ...patch }

    expect(patchedData.analysisOptions?.find((option) => option.optionId === 'keep')?.enabled).toBe(true)
    expect(getActiveToolInputs(tool, patchedData, { connectedPortIds: ['input', 'pheno', 'keep'] }).map((port) => port.id)).toContain('keep')
  })
})
