import React from 'react'
import { X } from 'lucide-react'
import { classNames } from '@/lib/utils'

interface Tab {
  id: string
  label: string
  icon?: React.ReactNode
  badge?: boolean
  closable?: boolean
}

interface TabsProps {
  tabs: Tab[]
  activeId: string
  onSelect: (id: string) => void
  onClose?: (id: string) => void
  rightContent?: React.ReactNode
}

export function Tabs({ tabs, activeId, onSelect, onClose, rightContent }: TabsProps) {
  return (
    <div className="flex items-center bg-bg-secondary/80 px-1 py-1 shadow-sm">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {tabs.map((tab) => {
          const isActive = tab.id === activeId
          return (
            <button
              key={tab.id}
              className={classNames(
                'group relative flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-all duration-150',
                isActive
                  ? 'bg-accent/10 text-text-primary shadow-sm'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-secondary',
              )}
              onClick={() => onSelect(tab.id)}
            >
              {tab.icon}
              <span className="text-nowrap min-w-0">{tab.label}</span>
              {tab.badge && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="This preview has active filters" />
              )}
              {tab.closable && onClose && (
                <span
                  className={classNames(
                    'ml-1 flex h-5 w-5 items-center justify-center rounded transition-colors',
                    'opacity-0 group-hover:opacity-100',
                    'hover:bg-bg-hover text-text-muted hover:text-text-primary',
                  )}
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onClose(tab.id)
                  }}
                >
                  <X size={12} />
                </span>
              )}
            </button>
          )
        })}
      </div>
      {rightContent && (
        <div className="ml-auto flex shrink-0 items-center px-2">{rightContent}</div>
      )}
    </div>
  )
}
