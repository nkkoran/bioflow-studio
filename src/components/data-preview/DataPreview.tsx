import { useEffect, useRef } from 'react'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import { headFile } from '@/stores/fileStore'
import { Tabs } from '@/components/ui/Tabs'
import { DataTable } from './DataTable'
import { detectDelimiter, parseTabularData } from './DelimiterDetector'
import { Table2, Loader2 } from 'lucide-react'

export function DataPreview() {
  const { tabs, activeTabId, setActiveTab, closeTab, setTabData } = useDataPreviewStore()
  const loadingRef = useRef(new Set<string>())

  // Fetch data for any tab that is loading and hasn't been fetched yet
  useEffect(() => {
    for (const tab of tabs) {
      if (tab.loading && !tab.data && !loadingRef.current.has(tab.id)) {
        loadingRef.current.add(tab.id)
        const tabId = tab.id
        const filePath = tab.filePath

        ;(async () => {
          try {
            const content = await headFile(filePath, 500)
            const delimiter = detectDelimiter(content)
            const { headers, rows } = parseTabularData(content, delimiter)
            setTabData(tabId, { headers, rows, delimiter })
          } catch (err) {
            console.error('Failed to load file:', err)
            useDataPreviewStore.getState().setTabData(tabId, { headers: [], rows: [], delimiter: '\t' })
          } finally {
            loadingRef.current.delete(tabId)
          }
        })()
      }
    }
  }, [tabs, setTabData])

  if (tabs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-muted">
        <Table2 size={32} strokeWidth={1.5} />
        <span className="text-sm">Double-click a tabular file to preview</span>
      </div>
    )
  }

  const activeTab = tabs.find((t) => t.id === activeTabId)

  return (
    <div className="flex flex-col h-full">
      <Tabs
        tabs={tabs.map((t) => ({
          id: t.id,
          label: t.fileName,
          closable: true,
        }))}
        activeId={activeTabId ?? tabs[0].id}
        onSelect={setActiveTab}
        onClose={closeTab}
      />

      <div className="flex-1 min-h-0">
        {activeTab?.loading && (
          <div className="flex items-center justify-center h-full text-text-muted">
            <Loader2 size={20} className="animate-spin" />
          </div>
        )}

        {activeTab && !activeTab.loading && activeTab.data && activeTab.data.headers.length > 0 && (
          <DataTable filePath={activeTab.filePath} headers={activeTab.data.headers} rows={activeTab.data.rows} />
        )}

        {activeTab && !activeTab.loading && (!activeTab.data || activeTab.data.headers.length === 0) && (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">
            Failed to load file data
          </div>
        )}
      </div>
    </div>
  )
}
