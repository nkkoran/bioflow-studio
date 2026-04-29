import { describe, expect, it } from 'vitest'
import { parseToolCommand } from '@/lib/commandEditing'
import { getTool } from '@/lib/toolRegistry'
import type { ToolNodeData } from '@/types/pipeline'

function toolOrThrow(id: string) {
  const tool = getTool(id)
  if (!tool) throw new Error(`missing tool ${id}`)
  return tool
}

describe('commandEditing', () => {
  it('maps known PLINK flags back to structured analysis options', () => {
    const tool = toolOrThrow('plink2.assoc')
    const nodeData: ToolNodeData = {
      toolId: tool.id,
      label: 'Assoc',
      paramValues: {},
      status: 'idle',
    }

    const parsed = parseToolCommand(
      tool,
      nodeData,
      'plink2 --pfile /data/cohort --pheno /data/pheno.tsv --keep /data/keep.txt --glm firth-fallback hide-covar --maf 0.01 --out /work/assoc',
    )

    expect(parsed.analysisOptions.find((option) => option.optionId === 'keep')?.source?.value).toBe('/data/keep.txt')
    expect(parsed.analysisOptions.find((option) => option.optionId === 'glm')?.subOptions?.['hide-covar']?.enabled).toBe(true)
    expect(parsed.paramValues.maf).toBe(0.01)
  })

  it('stores unknown flags as custom options', () => {
    const tool = toolOrThrow('plink2.qc')
    const parsed = parseToolCommand(
      tool,
      { toolId: tool.id, label: 'QC', paramValues: {}, status: 'idle' },
      'plink2 --pfile /data/cohort --mystery-flag demo --out /work/qc',
    )

    expect(parsed.analysisOptions.some((option) => option.customFlag === '--mystery-flag')).toBe(true)
  })
})
