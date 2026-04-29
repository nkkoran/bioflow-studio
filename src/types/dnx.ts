import type { RemoteFileEntry, FileStat } from './files'

export type DnxBootstrapStatus = 'unknown' | 'bootstrapping' | 'ready' | 'error'
export type DnxAuthStatus = 'unauthenticated' | 'authenticated' | 'error'

export interface DnxProject {
  id: string
  name: string
}

export interface DnxRemoteFileEntry extends RemoteFileEntry {
  id?: string
  projectId: string
  folder: string
}

export interface DnxFileStat extends FileStat {
  id?: string
  projectId: string
  folder: string
}

export interface DnxTransferProgress {
  direction: 'upload' | 'download'
  bytes: number
  total?: number
  path?: string
  projectId?: string
  fileId?: string
}

export interface DnxBridgeStatusEvent {
  level: 'info' | 'warning' | 'error'
  message: string
  code?: string
}

export interface DnxAppletInstallProgress {
  stage: 'building' | 'uploading' | 'verifying' | 'done'
  percent?: number
  message?: string
}

export interface DnxJobStatus {
  jobId: string
  state: string
  name?: string
  projectId?: string
  outputFolder?: string
  fileIds?: string[]
  startedAt?: number
  finishedAt?: number
}

export interface DnxFieldPresetItem {
  fieldId: string
  label?: string
}

export interface DnxFieldPreset {
  id: string
  name: string
  fields: DnxFieldPresetItem[]
}

export interface DnxInstanceSpec {
  id: string
  name: string
  cpu: number
  memoryGB: number
  localSsdGB?: number
}

export interface DnxInstanceCatalog {
  lastRefreshed: number
  specs: DnxInstanceSpec[]
}

export interface DnxInstalledAppletInfo {
  appletId: string | null
  hash: string | null
}
