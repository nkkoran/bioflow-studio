import { create } from 'zustand'

export interface PathSettings {
  scriptsSubfolder: string
  outputsSubfolder: string
  logsSubfolder: string
  uploadsSubfolder: string
  createSubfolders: boolean
  runFolderTemplate: string
}

export interface AppSettings {
  paths: PathSettings
  toolsRoot: string
  moduleDefaults: {
    plink: string
    r: string
    bcftools: string
    regenie: string
  }
  annovarScriptsPath: string
  annovarDbPath: string
  vepPath: string
  vepCachePath: string
  defaultPartition: string
  partitionMaxMemGB: number
  autoOpenJobsTabOnRun: boolean
  autosaveEnabled: boolean
  autosaveIntervalSeconds: number
  confirmOnLoginNodeRun: boolean
  notifyOnRunFinish: boolean
  notifyOnRunFail: boolean
  notifySoundEnabled: boolean
  clusterLoginPolicyWarnSeconds: number
  plinkFlagBuilderEnabled: boolean
  toolPaletteWorkflowPacksCollapsed: boolean
  rPackageInstallMode: 'prompt-on-run' | 'auto-on-run' | 'manual'
  arrayChainMode: 'task-level' | 'job-level'
  fileLifecyclePolicy: 'keep-all' | 'keep-outputs-only' | 'delete-intermediates-on-success'
  skipPreRunFileCheck: boolean
  skipPreRunDoctorCheck: boolean
  useOpenSshControlPersist: boolean
  dnxAuthTokenStored: boolean
  dnxDefaultProjectId: string | null
  onboardingComplete: boolean
  onboardingVersionComplete: number
  telemetryOptIn: boolean
  workflowGuideEnabled: boolean
  fileExplorerViewMode: 'list' | 'icons'
  showInputGenomeBuild: boolean
  showInlineValidateSettings: boolean
  splitExplorerBasePane: 'left' | 'right'
}

export const CURRENT_ONBOARDING_VERSION = 1

export const DEFAULT_SETTINGS: AppSettings = {
  paths: {
    scriptsSubfolder: 'scripts',
    outputsSubfolder: 'outputs',
    logsSubfolder: 'logs',
    uploadsSubfolder: 'uploads',
    createSubfolders: true,
    runFolderTemplate: 'runs/{pipelineSlug}-{timestamp}',
  },
  toolsRoot: '~/bioflow/tools',
  moduleDefaults: {
    plink: '',
    r: '',
    bcftools: '',
    regenie: '',
  },
  annovarScriptsPath: '',
  annovarDbPath: '',
  vepPath: '',
  vepCachePath: '',
  defaultPartition: '',
  partitionMaxMemGB: 192,
  autoOpenJobsTabOnRun: true,
  autosaveEnabled: true,
  autosaveIntervalSeconds: 15,
  confirmOnLoginNodeRun: true,
  notifyOnRunFinish: true,
  notifyOnRunFail: true,
  notifySoundEnabled: false,
  clusterLoginPolicyWarnSeconds: 600,
  plinkFlagBuilderEnabled: false,
  toolPaletteWorkflowPacksCollapsed: true,
  rPackageInstallMode: 'prompt-on-run',
  arrayChainMode: 'task-level',
  fileLifecyclePolicy: 'keep-all',
  skipPreRunFileCheck: false,
  skipPreRunDoctorCheck: false,
  useOpenSshControlPersist: false,
  dnxAuthTokenStored: false,
  dnxDefaultProjectId: null,
  onboardingComplete: false,
  onboardingVersionComplete: 0,
  telemetryOptIn: false,
  workflowGuideEnabled: false,
  fileExplorerViewMode: 'list',
  showInputGenomeBuild: true,
  showInlineValidateSettings: false,
  splitExplorerBasePane: 'left',
}

interface SettingsState {
  settings: AppSettings
  loaded: boolean
  devMode: boolean
  load: () => Promise<void>
  setSetting: <T>(key: string, value: T) => Promise<void>
  unlockDevMode: (pin: string) => boolean
  lockDevMode: () => void
}

async function readSetting<T>(key: string, fallback: T): Promise<T> {
  const value = await window.api.store.get<T>(key)
  return value === undefined ? fallback : value
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  devMode: false,

  load: async () => {
    const onboardingVersionComplete = await readSetting('settings:onboardingVersionComplete', DEFAULT_SETTINGS.onboardingVersionComplete)
    const settings: AppSettings = {
      paths: {
        scriptsSubfolder: await readSetting('settings:paths:scriptsSubfolder', DEFAULT_SETTINGS.paths.scriptsSubfolder),
        outputsSubfolder: await readSetting('settings:paths:outputsSubfolder', DEFAULT_SETTINGS.paths.outputsSubfolder),
        logsSubfolder: await readSetting('settings:paths:logsSubfolder', DEFAULT_SETTINGS.paths.logsSubfolder),
        uploadsSubfolder: await readSetting('settings:paths:uploadsSubfolder', DEFAULT_SETTINGS.paths.uploadsSubfolder),
        createSubfolders: await readSetting('settings:paths:createSubfolders', DEFAULT_SETTINGS.paths.createSubfolders),
        runFolderTemplate: await readSetting('settings:paths:runFolderTemplate', DEFAULT_SETTINGS.paths.runFolderTemplate),
      },
      toolsRoot: await readSetting('settings:toolsRoot', DEFAULT_SETTINGS.toolsRoot),
      moduleDefaults: {
        plink: await readSetting('settings:modules:plink', DEFAULT_SETTINGS.moduleDefaults.plink),
        r: await readSetting('settings:modules:r', DEFAULT_SETTINGS.moduleDefaults.r),
        bcftools: await readSetting('settings:modules:bcftools', DEFAULT_SETTINGS.moduleDefaults.bcftools),
        regenie: await readSetting('settings:modules:regenie', DEFAULT_SETTINGS.moduleDefaults.regenie),
      },
      annovarScriptsPath: await readSetting('settings:annovarScriptsPath', DEFAULT_SETTINGS.annovarScriptsPath),
      annovarDbPath: await readSetting('settings:annovarDbPath', DEFAULT_SETTINGS.annovarDbPath),
      vepPath: await readSetting('settings:vepPath', DEFAULT_SETTINGS.vepPath),
      vepCachePath: await readSetting('settings:vepCachePath', DEFAULT_SETTINGS.vepCachePath),
      defaultPartition: await readSetting('settings:defaultPartition', DEFAULT_SETTINGS.defaultPartition),
      partitionMaxMemGB: await readSetting('settings:partitionMaxMemGB', DEFAULT_SETTINGS.partitionMaxMemGB),
      autoOpenJobsTabOnRun: await readSetting('settings:autoOpenJobsTabOnRun', DEFAULT_SETTINGS.autoOpenJobsTabOnRun),
      autosaveEnabled: await readSetting('settings:autosaveEnabled', DEFAULT_SETTINGS.autosaveEnabled),
      autosaveIntervalSeconds: await readSetting('settings:autosaveIntervalSeconds', DEFAULT_SETTINGS.autosaveIntervalSeconds),
      confirmOnLoginNodeRun: await readSetting('settings:confirmOnLoginNodeRun', DEFAULT_SETTINGS.confirmOnLoginNodeRun),
      notifyOnRunFinish: await readSetting('settings:notifyOnRunFinish', DEFAULT_SETTINGS.notifyOnRunFinish),
      notifyOnRunFail: await readSetting('settings:notifyOnRunFail', DEFAULT_SETTINGS.notifyOnRunFail),
      notifySoundEnabled: await readSetting('settings:notifySoundEnabled', DEFAULT_SETTINGS.notifySoundEnabled),
      clusterLoginPolicyWarnSeconds: await readSetting('settings:cluster:loginPolicyWarnSeconds', DEFAULT_SETTINGS.clusterLoginPolicyWarnSeconds),
      plinkFlagBuilderEnabled: await readSetting('settings:experimental:plinkFlagBuilderEnabled', DEFAULT_SETTINGS.plinkFlagBuilderEnabled),
      toolPaletteWorkflowPacksCollapsed: await readSetting('settings:toolPalette:workflowPacksCollapsed', DEFAULT_SETTINGS.toolPaletteWorkflowPacksCollapsed),
      rPackageInstallMode: normalizeRPackageInstallMode(await readSetting('settings:rPackages:installMode', DEFAULT_SETTINGS.rPackageInstallMode)),
      arrayChainMode: await readSetting('settings:execution:arrayChainMode', DEFAULT_SETTINGS.arrayChainMode),
      fileLifecyclePolicy: await readSetting('settings:fileLifecyclePolicy', DEFAULT_SETTINGS.fileLifecyclePolicy),
      skipPreRunFileCheck: await readSetting('settings:skipPreRunFileCheck', DEFAULT_SETTINGS.skipPreRunFileCheck),
      skipPreRunDoctorCheck: await readSetting('settings:skipPreRunDoctorCheck', DEFAULT_SETTINGS.skipPreRunDoctorCheck),
      useOpenSshControlPersist: await readSetting('settings:ssh:useOpenSshControlPersist', DEFAULT_SETTINGS.useOpenSshControlPersist),
      dnxAuthTokenStored: Boolean(await window.api.store.getSecret('dnx:authToken')),
      dnxDefaultProjectId: await readSetting('dnx:defaultProjectId', DEFAULT_SETTINGS.dnxDefaultProjectId),
      onboardingComplete: onboardingVersionComplete >= CURRENT_ONBOARDING_VERSION,
      onboardingVersionComplete,
      telemetryOptIn: await readSetting('settings:telemetryOptIn', DEFAULT_SETTINGS.telemetryOptIn),
      workflowGuideEnabled: await readSetting('settings:workflowGuideEnabled', DEFAULT_SETTINGS.workflowGuideEnabled),
      fileExplorerViewMode: (await readSetting('settings:fileExplorerViewMode', DEFAULT_SETTINGS.fileExplorerViewMode)) === 'icons' ? 'icons' : 'list',
      showInputGenomeBuild: await readSetting('settings:showInputGenomeBuild', DEFAULT_SETTINGS.showInputGenomeBuild),
      showInlineValidateSettings: await readSetting('settings:inspector:showInlineValidateSettings', DEFAULT_SETTINGS.showInlineValidateSettings),
      splitExplorerBasePane: (await readSetting('settings:splitExplorerBasePane', DEFAULT_SETTINGS.splitExplorerBasePane)) === 'right' ? 'right' : 'left',
    }
    set({ settings, loaded: true })
  },

  setSetting: async (key, value) => {
    await window.api.store.set(key, value)
    if (key === 'settings:onboardingComplete') {
      await window.api.store.set('settings:onboardingVersionComplete', value ? CURRENT_ONBOARDING_VERSION : 0)
    }
    const current = get().settings
    const next: AppSettings = structuredClone(current)
    switch (key) {
      case 'settings:paths:scriptsSubfolder': next.paths.scriptsSubfolder = String(value); break
      case 'settings:paths:outputsSubfolder': next.paths.outputsSubfolder = String(value); break
      case 'settings:paths:logsSubfolder': next.paths.logsSubfolder = String(value); break
      case 'settings:paths:uploadsSubfolder': next.paths.uploadsSubfolder = String(value); break
      case 'settings:paths:createSubfolders': next.paths.createSubfolders = Boolean(value); break
      case 'settings:paths:runFolderTemplate': next.paths.runFolderTemplate = String(value); break
      case 'settings:toolsRoot': next.toolsRoot = String(value); break
      case 'settings:modules:plink': next.moduleDefaults.plink = String(value); break
      case 'settings:modules:r': next.moduleDefaults.r = String(value); break
      case 'settings:modules:bcftools': next.moduleDefaults.bcftools = String(value); break
      case 'settings:modules:regenie': next.moduleDefaults.regenie = String(value); break
      case 'settings:annovarScriptsPath': next.annovarScriptsPath = String(value); break
      case 'settings:annovarDbPath': next.annovarDbPath = String(value); break
      case 'settings:vepPath': next.vepPath = String(value); break
      case 'settings:vepCachePath': next.vepCachePath = String(value); break
      case 'settings:defaultPartition': next.defaultPartition = String(value); break
      case 'settings:partitionMaxMemGB': next.partitionMaxMemGB = Math.max(1, Number(value) || DEFAULT_SETTINGS.partitionMaxMemGB); break
      case 'settings:autoOpenJobsTabOnRun': next.autoOpenJobsTabOnRun = Boolean(value); break
      case 'settings:autosaveEnabled': next.autosaveEnabled = Boolean(value); break
      case 'settings:autosaveIntervalSeconds': next.autosaveIntervalSeconds = Math.max(5, Number(value) || DEFAULT_SETTINGS.autosaveIntervalSeconds); break
      case 'settings:confirmOnLoginNodeRun': next.confirmOnLoginNodeRun = Boolean(value); break
      case 'settings:notifyOnRunFinish': next.notifyOnRunFinish = Boolean(value); break
      case 'settings:notifyOnRunFail': next.notifyOnRunFail = Boolean(value); break
      case 'settings:notifySoundEnabled': next.notifySoundEnabled = Boolean(value); break
      case 'settings:cluster:loginPolicyWarnSeconds': {
        const parsed = Number(value)
        next.clusterLoginPolicyWarnSeconds = Number.isFinite(parsed)
          ? Math.max(0, parsed)
          : DEFAULT_SETTINGS.clusterLoginPolicyWarnSeconds
        break
      }
      case 'settings:experimental:plinkFlagBuilderEnabled':
        next.plinkFlagBuilderEnabled = Boolean(value)
        break
      case 'settings:toolPalette:workflowPacksCollapsed':
        next.toolPaletteWorkflowPacksCollapsed = Boolean(value)
        break
      case 'settings:rPackages:installMode':
        next.rPackageInstallMode = normalizeRPackageInstallMode(value)
        break
      case 'settings:execution:arrayChainMode':
        next.arrayChainMode = value === 'job-level' ? 'job-level' : 'task-level'
        break
      case 'settings:fileLifecyclePolicy':
        next.fileLifecyclePolicy =
          value === 'keep-outputs-only' || value === 'delete-intermediates-on-success'
            ? String(value) as AppSettings['fileLifecyclePolicy']
            : 'keep-all'
        break
      case 'settings:skipPreRunFileCheck': next.skipPreRunFileCheck = Boolean(value); break
      case 'settings:skipPreRunDoctorCheck': next.skipPreRunDoctorCheck = Boolean(value); break
      case 'settings:ssh:useOpenSshControlPersist': next.useOpenSshControlPersist = Boolean(value); break
      case 'dnx:defaultProjectId': next.dnxDefaultProjectId = value ? String(value) : null; break
      case 'settings:onboardingComplete':
        next.onboardingComplete = Boolean(value)
        next.onboardingVersionComplete = value ? CURRENT_ONBOARDING_VERSION : 0
        break
      case 'settings:onboardingVersionComplete': {
        const parsed = Number(value)
        next.onboardingVersionComplete = Number.isFinite(parsed) ? Math.max(0, parsed) : 0
        next.onboardingComplete = next.onboardingVersionComplete >= CURRENT_ONBOARDING_VERSION
        break
      }
      case 'settings:telemetryOptIn': next.telemetryOptIn = Boolean(value); break
      case 'settings:workflowGuideEnabled': next.workflowGuideEnabled = Boolean(value); break
      case 'settings:fileExplorerViewMode': next.fileExplorerViewMode = value === 'icons' ? 'icons' : 'list'; break
      case 'settings:showInputGenomeBuild': next.showInputGenomeBuild = Boolean(value); break
      case 'settings:inspector:showInlineValidateSettings': next.showInlineValidateSettings = Boolean(value); break
      case 'settings:splitExplorerBasePane': next.splitExplorerBasePane = value === 'right' ? 'right' : 'left'; break
    }
    set({ settings: next, loaded: true })
  },
  unlockDevMode: (pin) => {
    const ok = pin === '7755'
    if (ok) set({ devMode: true })
    return ok
  },
  lockDevMode: () => set({ devMode: false }),
}))

function normalizeRPackageInstallMode(value: unknown): AppSettings['rPackageInstallMode'] {
  return value === 'auto-on-run' || value === 'manual' ? value : 'prompt-on-run'
}
