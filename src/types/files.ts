export interface RemoteFileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modified: number  // timestamp ms
  permissions: string
  extension: string
}

export interface FileStat {
  size: number
  modified: number
  isDirectory: boolean
  permissions: string
}

export type SortField = 'name' | 'size' | 'modified' | 'extension'
export type SortDirection = 'asc' | 'desc'
