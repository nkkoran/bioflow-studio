import { Settings } from 'lucide-react'
import { ConnectionStatus } from '@/components/connection/ConnectionStatus'

export function TopBar() {
  return (
    <div
      className="flex items-center h-10 bg-bg-secondary border-b border-border px-3 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* macOS traffic light padding */}
      <div className="w-[70px] shrink-0" />

      <span className="text-text-primary text-sm font-semibold font-sans tracking-tight">
        BioFlow Studio
      </span>

      <div className="flex-1" />

      <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <ConnectionStatus />
      </div>

      <button
        className="p-1.5 rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors ml-2"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        title="Settings"
      >
        <Settings size={16} />
      </button>
    </div>
  )
}
