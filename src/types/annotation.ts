export interface AnnovarDatabaseStatus {
  database: string
  buildver: string
  estimatedSizeGB: number
  status: 'installed' | 'missing' | 'stale'
  expectedPath: string
}

export interface AnnovarStatusResult {
  databases: AnnovarDatabaseStatus[]
  totalDownloadSizeGB: number
  checkedAt: number
}

export interface AnnovarInstallRequest {
  connectionId: string
  scriptsPath: string
  humandbPath: string
  buildver: string
  databases: string[]
}

export interface AnnovarInstallProgress {
  connectionId: string
  buildver: string
  database: string
  phase: 'starting' | 'running' | 'done' | 'error'
  chunk?: string
}
