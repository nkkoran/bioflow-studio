import { FileExplorer } from '@/components/file-explorer/FileExplorer'
import { QuickExtractButton } from '@/components/sidebar/QuickExtractButton'
import { useSettingsStore } from '@/stores/settingsStore'

export function Sidebar() {
  const devMode = useSettingsStore((s) => s.devMode)
  return (
    <div
      className="bioflow-sidebar-rail bioflow-panel-text surface-panel z-20 h-full shrink-0 overflow-hidden"
    >
      <div className="bioflow-sidebar-content flex flex-col">
        {devMode && <QuickExtractButton />}
        <div className="min-h-0 flex-1 overflow-hidden">
          <FileExplorer />
        </div>
      </div>
    </div>
  )
}
