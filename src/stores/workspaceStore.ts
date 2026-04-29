import { create } from 'zustand'
import { useConnectionStore, LOCAL_CONNECTION_ID } from '@/stores/connectionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type { BioflowWorkspace } from '@/types/workspace'

interface WorkspaceDraft extends Omit<BioflowWorkspace, 'id' | 'createdAt' | 'updatedAt'> {
  id?: string
}

interface WorkspaceStoreState {
  loaded: boolean
  workspaces: BioflowWorkspace[]
  activeWorkspaceId: string | null
  load: () => Promise<void>
  saveWorkspace: (draft: WorkspaceDraft) => Promise<BioflowWorkspace>
  deleteWorkspace: (id: string) => Promise<void>
  setActiveWorkspace: (id: string | null) => Promise<void>
  applyActiveWorkspace: (connectionId?: string | null) => Promise<void>
}

function workspaceKey(id: string): string {
  return `workspace:${id}`
}

function makeId(): string {
  return `workspace_${Math.random().toString(36).slice(2, 10)}`
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const next = value?.trim()
  return next ? next : undefined
}

async function listWorkspaces(): Promise<BioflowWorkspace[]> {
  const ids = (await window.api.store.get<string[]>('workspaces:ids')) ?? []
  const rows = await Promise.all(ids.map((id) => window.api.store.get<BioflowWorkspace>(workspaceKey(id))))
  return rows
    .filter((row): row is BioflowWorkspace => Boolean(row))
    .sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt))
}

async function persistWorkspace(row: BioflowWorkspace): Promise<void> {
  await window.api.store.set(workspaceKey(row.id), row)
  const ids = (await window.api.store.get<string[]>('workspaces:ids')) ?? []
  if (!ids.includes(row.id)) await window.api.store.set('workspaces:ids', [...ids, row.id])
}

async function applyWorkspaceToActiveConnection(workspace: BioflowWorkspace | null, connectionId?: string | null): Promise<void> {
  if (!workspace || !connectionId || connectionId === LOCAL_CONNECTION_ID) return
  const activeConnection = useConnectionStore.getState().connections[connectionId]
  if (!activeConnection) return
  if (workspace.connectionName && workspace.connectionName !== activeConnection.config.name) return

  const settingsStore = useSettingsStore.getState()
  await Promise.all([
    window.api.store.set(`connection:${connectionId}:defaultAnalysisFolder`, workspace.analysisRoot ?? ''),
    window.api.store.set(`connection:${connectionId}:slurmAccount`, workspace.slurmAccount ?? ''),
    window.api.store.set(`connection:${connectionId}:slurmPartition`, workspace.slurmPartition ?? ''),
    workspace.toolsRoot !== undefined ? settingsStore.setSetting('settings:toolsRoot', workspace.toolsRoot) : Promise.resolve(),
    workspace.annovarScriptsPath !== undefined ? settingsStore.setSetting('settings:annovarScriptsPath', workspace.annovarScriptsPath) : Promise.resolve(),
    workspace.annovarDbPath !== undefined ? settingsStore.setSetting('settings:annovarDbPath', workspace.annovarDbPath) : Promise.resolve(),
    workspace.vepPath !== undefined ? settingsStore.setSetting('settings:vepPath', workspace.vepPath) : Promise.resolve(),
    workspace.vepCachePath !== undefined ? settingsStore.setSetting('settings:vepCachePath', workspace.vepCachePath) : Promise.resolve(),
  ])
}

export const useWorkspaceStore = create<WorkspaceStoreState>((set, get) => ({
  loaded: false,
  workspaces: [],
  activeWorkspaceId: null,

  load: async () => {
    const [workspaces, activeWorkspaceId] = await Promise.all([
      listWorkspaces(),
      window.api.store.get<string>('workspace:active'),
    ])
    set({
      loaded: true,
      workspaces,
      activeWorkspaceId: activeWorkspaceId && workspaces.some((workspace) => workspace.id === activeWorkspaceId)
        ? activeWorkspaceId
        : workspaces[0]?.id ?? null,
    })
  },

  saveWorkspace: async (draft) => {
    const now = Date.now()
    const existing = draft.id ? get().workspaces.find((workspace) => workspace.id === draft.id) : null
    const row: BioflowWorkspace = {
      id: draft.id ?? makeId(),
      name: draft.name.trim() || 'Untitled workspace',
      connectionName: trimOrUndefined(draft.connectionName),
      analysisRoot: trimOrUndefined(draft.analysisRoot),
      slurmAccount: trimOrUndefined(draft.slurmAccount),
      slurmPartition: trimOrUndefined(draft.slurmPartition),
      toolsRoot: trimOrUndefined(draft.toolsRoot),
      annovarScriptsPath: trimOrUndefined(draft.annovarScriptsPath),
      annovarDbPath: trimOrUndefined(draft.annovarDbPath),
      vepPath: trimOrUndefined(draft.vepPath),
      vepCachePath: trimOrUndefined(draft.vepCachePath),
      recommendedTemplateId: trimOrUndefined(draft.recommendedTemplateId),
      notes: trimOrUndefined(draft.notes),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt,
    }
    await persistWorkspace(row)
    const hadActiveWorkspace = Boolean(get().activeWorkspaceId)
    const workspaces = await listWorkspaces()
    const nextActive = get().activeWorkspaceId ?? row.id
    set({ workspaces, activeWorkspaceId: nextActive })
    if (!hadActiveWorkspace) {
      await get().setActiveWorkspace(row.id)
    } else if (get().activeWorkspaceId === row.id) {
      await get().applyActiveWorkspace(useConnectionStore.getState().activeConnectionId)
    }
    return row
  },

  deleteWorkspace: async (id) => {
    await window.api.store.delete(workspaceKey(id))
    const ids = ((await window.api.store.get<string[]>('workspaces:ids')) ?? []).filter((candidate) => candidate !== id)
    await window.api.store.set('workspaces:ids', ids)
    const nextWorkspaces = await listWorkspaces()
    const nextActive = get().activeWorkspaceId === id ? (nextWorkspaces[0]?.id ?? null) : get().activeWorkspaceId
    if (get().activeWorkspaceId === id) await window.api.store.set('workspace:active', nextActive)
    set({ workspaces: nextWorkspaces, activeWorkspaceId: nextActive })
  },

  setActiveWorkspace: async (id) => {
    const nextId = id ?? null
    await window.api.store.set('workspace:active', nextId)
    const active = nextId ? get().workspaces.find((workspace) => workspace.id === nextId) ?? null : null
    if (active) {
      const updated = { ...active, lastUsedAt: Date.now(), updatedAt: active.updatedAt }
      await persistWorkspace(updated)
    }
    const workspaces = await listWorkspaces()
    set({ activeWorkspaceId: nextId, workspaces })
    await get().applyActiveWorkspace(useConnectionStore.getState().activeConnectionId)
  },

  applyActiveWorkspace: async (connectionId) => {
    const workspace = get().activeWorkspaceId
      ? get().workspaces.find((row) => row.id === get().activeWorkspaceId) ?? null
      : null
    await applyWorkspaceToActiveConnection(workspace, connectionId)
  },
}))
