import { useEffect, useRef, useState } from 'react'
import { HelpCircle } from 'lucide-react'
import { getHelpContent } from '@/lib/helpContent'

export function HelpButton({ id }: { id: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const content = getHelpContent(id)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
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
      {open && (
        <span className="absolute right-0 top-6 z-50 w-64 rounded-md border border-border bg-bg-secondary p-3 text-left shadow-xl">
          <span className="block text-xs font-semibold text-text-primary">{content.title}</span>
          <span className="mt-1 block text-[11px] leading-relaxed text-text-secondary">{content.body}</span>
          {content.example && (
            <span className="mt-2 block rounded border border-border bg-bg-tertiary px-2 py-1 font-mono text-[10px] text-text-muted">
              {content.example}
            </span>
          )}
        </span>
      )}
    </span>
  )
}
