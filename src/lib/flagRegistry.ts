import type {
  ToolFlagBlock,
  ToolFlagDef,
  ToolParam,
  ValueSource,
} from '../types/pipeline'
import { getTool } from './toolRegistry'

const TOOL_DOCS: Record<string, string> = {
  'plink2.assoc': 'https://www.cog-genomics.org/plink/2.0/assoc',
  'plink2.qc': 'https://www.cog-genomics.org/plink/2.0/filter',
  'plink2.clump': 'https://www.cog-genomics.org/plink/2.0/postproc',
  'plink2.score': 'https://www.cog-genomics.org/plink/2.0/score',
  'plink2.pca': 'https://www.cog-genomics.org/plink/2.0/strat',
}

export type ToolPresetId = 'standard-assoc' | 'qc-filter-set' | 'grs-scoring' | 'pca'

export const PLINK_BLOCK_TOOL_IDS = new Set([
  'plink2.assoc',
  'plink2.qc',
  'plink2.clump',
  'plink2.score',
  'plink2.pca',
])

function flagId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function source(kind: ValueSource['kind'], value?: string, portId?: string): ValueSource {
  return { kind, value, portId }
}

const TOOL_FLAG_DEFS: Record<string, ToolFlagDef[]> = {
  'plink2.assoc': [
    { id: 'pheno', flag: '--pheno', label: 'Phenotype file', group: 'Input', kind: 'fileInput', sourcePortId: 'pheno', defaultEnabled: false, defaultValue: source('upstream-file', undefined, 'pheno') },
    { id: 'pheno-name', flag: '--pheno-name', label: 'Phenotype column', group: 'Input', kind: 'columnRef', sourcePortId: 'pheno', defaultEnabled: false, defaultValue: source('literal', '', 'pheno'), paramName: 'pheno-name', requiredValue: true },
    { id: 'covar', flag: '--covar', label: 'Covariate file', group: 'Input', kind: 'fileInput', sourcePortId: 'covar', defaultEnabled: false, defaultValue: source('upstream-file', undefined, 'covar') },
    { id: 'covar-name', flag: '--covar-name', label: 'Covariate columns', group: 'Input', kind: 'columnRef', sourcePortId: 'covar', defaultEnabled: false, defaultValue: source('literal', '', 'covar'), paramName: 'covar-name', multiValue: true },
    { id: 'glm', flag: '--glm', label: 'GLM output', group: 'Model', kind: 'enum', defaultEnabled: true, defaultValue: 'hide-covar', options: ['hide-covar', 'firth-fallback', 'allow-no-covars', 'omit-ref', 'none'], paramName: 'glm', requiredValue: true },
    { id: 'maf', flag: '--maf', label: 'Min MAF', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 0.01, paramName: 'maf' },
    { id: 'geno', flag: '--geno', label: 'Max missing genotype rate', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 0.05, paramName: 'geno' },
    { id: 'hwe', flag: '--hwe', label: 'HWE p-value', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 1e-6, paramName: 'hwe' },
    { id: 'chr', flag: '--chr', label: 'Chromosome filter', group: 'Filters', kind: 'value', placeholder: '1-22' },
    { id: 'keep', flag: '--keep', label: 'Keep samples file', group: 'Filters', kind: 'fileInput', defaultEnabled: false, defaultValue: source('path', ''), conflicts: ['remove'] },
    { id: 'remove', flag: '--remove', label: 'Remove samples file', group: 'Filters', kind: 'fileInput', defaultEnabled: false, defaultValue: source('path', ''), conflicts: ['keep'] },
  ],
  'plink2.qc': [
    { id: 'maf', flag: '--maf', label: 'Min MAF', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 0.01, paramName: 'maf' },
    { id: 'geno', flag: '--geno', label: 'Max missing genotype', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 0.02, paramName: 'geno' },
    { id: 'mind', flag: '--mind', label: 'Max missing per sample', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 0.02, paramName: 'mind' },
    { id: 'hwe', flag: '--hwe', label: 'HWE p-value', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 1e-6, paramName: 'hwe' },
    { id: 'keep', flag: '--keep', label: 'Keep samples file', group: 'Filters', kind: 'fileInput', defaultEnabled: false, defaultValue: source('path', ''), conflicts: ['remove'] },
    { id: 'remove', flag: '--remove', label: 'Remove samples file', group: 'Filters', kind: 'fileInput', defaultEnabled: false, defaultValue: source('path', ''), conflicts: ['keep'] },
    { id: 'chr', flag: '--chr', label: 'Chromosome filter', group: 'Filters', kind: 'value', placeholder: '1-22' },
    { id: 'make-bed', flag: '--make-bed', label: 'Output BED format', group: 'Output', kind: 'toggle', defaultEnabled: true, defaultValue: true, paramName: 'make-bed' },
  ],
  'plink2.clump': [
    { id: 'clump', flag: '--clump', label: 'Summary stats file', group: 'Input', kind: 'fileInput', sourcePortId: 'clump', defaultEnabled: true, defaultValue: source('upstream-file', undefined, 'clump'), requires: ['clump-p1'] },
    { id: 'clump-p1', flag: '--clump-p1', label: 'Primary p-value', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 5e-8, paramName: 'clump-p1', requiredValue: true },
    { id: 'clump-p2', flag: '--clump-p2', label: 'Secondary p-value', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 1e-4, paramName: 'clump-p2' },
    { id: 'clump-r2', flag: '--clump-r2', label: 'LD r2 threshold', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 0.1, paramName: 'clump-r2' },
    { id: 'clump-kb', flag: '--clump-kb', label: 'Window (kb)', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 250, paramName: 'clump-kb' },
    { id: 'clump-snp-field', flag: '--clump-snp-field', label: 'Variant ID column', group: 'Input', kind: 'columnRef', sourcePortId: 'clump', defaultEnabled: true, defaultValue: source('literal', 'ID', 'clump'), paramName: 'clump-snp-field', requiredValue: true },
    { id: 'clump-field', flag: '--clump-field', label: 'P-value column', group: 'Input', kind: 'columnRef', sourcePortId: 'clump', defaultEnabled: true, defaultValue: source('literal', 'P', 'clump'), paramName: 'clump-field', requiredValue: true },
  ],
  'plink2.score': [
    { id: 'score', flag: '--score', label: 'Score file', group: 'Input', kind: 'fileInput', sourcePortId: 'score', defaultEnabled: true, defaultValue: source('upstream-file', undefined, 'score'), requiredValue: true },
    { id: 'score-col-nums', flag: '--score-col-nums', label: 'Score columns', group: 'Input', kind: 'list', defaultEnabled: true, defaultValue: '3 4 5', paramName: 'score-col-nums' },
    { id: 'extract', flag: '--extract', label: 'Extract ranges', group: 'Filters', kind: 'fileInput', sourcePortId: 'extract', defaultEnabled: false, defaultValue: source('upstream-file', undefined, 'extract') },
    { id: 'header', flag: 'header', label: 'Score file has header', group: 'Advanced', kind: 'toggle', defaultEnabled: true, defaultValue: true, paramName: 'header' },
    { id: 'center', flag: 'center', label: 'Center scores', group: 'Advanced', kind: 'toggle', defaultEnabled: false, defaultValue: false, paramName: 'center' },
    { id: 'variance-standardize', flag: 'variance-standardize', label: 'Variance standardize', group: 'Advanced', kind: 'toggle', defaultEnabled: false, defaultValue: false, paramName: 'variance-standardize' },
    { id: 'no-mean-imputation', flag: 'no-mean-imputation', label: 'Disable mean imputation', group: 'Advanced', kind: 'toggle', defaultEnabled: false, defaultValue: false, paramName: 'no-mean-imputation' },
  ],
  'plink2.pca': [
    { id: 'pca', flag: '--pca', label: 'Components', group: 'Model', kind: 'value', defaultEnabled: true, defaultValue: 10, requiredValue: true },
    { id: 'maf', flag: '--maf', label: 'Min MAF', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 0.01, paramName: 'maf' },
    { id: 'mind', flag: '--mind', label: 'Max missing per sample', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 0.02, paramName: 'mind' },
    { id: 'geno', flag: '--geno', label: 'Max missing genotype', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 0.02, paramName: 'geno' },
    { id: 'hwe', flag: '--hwe', label: 'HWE p-value', group: 'Filters', kind: 'value', defaultEnabled: false, defaultValue: 1e-6, paramName: 'hwe' },
    { id: 'chr', flag: '--chr', label: 'Chromosome filter', group: 'Filters', kind: 'value', placeholder: '1-22' },
    { id: 'keep', flag: '--keep', label: 'Keep samples file', group: 'Filters', kind: 'fileInput', defaultEnabled: false, defaultValue: source('path', ''), conflicts: ['remove'] },
    { id: 'remove', flag: '--remove', label: 'Remove samples file', group: 'Filters', kind: 'fileInput', defaultEnabled: false, defaultValue: source('path', ''), conflicts: ['keep'] },
  ],
}

const FLAG_DESCRIPTIONS: Record<string, string> = {
  pheno: 'Phenotype file passed to PLINK2.',
  'pheno-name': 'Phenotype column to test.',
  covar: 'Covariates file passed to PLINK2.',
  'covar-name': 'Covariate columns PLINK should include.',
  glm: 'PLINK2 association output modifier.',
  maf: 'Exclude variants with minor allele frequency below this threshold.',
  geno: 'Exclude variants with missing genotype rate above this threshold.',
  hwe: 'Exclude variants failing Hardy-Weinberg equilibrium at this p-value.',
  mind: 'Exclude samples with missing genotype rate above this threshold.',
  chr: 'Restrict the run to a chromosome or chromosome range.',
  keep: 'Sample keep list passed to PLINK2.',
  remove: 'Sample remove list passed to PLINK2.',
  'make-bed': 'Write BED/BIM/FAM output instead of a PLINK2 fileset.',
  clump: 'Summary statistics file used by clumping.',
  'clump-p1': 'Primary p-value threshold for lead variants.',
  'clump-p2': 'Secondary p-value threshold for variants included around a lead.',
  'clump-r2': 'Maximum LD r-squared inside a clump.',
  'clump-kb': 'Physical window around each lead variant, in kilobases.',
  'clump-snp-field': 'Column containing variant IDs.',
  'clump-field': 'Column containing p-values.',
  score: 'Score file passed to PLINK2 --score.',
  'score-col-nums': 'One-based columns describing allele/weight values.',
  header: 'Tell PLINK2 the score file includes a header row.',
  center: 'Center genotype dosages before scoring.',
  'variance-standardize': 'Variance-standardize genotypes before scoring.',
  'no-mean-imputation': 'Disable PLINK2 mean imputation for missing dosages.',
  extract: 'Variant or range file used to filter prior to scoring.',
  pca: 'Number of principal components to compute.',
}

const PRESETS: Record<ToolPresetId, { label: string; toolId: string }> = {
  'standard-assoc': { label: 'Standard assoc', toolId: 'plink2.assoc' },
  'qc-filter-set': { label: 'QC filter set', toolId: 'plink2.qc' },
  'grs-scoring': { label: 'GRS scoring', toolId: 'plink2.score' },
  pca: { label: 'PCA', toolId: 'plink2.pca' },
}

function enrichDef(toolId: string, def: ToolFlagDef): ToolFlagDef {
  return {
    ...def,
    description: def.description ?? FLAG_DESCRIPTIONS[def.id],
    docUrl: def.docUrl ?? TOOL_DOCS[toolId],
  }
}

export function toolUsesFlagBuilder(toolId: string): boolean {
  return PLINK_BLOCK_TOOL_IDS.has(toolId)
}

export function getToolFlagDefs(toolId: string): ToolFlagDef[] {
  return (TOOL_FLAG_DEFS[toolId] ?? []).map((def) => enrichDef(toolId, def))
}

export function getToolPresetOptions(toolId: string): Array<{ id: ToolPresetId; label: string }> {
  return Object.entries(PRESETS)
    .filter(([, preset]) => preset.toolId === toolId)
    .map(([id, preset]) => ({ id: id as ToolPresetId, label: preset.label }))
}

function rawFlagDef(toolId: string, paramName: string): ToolFlagDef {
  const tool = getTool(toolId)
  const param = tool?.params.find((entry) => entry.name === paramName)
  return enrichDef(toolId, {
    id: `raw:${paramName}`,
    flag: param?.flag ?? `--${paramName}`,
    label: param?.label ?? paramName,
    group: 'Advanced',
    kind: 'raw',
    paramName,
  })
}

function blockValueForParam(param: ToolParam, raw: unknown): unknown {
  if (param.columnRef) {
    return source('literal', raw === undefined || raw === null ? '' : String(raw), param.columnSourcePortId)
  }
  return raw
}

function paramValueFromBlockValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'kind' in (value as Record<string, unknown>)) {
    return (value as ValueSource).value ?? ''
  }
  return value
}

export function getFlagDef(toolId: string, flagIdValue: string): ToolFlagDef | undefined {
  if (flagIdValue.startsWith('raw:')) return rawFlagDef(toolId, flagIdValue.slice(4))
  return getToolFlagDefs(toolId).find((def) => def.id === flagIdValue)
}

export function createFlagBlock(toolId: string, flagIdValue: string): ToolFlagBlock | null {
  const def = getFlagDef(toolId, flagIdValue)
  if (!def) return null
  return {
    id: flagId(def.id),
    flagId: def.id,
    enabled: def.defaultEnabled ?? true,
    value: structuredClone(def.defaultValue),
  }
}

export function buildDefaultFlagBlocks(toolId: string, paramValues: Record<string, unknown> = {}): ToolFlagBlock[] {
  const defs = getToolFlagDefs(toolId)
  const covered = new Set(defs.map((def) => def.paramName).filter(Boolean))
  const blocks = defs.map((def) => {
    const raw = def.paramName ? paramValues[def.paramName] : undefined
    const hasRaw = raw !== undefined && raw !== null && raw !== ''
    return {
      id: flagId(def.id),
      flagId: def.id,
      enabled: hasRaw || Boolean(def.defaultEnabled),
      value: hasRaw
        ? blockValueForParam({ name: def.paramName ?? def.id, type: 'string', label: def.label, columnRef: def.kind === 'columnRef', columnSourcePortId: def.sourcePortId }, raw)
        : structuredClone(def.defaultValue),
    } satisfies ToolFlagBlock
  })
  for (const [name, value] of Object.entries(paramValues)) {
    if (covered.has(name)) continue
    if (value === undefined || value === null || value === '' || value === false) continue
    blocks.push({
      id: flagId(name),
      flagId: `raw:${name}`,
      enabled: true,
      value,
    })
  }
  return blocks
}

export function ensureFlagBlocks(toolId: string, existing: ToolFlagBlock[] | undefined, paramValues: Record<string, unknown> = {}): ToolFlagBlock[] {
  if (!toolUsesFlagBuilder(toolId)) return existing ?? []
  if (existing && existing.length > 0) return existing
  return buildDefaultFlagBlocks(toolId, paramValues)
}

export function syncFlagBlocksFromParamValues(
  toolId: string,
  existing: ToolFlagBlock[] | undefined,
  paramValues: Record<string, unknown>,
): ToolFlagBlock[] {
  const blocks = ensureFlagBlocks(toolId, existing, paramValues)
  return blocks.map((block) => {
    const def = getFlagDef(toolId, block.flagId)
    if (!def?.paramName) return block
    const raw = paramValues[def.paramName]
    if (def.kind === 'toggle') {
      return { ...block, enabled: Boolean(raw), value: raw }
    }
    if (raw === undefined || raw === null || raw === '') {
      return { ...block, enabled: false }
    }
    if (def.kind === 'columnRef') {
      const current = sourceValue(block.value, 'literal')
      return { ...block, enabled: true, value: { ...current, value: String(raw) } }
    }
    return { ...block, enabled: true, value: raw }
  })
}

export function flagBlocksToParamValues(
  toolId: string,
  blocks: ToolFlagBlock[],
  previous: Record<string, unknown> = {},
): Record<string, unknown> {
  const tool = getTool(toolId)
  const next: Record<string, unknown> = {}
  for (const param of tool?.params ?? []) {
    if (param.default !== undefined) next[param.name] = param.default
  }
  for (const [key, value] of Object.entries(previous)) {
    next[key] = value
  }
  for (const block of blocks) {
    const def = getFlagDef(toolId, block.flagId)
    if (!def?.paramName) continue
    if (!block.enabled) {
      delete next[def.paramName]
      continue
    }
    const value = paramValueFromBlockValue(block.value)
    if (value === undefined || value === null || value === '') {
      if (def.kind === 'toggle') next[def.paramName] = true
      else delete next[def.paramName]
      continue
    }
    next[def.paramName] = value
  }
  return next
}

export function buildPresetFlagBlocks(toolId: string, presetId: ToolPresetId): ToolFlagBlock[] {
  const defs = getToolFlagDefs(toolId)
  if (PRESETS[presetId]?.toolId !== toolId) return buildDefaultFlagBlocks(toolId)
  const include = new Set<string>()
  if (presetId === 'standard-assoc') {
    for (const id of ['pheno', 'pheno-name', 'covar', 'covar-name', 'glm', 'maf', 'geno', 'hwe']) include.add(id)
  } else if (presetId === 'qc-filter-set') {
    for (const id of ['maf', 'geno', 'mind', 'hwe', 'make-bed']) include.add(id)
  } else if (presetId === 'grs-scoring') {
    for (const id of ['score', 'score-col-nums', 'extract', 'header']) include.add(id)
  } else if (presetId === 'pca') {
    for (const id of ['pca', 'maf', 'mind', 'geno']) include.add(id)
  }
  return defs
    .filter((def) => include.has(def.id))
    .map((def) => ({
      id: flagId(def.id),
      flagId: def.id,
      enabled: true,
      value: structuredClone(def.defaultValue),
    }))
}

export function blockLabel(toolId: string, block: ToolFlagBlock): string {
  return getFlagDef(toolId, block.flagId)?.label ?? block.flagId
}

export function activeFlagBlocks(toolId: string, blocks: ToolFlagBlock[] | undefined): ToolFlagBlock[] {
  return ensureFlagBlocks(toolId, blocks).filter((block) => block.enabled)
}

export function blockHasValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === 'object' && 'kind' in (value as Record<string, unknown>)) {
    return Boolean((value as ValueSource).value?.trim() || (value as ValueSource).kind === 'upstream-file')
  }
  return !(value === undefined || value === null || value === '')
}
