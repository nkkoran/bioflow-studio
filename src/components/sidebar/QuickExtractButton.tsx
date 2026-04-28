import { useMemo, useRef, useState } from 'react'
import { Sparkles, Plus, Save, Trash2, Upload } from 'lucide-react'

import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { LOCAL_CONNECTION_ID } from '@/constants/connections'
import { SPARK_INSTANCE_TYPES } from '@/lib/dnxInstanceCatalog'
import {
  mergeUkbPresets,
  parseImportedUkbFields,
  quickExtractDisplayName,
  sanitizeUkbFieldRows,
  type UkbFieldRow,
} from '@/lib/ukbFieldPresets'
import { useConnectionStore } from '@/stores/connectionStore'
import { useDialogStore } from '@/stores/dialogStore'
import { useDnxStore } from '@/stores/dnxStore'
import { useRunStore } from '@/stores/runStore'
import { useUIStore } from '@/stores/uiStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import type { PipelineSnapshot, ToolNodeData } from '@/types/pipeline'

function emptyRow(): UkbFieldRow {
  return { fieldId: '', label: '' }
}

export function QuickExtractButton() {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<UkbFieldRow[]>([emptyRow()])
  const [codingValues, setCodingValues] = useState('replace')
  const [outputName, setOutputName] = useState('ukb_extracted_traits.tsv')
  const [outputFolder, setOutputFolder] = useState('/BioFlow/extracts')
  const [instanceType, setInstanceType] = useState('mem1_ssd1_v2_x8')
  const [selectedPresetName, setSelectedPresetName] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const importRef = useRef<HTMLInputElement | null>(null)
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const authStatus = useDnxStore((s) => s.authStatus)
  const defaultProjectId = useDnxStore((s) => s.defaultProjectId)
  const fieldPresets = useDnxStore((s) => s.fieldPresets)
  const saveFieldPresets = useDnxStore((s) => s.saveFieldPresets)
  const appletInstallProgress = useDnxStore((s) => s.appletInstallProgress)
  const promptDialog = useDialogStore((s) => s.prompt)
  const clearLogs = useRunStore((s) => s.clearLogs)
  const refreshRuns = useRunStore((s) => s.refreshRuns)
  const setActiveRun = useRunStore((s) => s.setActiveRun)
  const setSelectedNode = useRunStore((s) => s.setSelectedNode)
  const setBottomPanelMode = useUIStore((s) => s.setBottomPanelMode)
  const instanceCatalog = useDnxStore((s) => s.instanceCatalog)
  const presets = useMemo(() => mergeUkbPresets(fieldPresets), [fieldPresets])

  const reset = () => {
    setRows([emptyRow()])
    setCodingValues('replace')
    setOutputName('ukb_extracted_traits.tsv')
    setOutputFolder('/BioFlow/extracts')
    setInstanceType('mem1_ssd1_v2_x8')
    setSelectedPresetName(null)
    setSubmitting(false)
    setError(null)
  }

  const close = () => {
    setOpen(false)
    reset()
  }

  const savePreset = async () => {
    const name = await promptDialog({
      title: 'Save field preset',
      message: 'Choose a preset name for these UKB fields.',
      defaultValue: 'UKB preset',
      confirmLabel: 'Save preset',
    })
    if (!name?.trim()) return
    await saveFieldPresets([
      ...fieldPresets,
      {
        id: `preset_${Date.now().toString(36)}`,
        name: name.trim(),
        fields: sanitizeUkbFieldRows(rows),
      },
    ])
  }

  const importRows = async (file: File | null) => {
    if (!file) return
    const text = await file.text()
    const parsed = parseImportedUkbFields(text)
    if (parsed.length === 0) return
    setRows(parsed)
    setSelectedPresetName(null)
  }

  const submit = async () => {
    const cleanedRows = sanitizeUkbFieldRows(rows)
    if (authStatus !== 'authenticated') {
      setError('Authenticate to DNAnexus in Settings before running a quick extract.')
      return
    }
    if (!defaultProjectId) {
      setError('Choose a default DNAnexus project in Settings before running a quick extract.')
      return
    }
    if (cleanedRows.length === 0) {
      setError('Add at least one UKB field before launching the extraction.')
      return
    }

    setSubmitting(true)
    setError(null)
    const now = Date.now()
    const snapshot: PipelineSnapshot = {
      version: 1,
      id: `quick_extract_${now.toString(36)}`,
      name: quickExtractDisplayName(selectedPresetName, now),
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          id: 'quick_extract_node',
          type: 'tool',
          position: { x: 0, y: 0 },
          data: {
            toolId: 'ukb.spark-extract',
            label: 'UKB Data Extraction',
            backend: 'dnx',
            dnxInstanceType: instanceType || undefined,
            paramValues: {
              fields: cleanedRows,
              codingValues,
              outputName,
              outputFolder,
            },
            outputDirOverride: outputFolder || undefined,
            status: 'idle',
          } satisfies ToolNodeData,
        },
      ],
      edges: [],
    }

    const workspaceStore = useWorkspaceStore.getState()
    const activeWorkspace = workspaceStore.activeWorkspaceId
      ? workspaceStore.workspaces.find((workspace) => workspace.id === workspaceStore.activeWorkspaceId) ?? null
      : null

    try {
      // Build/upload the applet first so the user sees the install progress
      // inside this dialog. Without this prefetch the install happens during
      // pipeline.run and the dialog has already closed by then.
      try {
        await window.api.dnx.ensureApplet({
          projectId: defaultProjectId,
          appletName: 'bioflow-ukb-extract',
        })
      } catch (err) {
        // Non-fatal here — the runner will retry. Surface the message so the
        // user sees what's happening, but proceed.
        setError(`Applet pre-install warning: ${err instanceof Error ? err.message : String(err)}`)
      }

      const { runId } = await window.api.pipeline.run(
        activeConnectionId || LOCAL_CONNECTION_ID,
        snapshot,
        undefined,
        activeWorkspace ? {
          id: activeWorkspace.id,
          name: activeWorkspace.name,
          connectionName: activeWorkspace.connectionName,
          analysisRoot: activeWorkspace.analysisRoot,
          slurmAccount: activeWorkspace.slurmAccount,
          slurmPartition: activeWorkspace.slurmPartition,
          toolsRoot: activeWorkspace.toolsRoot,
          annovarScriptsPath: activeWorkspace.annovarScriptsPath,
          annovarDbPath: activeWorkspace.annovarDbPath,
          vepPath: activeWorkspace.vepPath,
          vepCachePath: activeWorkspace.vepCachePath,
          recommendedTemplateId: activeWorkspace.recommendedTemplateId,
          notes: activeWorkspace.notes,
        } : null,
      )
      clearLogs()
      setActiveRun(runId)
      setSelectedNode(null)
      await refreshRuns()
      setBottomPanelMode('jobs')
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  const instanceOptions = instanceCatalog?.specs?.length ? instanceCatalog.specs : SPARK_INSTANCE_TYPES
  const dnxReady = authStatus === 'authenticated' && Boolean(defaultProjectId)
  const openSettings = useUIStore((s) => s.openSettings)

  if (!dnxReady) {
    // Show a low-key configure CTA instead of nothing — this is the entry
    // point researchers expect, so disappearing entirely is confusing.
    return (
      <button
        type="button"
        onClick={() => openSettings('DNAnexus')}
        className="m-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-lg border border-border bg-bg-tertiary/40 px-3 py-2 text-left transition-colors hover:border-cyan-500/30 hover:bg-cyan-500/5"
        title="Configure a DNAnexus token and project to enable quick extracts."
      >
        <Sparkles size={14} className="shrink-0 text-text-muted" />
        <div className="min-w-0">
          <div className="text-xs font-medium text-text-secondary">Quick UKB Extract</div>
          <div className="truncate text-[10px] text-text-muted">Configure DNAnexus to enable</div>
        </div>
      </button>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="m-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-left transition-colors hover:bg-cyan-500/15"
      >
        <Sparkles size={14} className="shrink-0 text-cyan-300" />
        <div className="min-w-0">
          <div className="text-xs font-medium text-text-primary">Quick UKB Extract</div>
          <div className="truncate text-[10px] text-text-muted">Launch a one-off Spark extraction straight into the Jobs panel</div>
        </div>
      </button>

      <Dialog
        open={open}
        onClose={close}
        title="Quick UKB Extract"
        width="max-w-3xl"
        footer={(
          <>
            <Button variant="secondary" onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={() => void submit()} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Launch extract'}
            </Button>
          </>
        )}
      >
        <div className="flex flex-col gap-4">
          <input
            ref={importRef}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
            className="hidden"
            onChange={(event) => {
              void importRows(event.target.files?.[0] ?? null)
              event.currentTarget.value = ''
            }}
          />

          <div className="grid grid-cols-[1fr_auto_auto] gap-2">
            <select
              defaultValue=""
              onChange={(event) => {
                const preset = presets.find((item) => item.id === event.target.value)
                if (!preset) return
                setRows(preset.fields.map((field) => ({ fieldId: field.fieldId, label: field.label })))
                setSelectedPresetName(preset.name)
                event.currentTarget.value = ''
              }}
              className="h-8 rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            >
              <option value="">Load preset…</option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.name}</option>
              ))}
            </select>
            <Button variant="secondary" size="sm" icon={<Upload size={12} />} onClick={() => importRef.current?.click()}>
              Import
            </Button>
            <Button variant="secondary" size="sm" icon={<Save size={12} />} onClick={() => void savePreset()}>
              Save preset
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            {rows.map((row, index) => (
              <div key={`${index}-${row.fieldId}`} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <Input
                  label={index === 0 ? 'Field ID' : ''}
                  value={row.fieldId}
                  placeholder="p21001_i0"
                  onChange={(event) => {
                    const next = [...rows]
                    next[index] = { ...next[index], fieldId: event.target.value }
                    setRows(next)
                    setSelectedPresetName(null)
                  }}
                />
                <Input
                  label={index === 0 ? 'Rename label (optional)' : ''}
                  value={row.label ?? ''}
                  placeholder="BMI"
                  onChange={(event) => {
                    const next = [...rows]
                    next[index] = { ...next[index], label: event.target.value }
                    setRows(next)
                    setSelectedPresetName(null)
                  }}
                />
                <button
                  type="button"
                  className="mt-auto h-8 w-8 rounded border border-border text-text-muted transition-colors hover:border-error/40 hover:text-error"
                  onClick={() => setRows(rows.filter((_, rowIndex) => rowIndex !== index))}
                  title="Remove field"
                >
                  <Trash2 size={13} className="mx-auto" />
                </button>
              </div>
            ))}
          </div>

          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              icon={<Plus size={12} />}
              onClick={() => {
                setRows([...rows, emptyRow()])
                setSelectedPresetName(null)
              }}
            >
              Add field
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-text-secondary">Coding values</label>
              <select
                value={codingValues}
                onChange={(event) => setCodingValues(event.target.value)}
                className="h-8 w-full rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              >
                <option value="replace">Replace coding values</option>
                <option value="raw">Keep raw coding values</option>
              </select>
            </div>
            <Input label="Output filename" value={outputName} onChange={(event) => setOutputName(event.target.value)} />
            <Input label="DNAnexus output folder" value={outputFolder} onChange={(event) => setOutputFolder(event.target.value)} />
            <div>
              <label className="mb-1 block text-xs font-medium text-text-secondary">Spark instance</label>
              <select
                value={instanceType}
                onChange={(event) => setInstanceType(event.target.value)}
                className="h-8 w-full rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              >
                {instanceOptions.map((spec) => (
                  <option key={spec.id} value={spec.id}>
                    {spec.name} ({spec.cpu} CPU, {spec.memoryGB} GB)
                  </option>
                ))}
              </select>
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-xs text-error">
              {error}
            </div>
          )}

          {submitting && appletInstallProgress && appletInstallProgress.stage !== 'done' && (
            <div className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
              <div className="font-medium capitalize">Applet {appletInstallProgress.stage.replace('-', ' ')}</div>
              {appletInstallProgress.message && (
                <div className="mt-0.5 text-[11px] text-cyan-200">{appletInstallProgress.message}</div>
              )}
              {typeof appletInstallProgress.percent === 'number' && (
                <div className="mt-1 h-1 w-full overflow-hidden rounded bg-cyan-900/40">
                  <div
                    className="h-full bg-cyan-400 transition-all"
                    style={{ width: `${Math.min(100, Math.max(0, appletInstallProgress.percent))}%` }}
                  />
                </div>
              )}
            </div>
          )}

          <p className="text-[11px] text-text-muted">
            Quick Extract submits the same DNAnexus pipeline node through the normal runner, so progress, logs, and outputs land in the Jobs panel like any other run.
          </p>
        </div>
      </Dialog>
    </>
  )
}
