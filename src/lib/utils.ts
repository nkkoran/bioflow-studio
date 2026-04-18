/**
 * Format bytes into a human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const k = 1024
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const value = bytes / Math.pow(k, i)
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

/**
 * Format a timestamp into a relative or absolute date string.
 */
export function formatDate(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`

  const date = new Date(timestamp)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  })
}

/**
 * Join truthy class name strings.
 */
export function classNames(...classes: (string | boolean | undefined | null | number | bigint)[]): string {
  return classes.filter(Boolean).join(' ')
}

/**
 * Get file extension from a filename.
 */
export function getFileExtension(name: string): string {
  const idx = name.lastIndexOf('.')
  if (idx <= 0) return ''
  return name.slice(idx + 1).toLowerCase()
}

/**
 * Check if a file extension indicates a tabular data file.
 */
export function isTabularFile(extension: string): boolean {
  const tabularExtensions = new Set([
    'tsv', 'csv', 'txt', 'pheno', 'psam', 'fam', 'bim', 'pvar', 'frq', 'afreq', 'assoc', 'qassoc', 'linear', 'logistic',
  ])
  return tabularExtensions.has(extension.toLowerCase())
}

/**
 * Join path segments with forward slashes.
 */
export function pathJoin(...parts: string[]): string {
  return parts
    .map((part, i) => {
      if (i === 0) return part.replace(/\/+$/, '')
      return part.replace(/^\/+/, '').replace(/\/+$/, '')
    })
    .filter(Boolean)
    .join('/')
}

/**
 * Get the directory portion of a path.
 */
export function pathDirname(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return '/'
  return path.slice(0, idx)
}

/**
 * Get the filename portion of a path.
 */
export function pathBasename(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? path : path.slice(idx + 1)
}
