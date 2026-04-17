import React, { useRef, useEffect } from 'react'
import { FolderOpen, ChevronRight } from 'lucide-react'

interface BreadcrumbProps {
  path: string
  onNavigate: (path: string) => void
}

export function Breadcrumb({ path, onNavigate }: BreadcrumbProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to end when path changes
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth
    }
  }, [path])

  const segments = path.split('/').filter(Boolean)

  return (
    <div
      ref={scrollRef}
      className="flex items-center gap-0.5 overflow-x-auto px-3 py-1.5 font-mono text-xs scrollbar-none"
    >
      <button
        onClick={() => onNavigate('/')}
        className="flex shrink-0 items-center gap-1 text-text-muted transition-colors hover:text-accent"
      >
        <FolderOpen className="h-3.5 w-3.5" />
        <span>/</span>
      </button>

      {segments.map((segment, i) => {
        const segmentPath = '/' + segments.slice(0, i + 1).join('/')
        const isLast = i === segments.length - 1

        return (
          <React.Fragment key={segmentPath}>
            <ChevronRight className="h-3 w-3 shrink-0 text-text-muted" />
            <button
              onClick={() => onNavigate(segmentPath)}
              className={
                isLast
                  ? 'shrink-0 text-text-primary'
                  : 'shrink-0 text-text-muted transition-colors hover:text-accent'
              }
            >
              {segment}
            </button>
          </React.Fragment>
        )
      })}
    </div>
  )
}
