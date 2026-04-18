import { useEffect, useState } from 'react'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { useSettingsStore } from '@/stores/settingsStore'
import { classNames } from '@/lib/utils'

const SECTIONS = ['General', 'Paths', 'Tools', 'Notifications', 'Advanced'] as const
type Section = typeof SECTIONS[number]

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [section, setSection] = useState<Section>('General')
  const settings = useSettingsStore((s) => s.settings)
  const load = useSettingsStore((s) => s.load)
  const setSetting = useSettingsStore((s) => s.setSetting)

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

  return (
    <Dialog open={open} onClose={onClose} title="Settings" width="max-w-3xl">
      <div className="grid min-h-[420px] grid-cols-[150px_1fr] gap-4">
        <div className="border-r border-border pr-2">
          {SECTIONS.map((item) => (
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
        </div>

        <div className="min-w-0">
          {section === 'General' && (
            <div className="flex flex-col gap-3">
              <Input
                label="Default partition"
                value={settings.defaultPartition}
                placeholder="Use connection partition"
                onChange={(e) => text('settings:defaultPartition', e.target.value)}
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
              <Checkbox
                label="Confirm before login-node runs"
                checked={settings.confirmOnLoginNodeRun}
                onChange={(value) => toggle('settings:confirmOnLoginNodeRun', value)}
              />
            </div>
          )}

          {section === 'Paths' && (
            <div className="flex flex-col gap-3">
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
            </div>
          )}

          {section === 'Tools' && (
            <div className="flex flex-col gap-3">
              <Input
                label="Tools folder"
                value={settings.toolsRoot}
                placeholder="~/bioflow/tools"
                onChange={(e) => text('settings:toolsRoot', e.target.value)}
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  label="ANNOVAR scripts folder"
                  value={settings.annovarScriptsPath}
                  placeholder="~/bioflow/tools/annovar"
                  onChange={(e) => text('settings:annovarScriptsPath', e.target.value)}
                />
                <Input
                  label="ANNOVAR humandb folder"
                  value={settings.annovarDbPath}
                  placeholder="~/bioflow/tools/annovar/humandb"
                  onChange={(e) => text('settings:annovarDbPath', e.target.value)}
                />
                <Input
                  label="VEP executable or folder"
                  value={settings.vepPath}
                  placeholder="vep or ~/bioflow/tools/ensembl-vep/vep"
                  onChange={(e) => text('settings:vepPath', e.target.value)}
                />
                <Input
                  label="VEP cache folder"
                  value={settings.vepCachePath}
                  placeholder="~/bioflow/tools/vep/cache"
                  onChange={(e) => text('settings:vepCachePath', e.target.value)}
                />
              </div>
              <p className="text-[11px] text-text-muted">
                Node inspector values override these defaults. ANNOVAR scripts may need manual download from the ANNOVAR site before database installs can run.
              </p>
            </div>
          )}

          {section === 'Notifications' && (
            <div className="flex flex-col gap-3">
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

          {section === 'Advanced' && (
            <div className="rounded border border-border bg-bg-primary p-3 text-xs text-text-muted">
              Advanced runtime controls will land here as more cluster-specific knobs become necessary.
            </div>
          )}
        </div>
      </div>
    </Dialog>
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
