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
  row: { frame: 'h-4 w-4 rounded', icon: 'h-3 w-3' },
  split: { frame: 'h-5 w-5 rounded', icon: 'h-3.5 w-3.5' },
  grid: { frame: 'h-9 w-9 rounded-md', icon: 'h-[18px] w-[18px]' },
}

export function FileGlyph({ entry, size = 'row', selected = false, open = false }: FileGlyphProps) {
  const iconDef = getFileIcon(entry.extension, entry.isDirectory, open)
  const Icon = iconDef.icon
  const classes = sizeClasses[size]

  return (
    <span
      className={classNames(
        'bioflow-file-glyph flex shrink-0 items-center justify-center',
        classes.frame,
        selected ? 'bg-accent/15' : 'bg-bg-tertiary/90',
      )}
      data-kind={entry.isDirectory ? 'folder' : 'file'}
      data-size={size}
      aria-hidden
    >
      <Icon
        className={classNames(
          classes.icon,
          iconDef.color,
        )}
        strokeWidth={size === 'grid' ? 1.65 : undefined}
      />
    </span>
  )
}
