import { create } from 'zustand'
import type {
  DnxAppletInstallProgress,
  DnxAuthStatus,
  DnxBootstrapStatus,
  DnxBridgeStatusEvent,
  DnxFieldPreset,
  DnxInstanceCatalog,
  DnxInstalledAppletInfo,
  DnxProject,
  DnxTransferProgress,
} from '@/types/dnx'
import { SPARK_INSTANCE_TYPES } from '@/lib/dnxInstanceCatalog'
import { useSettingsStore } from '@/stores/settingsStore'

const DEFAULT_PROJECT_KEY = 'dnx:defaultProjectId'
const FIELD_PRESETS_KEY = 'dnx:fieldPresets'
const INSTALLED_APPLET_HASH_KEY = 'dnx:installedAppletHash'
const INSTALLED_APPLET_ID_KEY = 'dnx:installedAppletId'
const TOKEN_SECRET_KEY = 'dnx:authToken'

interface DnxStoreState {
  bootstrapStatus: DnxBootstrapStatus
  authStatus: DnxAuthStatus
  defaultProjectId: string | null
  availableProjects: DnxProject[]
  authToken: string | null
  fieldPresets: DnxFieldPreset[]
  installedAppletHash: string | null
  installedAppletId: string | null
  instanceCatalog: DnxInstanceCatalog | null
  bridgeStatus: DnxBridgeStatusEvent | null
  lastTransfer: DnxTransferProgress | null
  appletInstallProgress: DnxAppletInstallProgress | null
  loaded: boolean

  load: () => Promise<void>
  setToken: (token: string) => Promise<void>
  clearToken: () => Promise<void>
  setDefaultProject: (projectId: string | null) => Promise<void>
  runBootstrap: () => Promise<void>
  authenticate: (opts?: { token?: string | null; projectId?: string | null }) => Promise<void>
  refreshProjects: () => Promise<DnxProject[]>
  saveFieldPresets: (presets: DnxFieldPreset[]) => Promise<void>
  setInstalledAppletInfo: (info: DnxInstalledAppletInfo) => Promise<void>
  refreshInstanceCatalog: () => Promise<DnxInstanceCatalog>
  setInstanceCatalog: (catalog: DnxInstanceCatalog | null) => void
  subscribeToEvents: () => () => void
}

export const useDnxStore = create<DnxStoreState>((set, get) => ({
  bootstrapStatus: 'unknown',
  authStatus: 'unauthenticated',
  defaultProjectId: null,
  availableProjects: [],
  authToken: null,
  fieldPresets: [],
  installedAppletHash: null,
  installedAppletId: null,
  instanceCatalog: null,
  bridgeStatus: null,
  lastTransfer: null,
  appletInstallProgress: null,
  loaded: false,

  load: async () => {
    if (!window.api?.store) return
    const [defaultProjectId, fieldPresets, installedAppletHash, installedAppletId, authToken] = await Promise.all([
      window.api.store.get<string>(DEFAULT_PROJECT_KEY),
      window.api.store.get<DnxFieldPreset[]>(FIELD_PRESETS_KEY),
      window.api.store.get<string>(INSTALLED_APPLET_HASH_KEY),
      window.api.store.get<string>(INSTALLED_APPLET_ID_KEY),
      window.api.store.getSecret(TOKEN_SECRET_KEY),
    ])
    set({
      defaultProjectId: defaultProjectId ?? null,
      fieldPresets: fieldPresets ?? [],
      installedAppletHash: installedAppletHash ?? null,
      installedAppletId: installedAppletId ?? null,
      authToken: authToken ?? null,
      // Token presence alone doesn't prove the bridge has applied it. Mark as
      // unauthenticated until an `authenticate()` call succeeds — that gates
      // the file-browser DNX tab and Quick Extract.
      authStatus: 'unauthenticated',
      loaded: true,
    })

    // Best-effort: if a token + project pair are stored, bring the bridge up
    // and authenticate on startup so the DNX tab and Quick Extract work
    // without forcing the user to open Settings every launch.
    if (authToken && defaultProjectId) {
      void (async () => {
        try {
          await window.api.dnx.bootstrap()
          await window.api.dnx.auth({ token: authToken, projectId: defaultProjectId })
          set({ authStatus: 'authenticated', bootstrapStatus: 'ready' })
          // Refresh projects in the background so the picker is populated.
          void get().refreshProjects().catch(() => undefined)
        } catch (error) {
          set({
            authStatus: 'error',
            bridgeStatus: {
              level: 'error',
              message: error instanceof Error ? error.message : String(error),
            },
          })
        }
      })()
    }
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        dnxAuthTokenStored: Boolean(authToken),
        dnxDefaultProjectId: defaultProjectId ?? null,
      },
    }))
  },

  setToken: async (token) => {
    await window.api.store.setSecret(TOKEN_SECRET_KEY, token)
    set({
      authToken: token,
      authStatus: 'authenticated',
    })
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        dnxAuthTokenStored: true,
      },
    }))
  },

  clearToken: async () => {
    await window.api.store.deleteSecret(TOKEN_SECRET_KEY)
    set({
      authToken: null,
      authStatus: 'unauthenticated',
      availableProjects: [],
    })
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        dnxAuthTokenStored: false,
      },
    }))
  },

  setDefaultProject: async (projectId) => {
    if (projectId) await window.api.store.set(DEFAULT_PROJECT_KEY, projectId)
    else await window.api.store.delete(DEFAULT_PROJECT_KEY)
    set({ defaultProjectId: projectId })
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        dnxDefaultProjectId: projectId,
      },
    }))
  },

  runBootstrap: async () => {
    if (!window.api?.dnx) throw new Error('DNAnexus preload API is unavailable.')
    set({ bootstrapStatus: 'bootstrapping', bridgeStatus: null })
    try {
      await window.api.dnx.bootstrap()
      set({ bootstrapStatus: 'ready' })
    } catch (error) {
      set({
        bootstrapStatus: 'error',
        bridgeStatus: {
          level: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    }
  },

  authenticate: async (opts) => {
    if (!window.api?.dnx) throw new Error('DNAnexus preload API is unavailable.')
    const token = opts?.token ?? get().authToken
    const projectId = opts?.projectId ?? get().defaultProjectId
    if (!token && !projectId) {
      set({ authStatus: 'unauthenticated' })
      return
    }
    try {
      await window.api.dnx.auth({ token: token ?? undefined, projectId: projectId ?? undefined })
      set({ authStatus: 'authenticated' })
    } catch (error) {
      set({
        authStatus: 'error',
        bridgeStatus: {
          level: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    }
  },

  refreshProjects: async () => {
    if (!window.api?.dnx) throw new Error('DNAnexus preload API is unavailable.')
    const currentProjectId = get().defaultProjectId
    const projects = await window.api.dnx.listProjects()
    const nextProjectId = currentProjectId && projects.some((project) => project.id === currentProjectId)
      ? currentProjectId
      : projects[0]?.id ?? null
    set({
      availableProjects: projects,
      defaultProjectId: nextProjectId,
      authStatus: 'authenticated',
    })
    if (nextProjectId !== currentProjectId) {
      await get().setDefaultProject(nextProjectId)
    }
    if (!get().instanceCatalog) {
      void get().refreshInstanceCatalog().catch(() => undefined)
    }
    return projects
  },

  saveFieldPresets: async (presets) => {
    await window.api.store.set(FIELD_PRESETS_KEY, presets)
    set({ fieldPresets: presets })
  },

  setInstalledAppletInfo: async ({ appletId, hash }) => {
    if (hash) await window.api.store.set(INSTALLED_APPLET_HASH_KEY, hash)
    else await window.api.store.delete(INSTALLED_APPLET_HASH_KEY)
    if (appletId) await window.api.store.set(INSTALLED_APPLET_ID_KEY, appletId)
    else await window.api.store.delete(INSTALLED_APPLET_ID_KEY)
    set({ installedAppletHash: hash, installedAppletId: appletId })
  },

  refreshInstanceCatalog: async () => {
    const specs = await window.api.dnx.listInstanceTypes()
    const catalog = {
      lastRefreshed: Date.now(),
      specs: specs.length > 0 ? specs : SPARK_INSTANCE_TYPES,
    }
    set({ instanceCatalog: catalog })
    return catalog
  },

  setInstanceCatalog: (instanceCatalog) => set({ instanceCatalog }),

  subscribeToEvents: () => {
    if (!window.api?.dnx) return () => {}
    const offBridge = window.api.dnx.onBridgeStatus((payload) => {
      set({
        bridgeStatus: payload,
        bootstrapStatus: payload.level === 'error' ? 'error' : get().bootstrapStatus,
      })
    })
    const offBootstrap = window.api.dnx.onBootstrapProgress((payload) => {
      set({
        bridgeStatus: {
          level: payload.level,
          message: payload.message,
          code: payload.code,
        },
      })
    })
    const offTransfer = window.api.dnx.onTransferProgress((payload) => {
      set({ lastTransfer: payload })
    })
    const offApplet = window.api.dnx.onAppletInstallProgress((payload) => {
      set({ appletInstallProgress: payload })
    })
    return () => {
      offBridge()
      offBootstrap()
      offTransfer()
      offApplet()
    }
  },
}))
