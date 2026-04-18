import { create } from 'zustand'

export interface PathSettings {
  scriptsSubfolder: string
  outputsSubfolder: string
  logsSubfolder: string
  createSubfolders: boolean
  runFolderTemplate: string
}

export interface AppSettings {
  paths: PathSettings
  toolsRoot: string
  annovarScriptsPath: string
  annovarDbPath: string
  vepPath: string
  vepCachePath: string
  defaultPartition: string
  autoOpenJobsTabOnRun: boolean
  autosaveEnabled: boolean
  autosaveIntervalSeconds: number
  confirmOnLoginNodeRun: boolean
  notifyOnRunFinish: boolean
  notifyOnRunFail: boolean
  notifySoundEnabled: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  paths: {
    scriptsSubfolder: 'scripts',
    outputsSubfolder: 'outputs',
    logsSubfolder: 'logs',
    createSubfolders: true,
    runFolderTemplate: 'runs/{pipelineSlug}-{timestamp}',
  },
  toolsRoot: '~/bioflow/tools',
  annovarScriptsPath: '',
  annovarDbPath: '',
  vepPath: '',
  vepCachePath: '',
  defaultPartition: '',
  autoOpenJobsTabOnRun: true,
  autosaveEnabled: true,
  autosaveIntervalSeconds: 15,
  confirmOnLoginNodeRun: true,
  notifyOnRunFinish: true,
  notifyOnRunFail: true,
  notifySoundEnabled: false,
}

interface SettingsState {
  settings: AppSettings
  loaded: boolean
  load: () => Promise<void>
  setSetting: <T>(key: string, value: T) => Promise<void>
}

async function readSetting<T>(key: string, fallback: T): Promise<T> {
  const value = await window.api.store.get<T>(key)
  return value === undefined ? fallback : value
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  load: async () => {
    const settings: AppSettings = {
      paths: {
        scriptsSubfolder: await readSetting('settings:paths:scriptsSubfolder', DEFAULT_SETTINGS.paths.scriptsSubfolder),
        outputsSubfolder: await readSetting('settings:paths:outputsSubfolder', DEFAULT_SETTINGS.paths.outputsSubfolder),
        logsSubfolder: await readSetting('settings:paths:logsSubfolder', DEFAULT_SETTINGS.paths.logsSubfolder),
        createSubfolders: await readSetting('settings:paths:createSubfolders', DEFAULT_SETTINGS.paths.createSubfolders),
        runFolderTemplate: await readSetting('settings:paths:runFolderTemplate', DEFAULT_SETTINGS.paths.runFolderTemplate),
      },
      toolsRoot: await readSetting('settings:toolsRoot', DEFAULT_SETTINGS.toolsRoot),
      annovarScriptsPath: await readSetting('settings:annovarScriptsPath', DEFAULT_SETTINGS.annovarScriptsPath),
      annovarDbPath: await readSetting('settings:annovarDbPath', DEFAULT_SETTINGS.annovarDbPath),
      vepPath: await readSetting('settings:vepPath', DEFAULT_SETTINGS.vepPath),
      vepCachePath: await readSetting('settings:vepCachePath', DEFAULT_SETTINGS.vepCachePath),
      defaultPartition: await readSetting('settings:defaultPartition', DEFAULT_SETTINGS.defaultPartition),
      autoOpenJobsTabOnRun: await readSetting('settings:autoOpenJobsTabOnRun', DEFAULT_SETTINGS.autoOpenJobsTabOnRun),
      autosaveEnabled: await readSetting('settings:autosaveEnabled', DEFAULT_SETTINGS.autosaveEnabled),
      autosaveIntervalSeconds: await readSetting('settings:autosaveIntervalSeconds', DEFAULT_SETTINGS.autosaveIntervalSeconds),
      confirmOnLoginNodeRun: await readSetting('settings:confirmOnLoginNodeRun', DEFAULT_SETTINGS.confirmOnLoginNodeRun),
      notifyOnRunFinish: await readSetting('settings:notifyOnRunFinish', DEFAULT_SETTINGS.notifyOnRunFinish),
      notifyOnRunFail: await readSetting('settings:notifyOnRunFail', DEFAULT_SETTINGS.notifyOnRunFail),
      notifySoundEnabled: await readSetting('settings:notifySoundEnabled', DEFAULT_SETTINGS.notifySoundEnabled),
    }
    set({ settings, loaded: true })
  },

  setSetting: async (key, value) => {
    await window.api.store.set(key, value)
    const current = get().settings
    const next: AppSettings = structuredClone(current)
    switch (key) {
      case 'settings:paths:scriptsSubfolder': next.paths.scriptsSubfolder = String(value); break
      case 'settings:paths:outputsSubfolder': next.paths.outputsSubfolder = String(value); break
      case 'settings:paths:logsSubfolder': next.paths.logsSubfolder = String(value); break
      case 'settings:paths:createSubfolders': next.paths.createSubfolders = Boolean(value); break
      case 'settings:paths:runFolderTemplate': next.paths.runFolderTemplate = String(value); break
      case 'settings:toolsRoot': next.toolsRoot = String(value); break
      case 'settings:annovarScriptsPath': next.annovarScriptsPath = String(value); break
      case 'settings:annovarDbPath': next.annovarDbPath = String(value); break
      case 'settings:vepPath': next.vepPath = String(value); break
      case 'settings:vepCachePath': next.vepCachePath = String(value); break
      case 'settings:defaultPartition': next.defaultPartition = String(value); break
      case 'settings:autoOpenJobsTabOnRun': next.autoOpenJobsTabOnRun = Boolean(value); break
      case 'settings:autosaveEnabled': next.autosaveEnabled = Boolean(value); break
      case 'settings:autosaveIntervalSeconds': next.autosaveIntervalSeconds = Math.max(5, Number(value) || DEFAULT_SETTINGS.autosaveIntervalSeconds); break
      case 'settings:confirmOnLoginNodeRun': next.confirmOnLoginNodeRun = Boolean(value); break
      case 'settings:notifyOnRunFinish': next.notifyOnRunFinish = Boolean(value); break
      case 'settings:notifyOnRunFail': next.notifyOnRunFail = Boolean(value); break
      case 'settings:notifySoundEnabled': next.notifySoundEnabled = Boolean(value); break
    }
    set({ settings: next, loaded: true })
  },
}))
