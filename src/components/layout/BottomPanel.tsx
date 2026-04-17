import { ChevronDown, ChevronUp } from 'lucide-react'
import { useUIStore } from '@/stores/uiStore'
import { useRunStore } from '@/stores/runStore'
import { TerminalPanel } from '@/components/terminal/TerminalPanel'
import { DataPreview } from '@/components/data-preview/DataPreview'
import { JobsPanel } from '@/components/jobs/JobsPanel'

interface BottomPanelProps {
  height: number
}

export function BottomPanel({ height }: BottomPanelProps) {
  const mode = useUIStore((s) => s.bottomPanelMode)
  const isOpen = useUIStore((s) => s.bottomPanelOpen)
  const setMode = useUIStore((s) => s.setBottomPanelMode)
  const toggle = useUIStore((s) => s.toggleBottomPanel)
  // Show a small badge on the Jobs tab when a run is in flight so the user
  // notices it even if they're on another tab.
  const runningCount = useRunStore((s) => {
    let n = 0
    for (const r of Object.values(s.runs)) {
      if (r.status === 'running' || r.status === 'queued') n++
    }
    return n
  })

  return (
    <div
      className="bg-bg-secondary border-t border-border flex flex-col shrink-0 overflow-hidden"
      style={{ height: isOpen ? height : 32 }}
    >
      {/* Tab bar */}
      <div className="flex items-center h-8 shrink-0 px-2 gap-1 border-b border-border-light">
        <TabButton
          label="Terminal"
          active={mode === 'terminal'}
          onClick={() => setMode('terminal')}
        />
        <TabButton
          label="Data Preview"
          active={mode === 'data'}
          onClick={() => setMode('data')}
        />
        <TabButton
          label="Jobs"
          active={mode === 'jobs'}
          onClick={() => setMode('jobs')}
          badge={runningCount > 0 ? runningCount : undefined}
        />

        <div className="flex-1" />

        <button
          onClick={toggle}
          className="p-1 rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
          title={isOpen ? 'Collapse panel' : 'Expand panel'}
        >
          {isOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>

      {/* Content */}
      {isOpen && (
        <>
          {mode === 'terminal' && <TerminalPanel />}
          {mode === 'data' && <DataPreview />}
          {mode === 'jobs' && <JobsPanel />}
        </>
      )}
    </div>
  )
}

function TabButton({
  label,
  active,
  onClick,
  badge,
}: {
  label: string
  active: boolean
  onClick: () => void
  badge?: number
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 h-full text-xs font-medium transition-colors relative inline-flex items-center gap-1.5 ${
        active
          ? 'text-text-primary'
          : 'text-text-secondary hover:text-text-primary'
      }`}
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-warning/20 text-warning text-[9px] font-semibold">
          {badge}
        </span>
      )}
      {active && (
        <span className="absolute bottom-0 left-1 right-1 h-0.5 bg-accent rounded-full" />
      )}
    </button>
  )
}
