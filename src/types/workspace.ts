import type { PipelineSnapshot, RunState } from '@/types/pipeline'

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
  outputs: Array<{
    nodeId: string
    label: string
    status: string
    paths: string[]
  }>
}
