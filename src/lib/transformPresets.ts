import type { TransformNodeData } from '@/types/pipeline'
import type { ArtifactRecipe, DataRoleDef, OutputSchemaDef } from '@/types/readiness'

export interface TransformPresetDef {
  id: ArtifactRecipe['preset']
  label: string
  description: string
  fileType: TransformNodeData['fileType']
  roles: DataRoleDef[]
  defaultConfig: Record<string, unknown>
}

export const TRANSFORM_PRESETS: TransformPresetDef[] = [
  {
    id: 'cohort-filter',
    label: 'Cohort Filter',
    description: 'Filter a metadata table to one cohort and optionally emit a PLINK keep file.',
    fileType: 'tsv',
    roles: [
      { id: 'sample_id', label: 'Sample ID', required: true, aliases: ['IID', 'sample_id', 'sampleid', 'participant_id', 'subject_id', 'ID'], binding: { kind: 'roleMapping', key: 'sample_id' } },
      { id: 'family_id', label: 'Family ID', required: false, aliases: ['FID', 'family_id', 'familyid'], binding: { kind: 'roleMapping', key: 'family_id' } },
      { id: 'cohort', label: 'Cohort column', required: true, aliases: ['ethnicity', 'ancestry', 'population', 'cohort', 'group', 'pop'], binding: { kind: 'roleMapping', key: 'cohort' } },
    ],
    defaultConfig: {
      matchValue: 'EUR',
      artifactMode: 'filtered-table',
    },
  },
  {
    id: 'gwas-pval-filter',
    label: 'GWAS P-value Filter',
    description: 'Keep only variants passing a configured p-value threshold.',
    fileType: 'tsv',
    roles: [
      { id: 'p_value', label: 'P-value column', required: true, aliases: ['P', 'PVAL', 'P_VALUE', 'PVALUE', 'P_LIN', 'P_LOGISTIC'], binding: { kind: 'roleMapping', key: 'p_value' } },
    ],
    defaultConfig: {
      threshold: 5e-8,
    },
  },
  {
    id: 'clump-lead-list',
    label: 'Clump Lead List',
    description: 'Extract one lead-variant ID per row from a PLINK clump report.',
    fileType: 'txt',
    roles: [
      { id: 'variant_id', label: 'Lead variant column', required: true, aliases: ['ID', 'SNP', 'RSID'], binding: { kind: 'roleMapping', key: 'variant_id' } },
    ],
    defaultConfig: {},
  },
  {
    id: 'plink-score-file',
    label: 'PLINK Score File',
    description: 'Build a three-column PLINK score file with variant ID, effect allele, and weight.',
    fileType: 'tsv',
    roles: [
      { id: 'variant_id', label: 'Variant ID', required: true, aliases: ['ID', 'SNP', 'RSID'], binding: { kind: 'roleMapping', key: 'variant_id' } },
      { id: 'effect_allele', label: 'Effect allele', required: true, aliases: ['A1', 'ALT', 'ALLELE', 'EFFECT_ALLELE'], binding: { kind: 'roleMapping', key: 'effect_allele' } },
      { id: 'weight', label: 'Weight', required: true, aliases: ['BETA', 'OR', 'LOG_OR', 'SCORE'], binding: { kind: 'roleMapping', key: 'weight' } },
    ],
    defaultConfig: {
      weightTransform: 'identity',
    },
  },
]

const TRANSFORM_PRESET_MAP = Object.fromEntries(TRANSFORM_PRESETS.map((preset) => [preset.id, preset])) as Record<ArtifactRecipe['preset'], TransformPresetDef>

export function getTransformPreset(id?: TransformNodeData['preset']): TransformPresetDef | undefined {
  if (!id) return undefined
  return TRANSFORM_PRESET_MAP[id]
}

export function defaultTransformPresetConfig(id: ArtifactRecipe['preset']): Record<string, unknown> {
  return { ...(TRANSFORM_PRESET_MAP[id]?.defaultConfig ?? {}) }
}

export function transformPresetOutputSchema(
  data: TransformNodeData,
  upstreamColumns: string[],
): OutputSchemaDef | null {
  if (!data.preset) return null
  if (data.preset === 'cohort-filter') {
    const artifactMode = String(data.presetConfig?.artifactMode ?? 'filtered-table')
    if (artifactMode === 'keep-file') {
      return {
        columns: ['FID', 'IID'],
        delimiter: '\t',
        roles: [
          { roleId: 'family_id', column: 'FID' },
          { roleId: 'sample_id', column: 'IID' },
        ],
      }
    }
    const selected = data.selectedColumns?.length ? data.selectedColumns : upstreamColumns
    return { columns: selected, delimiter: data.fileType === 'csv' ? ',' : '\t' }
  }
  if (data.preset === 'gwas-pval-filter') {
    const selected = data.selectedColumns?.length ? data.selectedColumns : upstreamColumns
    return { columns: selected, delimiter: data.fileType === 'csv' ? ',' : '\t' }
  }
  if (data.preset === 'clump-lead-list') {
    return {
      columns: ['ID'],
      delimiter: '\t',
      roles: [{ roleId: 'variant_id', column: 'ID' }],
    }
  }
  if (data.preset === 'plink-score-file') {
    return {
      columns: ['ID', 'A1', 'SCORE'],
      delimiter: '\t',
      roles: [
        { roleId: 'variant_id', column: 'ID' },
        { roleId: 'effect_allele', column: 'A1' },
        { roleId: 'weight', column: 'SCORE' },
      ],
    }
  }
  return null
}
