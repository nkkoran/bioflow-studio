import type { ArtifactRef, PipelineSnapshot, RunState, TransferPlan } from '@/types/pipeline'
import type { WorkflowReadinessReport } from '@/types/readiness'

export interface BioflowWorkspace {
  id: string
  name: string
  connectionName?: string
  analysisRoot?: string
  slurmAccount?: string
  slurmPartition?: string
  toolsRoot?: string
  annovarScriptsPath?: string
  annovarDbPath?: string
  vepPath?: string
  vepCachePath?: string
  recommendedTemplateId?: string
  notes?: string
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}

export type ClusterDoctorSeverity = 'info' | 'warning' | 'error'
export type ClusterDoctorStatus = 'pass' | 'warning' | 'error'

export interface ClusterDoctorCheck {
  id: string
  title: string
  severity: ClusterDoctorSeverity
  status: ClusterDoctorStatus
  detail: string
  suggestion?: string
}

export interface ClusterDoctorReport {
  connectionId: string
  workspaceId?: string
  createdAt: number
  checks: ClusterDoctorCheck[]
}

export interface RunManifest {
  generatedAt: number
  workspace?: BioflowWorkspace | RunState['workspace'] | null
  run: RunState
  snapshot?: PipelineSnapshot
  summary: string
  steps: Array<{
    nodeId: string
    label: string
    nodeType: 'tool' | 'merge' | 'transform' | 'transfer'
    toolId?: string
    toolName?: string
    mode?: string
    plainLanguage: string
    inputs: string[]
    outputs: string[]
    selectedOptions: string[]
    commands: string[]
    script?: string
    arraySize?: number
    status?: string
  }>
  commands: Array<{
    nodeId: string
    label: string
    commands: string[]
  }>
  scripts: Array<{
    nodeId: string
    label: string
    mode?: string
    script: string
    outputPaths: string[]
    arraySize?: number
  }>
  validation?: {
    errorCount: number
    warningCount: number
    infoCount: number
    issues: Array<{
      code: string
      severity: 'error' | 'warning' | 'info'
      message: string
      suggestion?: string
      nodeId?: string
    }>
  } | null
  readiness?: {
    blockingCount: number
    issueCount: number
    ok: boolean
    issues: Array<{
      code: string
      severity: 'error' | 'warning' | 'info'
      category: string
      message: string
      suggestion?: string
      nodeId?: string
      path?: string
    }>
  } | null
  runReadiness?: {
    ok: boolean
    errorCount: number
    warningCount: number
    infoCount: number
    issues: Array<{
      code: string
      severity: 'error' | 'warning' | 'info'
      category: 'Structure' | 'Files' | 'Columns' | 'IDs' | 'Backends' | 'Cluster' | 'Resources' | 'Results'
      message: string
      suggestion?: string
      nodeId?: string
      edgeId?: string
      details?: Record<string, string | number | boolean | null>
      action?: 'select-node' | 'insert-transfer' | 'insert-liftover' | 'open-settings' | 'run-cluster-doctor' | 'refresh-probe' | 'preview-file'
    }>
  } | null
  clusterDoctor?: ClusterDoctorReport | null
  transferPlans?: TransferPlan[]
  resourceEstimates?: Array<{
    nodeId: string
    cpus?: number
    memoryGB?: number
    timeHours?: number
    source?: string
    confidence?: string
  }>
  observedResources?: Array<{
    nodeId: string
    runtimeSeconds?: number
    exitCode?: number
  }>
  failureDiagnostics?: Array<{
    nodeId: string
    cause: string
    suggestion: string
  }>
  resultCards?: Array<{
    nodeId: string
    label: string
    kind: 'gwas-summary' | 'prs-profile' | 'variant-annotation' | 'multiqc-report' | 'log' | 'tabular' | 'generic'
    primary: boolean
    artifacts: ArtifactRef[]
  }>
  environment: {
    connectionId: string
    workDir: string
    scriptsDir?: string
    logsDir?: string
    outputRoot?: string
    arrayChainMode?: RunState['arrayChainMode']
    fileLifecyclePolicy?: RunState['fileLifecyclePolicy']
    homeDir?: string
  }
  outputs: Array<{
    nodeId: string
    label: string
    status: string
    paths: string[]
  }>
}

export type RunReadinessReport = NonNullable<RunManifest['runReadiness']>

export interface RunDossierInputs {
  readiness?: WorkflowReadinessReport | null
  clusterDoctor?: ClusterDoctorReport | null
  transferPlans?: TransferPlan[]
}
