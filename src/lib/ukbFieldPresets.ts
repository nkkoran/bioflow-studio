import type { DnxFieldPreset, DnxFieldPresetItem } from '@/types/dnx'

export const BUILTIN_UKB_FIELD_PRESETS: DnxFieldPreset[] = [
  {
    id: 'builtin:cardiac-mri',
    name: 'MRI Cardiac Traits',
    fields: [
      { fieldId: 'eid', label: 'eid' },
      { fieldId: 'p22420_i0', label: 'lv_end_diastolic_volume' },
      { fieldId: 'p22421_i0', label: 'lv_end_systolic_volume' },
      { fieldId: 'p22422_i0', label: 'lv_stroke_volume' },
      { fieldId: 'p22423_i0', label: 'lv_ejection_fraction' },
      { fieldId: 'p22424_i0', label: 'lv_cardiac_output' },
      { fieldId: 'p22425_i0', label: 'lv_mass' },
      { fieldId: 'p22426_i0', label: 'rv_end_diastolic_volume' },
      { fieldId: 'p22427_i0', label: 'rv_end_systolic_volume' },
      { fieldId: 'p22428_i0', label: 'rv_stroke_volume' },
      { fieldId: 'p22429_i0', label: 'rv_ejection_fraction' },
    ],
  },
  {
    id: 'builtin:anthropometrics',
    name: 'Anthropometrics',
    fields: [
      { fieldId: 'eid', label: 'eid' },
      { fieldId: 'p31_i0', label: 'sex' },
      { fieldId: 'p50_i0', label: 'height_cm' },
      { fieldId: 'p21001_i0', label: 'bmi' },
      { fieldId: 'p21002_i0', label: 'weight_kg' },
      { fieldId: 'p48_i0', label: 'waist_circumference_cm' },
      { fieldId: 'p49_i0', label: 'hip_circumference_cm' },
    ],
  },
  {
    id: 'builtin:demographics-eid',
    name: 'Demographics + EID',
    fields: [
      { fieldId: 'eid', label: 'eid' },
      { fieldId: 'p31_i0', label: 'sex' },
      { fieldId: 'p34_i0', label: 'birth_year' },
      { fieldId: 'p52_i0', label: 'birth_month' },
      { fieldId: 'p21022_i0', label: 'age_at_recruitment' },
      { fieldId: 'p54_i0', label: 'assessment_center' },
      { fieldId: 'p22001_i0', label: 'genetic_sex' },
      { fieldId: 'p22006_i0', label: 'genetic_ethnicity' },
    ],
  },
]

export interface UkbFieldRow {
  fieldId: string
  label?: string
}

export function normalizeUkbFieldRows(value: unknown): UkbFieldRow[] {
  if (!Array.isArray(value)) return []
  return value.map((row) => {
    const item = row as { fieldId?: unknown; label?: unknown }
    return {
      fieldId: typeof item.fieldId === 'string' ? item.fieldId : '',
      label: typeof item.label === 'string' ? item.label : '',
    }
  })
}

export function sanitizeUkbFieldRows(rows: UkbFieldRow[]): DnxFieldPresetItem[] {
  return rows
    .map((row) => ({
      fieldId: row.fieldId.trim(),
      label: row.label?.trim() || undefined,
    }))
    .filter((row) => row.fieldId)
}

export function parseImportedUkbFields(text: string): UkbFieldRow[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [fieldId, ...labelParts] = line.split(/\t|,/)
      return {
        fieldId: fieldId?.trim() ?? '',
        label: labelParts.join(' ').trim() || '',
      }
    })
    .filter((row) => row.fieldId)
}

export function mergeUkbPresets(saved: DnxFieldPreset[]): DnxFieldPreset[] {
  return [...BUILTIN_UKB_FIELD_PRESETS, ...saved]
}

export function quickExtractDisplayName(presetName: string | null, timestamp: number): string {
  const formatted = new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')
  return `Quick Extract — ${presetName || 'Custom fields'} (${formatted})`
}
