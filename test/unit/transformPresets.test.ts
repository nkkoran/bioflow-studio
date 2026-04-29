import { describe, expect, it } from 'vitest'
import { transformPresetOutputSchema } from '@/lib/transformPresets'
import type { TransformNodeData } from '@/types/pipeline'

function makeTransform(data: Partial<TransformNodeData>): TransformNodeData {
  return {
    label: 'Transform',
    fileType: 'tsv',
    preset: undefined,
    presetConfig: {},
    roleMappings: {},
    filters: [],
    renames: [],
    ...data,
  }
}

describe('transformPresets', () => {
  it('emits FID/IID schema for cohort keep-file artifacts', () => {
    const schema = transformPresetOutputSchema(
      makeTransform({
        preset: 'cohort-filter',
        presetConfig: { artifactMode: 'keep-file' },
      }),
      ['FID', 'IID', 'ethnicity'],
    )
    expect(schema?.columns).toEqual(['FID', 'IID'])
    expect(schema?.roles).toEqual([
      { roleId: 'family_id', column: 'FID' },
      { roleId: 'sample_id', column: 'IID' },
    ])
  })

  it('emits fixed score-file columns for PLINK scoring', () => {
    const schema = transformPresetOutputSchema(
      makeTransform({
        preset: 'plink-score-file',
      }),
      ['ID', 'A1', 'BETA'],
    )
    expect(schema?.columns).toEqual(['ID', 'A1', 'SCORE'])
  })
})
