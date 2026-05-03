import React, { useEffect, useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { classNames } from '@/lib/utils'

interface TooltipProps {
  content: string | React.ReactNode
  children: React.ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  delay?: number
}

interface TooltipPosition {
  left: number
  top: number
  transform: string
}

export function Tooltip({
  content,
  children,
  side = 'top',
  delay = 300,
}: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const [position, setPosition] = useState<TooltipPosition | null>(null)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    }
  }, [])

  const updatePosition = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return
    const gap = 8
    if (side === 'bottom') {
      setPosition({ left: rect.left + rect.width / 2, top: rect.bottom + gap, transform: 'translateX(-50%)' })
    } else if (side === 'left') {
      setPosition({ left: rect.left - gap, top: rect.top + rect.height / 2, transform: 'translate(-100%, -50%)' })
    } else if (side === 'right') {
      setPosition({ left: rect.right + gap, top: rect.top + rect.height / 2, transform: 'translateY(-50%)' })
    } else {
      setPosition({ left: rect.left + rect.width / 2, top: rect.top - gap, transform: 'translate(-50%, -100%)' })
    }
  }, [side])

  useEffect(() => {
    if (!visible) return
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [updatePosition, visible])

  const show = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
    timerRef.current = setTimeout(() => {
      updatePosition()
      setVisible(true)
    }, delay)
  }, [delay, updatePosition])

  const hide = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    hideTimerRef.current = setTimeout(() => setVisible(false), 700)
  }, [])

  return (
    <span ref={rootRef} className="bioflow-tooltip-root relative inline-flex" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {visible && position && typeof document !== 'undefined' && createPortal(
        <span
          className={classNames(
            'bioflow-tooltip-content fixed z-[1200] max-w-[min(22rem,calc(100vw-var(--space-4)))] rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary shadow-lg',
            'pointer-events-auto',
          )}
          style={position}
        >
          {content}
        </span>,
        document.body,
      )}
    </span>
  )
}
