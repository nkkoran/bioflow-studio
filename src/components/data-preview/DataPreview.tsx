import { useEffect, useRef, useState } from 'react'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import { headFile } from '@/stores/fileStore'
import { Tabs } from '@/components/ui/Tabs'
import { DataTable } from './DataTable'
import { detectDelimiter, parseTabularData } from './DelimiterDetector'
import { Table2, Loader2, AlertCircle } from 'lucide-react'

export function DataPreview() {
  const { tabs, activeTabId, setActiveTab, closeTab, setTabData } = useDataPreviewStore()
  const loadingRef = useRef(new Set<string>())
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    for (const tab of tabs) {
      if (tab.loading && !tab.data && !loadingRef.current.has(tab.id)) {
        loadingRef.current.add(tab.id)
        const tabId = tab.id
        const filePath = tab.filePath

        ;(async () => {
          try {
            const content = await headFile(filePath, 500)
            if (content.length === 0) {
              setErrors((prev) => ({ ...prev, [tabId]: 'File is empty.' }))
              setTabData(tabId, { headers: [], rows: [], delimiter: '\t' })
              return
            }
            // Crude binary-file guard: a run of null bytes or >5% non-printable chars
            // usually means we opened something that isn't actually text.
            const sample = content.slice(0, 4096)
            const nonPrintable = sample.replace(/[\x20-\x7E\t\n\r]/g, '').length
            if (sample.includes('\u0000') || nonPrintable / sample.length > 0.05) {
              setErrors((prev) => ({
                ...prev,
                [tabId]: 'File appears to be binary and cannot be previewed as tabular data.',
              }))
              setTabData(tabId, { headers: [], rows: [], delimiter: '\t' })
              return
            }
            const delimiter = detectDelimiter(content)
            const { headers, rows } = parseTabularData(content, delimiter)
            setErrors((prev) => {
              const { [tabId]: _, ...rest } = prev
              return rest
            })
            setTabData(tabId, { headers, rows, delimiter })
          } catch (err: any) {
            const message = err?.message ?? String(err)
            setErrors((prev) => ({ ...prev, [tabId]: `Failed to load: ${message}` }))
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
          <div className="flex flex-col items-center justify-center h-full gap-2 text-text-muted text-sm p-6 text-center">
            <AlertCircle size={20} />
            <span>{errors[activeTab.id] ?? 'No rows found in this file.'}</span>
            <span className="text-[11px] text-text-muted/70 font-mono break-all">{activeTab.filePath}</span>
          </div>
        )}
      </div>
    </div>
  )
}
