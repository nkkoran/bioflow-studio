import { useMemo, useState } from 'react'
import { Copy, ExternalLink, Eye, FilePlus2, FileText, FolderOpen, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useRunStore } from '@/stores/runStore'
import { LOCAL_CONNECTION_ID, useConnectionStore } from '@/stores/connectionStore'
import { useFileStore } from '@/stores/fileStore'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import { useDialogStore } from '@/stores/dialogStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { usePipelineStore } from '@/stores/pipelineStore'
import { classifyPreview } from '@/lib/filePreviewClassifier'
import { pathBasename, pathDirname } from '@/lib/remotePath'
import { buildRunManifest, renderRunManifestHtml, renderRunManifestMarkdown } from '@/lib/runManifest'
import { RunReportModal } from '@/components/pipeline/RunReportModal'
import type { RunManifest } from '@/types/workspace'
import { inferFileType } from '@/lib/fileTypeInference'
import type { FileOrigin } from '@/constants/connections'

export function ResultsPanel() {
  const runs = useRunStore((s) => s.runs)
  const activeRunId = useRunStore((s) => s.activeRunId)
  const refreshRuns = useRunStore((s) => s.refreshRuns)
  const setActiveConnection = useConnectionStore((s) => s.setActiveConnection)
  const navigate = useFileStore((s) => s.navigate)
  const openFile = useDataPreviewStore((s) => s.openFile)
  const alertDialog = useDialogStore((s) => s.alert)
  const confirmDialog = useDialogStore((s) => s.confirm)
  const addFileNode = usePipelineStore((s) => s.addFileNode)
  const loadSnapshot = usePipelineStore((s) => s.loadSnapshot)
  const dirty = usePipelineStore((s) => s.dirty)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const [exporting, setExporting] = useState(false)
  const [reporting, setReporting] = useState(false)
  const [reportPreview, setReportPreview] = useState<RunManifest | null>(null)

  const activeRun = activeRunId ? runs[activeRunId] : null
  const workspace = activeWorkspaceId ? workspaces.find((row) => row.id === activeWorkspaceId) ?? null : null

  const results = useMemo(() => {
    if (!activeRun) return []
    const resultCards = buildRunManifest(activeRun, activeRun.snapshot, activeRun.workspace ?? workspace).resultCards ?? []
    const snapshotNodes = activeRun.snapshot?.nodes ?? []
    const snapshotEdges = activeRun.snapshot?.edges ?? []
    return Object.entries(activeRun.nodes)
      .filter(([, node]) => (node.outputPaths?.length ?? 0) > 0)
      .map(([nodeId, node]) => {
        const pipelineNode = snapshotNodes.find((candidate) => candidate.id === nodeId)
        const downstreamConsumers = snapshotEdges.filter((edge) => {
          if (edge.source !== nodeId) return false
          const targetNode = snapshotNodes.find((candidate) => candidate.id === edge.target)
          return targetNode?.type === 'tool' || targetNode?.type === 'merge' || targetNode?.type === 'transform' || targetNode?.type === 'transfer'
        })
        const card = resultCards.find((candidate) => candidate.nodeId === nodeId)
        return {
          nodeId,
          label: String(pipelineNode?.data?.label ?? nodeId),
          status: node.status ?? 'idle',
          primary: card?.primary ?? downstreamConsumers.length === 0,
          origin: resultOrigin(pipelineNode, activeRun.connectionId),
          card,
          paths: node.outputPaths ?? [],
        }
      })
      .sort((a, b) => Number(b.primary) - Number(a.primary) || a.label.localeCompare(b.label))
  }, [activeRun, workspace])

  const exportManifest = async () => {
    if (!activeRun) return
    setExporting(true)
    try {
      const folder = await window.api.dialog.openDirectory()
      if (!folder) return
      const manifest = buildRunManifest(activeRun, activeRun.snapshot, activeRun.workspace ?? workspace)
      const safeName = (activeRun.pipelineName || activeRun.runId).replace(/[^A-Za-z0-9._-]+/g, '_')
      const jsonFile = `${folder}/${safeName}.bioflow-manifest.json`
      const mdFile = `${folder}/${safeName}.bioflow-dossier.md`
      const htmlFile = `${folder}/${safeName}.bioflow-dossier.html`
      await window.api.local.write(jsonFile, JSON.stringify(manifest, null, 2))
      await window.api.local.write(mdFile, renderRunManifestMarkdown(manifest))
      await window.api.local.write(htmlFile, renderRunManifestHtml(manifest))
      await alertDialog({
        title: 'Dossier exported',
        message: 'BioFlow wrote JSON, Markdown, and HTML dossiers for this run.',
        detail: htmlFile,
      })
    } finally {
      setExporting(false)
    }
  }

  const openReport = async () => {
    if (!activeRun) return
    setReporting(true)
    try {
      const scripts = activeRun.snapshot
        ? await window.api.pipeline.generateScriptsDry(activeRun.connectionId, activeRun.snapshot, activeRun.workDir).catch(() => [])
        : []
      setReportPreview(buildRunManifest(activeRun, activeRun.snapshot, activeRun.workspace ?? workspace, { scripts }))
    } finally {
      setReporting(false)
    }
  }

  const restoreRunSnapshot = async () => {
    if (!activeRun?.snapshot) return
    if (dirty) {
      const ok = await confirmDialog({
        title: 'Restore run pipeline',
        message: 'Replace the current canvas with the exact pipeline snapshot captured for this run?',
        detail: 'Unsaved canvas changes will be discarded. The run itself is not modified.',
        confirmLabel: 'Restore snapshot',
        cancelLabel: 'Keep current',
      })
      if (!ok) return
    }
    loadSnapshot(activeRun.snapshot)
    window.dispatchEvent(new CustomEvent('bioflow:toast', { detail: { kind: 'success', message: 'Restored run pipeline snapshot' } }))
  }

  const addOutputToCanvas = (path: string, index: number, origin: FileOrigin, artifact?: NonNullable<RunManifest['resultCards']>[number]['artifacts'][number]) => {
    if (!activeRun) return
    addFileNode(
      { x: 140 + (index % 5) * 34, y: 140 + (index % 5) * 34 },
      {
        isInput: true,
        label: pathBasename(path) || 'Run output',
        path,
        fileType: inferFileType(path) as any,
        origin,
        source: origin === 'local' ? 'local' : 'remote',
        artifactRef: artifact ?? {
          origin,
          path,
          fileType: inferFileType(path) as any,
        },
      },
    )
    window.dispatchEvent(new CustomEvent('bioflow:toast', { detail: { kind: 'success', message: 'Added output as an input node' } }))
  }

  const copyPath = async (path: string) => {
    await navigator.clipboard.writeText(path)
    window.dispatchEvent(new CustomEvent('bioflow:toast', { detail: { kind: 'success', message: 'Copied path' } }))
  }

  if (!activeRun) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-muted">
        Select a run to browse its results.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col min-h-0">
      <div className="flex items-center gap-2 border-b border-border-light px-3 py-2">
        <div>
          <div className="text-xs font-medium text-text-primary">Results Explorer</div>
          <div className="text-[10px] text-text-muted">
            {activeRun.pipelineName || activeRun.runId} · {results.length} producing step{results.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" icon={<RefreshCw size={12} />} onClick={() => void refreshRuns()} className="h-6 text-xs">
          Refresh
        </Button>
        {activeRun.snapshot && (
          <Button variant="ghost" size="sm" icon={<RotateCcw size={12} />} onClick={() => void restoreRunSnapshot()} className="h-6 text-xs" title="Restore the exact pipeline snapshot captured for this run">
            Restore pipeline
          </Button>
        )}
        <Button variant="secondary" size="sm" icon={<FileText size={12} />} onClick={() => void exportManifest()} disabled={exporting} className="h-6 text-xs">
          {exporting ? 'Exporting...' : 'Export manifest'}
        </Button>
        <Button variant="primary" size="sm" icon={<FileText size={12} />} onClick={() => void openReport()} disabled={reporting} className="h-6 text-xs">
          {reporting ? 'Building...' : 'Report'}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {results.length === 0 ? (
          <div className="rounded-lg border border-border bg-bg-tertiary/30 px-4 py-6 text-center text-sm text-text-muted">
            This run has not recorded any output files yet.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {results.map((entry) => (
              <div key={entry.nodeId} className="rounded-lg border border-border bg-bg-secondary/70">
                <div className="flex items-center gap-2 border-b border-border-light px-3 py-2">
                  <div className="text-sm font-medium text-text-primary">{entry.label}</div>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${
                    entry.primary ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'
                  }`}>
                    {entry.primary ? 'Primary' : 'Intermediate'}
                  </span>
                  {entry.card && (
                    <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] text-accent">
                      {resultKindLabel(entry.card.kind)}
                    </span>
                  )}
                  <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-muted">
                    {entry.status}
                  </span>
                </div>
                <div className="flex flex-col">
                  {entry.paths.map((path, pathIndex) => (
                    <div key={path} className="flex items-center gap-2 border-t border-border-light/60 px-3 py-2 first:border-t-0">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs text-text-primary">{pathBasename(path) || path}</div>
                        <div className="truncate text-[10px] text-text-muted">{path}</div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<FilePlus2 size={12} />}
                        className="h-6 text-xs"
                        onClick={() => addOutputToCanvas(path, pathIndex, entry.origin, entry.card?.artifacts[pathIndex])}
                        title="Add this result as a new input node on the canvas"
                      >
                        Reuse
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Copy size={12} />}
                        className="h-6 text-xs"
                        onClick={() => void copyPath(path)}
                        title="Copy output path"
                      >
                        Copy
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Eye size={12} />}
                        className="h-6 text-xs"
                        onClick={() => {
                          setActiveConnection(activeRun.connectionId)
                          openFile(path, pathBasename(path), classifyPreview(path))
                        }}
                      >
                        Preview
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<FolderOpen size={12} />}
                        className="h-6 text-xs"
                        onClick={() => {
                          setActiveConnection(activeRun.connectionId)
                          void navigate(pathDirname(path))
                        }}
                      >
                        Folder
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<ExternalLink size={12} />}
                        className="h-6 text-xs"
                        onClick={() => {
                          setActiveConnection(activeRun.connectionId)
                          void navigate(activeRun.workDir)
                        }}
                      >
                        Run folder
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {reportPreview && (
        <RunReportModal report={reportPreview} onClose={() => setReportPreview(null)} />
      )}
    </div>
  )
}

function resultKindLabel(kind: NonNullable<RunManifest['resultCards']>[number]['kind']): string {
  if (kind === 'gwas-summary') return 'GWAS'
  if (kind === 'prs-profile') return 'PRS/Profile'
  if (kind === 'variant-annotation') return 'Annotation'
  if (kind === 'multiqc-report') return 'MultiQC'
  if (kind === 'log') return 'Log'
  if (kind === 'tabular') return 'Table'
  return 'Result'
}

function resultOrigin(
  node: { type?: string; data?: Record<string, unknown> } | undefined,
  connectionId: string,
): FileOrigin {
  if (node?.type === 'tool' && node.data?.backend === 'dnx') return 'dnx'
  if (node?.type === 'transfer' && node.data?.to === 'dnx') return 'dnx'
  if (node?.type === 'file' && node.data?.origin === 'dnx') return 'dnx'
  return connectionId === LOCAL_CONNECTION_ID ? 'local' : 'ssh'
}
