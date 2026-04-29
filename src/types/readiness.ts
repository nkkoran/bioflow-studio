export type TabularDelimiter = '\t' | ',' | ' ' | ';' | '|'

export type ContractFileFamily =
  | 'tabular'
  | 'plink-fileset'
  | 'vcf-bcf'
  | 'alignment'
  | 'fastq'
  | 'fasta'
  | 'generic'

export interface RoleBinding {
  kind: 'param' | 'roleMapping'
  key: string
  multi?: boolean
}

export interface DataRoleDef {
  id: string
  label: string
  aliases?: string[]
  required?: boolean
  description?: string
  binding?: RoleBinding
}

export interface TabularContract {
  requiresHeader?: boolean
  allowedDelimiters?: TabularDelimiter[]
  roles?: DataRoleDef[]
  sampleIdRoleIds?: string[]
  recordIdRoleIds?: string[]
}

export interface PortContract {
  family?: ContractFileFamily
  requiresSidecars?: string[]
  requiresIndexes?: string[]
  tabular?: TabularContract
}

export interface OutputSchemaRole {
  roleId: string
  column: string
}

export interface OutputSchemaDef {
  columns?: string[]
  delimiter?: TabularDelimiter
  roles?: OutputSchemaRole[]
}

export interface ArtifactRecipe {
  id: string
  label: string
  description?: string
  preset: 'cohort-filter' | 'gwas-pval-filter' | 'clump-lead-list' | 'plink-score-file'
  sourcePortId?: string
  targetFileType?: string
}

export interface ParameterRule {
  id: string
  whenParam?: string
  equals?: string | number | boolean
  requiresPortsWithIndexes?: string[]
  conflictsWithParams?: string[]
  message: string
  suggestion?: string
}

export interface FileProbeResult {
  key: string
  path: string
  exists: boolean
  modified?: number
  size?: number
  isDirectory?: boolean
  fileTypeHint?: string
  compression?: 'none' | 'gzip' | 'bgzip' | 'binary' | 'unknown'
  delimiter?: TabularDelimiter
  header?: string[]
  previewRows?: string[][]
  sampleIds?: string[]
  recordIds?: string[]
  sidecars?: Record<string, boolean>
  indexes?: Record<string, boolean>
  rowCountEstimate?: number
  errors?: string[]
  warnings?: string[]
}

export interface RoleMapping {
  roleId: string
  column?: string
  columns?: string[]
  confidence?: number
  aliasesMatched?: string[]
  confirmed?: boolean
  transform?: 'identity' | 'log'
}

export type WorkflowReadinessCategory =
  | 'Files'
  | 'Columns'
  | 'IDs'
  | 'Handoffs'
  | 'Parameters'
  | 'Outputs'
  | 'Export'

export interface WorkflowReadinessIssue {
  severity: 'error' | 'warning' | 'info'
  blocking: boolean
  category: WorkflowReadinessCategory
  code: string
  message: string
  suggestion?: string
  nodeId?: string
  portId?: string
  path?: string
}

export interface WorkflowReadinessReport {
  ok: boolean
  blockingCount: number
  issueCount: number
  issues: WorkflowReadinessIssue[]
  probes: Record<string, FileProbeResult>
  roleMappings: Record<string, RoleMapping[]>
}
