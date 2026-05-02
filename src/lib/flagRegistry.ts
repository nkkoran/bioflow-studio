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
export const CUSTOM_FLAG_ID = '__custom__'

export const PLINK_BLOCK_TOOL_IDS = new Set([
  'plink2.assoc',
  'plink2.qc',
  'plink2.clump',
  'plink2.score',
  'plink2.pca',
])

const PLINK_ASSOC_GLM_MODIFIER_IDS = ['hide-covar', 'allow-no-covars', 'omit-ref', 'skip-invalid-pheno'] as const

function flagId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function source(kind: ValueSource['kind'], value?: string, portId?: string): ValueSource {
  return { kind, value, portId }
}

function isValueSource(value: unknown): value is ValueSource {
  return Boolean(value) && typeof value === 'object' && 'kind' in (value as Record<string, unknown>)
}

function sourceValue(value: unknown, fallbackKind: ValueSource['kind']): ValueSource {
  return isValueSource(value)
    ? value
    : { kind: fallbackKind, value: value === undefined || value === null ? '' : String(value) }
}

const PLINK_TROUBLESHOOTING_DEFS: ToolFlagDef[] = [
  {
    id: 'allow-no-sex',
    flag: '--allow-no-sex',
    label: 'Allow missing sex',
    group: 'Advanced',
    kind: 'toggle',
    defaultEnabled: false,
    defaultValue: false,
    description: 'Keep phenotype values for samples with ambiguous or missing sex.',
  },
  {
    id: 'allow-extra-chr',
    flag: '--allow-extra-chr',
    label: 'Allow extra chromosomes',
    group: 'Advanced',
    kind: 'toggle',
    defaultEnabled: false,
    defaultValue: false,
    description: 'Permit nonstandard chromosome names when the dataset uses contigs outside the default set.',
  },
  {
    id: 'rm-dup',
    flag: '--rm-dup',
    label: 'Deduplicate variant IDs',
    group: 'Advanced',
    kind: 'enum',
    defaultEnabled: false,
    defaultValue: 'exclude-mismatch',
    options: ['error', 'retain-mismatch', 'exclude-mismatch', 'exclude-all', 'force-first'],
    description: 'Handle duplicate variant IDs before the main analysis step.',
  },
  {
    id: 'set-all-var-ids',
    flag: '--set-all-var-ids',
    label: 'Rewrite variant IDs',
    group: 'Advanced',
    kind: 'value',
    defaultEnabled: false,
    defaultValue: '@:#$r,$a',
    placeholder: '@:#$r,$a',
    description: 'Assign chromosome/position/allele-based IDs when the input IDs are missing or non-unique.',
  },
  {
    id: 'max-alleles',
    flag: '--max-alleles',
    label: 'Max alleles',
    group: 'Advanced',
    kind: 'value',
    defaultEnabled: false,
    defaultValue: 2,
    description: 'Exclude variants with more than this number of alleles.',
  },
  {
    id: 'snps-only',
    flag: '--snps-only',
    label: 'SNPs only',
    group: 'Advanced',
    kind: 'value',
    defaultEnabled: false,
    defaultValue: 'just-acgt',
    placeholder: 'just-acgt',
    description: 'Exclude non-SNP variants; useful when downstream steps expect biallelic SNPs.',
  },
  {
    id: 'neg9-pheno-really-missing',
    flag: '--neg9-pheno-really-missing',
    label: '-9 is missing',
    group: 'Advanced',
    kind: 'toggle',
    defaultEnabled: false,
    defaultValue: false,
    description: 'Suppress PLINK warnings when -9 is intentionally used as the missing phenotype code.',
  },
  {
    id: 'no-input-missing-phenotype',
    flag: '--no-input-missing-phenotype',
    label: 'Treat -9 as numeric',
    group: 'Advanced',
    kind: 'toggle',
    defaultEnabled: false,
    defaultValue: false,
    description: 'Use only when -9 is a real numeric phenotype value instead of a missing-value marker.',
  },
  {
    id: 'input-missing-phenotype',
    flag: '--input-missing-phenotype',
    label: 'Custom missing phenotype code',
    group: 'Advanced',
    kind: 'value',
    defaultEnabled: false,
    defaultValue: 'NA',
    placeholder: 'NA',
    description: 'Tell PLINK which phenotype value should be treated as missing on input.',
  },
]

function plinkCommonSampleFilterDefs(): ToolFlagDef[] {
  return [
    { id: 'keep', flag: '--keep', label: 'Keep samples file', group: 'Filters', kind: 'fileInput', sourcePortId: 'keep', defaultEnabled: true, defaultValue: source('upstream-file', undefined, 'keep'), conflicts: ['remove'] },
    { id: 'remove', flag: '--remove', label: 'Remove samples file', group: 'Filters', kind: 'fileInput', defaultEnabled: false, defaultValue: source('path', ''), conflicts: ['keep'] },
    { id: 'keep-fam', flag: '--keep-fam', label: 'Keep families file', group: 'Filters', kind: 'fileInput', defaultEnabled: false, defaultValue: source('path', ''), conflicts: ['remove-fam'] },
    { id: 'remove-fam', flag: '--remove-fam', label: 'Remove families file', group: 'Filters', kind: 'fileInput', defaultEnabled: false, defaultValue: source('path', ''), conflicts: ['keep-fam'] },
    { id: 'chr', flag: '--chr', label: 'Chromosome filter', group: 'Filters', kind: 'value', placeholder: '1-22' },
    { id: 'not-chr', flag: '--not-chr', label: 'Exclude chromosomes', group: 'Filters', kind: 'value', placeholder: 'X,Y,MT' },
  ]
}

function plinkCommonVariantFilterDefs(): ToolFlagDef[] {
  return [
    { id: 'extract', flag: '--extract', label: 'Extract variants file', group: 'Filters', kind: 'fileInput', defaultEnabled: false, defaultValue: source('path', ''), conflicts: ['exclude'] },
    { id: 'exclude', flag: '--exclude', label: 'Exclude variants file', group: 'Filters', kind: 'fileInput', defaultEnabled: false, defaultValue: source('path', ''), conflicts: ['extract'] },
    ...plinkCommonNumericVariantFilterDefs(),
  ]
}

function plinkCommonFrequencyInputDefs(): ToolFlagDef[] {
  return [
    {
      id: 'read-freq',
      flag: '--read-freq',
      label: 'Allele frequency file',
      group: 'Input',
      kind: 'fileInput',
      sourcePortId: 'read-freq',
      defaultEnabled: false,
      defaultValue: source('upstream-file', undefined, 'read-freq'),
      description: 'Supply precomputed allele frequencies. For split genotype runs, connect a matching split set so each task receives the frequency file with the same key.',
    },
  ]
}

function plinkCommonNumericVariantFilterDefs(): ToolFlagDef[] {
  return [
    { id: 'max-maf', flag: '--max-maf', label: 'Max MAF', group: 'Filters', kind: 'value', defaultEnabled: false, defaultValue: 0.5, paramName: 'max-maf' },
    { id: 'mac', flag: '--mac', label: 'Min MAC', group: 'Filters', kind: 'value', defaultEnabled: false, defaultValue: 20, paramName: 'mac' },
    { id: 'max-mac', flag: '--max-mac', label: 'Max MAC', group: 'Filters', kind: 'value', defaultEnabled: false, defaultValue: 400, paramName: 'max-mac' },
    { id: 'min-alleles', flag: '--min-alleles', label: 'Min alleles', group: 'Filters', kind: 'value', defaultEnabled: false, defaultValue: 2, paramName: 'min-alleles' },
    { id: 'exclude-palindromic-snps', flag: '--exclude-palindromic-snps', label: 'Exclude palindromic SNPs', group: 'Filters', kind: 'toggle', defaultEnabled: false, defaultValue: false, paramName: 'exclude-palindromic-snps' },
  ]
}

function plinkTroubleshootingDefs(): ToolFlagDef[] {
  return PLINK_TROUBLESHOOTING_DEFS.map((def) => ({ ...def }))
}

const TOOL_FLAG_DEFS: Record<string, ToolFlagDef[]> = {
  'plink2.assoc': [
    { id: 'pheno', flag: '--pheno', label: 'Phenotype file', group: 'Input', kind: 'fileInput', sourcePortId: 'pheno', defaultEnabled: true, defaultValue: source('upstream-file', undefined, 'pheno') },
    { id: 'pheno-name', flag: '--pheno-name', label: 'Phenotype column', group: 'Input', kind: 'columnRef', sourcePortId: 'pheno', defaultEnabled: true, defaultValue: source('literal', '', 'pheno'), paramName: 'pheno-name', requiredValue: true },
    { id: 'pheno-iid-only', flag: 'iid-only', label: 'Phenotype file uses IID only', group: 'Input', kind: 'toggle', defaultEnabled: false, defaultValue: false, paramName: 'pheno-iid-only', description: 'Add PLINK2\'s iid-only modifier to --pheno when the phenotype file has IID but no FID column.' },
    { id: 'one', flag: '--1', label: '0/1 case-control coding', group: 'Input', kind: 'toggle', defaultEnabled: false, defaultValue: false, paramName: 'one', description: 'Use when binary phenotypes are coded 0=control and 1=case instead of PLINK2 default 1=control and 2=case.' },
    { id: 'covar', flag: '--covar', label: 'Covariate file', group: 'Input', kind: 'fileInput', sourcePortId: 'covar', defaultEnabled: true, defaultValue: source('upstream-file', undefined, 'covar') },
    { id: 'covar-name', flag: '--covar-name', label: 'Covariate columns', group: 'Input', kind: 'columnRef', sourcePortId: 'covar', defaultEnabled: true, defaultValue: source('literal', '', 'covar'), paramName: 'covar-name', multiValue: true },
    { id: 'covar-iid-only', flag: 'iid-only', label: 'Covariate file uses IID only', group: 'Input', kind: 'toggle', defaultEnabled: false, defaultValue: false, paramName: 'covar-iid-only', description: 'Add PLINK2\'s iid-only modifier to --covar when the covariate file has IID but no FID column.' },
    { id: 'glm', flag: '--glm', label: 'Regression mode', group: 'Model', kind: 'enum', defaultEnabled: true, defaultValue: 'hide-covar', options: ['hide-covar', 'firth-fallback', 'firth', 'no-firth'], paramName: 'glm', requiredValue: true },
    { id: 'hide-covar', flag: 'hide-covar', label: 'Hide covariate rows', group: 'Model', kind: 'toggle', defaultEnabled: true, defaultValue: true, paramName: 'hide-covar' },
    { id: 'allow-no-covars', flag: 'allow-no-covars', label: 'Allow no covariates', group: 'Model', kind: 'toggle', defaultEnabled: false, defaultValue: false, paramName: 'allow-no-covars' },
    { id: 'omit-ref', flag: 'omit-ref', label: 'Omit reference allele row', group: 'Model', kind: 'toggle', defaultEnabled: false, defaultValue: false, paramName: 'omit-ref' },
    { id: 'skip-invalid-pheno', flag: 'skip-invalid-pheno', label: 'Skip invalid phenotypes', group: 'Model', kind: 'toggle', defaultEnabled: false, defaultValue: false, paramName: 'skip-invalid-pheno' },
    { id: 'ci', flag: '--ci', label: 'Confidence interval', group: 'Model', kind: 'value', defaultEnabled: false, defaultValue: 0.95, paramName: 'ci' },
    { id: 'maf', flag: '--maf', label: 'Min MAF', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 0.01, paramName: 'maf' },
    { id: 'geno', flag: '--geno', label: 'Max missing genotype rate', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 0.05, paramName: 'geno' },
    { id: 'hwe', flag: '--hwe', label: 'HWE p-value', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 1e-6, paramName: 'hwe' },
    ...plinkCommonSampleFilterDefs(),
    ...plinkCommonFrequencyInputDefs(),
    ...plinkCommonVariantFilterDefs(),
    { id: 'condition', flag: '--condition', label: 'Condition on variant ID', group: 'Advanced', kind: 'value', defaultEnabled: false, paramName: 'condition' },
    { id: 'condition-list', flag: '--condition-list', label: 'Condition list file', group: 'Advanced', kind: 'fileInput', defaultEnabled: false, defaultValue: source('path', ''), paramName: 'condition-list' },
    { id: 'parameters', flag: '--parameters', label: 'Regression parameter subset', group: 'Advanced', kind: 'value', defaultEnabled: false, paramName: 'parameters', placeholder: '1-4,7' },
    { id: 'tests', flag: '--tests', label: 'Regression tests subset', group: 'Advanced', kind: 'value', defaultEnabled: false, paramName: 'tests', placeholder: 'all or 1-3' },
    { id: 'vif', flag: '--vif', label: 'Max VIF', group: 'Advanced', kind: 'value', defaultEnabled: false, defaultValue: 50, paramName: 'vif' },
    { id: 'max-corr', flag: '--max-corr', label: 'Max covariate correlation', group: 'Advanced', kind: 'value', defaultEnabled: false, defaultValue: 0.999, paramName: 'max-corr' },
    ...plinkTroubleshootingDefs(),
  ],
  'plink2.qc': [
    { id: 'maf', flag: '--maf', label: 'Min MAF', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 0.01, paramName: 'maf' },
    { id: 'geno', flag: '--geno', label: 'Max missing genotype', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 0.02, paramName: 'geno' },
    { id: 'mind', flag: '--mind', label: 'Max missing per sample', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 0.02, paramName: 'mind' },
    { id: 'hwe', flag: '--hwe', label: 'HWE p-value', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 1e-6, paramName: 'hwe' },
    ...plinkCommonSampleFilterDefs(),
    ...plinkCommonFrequencyInputDefs(),
    ...plinkCommonVariantFilterDefs(),
    { id: 'make-bed', flag: '--make-bed', label: 'Output BED format', group: 'Output', kind: 'toggle', defaultEnabled: true, defaultValue: true, paramName: 'make-bed' },
    ...plinkTroubleshootingDefs(),
  ],
  'plink2.clump': [
    { id: 'clump', flag: '--clump', label: 'Summary stats file', group: 'Input', kind: 'fileInput', sourcePortId: 'clump', defaultEnabled: true, defaultValue: source('upstream-file', undefined, 'clump'), requires: ['clump-p1'] },
    { id: 'clump-p1', flag: '--clump-p1', label: 'Primary p-value', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 5e-8, paramName: 'clump-p1', requiredValue: true },
    { id: 'clump-p2', flag: '--clump-p2', label: 'Secondary p-value', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 1e-4, paramName: 'clump-p2' },
    { id: 'clump-r2', flag: '--clump-r2', label: 'LD r2 threshold', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 0.1, paramName: 'clump-r2' },
    { id: 'clump-kb', flag: '--clump-kb', label: 'Window (kb)', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 250, paramName: 'clump-kb' },
    { id: 'clump-snp-field', flag: '--clump-snp-field', label: 'Variant ID column', group: 'Input', kind: 'columnRef', sourcePortId: 'clump', defaultEnabled: true, defaultValue: source('literal', 'ID', 'clump'), paramName: 'clump-snp-field', requiredValue: true },
    { id: 'clump-field', flag: '--clump-field', label: 'P-value column', group: 'Input', kind: 'columnRef', sourcePortId: 'clump', defaultEnabled: true, defaultValue: source('literal', 'P', 'clump'), paramName: 'clump-field', requiredValue: true },
    ...plinkCommonSampleFilterDefs(),
    ...plinkCommonFrequencyInputDefs(),
    ...plinkCommonVariantFilterDefs(),
    { id: 'clump-a1-field', flag: '--clump-a1-field', label: 'Effect allele column', group: 'Input', kind: 'columnRef', sourcePortId: 'clump', defaultEnabled: false, defaultValue: source('literal', 'A1', 'clump'), paramName: 'clump-a1-field' },
    { id: 'clump-test-field', flag: '--clump-test-field', label: 'Test column', group: 'Input', kind: 'columnRef', sourcePortId: 'clump', defaultEnabled: false, defaultValue: source('literal', 'TEST', 'clump'), paramName: 'clump-test-field' },
    { id: 'clump-test', flag: '--clump-test', label: 'Tests to include', group: 'Advanced', kind: 'value', defaultEnabled: false, paramName: 'clump-test', placeholder: 'ADD' },
    { id: 'clump-log10', flag: '--clump-log10', label: 'Log10 p-values', group: 'Advanced', kind: 'enum', defaultEnabled: false, defaultValue: 'input-only', options: ['input-only', 'output-only'], paramName: 'clump-log10' },
    { id: 'clump-unphased', flag: '--clump-unphased', label: 'Use unphased r2', group: 'Advanced', kind: 'toggle', defaultEnabled: false, defaultValue: false, paramName: 'clump-unphased' },
    { id: 'clump-allow-overlap', flag: '--clump-allow-overlap', label: 'Allow clump overlap', group: 'Advanced', kind: 'toggle', defaultEnabled: false, defaultValue: false, paramName: 'clump-allow-overlap' },
    ...plinkTroubleshootingDefs(),
  ],
  'plink2.score': [
    { id: 'score', flag: '--score', label: 'Score file', group: 'Input', kind: 'fileInput', sourcePortId: 'score', defaultEnabled: true, defaultValue: source('upstream-file', undefined, 'score'), requiredValue: true },
    { id: 'score-col-nums', flag: '--score-col-nums', label: 'Score columns', group: 'Input', kind: 'list', defaultEnabled: true, defaultValue: '1 2 3', paramName: 'score-col-nums' },
    { id: 'extract', flag: '--extract', label: 'Extract ranges', group: 'Filters', kind: 'fileInput', sourcePortId: 'extract', defaultEnabled: true, defaultValue: source('upstream-file', undefined, 'extract') },
    ...plinkCommonSampleFilterDefs(),
    ...plinkCommonFrequencyInputDefs(),
    ...plinkCommonNumericVariantFilterDefs(),
    { id: 'header', flag: 'header', label: 'Score file has header', group: 'Advanced', kind: 'toggle', defaultEnabled: true, defaultValue: true, paramName: 'header' },
    { id: 'center', flag: 'center', label: 'Center scores', group: 'Advanced', kind: 'toggle', defaultEnabled: false, defaultValue: false, paramName: 'center' },
    { id: 'variance-standardize', flag: 'variance-standardize', label: 'Variance standardize', group: 'Advanced', kind: 'toggle', defaultEnabled: false, defaultValue: false, paramName: 'variance-standardize' },
    { id: 'no-mean-imputation', flag: 'no-mean-imputation', label: 'Disable mean imputation', group: 'Advanced', kind: 'toggle', defaultEnabled: false, defaultValue: false, paramName: 'no-mean-imputation' },
    { id: 'ignore-dup-ids', flag: 'ignore-dup-ids', label: 'Ignore duplicate score IDs', group: 'Advanced', kind: 'toggle', defaultEnabled: false, defaultValue: false, paramName: 'ignore-dup-ids' },
    ...plinkTroubleshootingDefs(),
  ],
  'plink2.pca': [
    { id: 'pca', flag: '--pca', label: 'Components', group: 'Model', kind: 'value', defaultEnabled: true, defaultValue: 10, requiredValue: true },
    { id: 'maf', flag: '--maf', label: 'Min MAF', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 0.01, paramName: 'maf' },
    { id: 'mind', flag: '--mind', label: 'Max missing per sample', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 0.02, paramName: 'mind' },
    { id: 'geno', flag: '--geno', label: 'Max missing genotype', group: 'Filters', kind: 'value', defaultEnabled: true, defaultValue: 0.02, paramName: 'geno' },
    { id: 'hwe', flag: '--hwe', label: 'HWE p-value', group: 'Filters', kind: 'value', defaultEnabled: false, defaultValue: 1e-6, paramName: 'hwe' },
    ...plinkCommonSampleFilterDefs(),
    ...plinkCommonFrequencyInputDefs(),
    ...plinkCommonVariantFilterDefs(),
    ...plinkTroubleshootingDefs(),
  ],
}

const FLAG_DESCRIPTIONS: Record<string, string> = {
  pheno: 'Phenotype file passed to PLINK2.',
  'pheno-name': 'Phenotype column to test.',
  'pheno-iid-only': 'Add iid-only to --pheno when the file has IID but not FID.',
  one: 'Interpret binary phenotypes as 0=control, 1=case for PLINK2 input.',
  covar: 'Covariates file passed to PLINK2.',
  'covar-name': 'Covariate columns PLINK should include.',
  'covar-iid-only': 'Add iid-only to --covar when the file has IID but not FID.',
  glm: 'PLINK2 logistic/Firth regression mode for --glm.',
  'hide-covar': 'Suppress covariate rows in the main association report.',
  'allow-no-covars': 'Allow --glm to run without a covariate file.',
  'omit-ref': 'Omit the reference-allele result row from the output.',
  'skip-invalid-pheno': 'Skip samples with invalid phenotypes instead of halting.',
  ci: 'Confidence interval coverage passed to PLINK2 --ci.',
  maf: 'Exclude variants with minor allele frequency below this threshold.',
  geno: 'Exclude variants with missing genotype rate above this threshold.',
  hwe: 'Exclude variants failing Hardy-Weinberg equilibrium at this p-value.',
  mind: 'Exclude samples with missing genotype rate above this threshold.',
  chr: 'Restrict the run to a chromosome or chromosome range.',
  keep: 'Sample keep list passed to PLINK2.',
  remove: 'Sample remove list passed to PLINK2.',
  'keep-fam': 'Family keep list passed to PLINK2.',
  'remove-fam': 'Family remove list passed to PLINK2.',
  'not-chr': 'Exclude one or more chromosomes from the run.',
  'max-maf': 'Exclude variants above this minor allele frequency threshold.',
  mac: 'Exclude variants below this minor allele count threshold.',
  'max-mac': 'Exclude variants above this minor allele count threshold.',
  'min-alleles': 'Exclude variants with fewer than this number of alleles.',
  'exclude-palindromic-snps': 'Exclude A/T and C/G SNPs.',
  'make-bed': 'Write BED/BIM/FAM output instead of a PLINK2 fileset.',
  condition: 'Condition the association model on one named variant.',
  'condition-list': 'Condition the association model on a list of named variants.',
  parameters: 'Subset of regression parameters to report.',
  tests: 'Subset of regression tests to report.',
  vif: 'Upper bound on variance inflation factor for covariates.',
  'max-corr': 'Upper bound on pairwise covariate correlation.',
  clump: 'Summary statistics file used by clumping.',
  'clump-p1': 'Primary p-value threshold for lead variants.',
  'clump-p2': 'Secondary p-value threshold for variants included around a lead.',
  'clump-r2': 'Maximum LD r-squared inside a clump.',
  'clump-kb': 'Physical window around each lead variant, in kilobases.',
  'clump-snp-field': 'Column containing variant IDs.',
  'clump-field': 'Column containing p-values.',
  'clump-a1-field': 'Column containing the effect allele for multiallelic clumping.',
  'clump-test-field': 'Column containing test names in the association report.',
  'clump-test': 'Association test names to keep when clumping.',
  'clump-log10': 'Interpret clump p-values as -log10 values on input or output.',
  'clump-unphased': 'Use unphased r-squared for clumping.',
  'clump-allow-overlap': 'Allow a variant to appear in more than one clump.',
  score: 'Score file passed to PLINK2 --score.',
  'score-col-nums': 'One-based columns describing allele/weight values.',
  header: 'Tell PLINK2 the score file includes a header row.',
  center: 'Center genotype dosages before scoring.',
  'variance-standardize': 'Variance-standardize genotypes before scoring.',
  'no-mean-imputation': 'Disable PLINK2 mean imputation for missing dosages.',
  'ignore-dup-ids': 'Allow duplicate variant IDs in PLINK2 score files when intentional.',
  'neg9-pheno-really-missing': 'Confirm that -9 should be treated as missing phenotype data.',
  'no-input-missing-phenotype': 'Treat -9 as a real numeric phenotype value.',
  'input-missing-phenotype': 'Custom phenotype missing-value token for PLINK input.',
  'read-freq': 'Allele frequency file passed to PLINK2 --read-freq.',
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

function customFlagDef(toolId: string): ToolFlagDef {
  return enrichDef(toolId, {
    id: CUSTOM_FLAG_ID,
    flag: '--custom',
    label: 'Custom flag',
    group: 'Advanced',
    kind: 'raw',
    description: 'Use this when BioFlow does not yet expose the PLINK flag you need. Enter the flag name exactly as PLINK expects it, with an optional value.',
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
  if (flagIdValue === CUSTOM_FLAG_ID) return customFlagDef(toolId)
  if (flagIdValue.startsWith('raw:')) return rawFlagDef(toolId, flagIdValue.slice(4))
  return getToolFlagDefs(toolId).find((def) => def.id === flagIdValue)
}

export function createFlagBlock(toolId: string, flagIdValue: string): ToolFlagBlock | null {
  if (flagIdValue === CUSTOM_FLAG_ID) {
    return {
      id: flagId(CUSTOM_FLAG_ID),
      flagId: CUSTOM_FLAG_ID,
      enabled: true,
      customFlag: '',
      customLabel: '',
      customInputKind: 'text',
      value: '',
    }
  }
  const def = getFlagDef(toolId, flagIdValue)
  if (!def) return null
  return {
    id: flagId(def.id),
    flagId: def.id,
    enabled: def.defaultEnabled ?? true,
    value: structuredClone(def.defaultValue),
  }
}

export function createCustomFlagBlock(toolId: string): ToolFlagBlock {
  return createFlagBlock(toolId, CUSTOM_FLAG_ID) ?? {
    id: flagId(CUSTOM_FLAG_ID),
    flagId: CUSTOM_FLAG_ID,
    enabled: true,
    customFlag: '',
    customLabel: '',
    customInputKind: 'text',
    value: '',
  }
}

export function buildDefaultFlagBlocks(toolId: string, paramValues: Record<string, unknown> = {}): ToolFlagBlock[] {
  const defs = getToolFlagDefs(toolId)
  const covered = new Set(defs.map((def) => def.paramName).filter(Boolean))
  const blocks = defs.map((def) => {
    const raw = def.paramName ? paramValues[def.paramName] : undefined
    const hasRaw = raw !== undefined && raw !== null && raw !== '' && (def.kind !== 'toggle' || raw !== false)
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
  if (existing && existing.length > 0) return migrateFlagBlocks(toolId, existing, paramValues)
  return migrateFlagBlocks(toolId, buildDefaultFlagBlocks(toolId, paramValues), paramValues)
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

function migrateFlagBlocks(toolId: string, blocks: ToolFlagBlock[], paramValues: Record<string, unknown>): ToolFlagBlock[] {
  if (toolId !== 'plink2.assoc') return blocks
  const next = [...blocks]
  const glm = next.find((block) => block.flagId === 'glm')
  const legacyGlmValue = glm?.value ?? paramValues.glm
  if (legacyGlmValue === 'hide-covar' || legacyGlmValue === 'firth-fallback' || legacyGlmValue === 'firth' || legacyGlmValue === 'no-firth') {
    return next
  }
  if (glm) glm.value = 'hide-covar'
  if (legacyGlmValue && typeof legacyGlmValue === 'string') {
    const modifierId = PLINK_ASSOC_GLM_MODIFIER_IDS.find((id) => id === legacyGlmValue)
    if (modifierId) {
      const existingModifier = next.find((block) => block.flagId === modifierId)
      if (existingModifier) existingModifier.enabled = true
      else {
        const block = createFlagBlock(toolId, modifierId)
        if (block) next.push({ ...block, enabled: true, value: true })
      }
    }
  }
  return next
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
    if (def.kind === 'toggle') {
      next[def.paramName] = true
      continue
    }
    const value = paramValueFromBlockValue(block.value)
    if (value === undefined || value === null || value === '') {
      delete next[def.paramName]
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
  if (block.flagId === CUSTOM_FLAG_ID) return block.customLabel?.trim() || block.customFlag?.trim() || 'Custom flag'
  return getFlagDef(toolId, block.flagId)?.label ?? block.flagId
}

export function blockFlag(toolId: string, block: ToolFlagBlock): string {
  if (block.flagId === CUSTOM_FLAG_ID) return block.customFlag?.trim() || ''
  return getFlagDef(toolId, block.flagId)?.flag ?? ''
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
