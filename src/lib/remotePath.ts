export function trimTrailingSlash(path: string): string {
  if (!path) return path
  if (path === '/') return path
  return path.replace(/\/+$/, '')
}

export function pathDirname(path: string): string {
  const normalized = trimTrailingSlash(path)
  if (!normalized) return ''
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return normalized.startsWith('/') ? '/' : ''
  return normalized.slice(0, idx)
}

export function pathBasename(path: string): string {
  const normalized = trimTrailingSlash(path)
  if (!normalized) return ''
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? normalized : normalized.slice(idx + 1)
}

export function joinRemotePath(base: string, child: string): string {
  if (!base || base === '/') return `/${child.replace(/^\/+/, '')}`
  return `${trimTrailingSlash(base)}/${child.replace(/^\/+/, '')}`
}

export function expandHomePath(path: string, homeDir: string | null): string {
  if (!homeDir) return path
  if (path === '~') return homeDir
  if (path.startsWith('~/')) return `${homeDir}/${path.slice(2)}`
  return path
}

export function collapseHomePath(path: string, homeDir: string | null): string {
  if (!homeDir) return path
  if (path === homeDir) return '~'
  if (path.startsWith(`${homeDir}/`)) return `~/${path.slice(homeDir.length + 1)}`
  return path
}

export function autocompleteContext(path: string, homeDir: string | null): { dir: string; prefix: string } {
  const expanded = expandHomePath(path, homeDir)
  if (!expanded) return { dir: homeDir ?? '/', prefix: '' }
  if (expanded.endsWith('/')) return { dir: trimTrailingSlash(expanded) || '/', prefix: '' }
  const idx = expanded.lastIndexOf('/')
  if (idx === -1) return { dir: homeDir ?? '/', prefix: expanded }
  return {
    dir: idx === 0 ? '/' : expanded.slice(0, idx),
    prefix: expanded.slice(idx + 1),
  }
}
