import { describe, expect, it } from 'vitest'

import {
  BUILTIN_UKB_FIELD_PRESETS,
  parseImportedUkbFields,
  quickExtractDisplayName,
  sanitizeUkbFieldRows,
} from '@/lib/ukbFieldPresets'

describe('UKB field helpers', () => {
  it('parses imported csv and tsv rows into field ids and labels', () => {
    const parsed = parseImportedUkbFields('p21001_i0,BMI\np31_i0\tsex\n\n')
    expect(parsed).toEqual([
      { fieldId: 'p21001_i0', label: 'BMI' },
      { fieldId: 'p31_i0', label: 'sex' },
    ])
  })

  it('sanitizes empty rows before persistence', () => {
    expect(sanitizeUkbFieldRows([
      { fieldId: ' p21001_i0 ', label: ' BMI ' },
      { fieldId: ' ', label: 'drop me' },
    ])).toEqual([
      { fieldId: 'p21001_i0', label: 'BMI' },
    ])
  })

  it('ships the expected built-in presets and quick-run naming', () => {
    expect(BUILTIN_UKB_FIELD_PRESETS.map((preset) => preset.name)).toEqual(
      expect.arrayContaining(['MRI Cardiac Traits', 'Anthropometrics', 'Demographics + EID']),
    )
    expect(quickExtractDisplayName('Anthropometrics', Date.UTC(2026, 3, 28, 12, 34))).toBe(
      'Quick Extract — Anthropometrics (2026-04-28 12:34)',
    )
  })
})
