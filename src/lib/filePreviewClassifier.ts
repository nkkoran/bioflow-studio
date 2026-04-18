import { getFileExtension, isTabularFile } from '@/lib/utils'
import type { PreviewMode } from '@/stores/dataPreviewStore'

const TEXT_EXTENSIONS = new Set([
  'log', 'sh', 'bash', 'zsh', 'out', 'err', 'md', 'json', 'yaml', 'yml',
  'py', 'r', 'R', 'sbatch', 'conf', 'ini', 'toml', 'bed', 'txt',
])

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

export function classifyPreview(pathOrName: string): PreviewMode {
  const ext = getFileExtension(pathOrName)
  const lower = pathOrName.toLowerCase()
  if (isTabularFile(ext) || lower.endsWith('.pgen.pvar')) return 'tabular'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  return 'binary'
}

export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024
