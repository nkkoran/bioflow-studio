import { useEffect, useMemo, useState } from 'react'
import { Lock } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { HelpButton } from '@/components/ui/HelpButton'
import { RemotePathField } from '@/components/file-browser/RemotePathField'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { classNames } from '@/lib/utils'
import { AnnovarSetupWizard } from './AnnovarSetupWizard'
import { DnanexusSettingsPanel } from './DnanexusSettingsPanel'

const SECTIONS = ['General', 'Paths', 'Tools', 'DNAnexus', 'Notifications', 'Advanced'] as const
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

  return (
    <Dialog open={open} onClose={onClose} title="Settings" width="max-w-3xl">
      <div className="grid min-h-[420px] grid-cols-[150px_1fr] gap-4">
        <div className="border-r border-border pr-2">
          {visibleSections.map((item) => (
            <button
              key={item}
              onClick={() => setSection(item)}
              className={classNames(
                'mb-1 w-full rounded px-2 py-1.5 text-left text-xs',
                section === item ? 'bg-accent/10 text-text-primary' : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
              )}
            >
              {item}
            </button>
          ))}
          {!devMode && (
            <button
              type="button"
              onClick={() => setPinOpen(true)}
              className="mt-3 flex w-full items-center gap-2 rounded border border-border bg-bg-tertiary px-2 py-1.5 text-left text-xs text-text-muted hover:bg-bg-hover hover:text-text-primary"
            >
              <Lock size={12} />
              Developer Options
              <HelpButton id="developer.gate" />
            </button>
          )}
        </div>

        <div className="min-w-0">
          {section === 'General' && (
            <div className="flex flex-col gap-3">
              <SectionHeader label="General" helpId="settings.general" />
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
              <div>
                <label className="mb-1 block text-text-secondary text-xs font-medium">Theme</label>
                <select
                  value={theme}
                  onChange={(e) => {
                    const next = e.target.value === 'light' || e.target.value === 'simple' ? e.target.value : 'dark'
                    setTheme(next)
                    void window.api.store.set('settings:theme', next)
                  }}
                  className="h-8 w-full rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent"
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                  <option value="simple">Simple</option>
                </select>
              </div>
              <Checkbox
                label="Confirm before login-node runs"
                checked={settings.confirmOnLoginNodeRun}
                onChange={(value) => toggle('settings:confirmOnLoginNodeRun', value)}
              />
              <Checkbox
                label="Share anonymous usage telemetry"
                checked={settings.telemetryOptIn}
                onChange={(value) => toggle('settings:telemetryOptIn', value)}
              />
              <div className="rounded-md border border-border bg-bg-tertiary px-3 py-2.5 flex flex-col gap-2">
                <p className="text-[11px] font-medium text-text-secondary">Pre-run checks</p>
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
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-text-secondary text-xs font-medium">Array chain mode</label>
                  <select
                    value={settings.arrayChainMode}
                    onChange={(e) => text('settings:execution:arrayChainMode', e.target.value)}
                    className="h-8 w-full rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent"
                  >
                    <option value="task-level">Task-level (`aftercorr` when supported)</option>
                    <option value="job-level">Job-level (`afterok` only)</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-text-secondary text-xs font-medium">File lifecycle</label>
                  <select
                    value={settings.fileLifecyclePolicy}
                    onChange={(e) => text('settings:fileLifecyclePolicy', e.target.value)}
                    className="h-8 w-full rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent"
                  >
                    <option value="keep-all">Keep all files</option>
                    <option value="keep-outputs-only">Delete marked intermediates after success</option>
                    <option value="delete-intermediates-on-success">Aggressive intermediate cleanup after success</option>
                  </select>
                </div>
              </div>
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
              <p className="text-[11px] text-text-muted">
                Tokens: <code>{'{pipelineSlug}'}</code>, <code>{'{pipelineName}'}</code>, <code>{'{timestamp}'}</code>, <code>{'{date}'}</code>, <code>{'{user}'}</code>.
              </p>
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
              <p className="text-[11px] text-text-muted">
                Node inspector values override these defaults. ANNOVAR scripts may need manual download from the ANNOVAR site before database installs can run.
              </p>
              <div>
                <Button variant="secondary" size="sm" onClick={() => setAnnovarWizardOpen(true)}>
                  ANNOVAR setup wizard
                </Button>
              </div>
            </div>
          )}

          {section === 'Notifications' && (
            <div className="flex flex-col gap-3">
              <SectionHeader label="Notifications" helpId="settings.notifications" />
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
            </div>
          )}

          {section === 'DNAnexus' && devMode && <DnanexusSettingsPanel />}

          {section === 'Advanced' && (
            <div className="flex flex-col gap-3">
              <SectionHeader label="Advanced" helpId="settings.advanced" />
              <Input
                label="Login-node CPU warning threshold (seconds)"
                type="number"
                min={0}
                step={60}
                value={settings.clusterLoginPolicyWarnSeconds}
                onChange={(e) => number('settings:cluster:loginPolicyWarnSeconds', Number(e.target.value))}
              />
              <p className="text-[11px] text-text-muted">
                Show a warning after connect when the cluster reports a login-node CPU time limit below this value. Use 0 to suppress the warning.
              </p>
              <div className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-xs leading-relaxed text-text-primary">
                PLINK tools now use the block-based flag builder so users can add documented flags, custom fallback flags, and suggested rerun fixes directly in the inspector.
              </div>
              <p className="text-[11px] text-text-muted">
                This is the shared large-flag pattern we can extend to other tools with broad command surfaces in later passes.
              </p>
            </div>
          )}
        </div>
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
        width="max-w-sm"
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
          <p className="text-[11px] text-text-muted">RAP features are under development and stay locked after app restart.</p>
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
