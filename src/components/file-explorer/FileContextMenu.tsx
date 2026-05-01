import React from 'react'
import {
  Eye,
  Copy,
  ArrowRightToLine,
  FolderOpen,
  Bookmark,
  BookmarkX,
  FilePlus,
  FolderPlus,
  Pencil,
  Trash2,
} from 'lucide-react'
import { ContextMenu } from '@/components/ui/ContextMenu'
import type { RemoteFileEntry } from '@/types/files'
import { isTabularFile } from '@/lib/utils'

interface FileContextMenuProps {
  entry: RemoteFileEntry | null
  position: { x: number; y: number } | null
  isBookmarked: boolean
  onClose: () => void
  onOpen: (entry: RemoteFileEntry) => void
  onPreview: (entry: RemoteFileEntry) => void
  onCopyPath: (path: string) => void
  onUseAsInput: (entry: RemoteFileEntry) => void
  onBookmark: (path: string) => void
  onUnbookmark: (path: string) => void
  onRename: (entry: RemoteFileEntry) => void
  onDelete: (entry: RemoteFileEntry) => void
  onNewFile: (dirPath: string) => void
  onNewFolder: (dirPath: string) => void
}

export function FileContextMenu({
  entry,
  position,
  isBookmarked,
  onClose,
  onOpen,
  onPreview,
  onCopyPath,
  onUseAsInput,
  onBookmark,
  onUnbookmark,
  onRename,
  onDelete,
  onNewFile,
  onNewFolder,
}: FileContextMenuProps) {
  if (!entry) return null

  const isDir = entry.isDirectory
  const isTabular = !isDir && isTabularFile(entry.extension)

  const fileItems = [
    ...(isTabular
      ? [
          {
            label: 'Open Preview',
            icon: <Eye className="h-4 w-4" />,
            onClick: () => onPreview(entry),
          },
        ]
      : []),
    {
      label: 'Copy Path',
      icon: <Copy className="h-4 w-4" />,
      onClick: () => onCopyPath(entry.path),
    },
    {
      label: 'Use as Input',
      icon: <ArrowRightToLine className="h-4 w-4" />,
      onClick: () => onUseAsInput(entry),
    },
    { label: '', onClick: () => {}, separator: true },
    {
      label: 'Rename',
      icon: <Pencil className="h-4 w-4" />,
      onClick: () => onRename(entry),
    },
    {
      label: 'Delete',
      icon: <Trash2 className="h-4 w-4" />,
      onClick: () => onDelete(entry),
      danger: true,
    },
  ]

  const dirItems = [
    {
      label: 'Open',
      icon: <FolderOpen className="h-4 w-4" />,
      onClick: () => onOpen(entry),
    },
    {
      label: 'Copy Path',
      icon: <Copy className="h-4 w-4" />,
      onClick: () => onCopyPath(entry.path),
    },
    isBookmarked
      ? {
          label: 'Remove Bookmark',
          icon: <BookmarkX className="h-4 w-4" />,
          onClick: () => onUnbookmark(entry.path),
        }
      : {
          label: 'Bookmark',
          icon: <Bookmark className="h-4 w-4" />,
          onClick: () => onBookmark(entry.path),
        },
    { label: '', onClick: () => {}, separator: true },
    {
      label: 'New File',
      icon: <FilePlus className="h-4 w-4" />,
      onClick: () => onNewFile(entry.path),
    },
    {
      label: 'New Folder',
      icon: <FolderPlus className="h-4 w-4" />,
      onClick: () => onNewFolder(entry.path),
    },
    { label: '', onClick: () => {}, separator: true },
    {
      label: 'Rename',
      icon: <Pencil className="h-4 w-4" />,
      onClick: () => onRename(entry),
    },
    {
      label: 'Delete',
      icon: <Trash2 className="h-4 w-4" />,
      onClick: () => onDelete(entry),
      danger: true,
    },
  ]

  return (
    <ContextMenu
      items={isDir ? dirItems : fileItems}
      position={position}
      onClose={onClose}
    />
  )
}
