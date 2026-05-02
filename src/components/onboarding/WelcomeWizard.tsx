import { useEffect, useState } from 'react'
import type React from 'react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { HelpButton } from '@/components/ui/HelpButton'
import { LOCAL_CONNECTION_ID, useConnectionStore } from '@/stores/connectionStore'
import { useDnxStore } from '@/stores/dnxStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'

const STEPS = ['Welcome', 'SSH', 'Test', 'Slurm', 'Folders', 'DNAnexus', 'Done'] as const

export function WelcomeWizard() {
  const settings = useSettingsStore((s) => s.settings)
  const loaded = useSettingsStore((s) => s.loaded)
  const setSetting = useSettingsStore((s) => s.setSetting)
  const devMode = useSettingsStore((s) => s.devMode)
  const openConnectionDialog = useUIStore((s) => s.openConnectionDialog)
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const connections = useConnectionStore((s) => s.connections)
  const dnxAuthStatus = useDnxStore((s) => s.authStatus)
  const refreshProjects = useDnxStore((s) => s.refreshProjects)
  const [step, setStep] = useState(0)
  const [account, setAccount] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [forceOpen, setForceOpen] = useState(false)

  useEffect(() => {
    const open = () => {
      setStep(0)
      setMessage(null)
      setDismissed(false)
      setForceOpen(true)
    }
    window.addEventListener('bioflow:open-onboarding', open)
    return () => window.removeEventListener('bioflow:open-onboarding', open)
  }, [])

  useEffect(() => {
    if (!settings.onboardingComplete) setDismissed(false)
  }, [settings.onboardingComplete])

  if (!loaded || (!forceOpen && (settings.onboardingComplete || dismissed))) return null
  const visibleSteps = devMode ? STEPS : STEPS.filter((item) => item !== 'DNAnexus')
  const current = visibleSteps[Math.min(step, visibleSteps.length - 1)]
  const activeEntry = activeConnectionId ? connections[activeConnectionId] : null
  const hasActiveConnection = Boolean(activeEntry && activeEntry.status === 'connected')
  const hasSshConnection = Boolean(hasActiveConnection && activeConnectionId && activeConnectionId !== LOCAL_CONNECTION_ID)

  const finish = async () => {
    if (account.trim() && activeConnectionId) {
      await window.api.store.set(`connection:${activeConnectionId}:slurmAccount`, account.trim())
    }
    await setSetting('settings:onboardingComplete', true)
    setForceOpen(false)
  }

  const dismissForNow = () => {
    setMessage(null)
    setForceOpen(false)
    setDismissed(true)
  }

  const next = () => {
    setMessage(null)
    setStep((value) => Math.min(value + 1, visibleSteps.length - 1))
  }

  const back = () => {
    setMessage(null)
    setStep((value) => Math.max(0, value - 1))
  }

  return (
    <Dialog
      open
      onClose={dismissForNow}
      title="Welcome to BioFlow Studio"
      footer={(
        <div className="flex w-full items-center justify-between">
          <Button variant="secondary" onClick={() => void finish()}>Skip setup</Button>
          <div className="flex gap-2">
            {step > 0 && current !== 'Done' && (
              <Button variant="secondary" onClick={back}>Back</Button>
            )}
            {current === 'Done' ? (
              <Button onClick={() => void finish()}>Get started</Button>
            ) : (
              <Button onClick={next}>Continue</Button>
            )}
          </div>
        </div>
      )}
    >
      <div className="space-y-4">
        <div className="flex gap-1">
          {visibleSteps.map((item, index) => (
            <div key={item} className={`h-1 flex-1 rounded ${index <= step ? 'bg-accent' : 'bg-bg-tertiary'}`} />
          ))}
        </div>
        <div className="text-[11px] uppercase tracking-wide text-text-muted">
          Step {step + 1} of {visibleSteps.length} — {current}
        </div>

        {current === 'Welcome' && (
          <WizardSection helpId="onboarding.welcome" title="Build and run bioinformatics pipelines">
            <p>BioFlow Studio helps you build Slurm-backed GWAS and file-processing workflows without hand-writing every <code>sbatch</code> script.</p>
            <p className="mt-2">This setup takes about a minute. You can skip and come back later from <strong>Settings</strong>.</p>
          </WizardSection>
        )}

        {current === 'SSH' && (
          <WizardSection helpId="onboarding.connection" title="Connect to your cluster">
            <p>Add the SSH connection that BioFlow will use to submit jobs (Rorqual, your university cluster, …).</p>
            <p className="mt-1 text-[11px] text-text-muted">For Compute Canada / Alliance accounts the &quot;Password:&quot; prompt during login is your TOTP code, not your account password.</p>
            <div className="mt-3 flex items-center gap-3">
              <Button onClick={() => openConnectionDialog()}>Add connection</Button>
              <span className="text-xs text-text-secondary">
                {activeEntry ? `Active: ${activeEntry.config.name}` : 'No connection yet'}
              </span>
            </div>
          </WizardSection>
        )}

        {current === 'Test' && (
          <WizardSection helpId="onboarding.connection" title="Verify the connection works">
            <p className="text-sm">
              Active connection: <strong>{activeEntry ? activeEntry.config.name : 'none'}</strong>
              {activeEntry && (
                <span className={`ml-2 text-[11px] ${activeEntry.status === 'connected' ? 'text-green-400' : 'text-amber-400'}`}>
                  ({activeEntry.status})
                </span>
              )}
            </p>
            <Button
              className="mt-2"
              disabled={!hasSshConnection || testing}
              onClick={async () => {
                if (!activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID) {
                  setMessage('Connect to an SSH cluster before running the test.')
                  return
                }
                setTesting(true)
                setMessage('Running hostname && squeue --version on the cluster…')
                try {
                  const result = await window.api.ssh.exec(activeConnectionId, 'hostname && squeue --version')
                  if (result.exitCode === 0) {
                    setMessage(`✓ ${result.stdout.trim().split('\n').join(' — ')}`)
                  } else {
                    setMessage(`Connection responded but the test command failed: ${result.stderr || 'no output'}`)
                  }
                } catch (err) {
                  setMessage(`✗ ${err instanceof Error ? err.message : String(err)}`)
                } finally {
                  setTesting(false)
                }
              }}
            >
              {testing ? 'Testing…' : 'Run test'}
            </Button>
            {!hasActiveConnection && (
              <p className="mt-2 text-[11px] text-text-muted">No connected session yet — add or connect one in the previous step, or skip this check.</p>
            )}
            {message && <p className="mt-2 rounded border border-border bg-bg-tertiary px-3 py-2 text-xs text-text-secondary whitespace-pre-wrap">{message}</p>}
          </WizardSection>
        )}

        {current === 'Slurm' && (
          <WizardSection helpId="onboarding.slurm" title="Default Slurm account (optional)">
            <Input label="Account" value={account} placeholder="def-somepi" onChange={(e) => setAccount(e.target.value)} />
            <p className="mt-1 text-[11px] text-text-muted">
              On the cluster, run <code>sacctmgr show assoc user=$USER format=Account</code> or ask your lab admin. Leave blank if your cluster doesn&apos;t require one.
            </p>
          </WizardSection>
        )}

        {current === 'Folders' && (
          <WizardSection helpId="onboarding.paths" title="Run-folder layout (optional)">
            <p>Each pipeline run gets its own folder under <code className="rounded bg-bg-tertiary px-1">{settings.paths.runFolderTemplate}</code> on the cluster, with these subfolders. The defaults work for most labs — change them only if you have a strong preference.</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <SubfolderInput label="Scripts" settingKey="settings:paths:scriptsSubfolder" value={settings.paths.scriptsSubfolder} />
              <SubfolderInput label="Outputs" settingKey="settings:paths:outputsSubfolder" value={settings.paths.outputsSubfolder} />
              <SubfolderInput label="Logs" settingKey="settings:paths:logsSubfolder" value={settings.paths.logsSubfolder} />
            </div>
          </WizardSection>
        )}

        {current === 'DNAnexus' && (
          <WizardSection helpId="onboarding.dnx" title="DNAnexus RAP (developer-only)">
            <p>This step verifies DNAnexus auth and your default project. The RAP integration is in development; lab members without the developer PIN will not see this section.</p>
            <div className="mt-3 flex gap-2">
              <Button
                variant="secondary"
                onClick={() => void refreshProjects()
                  .then(() => setMessage('✓ DNAnexus project list loaded.'))
                  .catch((err) => setMessage(err instanceof Error ? err.message : String(err)))}
              >
                Test DNAnexus
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-text-muted">Status: {dnxAuthStatus}</p>
            {message && <p className="mt-2 rounded border border-border bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">{message}</p>}
          </WizardSection>
        )}

        {current === 'Done' && (
          <WizardSection helpId="onboarding.welcome" title="You&apos;re ready">
            <p>You can replay the guided tour from the <strong>Help → Build Your First Pipeline</strong> menu, and update any of these choices later under <strong>Settings</strong>.</p>
            <p className="mt-2">Drag a file or folder onto the canvas to start a pipeline.</p>
          </WizardSection>
        )}
      </div>
    </Dialog>
  )
}

function WizardSection({ title, helpId, children }: { title: string; helpId: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-lg font-semibold text-text-primary">{title}</h3>
        <HelpButton id={helpId} />
      </div>
      <div className="text-sm leading-relaxed text-text-secondary">{children}</div>
    </div>
  )
}

function SubfolderInput({ label, settingKey, value }: { label: string; settingKey: string; value: string }) {
  const setSetting = useSettingsStore((s) => s.setSetting)
  const [draft, setDraft] = useState(value)
  return (
    <div className="rounded border border-border bg-bg-tertiary p-3">
      <div className="text-xs font-medium text-text-primary">{label}</div>
      <Input
        className="mt-1"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const trimmed = draft.trim().replace(/^\/+|\/+$/g, '')
          if (trimmed && trimmed !== value) void setSetting(settingKey, trimmed)
          else setDraft(value)
        }}
      />
    </div>
  )
}
