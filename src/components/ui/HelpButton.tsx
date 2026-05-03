import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { HelpCircle } from 'lucide-react'
import { getHelpContent } from '@/lib/helpContent'

export function HelpButton({ id }: { id: string }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  const popoverRef = useRef<HTMLSpanElement>(null)
  const content = getHelpContent(id)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!ref.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    const updatePosition = () => {
      const rect = ref.current?.getBoundingClientRect()
      if (!rect) return
      const width = 256
      const padding = 8
      setPosition({
        left: Math.max(padding, Math.min(window.innerWidth - width - padding, rect.right - width)),
        top: rect.bottom + 6,
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-5 w-5 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text-primary"
        aria-label={`Help: ${content.title}`}
        title={content.title}
      >
        <HelpCircle size={13} />
      </button>
      {open && position && typeof document !== 'undefined' && createPortal(
        <span
          ref={popoverRef}
          className="bioflow-help-popover fixed z-[1200] w-64 rounded-md border border-border bg-bg-secondary p-3 text-left shadow-xl"
          style={position}
        >
          <span className="block text-xs font-semibold text-text-primary">{content.title}</span>
          <span className="mt-1 block text-[11px] leading-relaxed text-text-secondary">{content.body}</span>
          {content.example && (
            <span className="mt-2 block rounded border border-border bg-bg-tertiary px-2 py-1 font-mono text-[10px] text-text-muted">
              {content.example}
            </span>
          )}
        </span>,
        document.body,
      )}
    </span>
  )
}
