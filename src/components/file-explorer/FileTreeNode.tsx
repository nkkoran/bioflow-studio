import React, { useCallback } from 'react'
import type { RemoteFileEntry } from '@/types/files'
import { formatBytes, formatDate } from '@/lib/utils'
import { Tooltip } from '@/components/ui/Tooltip'
import { classNames } from '@/lib/utils'
import { FileGlyph } from './FileGlyph'

interface FileTreeNodeProps {
  entry: RemoteFileEntry
  isSelected: boolean
  onSelect: (entry: RemoteFileEntry, event: React.MouseEvent) => void
  onNavigate: (path: string) => void
  onPreview: (entry: RemoteFileEntry) => void
  onContextMenu: (e: React.MouseEvent, entry: RemoteFileEntry) => void
}

export function FileTreeNode({
  entry,
  isSelected,
  onSelect,
  onNavigate,
  onPreview,
  onContextMenu,
}: FileTreeNodeProps) {
  const handleClick = useCallback((event: React.MouseEvent) => {
    onSelect(entry, event)
  }, [onSelect, entry])

  const handleDoubleClick = useCallback(() => {
    if (entry.isDirectory) {
      onNavigate(entry.path)
    } else {
      onPreview(entry)
    }
  }, [entry, onNavigate, onPreview])

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      onContextMenu(e, entry)
    },
    [onContextMenu, entry],
  )

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.setData('text/plain', entry.path)
      e.dataTransfer.setData('application/x-bioflow-path', entry.path)
      e.dataTransfer.setData('application/x-bioflow-file-entry', JSON.stringify({
        path: entry.path,
        name: entry.name,
        isDirectory: entry.isDirectory,
      }))
      e.dataTransfer.effectAllowed = 'copyMove'
    },
    [entry.isDirectory, entry.name, entry.path],
  )

  return (
    <Tooltip content={formatDate(entry.modified)} side="right" delay={500}>
      <div
        data-file-path={entry.path}
        className={classNames(
          'interactive-row flex h-8 cursor-pointer items-center gap-2 rounded-md px-3 text-text-secondary transition-colors duration-150',
          isSelected
            ? 'bg-accent/10 text-text-primary shadow-sm'
            : 'hover:text-text-primary',
        )}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        draggable
        onDragStart={handleDragStart}
      >
        <FileGlyph entry={entry} size="row" selected={isSelected} />

        <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
          {entry.name}
          {entry.isDirectory && '/'}
        </span>

        {!entry.isDirectory && (
          <span className="shrink-0 text-xs text-text-muted">
            {formatBytes(entry.size)}
          </span>
        )}
      </div>
    </Tooltip>
  )
}
