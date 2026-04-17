import React, { useEffect, useCallback } from 'react'
import { classNames } from '@/lib/utils'

interface MenuItem {
  label: string
  icon?: React.ReactNode
  shortcut?: string
  onClick: () => void
  danger?: boolean
  separator?: boolean
  disabled?: boolean
}

interface ContextMenuProps {
  items: MenuItem[]
  position: { x: number; y: number } | null
  onClose: () => void
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose],
  )

  const handleClickOutside = useCallback(() => {
    onClose()
  }, [onClose])

  useEffect(() => {
    if (position) {
      document.addEventListener('keydown', handleKeyDown)
      document.addEventListener('mousedown', handleClickOutside)
      return () => {
        document.removeEventListener('keydown', handleKeyDown)
        document.removeEventListener('mousedown', handleClickOutside)
      }
    }
  }, [position, handleKeyDown, handleClickOutside])

  if (!position) return null

  return (
    <div
      className="fixed z-50 min-w-[180px] rounded-lg border border-border bg-bg-secondary py-1 shadow-xl"
      style={{ left: position.x, top: position.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => {
        if (item.separator) {
          return <div key={i} className="mx-2 my-1 h-px bg-border" />
        }

        return (
          <button
            key={i}
            className={classNames(
              'flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors',
              item.danger
                ? 'text-error hover:bg-error/10'
                : 'text-text-primary hover:bg-bg-hover',
              item.disabled && 'opacity-50 cursor-not-allowed',
            )}
            disabled={item.disabled}
            onClick={() => {
              if (!item.disabled) {
                item.onClick()
                onClose()
              }
            }}
          >
            {item.icon && <span className="shrink-0">{item.icon}</span>}
            <span className="flex-1 text-left">{item.label}</span>
            {item.shortcut && (
              <span className="ml-auto text-xs text-text-muted">{item.shortcut}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
