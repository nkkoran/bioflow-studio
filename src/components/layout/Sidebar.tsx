import { FileExplorer } from '@/components/file-explorer/FileExplorer'
import { QuickExtractButton } from '@/components/sidebar/QuickExtractButton'

interface SidebarProps {
  width: number
}

export function Sidebar({ width }: SidebarProps) {
  return (
    <div
      className="h-full bg-bg-secondary border-r border-border overflow-hidden shrink-0"
      style={{ width }}
    >
      <div className="flex h-full flex-col">
        <QuickExtractButton />
        <div className="min-h-0 flex-1">
          <FileExplorer />
        </div>
      </div>
    </div>
  )
}
