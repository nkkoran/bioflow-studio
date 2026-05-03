import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Loader2, Lock } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { HelpButton } from '@/components/ui/HelpButton'
import { RemotePathField } from '@/components/file-browser/RemotePathField'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { classNames } from '@/lib/utils'
import { showToast } from '@/components/ui/Toaster'
import { AnnovarSetupWizard } from './AnnovarSetupWizard'
import { DnanexusSettingsPanel } from './DnanexusSettingsPanel'

const SECTIONS = [
  'General',
  'Run',
  'Paths',
  'Tools',
  'DNAnexus',
  'Advanced',
] as const
type Section = typeof SECTIONS[number]

export function SettingsDialog({
  open,
  onClose,
  initialSection,
}: {
  open: boolean
  onClose: () => void
  initialSection?: Section
}) {
  const [section, setSection] = useState<Section>(initialSection ?? 'General')

  useEffect(() => {
    if (open && initialSection) setSection(initialSection)
  }, [open, initialSection])
  const [annovarWizardOpen, setAnnovarWizardOpen] = useState(false)
  const [pinOpen, setPinOpen] = useState(false)
  const [pinDraft, setPinDraft] = useState('')
  const [pinError, setPinError] = useState<string | null>(null)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const settings = useSettingsStore((s) => s.settings)
  const devMode = useSettingsStore((s) => s.devMode)
  const load = useSettingsStore((s) => s.load)
  const setSetting = useSettingsStore((s) => s.setSetting)
  const unlockDevMode = useSettingsStore((s) => s.unlockDevMode)
  const theme = useUIStore((s) => s.theme)
  const setTheme = useUIStore((s) => s.setTheme)

  const visibleSections = useMemo(() => SECTIONS.filter((item) => item !== 'DNAnexus' || devMode), [devMode])

  useEffect(() => {
    if (!devMode && section === 'DNAnexus') {
      setSection('General')
      if (open) setPinOpen(true)
    }
  }, [devMode, open, section])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const toggle = (key: string, value: boolean) => {
    void setSetting(key, value)
  }

  const text = (key: string, value: string) => {
    void setSetting(key, value)
  }

  const number = (key: string, value: number) => {
    void setSetting(key, value)
  }

  const tryUnlockDevMode = () => {
    if (unlockDevMode(pinDraft)) {
      setPinDraft('')
      setPinError(null)
      setPinOpen(false)
      setSection('DNAnexus')
      return
    }
    setPinError('Incorrect PIN.')
  }

  const runStartupWizard = () => {
    void setSetting('settings:onboardingComplete', false).then(() => {
      onClose()
      window.dispatchEvent(new CustomEvent('bioflow:open-onboarding'))
    })
  }

  const checkForUpdates = async () => {
    setCheckingUpdates(true)
    showToast({ kind: 'info', message: 'Checking for updates...', durationMs: 2500 })
    try {
      await window.api.app.checkForUpdates()
      showToast({
        kind: 'success',
        message: 'Update check started. BioFlow will notify you if an update is available.',
        durationMs: 5000,
      })
    } catch (err) {
      showToast({
        kind: 'error',
        message: `Update check failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: 6000,
      })
    } finally {
      setCheckingUpdates(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Settings"
      className="bioflow-settings-dialog"
      bodyClassName="bioflow-settings-body"
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      <div className="bioflow-settings-grid">
        <aside className="bioflow-settings-nav">
          {visibleSections.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setSection(item)}
              className={classNames(
                'bioflow-settings-nav-button',
                section === item ? 'bg-accent/10 text-text-primary' : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
              )}
            >
              {item}
            </button>
          ))}
          {!devMode && (
            <div className="mt-2 flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPinOpen(true)}
                className="bioflow-settings-nav-button flex-1 bg-bg-tertiary text-text-muted shadow-sm hover:bg-bg-hover hover:text-text-primary"
              >
                <span className="text-nowrap min-w-0 flex-1 text-left">Developer Options</span>
                <Lock size={12} className="shrink-0" />
              </button>
              <HelpButton id="developer.gate" />
            </div>
          )}
        </aside>

        <section className="bioflow-settings-page">
          {section === 'General' && (
            <div className="flex flex-col gap-3">
              <SectionHeader label="General" helpId="settings.general" />
              <SettingsGroup title="Workspace">
                <Checkbox
                  label="Autosave pipelines"
                  checked={settings.autosaveEnabled}
                  onChange={(value) => toggle('settings:autosaveEnabled', value)}
                />
                <Input
                  label="Autosave interval (seconds)"
                  type="number"
                  min={5}
                  step={1}
                  value={settings.autosaveIntervalSeconds}
                  disabled={!settings.autosaveEnabled}
                  onChange={(e) => number('settings:autosaveIntervalSeconds', Number(e.target.value))}
                />
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={runStartupWizard}>
                    Run startup wizard
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => void checkForUpdates()} disabled={checkingUpdates}>
                    {checkingUpdates && <Loader2 size={12} className="mr-1 animate-spin" />}
                    {checkingUpdates ? 'Checking...' : 'Check for updates'}
                  </Button>
                </div>
              </SettingsGroup>
              <SettingsGroup title="Interface">
                <ChoiceGroup
                  label="Theme"
                  value={theme}
                  options={[
                    { value: 'dark', label: 'Dark' },
                    { value: 'light', label: 'Light' },
                    { value: 'simple', label: 'Simple' },
                  ]}
                  onChange={(value) => {
                    const next = value === 'light' || value === 'simple' ? value : 'dark'
                    setTheme(next)
                    void window.api.store.set('settings:theme', next)
                  }}
                />
                <Checkbox
                  label="Show workflow guide in the toolbar"
                  checked={settings.workflowGuideEnabled}
                  onChange={(value) => toggle('settings:workflowGuideEnabled', value)}
                />
                <Checkbox
                  label="Use icon grid in file explorers"
                  checked={settings.fileExplorerViewMode === 'icons'}
                  onChange={(value) => text('settings:fileExplorerViewMode', value ? 'icons' : 'list')}
                />
                <Checkbox
                  label="Show genome build metadata on input files"
                  checked={settings.showInputGenomeBuild}
                  onChange={(value) => toggle('settings:showInputGenomeBuild', value)}
                />
                <ChoiceGroup
                  label="Split file explorer layout"
                  value={settings.splitExplorerBasePane}
                  options={[
                    { value: 'left', label: 'Base path left' },
                    { value: 'right', label: 'Current folder left' },
                  ]}
                  onChange={(value) => text('settings:splitExplorerBasePane', value)}
                />
              </SettingsGroup>
              <SettingsGroup title="Privacy and notifications">
                <Checkbox
                  label="Share anonymous usage telemetry"
                  checked={settings.telemetryOptIn}
                  onChange={(value) => toggle('settings:telemetryOptIn', value)}
                />
                <Checkbox
                  label="Notify when a run finishes"
                  checked={settings.notifyOnRunFinish}
                  onChange={(value) => toggle('settings:notifyOnRunFinish', value)}
                />
                <Checkbox
                  label="Notify when a run fails"
                  checked={settings.notifyOnRunFail}
                  onChange={(value) => toggle('settings:notifyOnRunFail', value)}
                />
                <Checkbox
                  label="Play notification sound"
                  checked={settings.notifySoundEnabled}
                  onChange={(value) => toggle('settings:notifySoundEnabled', value)}
                />
              </SettingsGroup>
            </div>
          )}

          {section === 'Run' && (
            <div className="flex flex-col gap-3">
              <SectionHeader label="Run" helpId="settings.general" />
              <SettingsGroup title="Defaults">
                <Input
                  label="Default partition"
                  value={settings.defaultPartition}
                  placeholder="Use connection partition"
                  onChange={(e) => text('settings:defaultPartition', e.target.value)}
                />
                <Input
                  label="Partition memory cap (GB)"
                  type="number"
                  min={1}
                  step={1}
                  value={settings.partitionMaxMemGB}
                  onChange={(e) => number('settings:partitionMaxMemGB', Number(e.target.value))}
                />
                <Checkbox
                  label="Open Jobs tab when a run starts"
                  checked={settings.autoOpenJobsTabOnRun}
                  onChange={(value) => toggle('settings:autoOpenJobsTabOnRun', value)}
                />
              </SettingsGroup>
              <SettingsGroup title="Safety checks">
                <Checkbox
                  label="Confirm before login-node runs"
                  checked={settings.confirmOnLoginNodeRun}
                  onChange={(value) => toggle('settings:confirmOnLoginNodeRun', value)}
                />
                <Checkbox
                  label="Skip input file checks (faster, uses last known result)"
                  checked={settings.skipPreRunFileCheck}
                  onChange={(value) => toggle('settings:skipPreRunFileCheck', value)}
                />
                <Checkbox
                  label="Skip cluster doctor check before run"
                  checked={settings.skipPreRunDoctorCheck}
                  onChange={(value) => toggle('settings:skipPreRunDoctorCheck', value)}
                />
              </SettingsGroup>
              <SettingsGroup title="Execution">
                <ChoiceGroup
                  label="Array chain mode"
                  value={settings.arrayChainMode}
                  options={[
                    { value: 'task-level', label: 'Task-level aftercorr' },
                    { value: 'job-level', label: 'Job-level afterok' },
                  ]}
                  onChange={(value) => text('settings:execution:arrayChainMode', value)}
                />
                <ChoiceGroup
                  label="File lifecycle"
                  value={settings.fileLifecyclePolicy}
                  options={[
                    { value: 'keep-all', label: 'Keep all' },
                    { value: 'keep-outputs-only', label: 'Outputs only' },
                    { value: 'delete-intermediates-on-success', label: 'Aggressive cleanup' },
                  ]}
                  onChange={(value) => text('settings:fileLifecyclePolicy', value)}
                />
              </SettingsGroup>
            </div>
          )}

          {section === 'Paths' && (
            <div className="flex flex-col gap-3">
              <SectionHeader label="Paths" helpId="settings.paths" />
              <Input
                label="Run folder template"
                value={settings.paths.runFolderTemplate}
                placeholder="runs/{pipelineSlug}-{timestamp}"
                onChange={(e) => text('settings:paths:runFolderTemplate', e.target.value)}
              />
              <SettingsGroup title="Template tokens">
                <div className="text-[11px] text-text-muted" data-wrap>
                  <code>{'{pipelineSlug}'}</code>, <code>{'{pipelineName}'}</code>, <code>{'{timestamp}'}</code>, <code>{'{date}'}</code>, <code>{'{user}'}</code>
                </div>
              </SettingsGroup>
              <Checkbox
                label="Create scripts, outputs, and logs subfolders"
                checked={settings.paths.createSubfolders}
                onChange={(value) => toggle('settings:paths:createSubfolders', value)}
              />
              <div className="grid grid-cols-3 gap-2">
                <Input
                  label="Scripts"
                  value={settings.paths.scriptsSubfolder}
                  disabled={!settings.paths.createSubfolders}
                  onChange={(e) => text('settings:paths:scriptsSubfolder', e.target.value)}
                />
                <Input
                  label="Outputs"
                  value={settings.paths.outputsSubfolder}
                  disabled={!settings.paths.createSubfolders}
                  onChange={(e) => text('settings:paths:outputsSubfolder', e.target.value)}
                />
                <Input
                  label="Logs"
                  value={settings.paths.logsSubfolder}
                  disabled={!settings.paths.createSubfolders}
                  onChange={(e) => text('settings:paths:logsSubfolder', e.target.value)}
                />
              </div>
              <Input
                label="Uploads folder"
                value={settings.paths.uploadsSubfolder}
                placeholder="uploads"
                onChange={(e) => text('settings:paths:uploadsSubfolder', e.target.value)}
              />
            </div>
          )}

          {section === 'Tools' && (
            <div className="flex flex-col gap-3">
              <SectionHeader label="Tools" helpId="settings.tools" />
              <RemotePathField
                label="Tools folder"
                value={settings.toolsRoot}
                placeholder="~/bioflow/tools"
                onChange={(value) => text('settings:toolsRoot', value)}
                mode="directory"
                title="Choose tools folder"
              />
              <SettingsGroup title="Tool-specific paths">
                <div className="grid grid-cols-2 gap-2">
                  <RemotePathField
                    label="ANNOVAR scripts folder"
                    value={settings.annovarScriptsPath}
                    placeholder="~/bioflow/tools/annovar"
                    onChange={(value) => text('settings:annovarScriptsPath', value)}
                    mode="directory"
                    title="Choose ANNOVAR scripts folder"
                  />
                  <RemotePathField
                    label="ANNOVAR humandb folder"
                    value={settings.annovarDbPath}
                    placeholder="~/bioflow/tools/annovar/humandb"
                    onChange={(value) => text('settings:annovarDbPath', value)}
                    mode="directory"
                    title="Choose ANNOVAR humandb folder"
                  />
                  <RemotePathField
                    label="VEP executable or folder"
                    value={settings.vepPath}
                    placeholder="vep or ~/bioflow/tools/ensembl-vep/vep"
                    onChange={(value) => text('settings:vepPath', value)}
                    mode="file"
                    title="Choose VEP executable or folder"
                  />
                  <RemotePathField
                    label="VEP cache folder"
                    value={settings.vepCachePath}
                    placeholder="~/bioflow/tools/vep/cache"
                    onChange={(value) => text('settings:vepCachePath', value)}
                    mode="directory"
                    title="Choose VEP cache folder"
                  />
                </div>
              </SettingsGroup>
              <div>
                <Button variant="secondary" size="sm" onClick={() => setAnnovarWizardOpen(true)}>
                  ANNOVAR setup wizard
                </Button>
              </div>
            </div>
          )}

          {section === 'DNAnexus' && devMode && <DnanexusSettingsPanel />}

          {section === 'Advanced' && (
            <div className="flex flex-col gap-3">
              <SectionHeader label="Advanced" helpId="settings.advanced" />
              <SettingsGroup title="SSH transport">
                <Checkbox
                  label="Use OpenSSH ControlPersist for BioFlow operations"
                  checked={settings.useOpenSshControlPersist}
                  onChange={(value) => toggle('settings:ssh:useOpenSshControlPersist', value)}
                />
                <div className="text-[11px] leading-relaxed text-text-muted" data-wrap>
                  Off uses BioFlow&apos;s legacy ssh2 connection. On routes file browsing, uploads, downloads, remote commands, run submission, and Slurm polling through a BioFlow-managed OpenSSH master socket. The in-app terminal still uses ssh2 in this release.
                </div>
              </SettingsGroup>
              <Input
                label="Login-node CPU warning threshold (seconds)"
                type="number"
                min={0}
                step={60}
                value={settings.clusterLoginPolicyWarnSeconds}
                onChange={(e) => number('settings:cluster:loginPolicyWarnSeconds', Number(e.target.value))}
              />
              <SettingsGroup title="Login-node warning details">
                <div className="text-[11px] text-text-muted" data-wrap>
                Show a warning after connect when the cluster reports a login-node CPU time limit below this value. Use 0 to suppress the warning.
                </div>
              </SettingsGroup>
              <SettingsGroup title="PLINK flag builder">
                <div className="text-[11px] text-text-muted" data-wrap>
                  Documented flags, custom fallback flags, and suggested rerun fixes are handled directly in the inspector.
                </div>
              </SettingsGroup>
            </div>
          )}
        </section>
      </div>
      <AnnovarSetupWizard open={annovarWizardOpen} onClose={() => setAnnovarWizardOpen(false)} />
      <Dialog
        open={pinOpen}
        onClose={() => {
          setPinOpen(false)
          setPinDraft('')
          setPinError(null)
        }}
        title="Developer Options"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setPinOpen(false)}>Cancel</Button>
            <Button onClick={tryUnlockDevMode}>Unlock</Button>
          </>
        )}
      >
        <div className="space-y-2">
          <Input
            label="PIN"
            type="password"
            value={pinDraft}
            onChange={(e) => setPinDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') tryUnlockDevMode()
            }}
            autoFocus
          />
          {pinError && <p className="text-xs text-error">{pinError}</p>}
        </div>
      </Dialog>
    </Dialog>
  )
}

function SectionHeader({ label, helpId }: { label: string; helpId: string }) {
  return (
    <div className="mb-1 flex items-center gap-2">
      <h3 className="text-sm font-semibold text-text-primary">{label}</h3>
      <HelpButton id={helpId} />
    </div>
  )
}

function SettingsGroup({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div className="rounded-md bg-bg-tertiary px-3 py-2 text-xs text-text-secondary shadow-inner">
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-text-muted">{title}</div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  )
}

function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs font-medium text-text-secondary">{label}</div>
      <div className="flex flex-wrap gap-1 rounded-md bg-bg-primary/60 p-1 shadow-inner">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={classNames(
              'interactive-row min-h-7 px-2 py-1 text-left text-xs',
              value === option.value ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:text-text-primary',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-text-primary">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-accent"
      />
      {label}
    </label>
  )
}
