import { useEffect, useRef, useState } from 'react'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import { usePipelineStore } from '@/stores/pipelineStore'
import { LOCAL_CONNECTION_ID, useConnectionStore } from '@/stores/connectionStore'
import type { DelimiterOverride } from '@/stores/dataPreviewStore'
import { headPreviewFile, readFileBase64, statFile } from '@/stores/fileStore'
import { MAX_PREVIEW_BYTES } from '@/lib/filePreviewClassifier'
import { Tabs } from '@/components/ui/Tabs'
import { DataTable } from './DataTable'
import { RawTextView } from './RawTextView'
import { SavedViewsMenu } from './SavedViewsMenu'
import { detectDelimiter, parseTabularData, type Delimiter } from './DelimiterDetector'
import { Table2, Loader2, AlertCircle, Clipboard, ClipboardCheck, ClipboardPaste } from 'lucide-react'
import { joinRemotePath, pathBasename, pathDirname } from '@/lib/remotePath'
import { useDialogStore } from '@/stores/dialogStore'
import { exportBugReport } from '@/lib/bugReport'

export function DataPreview() {
  const {
    tabs,
    activeTabId,
    filters,
    delimiterOverride,
    savedViews,
    activeSavedViewId,
    savedViewsLoaded,
    setActiveTab,
    closeTab,
    setTabData,
    setDelimiterOverride,
    loadSavedViews,
    saveView,
    applySavedView,
    resetFreshView,
    updateSavedView,
    renameSavedView,
    deleteSavedView,
    openText,
  } = useDataPreviewStore()
  const addTransformNode = usePipelineStore((s) => s.addTransformNode)
  const addFileNode = usePipelineStore((s) => s.addFileNode)
  const onConnect = usePipelineStore((s) => s.onConnect)
  const nodes = usePipelineStore((s) => s.nodes)
  const loadingRef = useRef(new Set<string>())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({})
  const [copyMessage, setCopyMessage] = useState<string | null>(null)
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const alertDialog = useDialogStore((s) => s.alert)
  const promptDialog = useDialogStore((s) => s.prompt)
  const confirmDialog = useDialogStore((s) => s.confirm)

  useEffect(() => {
    if (!savedViewsLoaded) void loadSavedViews()
  }, [loadSavedViews, savedViewsLoaded])

  useEffect(() => {
    for (const tab of tabs) {
      if (tab.loading && !tab.data && !loadingRef.current.has(tab.id)) {
        loadingRef.current.add(tab.id)
        const tabId = tab.id
        const filePath = tab.filePath

        ;(async () => {
          try {
            const stat = await statFile(filePath)
            if (tab.mode === 'image' || tab.mode === 'pdf') {
              if (stat.size > MAX_PREVIEW_BYTES) {
                setErrors((prev) => ({
                  ...prev,
                  [tabId]: `This ${tab.mode.toUpperCase()} is ${(stat.size / 1_000_000).toFixed(1)} MB and is too large to embed.`,
                }))
                setTabData(tabId, { headers: [], rows: [], delimiter: '\t', rawText: '' })
                return
              }
              const base64 = await readFileBase64(filePath, MAX_PREVIEW_BYTES)
              const mime = tab.mode === 'pdf' ? 'application/pdf' : mimeForImage(filePath)
              setMediaUrls((prev) => ({ ...prev, [tabId]: `data:${mime};base64,${base64}` }))
              setErrors((prev) => {
                const { [tabId]: _, ...rest } = prev
                return rest
              })
              setTabData(tabId, { headers: [], rows: [], delimiter: '\t', rawText: '' })
              return
            }

            const content = await headPreviewFile(filePath, 500)
            const truncated = stat.size > MAX_PREVIEW_BYTES
            if (content.length === 0) {
              setErrors((prev) => ({ ...prev, [tabId]: 'File is empty.' }))
              setTabData(tabId, { headers: [], rows: [], delimiter: '\t', rawText: '' })
              return
            }
            // Crude binary-file guard: a run of null bytes or >5% non-printable chars
            // usually means we opened something that isn't actually text.
            const sample = content.slice(0, 4096)
            const nonPrintable = sample.replace(/[\x20-\x7E\t\n\r]/g, '').length
            if (sample.includes('\u0000') || nonPrintable / sample.length > 0.05) {
              setErrors((prev) => ({
                ...prev,
                [tabId]: 'File appears to be binary and cannot be previewed as text.',
              }))
              setTabData(tabId, { headers: [], rows: [], delimiter: '\t', rawText: '' })
              return
            }
            if (tab.mode === 'text' || tab.mode === 'binary') {
              setErrors((prev) => {
                if (!truncated) {
                  const { [tabId]: _, ...rest } = prev
                  return rest
                }
                return {
                  ...prev,
                  [tabId]: `Showing the first 500 rows from a ${(stat.size / 1_000_000).toFixed(1)} MB file.`,
                }
              })
              setTabData(tabId, { headers: [], rows: [], delimiter: '\t', rawText: content })
              return
            }
            let delimiter: Delimiter = '\t'
            let headers: string[] = []
            let rows: string[][] = []
            try {
              const override = useDataPreviewStore.getState().delimiterOverride[filePath] ?? 'auto'
              delimiter = override === 'auto' ? detectDelimiter(content) : override
              ;({ headers, rows } = parseTabularData(content, delimiter))
            } catch (err) {
              console.warn('[DataPreview] tabular parse failed; falling back to raw text:', err)
              setErrors((prev) => ({
                ...prev,
                [tabId]: 'Could not parse as a table. Showing raw text.',
              }))
              setTabData(tabId, { headers: [], rows: [], delimiter: '\t', rawText: content })
              return
            }
            setErrors((prev) => {
              if (!truncated) {
                const { [tabId]: _, ...rest } = prev
                return rest
              }
              return {
                ...prev,
                [tabId]: `Showing the first 500 rows from a ${(stat.size / 1_000_000).toFixed(1)} MB file.`,
              }
            })
            setTabData(tabId, { headers, rows, delimiter, rawText: content })
          } catch (err: any) {
            const message = err?.message ?? String(err)
            setErrors((prev) => ({ ...prev, [tabId]: `Failed to load: ${message}` }))
            useDataPreviewStore.getState().setTabData(tabId, { headers: [], rows: [], delimiter: '\t', rawText: '' })
          } finally {
            loadingRef.current.delete(tabId)
          }
        })()
      }
    }
  }, [tabs, setTabData])

  const pasteRawText = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) {
        await alertDialog({ title: 'Clipboard is empty', message: 'No text was available to paste into the preview pane.' })
        return
      }
      openText('Pasted text', text)
    } catch (err: any) {
      await alertDialog({ title: 'Could not read clipboard', message: err?.message ?? String(err) })
    }
  }

  const copyRawText = async (text: string) => {
    await navigator.clipboard.writeText(text)
    setCopyMessage('Copied')
    window.setTimeout(() => setCopyMessage(null), 1600)
  }

  if (tabs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-muted">
        <Table2 size={32} strokeWidth={1.5} />
        <span className="text-sm">Double-click a file to preview</span>
        <button
          type="button"
          onClick={() => void pasteRawText()}
          className="inline-flex h-7 items-center gap-1 rounded border border-border bg-bg-secondary px-2 text-[11px] text-text-secondary hover:text-text-primary"
          title="Paste clipboard text into a raw preview tab"
        >
          <ClipboardPaste size={13} />
          Paste text
        </button>
      </div>
    )
  }

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activeViews = activeTab ? (savedViews[activeTab.filePath] ?? []) : []
  const selectedSavedViewId = activeTab ? activeSavedViewId[activeTab.filePath] : undefined
  const activeFilters = activeTab ? (filters[activeTab.filePath] ?? []) : []

  const addFilteredToPipeline = () => {
    if (!activeTab || activeFilters.length === 0) return
    const offset = nodes.length * 16
    const inputId = addFileNode(
      { x: 120 + offset, y: 120 + offset },
      {
        isInput: true,
        label: pathBasename(activeTab.filePath) || 'Input file',
        path: activeTab.filePath,
        fileType: 'tsv',
      },
    )
    const transformId = addTransformNode(
      { x: 360 + offset, y: 120 + offset },
      {
        label: `${pathBasename(activeTab.filePath)} filtered`,
        fileType: 'tsv',
        filters: activeFilters,
      },
    )
    const outputFilename = `${pathBasename(activeTab.filePath).replace(/(\.[^.]+)?$/, '')}.filtered.tsv`
    const outputId = addFileNode(
      { x: 620 + offset, y: 120 + offset },
      {
        isInput: false,
        label: `${pathBasename(activeTab.filePath)} filtered`,
        path: joinRemotePath(pathDirname(activeTab.filePath), outputFilename),
        outputFilename,
        outputDir: pathDirname(activeTab.filePath),
        fileType: 'tsv',
      },
    )
    onConnect({ source: inputId, sourceHandle: 'output', target: transformId, targetHandle: 'input' })
    onConnect({ source: transformId, sourceHandle: 'output', target: outputId, targetHandle: 'input' })
  }

  const exportFilteredFile = async (filteredRows: string[][]) => {
    if (!activeTab || !activeConnectionId) return
    const outputFilename = `${pathBasename(activeTab.filePath).replace(/(\.[^.]+)?$/, '')}.filtered.tsv`
    const outputPath = joinRemotePath(pathDirname(activeTab.filePath), outputFilename)
    const content = [
      activeTab.data?.headers.join('\t') ?? '',
      ...filteredRows.map((row) => row.join('\t')),
    ].join('\n')
    if (activeConnectionId === LOCAL_CONNECTION_ID) {
      await window.api.local.write(outputPath, content)
    } else {
      await window.api.sftp.write(activeConnectionId, outputPath, content)
    }
    await alertDialog({
      title: 'Filtered file saved',
      message: 'BioFlow wrote the filtered preview output.',
      detail: outputPath,
    })
  }

  return (
    <div className="flex flex-col h-full">
      <Tabs
        tabs={tabs.map((t) => ({
          id: t.id,
          label: t.fileName,
          badge: (filters[t.filePath]?.length ?? 0) > 0,
          closable: true,
        }))}
        activeId={activeTabId ?? tabs[0].id}
        onSelect={setActiveTab}
        onClose={closeTab}
      />

      {activeTab && !activeTab.loading && activeTab.data?.rawText !== undefined && (
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
          <button
            className={`rounded border px-2 py-0.5 text-[11px] ${
              activeTab.mode === 'text'
                ? 'border-accent bg-accent/10 text-text-primary'
                : 'border-border text-text-muted hover:text-text-primary'
            }`}
            onClick={() => useDataPreviewStore.getState().openFile(activeTab.filePath, activeTab.fileName, 'text')}
          >
            Raw text
          </button>
          <button
            className={`rounded border px-2 py-0.5 text-[11px] ${
              activeTab.mode === 'tabular'
                ? 'border-accent bg-accent/10 text-text-primary'
                : 'border-border text-text-muted hover:text-text-primary'
            }`}
            onClick={() => useDataPreviewStore.getState().openFile(activeTab.filePath, activeTab.fileName, 'tabular')}
          >
            Table
          </button>
          {activeTab.mode === 'tabular' && (
            <>
              <label className="ml-1 flex items-center gap-1 text-[11px] text-text-muted">
                Delimiter
                <select
                  value={delimiterOverride[activeTab.filePath] ?? 'auto'}
                  onChange={(e) => setDelimiterOverride(activeTab.filePath, e.target.value as DelimiterOverride)}
                  className="h-6 rounded border border-border bg-bg-primary px-1.5 text-[11px] text-text-primary outline-none focus:ring-1 focus:ring-accent"
                  title="Override the delimiter used to parse this file"
                >
                  <option value="auto">Auto</option>
                  <option value={'\t'}>Tab</option>
                  <option value=",">Comma</option>
                  <option value=" ">Space</option>
                  <option value=";">Semicolon</option>
                  <option value="|">Pipe</option>
                </select>
              </label>
              <SavedViewsMenu
                views={activeViews}
                activeViewId={selectedSavedViewId}
                onApply={(viewId) => {
                  if (viewId) applySavedView(activeTab.filePath, viewId)
                  else resetFreshView(activeTab.filePath)
                }}
                onSave={() => {
                  void promptDialog({
                    title: 'Save preview view',
                    message: 'Name this saved preview configuration.',
                    placeholder: 'QC subset',
                    confirmLabel: 'Save view',
                  }).then((name) => {
                    if (name) void saveView(activeTab.filePath, name)
                  })
                }}
                onUpdate={() => {
                  if (selectedSavedViewId) void updateSavedView(activeTab.filePath, selectedSavedViewId)
                }}
                onRename={() => {
                  if (!selectedSavedViewId) return
                  const current = activeViews.find((view) => view.id === selectedSavedViewId)
                  void promptDialog({
                    title: 'Rename preview view',
                    message: 'Choose a new name for this saved preview configuration.',
                    defaultValue: current?.name ?? '',
                    confirmLabel: 'Rename',
                  }).then((name) => {
                    if (name) void renameSavedView(activeTab.filePath, selectedSavedViewId, name)
                  })
                }}
                onDelete={() => {
                  if (!selectedSavedViewId) return
                  void confirmDialog({
                    title: 'Delete saved preview view',
                    message: 'Delete this saved preview view?',
                    confirmLabel: 'Delete view',
                    cancelLabel: 'Keep',
                    danger: true,
                  }).then((confirmed) => {
                    if (confirmed) void deleteSavedView(activeTab.filePath, selectedSavedViewId)
                  })
                }}
              />
            </>
          )}
          {errors[activeTab.id] && (
            <span className="truncate text-[11px] text-warning">{errors[activeTab.id]}</span>
          )}
          {activeTab.data?.rawText !== undefined && activeTab.data.rawText.length > 0 && (
            <button
              type="button"
              className="ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded border border-border bg-bg-tertiary px-2 text-[11px] text-text-muted hover:text-text-primary"
              title="Copy the raw preview text to the clipboard"
              onClick={() => void copyRawText(activeTab.data?.rawText ?? '')}
            >
              {copyMessage ? <ClipboardCheck size={13} className="text-success" /> : <Clipboard size={13} />}
              {copyMessage ?? 'Copy all'}
            </button>
          )}
          <button
            type="button"
            className={`${activeTab.data?.rawText !== undefined && activeTab.data.rawText.length > 0 ? '' : 'ml-auto'} shrink-0 text-[11px] text-text-muted hover:text-accent`}
            title="Save a bug report with the current file state and app context"
            onClick={() => void exportBugReport({
              title: 'data-preview-issue',
              reason: errors[activeTab.id] ?? 'Data preview issue reported by user',
              extra: {
                filePath: activeTab.filePath,
                detectedDelimiter: activeTab.data?.delimiter,
                headers: activeTab.data?.headers,
                rowCount: activeTab.data?.rows.length,
                errorMessage: errors[activeTab.id] ?? null,
              },
            })}
          >
            Report issue
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {activeTab?.loading && (
          <div className="flex items-center justify-center h-full text-text-muted">
            <Loader2 size={20} className="animate-spin" />
          </div>
        )}

        {activeTab && !activeTab.loading && activeTab.data && activeTab.mode === 'tabular' && activeTab.data.headers.length > 0 && (
          <DataTable
            filePath={activeTab.filePath}
            headers={activeTab.data.headers}
            rows={activeTab.data.rows}
            onAddFilteredToPipeline={addFilteredToPipeline}
            onExportFilteredFile={(nextRows) => void exportFilteredFile(nextRows)}
          />
        )}

        {activeTab && !activeTab.loading && activeTab.mode === 'image' && mediaUrls[activeTab.id] && (
          <div className="flex h-full items-center justify-center bg-bg-primary p-4">
            <img src={mediaUrls[activeTab.id]} alt={activeTab.fileName} className="max-h-full max-w-full object-contain" />
          </div>
        )}

        {activeTab && !activeTab.loading && activeTab.mode === 'pdf' && mediaUrls[activeTab.id] && (
          <iframe title={activeTab.fileName} src={mediaUrls[activeTab.id]} className="h-full w-full border-0 bg-bg-primary" />
        )}

        {activeTab && !activeTab.loading && activeTab.data?.rawText !== undefined && activeTab.mode !== 'image' && activeTab.mode !== 'pdf' && (activeTab.mode !== 'tabular' || activeTab.data.headers.length === 0) && activeTab.data.rawText.length > 0 && (
          <RawTextView text={activeTab.data.rawText} />
        )}

        {activeTab && !activeTab.loading && activeTab.mode !== 'image' && activeTab.mode !== 'pdf' && (!activeTab.data || (activeTab.data.headers.length === 0 && !activeTab.data.rawText)) && (
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

function mimeForImage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'jpg') return 'image/jpeg'
  if (ext === 'svg') return 'image/svg+xml'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/png'
}
