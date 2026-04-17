import { FileExplorer } from '@/components/file-explorer/FileExplorer'

interface SidebarProps {
  width: number
}

export function Sidebar({ width }: SidebarProps) {
  return (
    <div
      className="h-full bg-bg-secondary border-r border-border overflow-hidden shrink-0"
      style={{ width }}
    >
      <FileExplorer />
    </div>
  )
}
