import packageJson from '../../package.json'
import { validatePipeline } from '@/lib/pipelineValidator'
import { useConnectionStore } from '@/stores/connectionStore'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import { useFileStore } from '@/stores/fileStore'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useRunStore } from '@/stores/runStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWorkflowReadinessStore } from '@/stores/readinessStore'

interface ExportBugReportOptions {
  title: string
  reason: string
  extra?: Record<string, unknown>
}

export async function exportBugReport(options: ExportBugReportOptions): Promise<string | null> {
  const folder = await window.api.dialog.openDirectory()
  if (!folder) return null

  const pipelineStore = usePipelineStore.getState()
  const runStore = useRunStore.getState()
  const previewStore = useDataPreviewStore.getState()
  const connectionStore = useConnectionStore.getState()
  const fileStore = useFileStore.getState()
  const settingsStore = useSettingsStore.getState()
  const readinessStore = useWorkflowReadinessStore.getState()
  const snapshot = pipelineStore.exportSnapshot()
  const selectedNode = pipelineStore.nodes.find((node) => node.id === pipelineStore.selectedNodeId) ?? null
  const validation = validatePipeline(snapshot, {
    schemas: previewStore.schemas,
    annotationDefaults: {
      annovarDbPath: settingsStore.settings.annovarDbPath,
      annovarScriptsPath: settingsStore.settings.annovarScriptsPath,
      vepCachePath: settingsStore.settings.vepCachePath,
      vepPath: settingsStore.settings.vepPath,
    },
  })
  const activeRun = runStore.activeRunId ? runStore.runs[runStore.activeRunId] ?? null : null
  const activeTab = previewStore.activeTabId
    ? previewStore.tabs.find((tab) => tab.id === previewStore.activeTabId) ?? null
    : null

  const payload = {
    title: options.title,
    reason: options.reason,
    createdAt: new Date().toISOString(),
    app: {
      name: packageJson.name,
      version: packageJson.version,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    },
    pipeline: {
      snapshot,
      selectedNodeId: pipelineStore.selectedNodeId,
      selectedNode,
    },
    run: {
      activeRunId: runStore.activeRunId,
      activeRun,
      diagnostics: runStore.diagnostics,
      logs: runStore.logs,
    },
    diagnostics: {
      validation,
      readiness: readinessStore.lastReport,
      extra: options.extra ?? {},
    },
    dataPreview: {
      activeTab,
      tabs: previewStore.tabs,
      filters: previewStore.filters,
      draftFilters: previewStore.draftFilters,
      visibleColumns: previewStore.visibleColumns,
      delimiterOverride: previewStore.delimiterOverride,
      savedViews: previewStore.savedViews,
      schemas: previewStore.schemas,
    },
    fileBrowser: {
      cwd: fileStore.cwd,
      selectedPaths: fileStore.selectedPaths,
      error: fileStore.error,
    },
    connection: {
      activeConnectionId: connectionStore.activeConnectionId,
      connections: redactSecrets(connectionStore.connections),
      loginPolicy: connectionStore.loginPolicy,
    },
    settingsRedacted: redactSecrets(settingsStore.settings),
  }

  const slug = options.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bug-report'
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const reportDir = `${folder}/${timestamp}-${slug}`
  await window.api.local.mkdir(reportDir)
  await window.api.local.write(`${reportDir}/bug-report.json`, JSON.stringify(payload, null, 2))
  if (activeTab?.data?.rawText) {
    await window.api.local.write(`${reportDir}/active-preview.txt`, activeTab.data.rawText)
  }
  if (activeRun && runStore.activeRunId) {
    await window.api.local.write(`${reportDir}/run-summary.txt`, JSON.stringify(activeRun, null, 2))
  }
  return reportDir
}

function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry)) as T
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/(password|passphrase|prompt|secret|totp)/i.test(key)) {
      out[key] = '[redacted]'
      continue
    }
    if (/privatekeypath/i.test(key) && typeof entry === 'string') {
      out[key] = '[redacted-path]'
      continue
    }
    out[key] = redactSecrets(entry)
  }
  return out as T
}
