import { useEffect, useMemo, useState } from 'react'
import { Briefcase, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { instantiateTemplate, PIPELINE_TEMPLATES } from '@/lib/pipelineTemplates'
import { useDialogStore } from '@/stores/dialogStore'
import { usePipelineStore } from '@/stores/pipelineStore'

interface WorkspaceFormState {
  id?: string
  name: string
  connectionName: string
  analysisRoot: string
  slurmAccount: string
  slurmPartition: string
  toolsRoot: string
  annovarScriptsPath: string
  annovarDbPath: string
  vepPath: string
  vepCachePath: string
  recommendedTemplateId: string
  notes: string
}

const EMPTY_FORM: WorkspaceFormState = {
  name: '',
  connectionName: '',
  analysisRoot: '',
  slurmAccount: '',
  slurmPartition: '',
  toolsRoot: '',
  annovarScriptsPath: '',
  annovarDbPath: '',
  vepPath: '',
  vepCachePath: '',
  recommendedTemplateId: '',
  notes: '',
}

export function WorkspaceSwitcher() {
  const loaded = useWorkspaceStore((s) => s.loaded)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const load = useWorkspaceStore((s) => s.load)
  const saveWorkspace = useWorkspaceStore((s) => s.saveWorkspace)
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const activeConnection = useConnectionStore((s) => s.activeConnectionId ? s.connections[s.activeConnectionId] : null)
  const confirmDialog = useDialogStore((s) => s.confirm)
  const loadSnapshot = usePipelineStore((s) => s.loadSnapshot)
  const dirty = usePipelineStore((s) => s.dirty)

  const [open, setOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [autoOpened, setAutoOpened] = useState(false)
  const [form, setForm] = useState<WorkspaceFormState>(EMPTY_FORM)

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, workspaces],
  )

  useEffect(() => {
    if (!loaded) void load()
  }, [load, loaded])

  useEffect(() => {
    if (loaded && workspaces.length === 0 && !autoOpened) {
      setAutoOpened(true)
      setEditorOpen(true)
      setForm({
        ...EMPTY_FORM,
        connectionName: activeConnection?.config.name ?? '',
      })
    }
  }, [activeConnection?.config.name, autoOpened, loaded, workspaces.length])

  const beginCreate = () => {
    setOpen(false)
    setForm({
      ...EMPTY_FORM,
      connectionName: activeConnection?.config.name ?? '',
    })
    setEditorOpen(true)
  }

  const beginEdit = () => {
    if (!activeWorkspace) return
    setOpen(false)
    setForm({
      id: activeWorkspace.id,
      name: activeWorkspace.name,
      connectionName: activeWorkspace.connectionName ?? '',
      analysisRoot: activeWorkspace.analysisRoot ?? '',
      slurmAccount: activeWorkspace.slurmAccount ?? '',
      slurmPartition: activeWorkspace.slurmPartition ?? '',
      toolsRoot: activeWorkspace.toolsRoot ?? '',
      annovarScriptsPath: activeWorkspace.annovarScriptsPath ?? '',
      annovarDbPath: activeWorkspace.annovarDbPath ?? '',
      vepPath: activeWorkspace.vepPath ?? '',
      vepCachePath: activeWorkspace.vepCachePath ?? '',
      recommendedTemplateId: activeWorkspace.recommendedTemplateId ?? '',
      notes: activeWorkspace.notes ?? '',
    })
    setEditorOpen(true)
  }

  const handleSave = async () => {
    const saved = await saveWorkspace(form)
    await setActiveWorkspace(saved.id)
    if (activeConnectionId) await useWorkspaceStore.getState().applyActiveWorkspace(activeConnectionId)
    setEditorOpen(false)
  }

  const handleDelete = async (workspaceId: string, name: string) => {
    const confirmed = await confirmDialog({
      title: 'Delete workspace',
      message: `Remove "${name}" from this machine?`,
      detail: 'This does not delete cluster files. It only removes the saved BioFlow workspace profile.',
      confirmLabel: 'Delete workspace',
      cancelLabel: 'Keep',
      danger: true,
    })
    if (!confirmed) return
    await deleteWorkspace(workspaceId)
    setOpen(false)
  }

  const loadRecommendedTemplate = async (workspace = activeWorkspace) => {
    if (!workspace?.recommendedTemplateId) return
    const template = PIPELINE_TEMPLATES.find((candidate) => candidate.id === workspace.recommendedTemplateId)
    if (!template) return
    if (dirty) {
      const confirmed = await confirmDialog({
        title: 'Load recommended template',
        message: `Discard unsaved changes and load "${template.name}" for this workspace?`,
        confirmLabel: 'Load template',
        cancelLabel: 'Keep current',
      })
      if (!confirmed) return
    }
    loadSnapshot(instantiateTemplate(template))
    setOpen(false)
  }

  return (
    <>
      <div className="relative" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          onClick={() => setOpen((value) => !value)}
          className="flex max-w-[240px] items-center gap-1 rounded px-2 py-1 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          title={activeWorkspace?.name ?? 'Set up a workspace'}
        >
          <Briefcase size={13} className="shrink-0" />
          <span className="truncate">{activeWorkspace?.name ?? 'Set up workspace'}</span>
          <ChevronDown size={12} className="shrink-0 text-text-muted" />
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div className="absolute left-0 top-full z-50 mt-1 w-80 rounded border border-border bg-bg-secondary py-1 shadow-xl">
              {workspaces.length > 0 ? (
                workspaces.map((workspace) => (
                  <div key={workspace.id} className="flex items-center hover:bg-bg-hover">
                    <button
                      onClick={() => {
                        void setActiveWorkspace(workspace.id)
                        setOpen(false)
                      }}
                      className="flex min-w-0 flex-1 flex-col items-start px-3 py-2 text-left"
                    >
                      <div className="flex w-full items-center gap-2">
                        <span className="truncate text-xs text-text-primary">{workspace.name}</span>
                        {workspace.id === activeWorkspaceId && (
                          <span className="text-[10px] text-accent">current</span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-[10px] text-text-muted">
                        {workspace.connectionName || 'Any connection'}
                        {workspace.analysisRoot ? ` · ${workspace.analysisRoot}` : ''}
                      </div>
                    </button>
                    <button
                      onClick={() => {
                        setForm({
                          id: workspace.id,
                          name: workspace.name,
                          connectionName: workspace.connectionName ?? '',
                          analysisRoot: workspace.analysisRoot ?? '',
                          slurmAccount: workspace.slurmAccount ?? '',
                          slurmPartition: workspace.slurmPartition ?? '',
                          toolsRoot: workspace.toolsRoot ?? '',
                          annovarScriptsPath: workspace.annovarScriptsPath ?? '',
                          annovarDbPath: workspace.annovarDbPath ?? '',
                          vepPath: workspace.vepPath ?? '',
                          vepCachePath: workspace.vepCachePath ?? '',
                          recommendedTemplateId: workspace.recommendedTemplateId ?? '',
                          notes: workspace.notes ?? '',
                        })
                        setOpen(false)
                        setEditorOpen(true)
                      }}
                      className="rounded p-1 text-text-muted hover:text-text-primary"
                      title={`Edit ${workspace.name}`}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      onClick={() => void handleDelete(workspace.id, workspace.name)}
                      className="mr-1 rounded p-1 text-text-muted hover:text-error"
                      title={`Delete ${workspace.name}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))
              ) : (
                <div className="px-3 py-2 text-xs text-text-muted">No workspaces yet.</div>
              )}
              <div className="my-1 h-px bg-border" />
              <button
                onClick={beginCreate}
                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-text-primary hover:bg-bg-hover"
              >
                <Plus size={12} />
                New workspace
              </button>
              {activeWorkspace && (
                <button
                  onClick={beginEdit}
                  className="flex w-full items-center gap-2 px-3 py-2 text-xs text-text-primary hover:bg-bg-hover"
                >
                  <Pencil size={12} />
                  Edit current workspace
                </button>
              )}
              {activeWorkspace?.recommendedTemplateId && (
                <button
                  onClick={() => void loadRecommendedTemplate(activeWorkspace)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-xs text-text-primary hover:bg-bg-hover"
                >
                  <Plus size={12} />
                  Load recommended template
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <Dialog
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={form.id ? 'Edit Workspace' : 'Workspace Setup'}
        width="max-w-3xl"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setEditorOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleSave()}>
              {form.id ? 'Save workspace' : 'Create workspace'}
            </Button>
          </>
        )}
      >
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Workspace name"
            value={form.name}
            placeholder="Rorqual GWAS"
            onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
          />
          <Input
            label="Preferred connection"
            value={form.connectionName}
            placeholder={activeConnection?.config.name ?? 'Optional'}
            onChange={(e) => setForm((prev) => ({ ...prev, connectionName: e.target.value }))}
          />
          <Input
            label="Analysis root"
            value={form.analysisRoot}
            placeholder="/scratch/user/bioflow"
            onChange={(e) => setForm((prev) => ({ ...prev, analysisRoot: e.target.value }))}
          />
          <Input
            label="Slurm account"
            value={form.slurmAccount}
            placeholder="rrg-xxxx"
            onChange={(e) => setForm((prev) => ({ ...prev, slurmAccount: e.target.value }))}
          />
          <Input
            label="Default partition"
            value={form.slurmPartition}
            placeholder="Optional"
            onChange={(e) => setForm((prev) => ({ ...prev, slurmPartition: e.target.value }))}
          />
          <div className="flex flex-col gap-1">
            <label className="text-text-secondary text-xs font-medium">Recommended template</label>
            <select
              value={form.recommendedTemplateId}
              onChange={(e) => setForm((prev) => ({ ...prev, recommendedTemplateId: e.target.value }))}
              className="h-8 rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="">None</option>
              {PIPELINE_TEMPLATES.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </div>
          <Input
            label="Tools root"
            value={form.toolsRoot}
            placeholder="~/bioflow/tools"
            onChange={(e) => setForm((prev) => ({ ...prev, toolsRoot: e.target.value }))}
          />
          <Input
            label="ANNOVAR scripts"
            value={form.annovarScriptsPath}
            placeholder="~/bioflow/tools/annovar"
            onChange={(e) => setForm((prev) => ({ ...prev, annovarScriptsPath: e.target.value }))}
          />
          <Input
            label="ANNOVAR humandb"
            value={form.annovarDbPath}
            placeholder="~/bioflow/tools/annovar/humandb"
            onChange={(e) => setForm((prev) => ({ ...prev, annovarDbPath: e.target.value }))}
          />
          <Input
            label="VEP executable"
            value={form.vepPath}
            placeholder="vep or /path/to/vep"
            onChange={(e) => setForm((prev) => ({ ...prev, vepPath: e.target.value }))}
          />
          <Input
            label="VEP cache"
            value={form.vepCachePath}
            placeholder="~/bioflow/tools/vep/cache"
            onChange={(e) => setForm((prev) => ({ ...prev, vepCachePath: e.target.value }))}
          />
          <div className="col-span-2 flex flex-col gap-1">
            <label className="text-text-secondary text-xs font-medium">Notes</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
              rows={4}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent"
              placeholder="Cluster-specific notes, expected project folders, or handoff instructions."
            />
          </div>
        </div>
      </Dialog>
    </>
  )
}
