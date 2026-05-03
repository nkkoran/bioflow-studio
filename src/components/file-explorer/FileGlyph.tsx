import type { RemoteFileEntry } from '@/types/files'
import { classNames } from '@/lib/utils'
import { getFileIcon } from './fileIconMap'

type FileGlyphSize = 'row' | 'split' | 'grid'

interface FileGlyphProps {
  entry: RemoteFileEntry
  size?: FileGlyphSize
  selected?: boolean
  open?: boolean
}

const sizeClasses: Record<FileGlyphSize, { frame: string; icon: string }> = {
  row: { frame: 'h-5 w-5 rounded-md', icon: 'h-3.5 w-3.5' },
  split: { frame: 'h-6 w-6 rounded-md', icon: 'h-4 w-4' },
  grid: { frame: 'h-12 w-12 rounded-lg', icon: 'h-7 w-7' },
}

export function FileGlyph({ entry, size = 'row', selected = false, open = false }: FileGlyphProps) {
  const iconDef = getFileIcon(entry.extension, entry.isDirectory, open)
  const Icon = iconDef.icon
  const classes = sizeClasses[size]
  const finderStyleFolder = size === 'grid' && entry.isDirectory

  return (
    <span
      className={classNames(
        'bioflow-file-glyph flex shrink-0 items-center justify-center',
        classes.frame,
        finderStyleFolder
          ? 'bg-transparent'
          : selected ? 'bg-accent/15' : 'bg-bg-tertiary/90',
      )}
      data-kind={entry.isDirectory ? 'folder' : 'file'}
      data-size={size}
      aria-hidden
    >
      <Icon
        className={classNames(
          finderStyleFolder ? 'h-12 w-12 fill-accent/35' : classes.icon,
          iconDef.color,
        )}
        strokeWidth={finderStyleFolder ? 1.35 : undefined}
      />
    </span>
  )
}
