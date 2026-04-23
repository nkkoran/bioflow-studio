import { useMemo, useState } from 'react'
import { ExternalLink, Eye, FileText, FolderOpen, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useRunStore } from '@/stores/runStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { useFileStore } from '@/stores/fileStore'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import { useDialogStore } from '@/stores/dialogStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { classifyPreview } from '@/lib/filePreviewClassifier'
import { pathBasename, pathDirname } from '@/lib/remotePath'
import { buildRunManifest } from '@/lib/runManifest'

export function ResultsPanel() {
  const runs = useRunStore((s) => s.runs)
  const activeRunId = useRunStore((s) => s.activeRunId)
  const refreshRuns = useRunStore((s) => s.refreshRuns)
  const setActiveConnection = useConnectionStore((s) => s.setActiveConnection)
  const navigate = useFileStore((s) => s.navigate)
  const openFile = useDataPreviewStore((s) => s.openFile)
  const alertDialog = useDialogStore((s) => s.alert)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const [exporting, setExporting] = useState(false)

  const activeRun = activeRunId ? runs[activeRunId] : null
  const workspace = activeWorkspaceId ? workspaces.find((row) => row.id === activeWorkspaceId) ?? null : null

  const results = useMemo(() => {
    if (!activeRun) return []
    const snapshotNodes = activeRun.snapshot?.nodes ?? []
    const snapshotEdges = activeRun.snapshot?.edges ?? []
    return Object.entries(activeRun.nodes)
      .filter(([, node]) => (node.outputPaths?.length ?? 0) > 0)
      .map(([nodeId, node]) => {
        const pipelineNode = snapshotNodes.find((candidate) => candidate.id === nodeId)
        const downstreamConsumers = snapshotEdges.filter((edge) => {
          if (edge.source !== nodeId) return false
          const targetNode = snapshotNodes.find((candidate) => candidate.id === edge.target)
          return targetNode?.type === 'tool' || targetNode?.type === 'merge' || targetNode?.type === 'transform'
        })
        return {
          nodeId,
          label: String(pipelineNode?.data?.label ?? nodeId),
          status: node.status ?? 'idle',
          primary: downstreamConsumers.length === 0,
          paths: node.outputPaths ?? [],
        }
      })
      .sort((a, b) => Number(b.primary) - Number(a.primary) || a.label.localeCompare(b.label))
  }, [activeRun])

  const exportManifest = async () => {
    if (!activeRun) return
    setExporting(true)
    try {
      const folder = await window.api.dialog.openDirectory()
      if (!folder) return
      const manifest = buildRunManifest(activeRun, activeRun.snapshot, activeRun.workspace ?? workspace)
      const safeName = (activeRun.pipelineName || activeRun.runId).replace(/[^A-Za-z0-9._-]+/g, '_')
      const filename = `${folder}/${safeName}.bioflow-manifest.json`
      await window.api.local.write(filename, JSON.stringify(manifest, null, 2))
      await alertDialog({
        title: 'Manifest exported',
        message: 'BioFlow wrote a reproducibility manifest for this run.',
        detail: filename,
      })
    } finally {
      setExporting(false)
    }
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
        <Button variant="secondary" size="sm" icon={<FileText size={12} />} onClick={() => void exportManifest()} disabled={exporting} className="h-6 text-xs">
          {exporting ? 'Exporting...' : 'Export manifest'}
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
                  <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-muted">
                    {entry.status}
                  </span>
                </div>
                <div className="flex flex-col">
                  {entry.paths.map((path) => (
                    <div key={path} className="flex items-center gap-2 border-t border-border-light/60 px-3 py-2 first:border-t-0">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs text-text-primary">{pathBasename(path) || path}</div>
                        <div className="truncate text-[10px] text-text-muted">{path}</div>
                      </div>
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
    </div>
  )
}
