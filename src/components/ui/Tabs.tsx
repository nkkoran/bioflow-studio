import React from 'react'
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
    <div className="flex items-center bg-bg-secondary border-b border-border">
      <div className="flex items-center flex-1 min-w-0">
        {tabs.map((tab) => {
          const isActive = tab.id === activeId
          return (
            <button
              key={tab.id}
              className={classNames(
                'group relative flex items-center gap-1.5 px-3 py-2 text-sm cursor-pointer transition-colors',
                'border-b-2 -mb-px',
                isActive
                  ? 'text-text-primary border-accent'
                  : 'text-text-muted hover:text-text-secondary border-transparent',
              )}
              onClick={() => onSelect(tab.id)}
            >
              {tab.icon}
              <span className="truncate">{tab.label}</span>
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
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  >
                    <path d="M3 3l6 6M9 3l-6 6" />
                  </svg>
                </span>
              )}
            </button>
          )
        })}
      </div>
      {rightContent && (
        <div className="flex items-center px-2 ml-auto shrink-0">{rightContent}</div>
      )}
    </div>
  )
}
