import React, { useState, useRef, useCallback } from 'react'
import { classNames } from '@/lib/utils'

interface TooltipProps {
  content: string | React.ReactNode
  children: React.ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  delay?: number
}

const positionStyles: Record<NonNullable<TooltipProps['side']>, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
  left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
  right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
}

export function Tooltip({
  content,
  children,
  side = 'top',
  delay = 300,
}: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = useCallback(() => {
    timerRef.current = setTimeout(() => setVisible(true), delay)
  }, [delay])

  const hide = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setVisible(false)
  }, [])

  return (
    <div className="relative inline-flex" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {visible && (
        <span
          className={classNames(
            'absolute z-50 whitespace-nowrap rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary shadow-lg',
            'pointer-events-none',
            positionStyles[side],
          )}
        >
          {content}
        </span>
      )}
    </div>
  )
}
