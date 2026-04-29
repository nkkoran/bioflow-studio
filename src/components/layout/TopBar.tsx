import { useEffect, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import { ConnectionStatus } from '@/components/connection/ConnectionStatus'
import { PipelineSwitcher } from './PipelineSwitcher'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { WorkspaceSwitcher } from '@/components/workspace/WorkspaceSwitcher'
import { useUIStore, type SettingsSection } from '@/stores/uiStore'

// Width below which the TopBar switches to compact mode: title hides,
// connection status collapses to an icon pill. Measured against the TopBar
// root, not viewport, because the app layout is driven by panel widths.
const COMPACT_WIDTH_THRESHOLD = 620

export function TopBar() {
  const rootRef = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined)
  const settingsOpenRequest = useUIStore((s) => s.settingsOpenRequest)
  const consumeSettingsOpen = useUIStore((s) => s.consumeSettingsOpen)

  useEffect(() => {
    if (!settingsOpenRequest) return
    setSettingsSection(settingsOpenRequest.section)
    setSettingsOpen(true)
    consumeSettingsOpen()
  }, [settingsOpenRequest, consumeSettingsOpen])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCompact(entry.contentRect.width < COMPACT_WIDTH_THRESHOLD)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={rootRef}
      className="flex items-center h-10 bg-bg-secondary border-b border-border px-3 select-none gap-2"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* macOS traffic light padding */}
      <div className="w-[70px] shrink-0" />

      <PipelineSwitcher compact={compact} />
      {!compact && <WorkspaceSwitcher />}

      <div className="flex-1 min-w-0" />

      <div
        className="min-w-0 shrink"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <ConnectionStatus compact={compact} />
      </div>

      <button
        onClick={() => setSettingsOpen(true)}
        className="p-1.5 rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors shrink-0"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        title="Settings"
      >
        <Settings size={16} />
      </button>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialSection={settingsSection}
      />
    </div>
  )
}
