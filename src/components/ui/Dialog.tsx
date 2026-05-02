import React, { useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { classNames } from '@/lib/utils'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: React.ReactNode
  icon?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  className?: string
  bodyClassName?: string
}

export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  icon,
  children,
  footer,
  className,
  bodyClassName,
}: DialogProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose],
  )

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, handleKeyDown])

  if (!open) return null

  return createPortal(
    <div
      className="bioflow-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={classNames(
          'bioflow-modal surface-popover rounded-lg',
          'animate-fade-up',
          className,
        )}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bioflow-modal-header">
          {icon && (
            <div className="mt-0.5 shrink-0 text-accent" aria-hidden>
              {icon}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold leading-5 text-text-primary">{title}</h2>
            {subtitle && <div className="mt-0.5 truncate text-xs text-text-muted">{subtitle}</div>}
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            aria-label="Close dialog"
          >
            <X size={16} />
          </button>
        </div>

        <div className={classNames('bioflow-modal-body', bodyClassName)}>{children}</div>

        {footer && (
          <div className="bioflow-modal-footer">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
