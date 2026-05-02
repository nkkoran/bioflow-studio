import { useEffect, useMemo, useState } from 'react'
import { Pencil, RefreshCw, Sparkles, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { SPARK_INSTANCE_TYPES } from '@/lib/dnxInstanceCatalog'
import { BUILTIN_UKB_FIELD_PRESETS } from '@/lib/ukbFieldPresets'
import { useDialogStore } from '@/stores/dialogStore'
import { useDnxStore } from '@/stores/dnxStore'

export function DnanexusSettingsPanel() {
  const authStatus = useDnxStore((s) => s.authStatus)
  const bootstrapStatus = useDnxStore((s) => s.bootstrapStatus)
  const defaultProjectId = useDnxStore((s) => s.defaultProjectId)
  const availableProjects = useDnxStore((s) => s.availableProjects)
  const bridgeStatus = useDnxStore((s) => s.bridgeStatus)
  const load = useDnxStore((s) => s.load)
  const setToken = useDnxStore((s) => s.setToken)
  const clearToken = useDnxStore((s) => s.clearToken)
  const setDefaultProject = useDnxStore((s) => s.setDefaultProject)
  const runBootstrap = useDnxStore((s) => s.runBootstrap)
  const authenticate = useDnxStore((s) => s.authenticate)
  const refreshProjects = useDnxStore((s) => s.refreshProjects)
  const saveFieldPresets = useDnxStore((s) => s.saveFieldPresets)
  const fieldPresets = useDnxStore((s) => s.fieldPresets)
  const refreshInstanceCatalog = useDnxStore((s) => s.refreshInstanceCatalog)
  const instanceCatalog = useDnxStore((s) => s.instanceCatalog)
  const installedAppletHash = useDnxStore((s) => s.installedAppletHash)
  const installedAppletId = useDnxStore((s) => s.installedAppletId)
  const setInstalledAppletInfo = useDnxStore((s) => s.setInstalledAppletInfo)
  const appletInstallProgress = useDnxStore((s) => s.appletInstallProgress)
  const loaded = useDnxStore((s) => s.loaded)
  const authToken = useDnxStore((s) => s.authToken)
  const promptDialog = useDialogStore((s) => s.prompt)
  const confirmDialog = useDialogStore((s) => s.confirm)

  const [tokenDraft, setTokenDraft] = useState('')
  const [busy, setBusy] = useState<'bootstrap' | 'test' | 'projects' | 'instances' | 'applet' | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!loaded) void load()
  }, [load, loaded])

  useEffect(() => {
    setTokenDraft(authToken ?? '')
  }, [authToken])

  const projectOptions = useMemo(() => {
    return availableProjects.map((project) => ({ value: project.id, label: project.name }))
  }, [availableProjects])

  const instanceSpecs = instanceCatalog?.specs?.length ? instanceCatalog.specs : SPARK_INSTANCE_TYPES

  const saveToken = async () => {
    if (!tokenDraft.trim()) return
    try {
      await setToken(tokenDraft.trim())
      setMessage('Token saved.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const testConnection = async () => {
    setBusy('test')
    setMessage(null)
    try {
      await authenticate({ token: tokenDraft.trim() || undefined, projectId: defaultProjectId ?? undefined })
      await refreshProjects()
      setMessage('DNAnexus authentication succeeded and projects were refreshed.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const refreshProjectList = async () => {
    setBusy('projects')
    setMessage(null)
    try {
      await authenticate({ token: tokenDraft.trim() || undefined, projectId: defaultProjectId ?? undefined })
      const projects = await refreshProjects()
      setMessage(projects.length > 0 ? `Loaded ${projects.length} project${projects.length === 1 ? '' : 's'}.` : 'No projects were returned for this token.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const repairEnvironment = async () => {
    setBusy('bootstrap')
    setMessage(null)
    try {
      await runBootstrap()
      setMessage('Python bridge environment is ready.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const refreshInstances = async () => {
    setBusy('instances')
    setMessage(null)
    try {
      await authenticate({ token: tokenDraft.trim() || undefined, projectId: defaultProjectId ?? undefined })
      const catalog = await refreshInstanceCatalog()
      setMessage(`Loaded ${catalog.specs.length} instance type${catalog.specs.length === 1 ? '' : 's'}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const reinstallApplet = async () => {
    if (!defaultProjectId) return
    setBusy('applet')
    setMessage(null)
    try {
      await authenticate({ token: tokenDraft.trim() || undefined, projectId: defaultProjectId })
      const install = await window.api.dnx.ensureApplet({
        projectId: defaultProjectId,
        appletName: 'bioflow-ukb-extract',
      })
      await setInstalledAppletInfo({ appletId: install.appletId, hash: install.hash })
      setMessage('UKB extract applet is installed and ready.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const renamePreset = async (presetId: string) => {
    const preset = fieldPresets.find((item) => item.id === presetId)
    if (!preset) return
    const nextName = await promptDialog({
      title: 'Rename field preset',
      message: 'Choose a new preset name.',
      defaultValue: preset.name,
      confirmLabel: 'Rename',
    })
    if (!nextName?.trim()) return
    await saveFieldPresets(fieldPresets.map((item) => item.id === presetId ? { ...item, name: nextName.trim() } : item))
  }

  const deletePreset = async (presetId: string) => {
    const preset = fieldPresets.find((item) => item.id === presetId)
    if (!preset) return
    const confirmed = await confirmDialog({
      title: 'Delete preset',
      message: `Remove "${preset.name}" from saved DNAnexus field presets?`,
      confirmLabel: 'Delete preset',
      danger: true,
    })
    if (!confirmed) return
    await saveFieldPresets(fieldPresets.filter((item) => item.id !== presetId))
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md bg-bg-tertiary px-3 py-2 text-xs text-text-secondary shadow-inner">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-medium text-text-primary">Bridge status</div>
            <div className="mt-1">Python: {bootstrapStatus} · Auth: {authStatus}</div>
          </div>
          <div className="text-right text-[11px]">
            <div>Stored token: {authToken ? 'yes' : 'no'}</div>
            <div>Default project: {defaultProjectId || 'not set'}</div>
          </div>
        </div>
        {bridgeStatus && (
          <div className="mt-2 rounded bg-bg-secondary px-2 py-1.5 text-[11px] shadow-sm">
            <div className="font-medium text-text-primary">{bridgeStatus.level}</div>
            <div className="mt-1">{bridgeStatus.message}</div>
          </div>
        )}
        {message && (
          <div className="mt-2 rounded bg-accent/10 px-2 py-1.5 text-[11px] text-text-primary shadow-sm">
            {message}
          </div>
        )}
      </div>

      <Input
        label="Auth token"
        type="password"
        value={tokenDraft}
        placeholder="Paste a DNAnexus API token"
        onChange={(event) => setTokenDraft(event.target.value)}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => void saveToken()} disabled={!tokenDraft.trim()}>
          Save token
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void testConnection()} disabled={busy !== null}>
          {busy === 'test' ? 'Testing...' : 'Test connection'}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void refreshProjectList()} disabled={busy !== null}>
          {busy === 'projects' ? 'Refreshing...' : 'Refresh projects'}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void repairEnvironment()} disabled={busy !== null}>
          {busy === 'bootstrap' ? 'Repairing...' : 'Repair Python environment'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => {
          setTokenDraft('')
          void clearToken()
        }}>
          Clear token
        </Button>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-text-secondary">Default project</label>
        <select
          value={defaultProjectId ?? ''}
          onChange={(event) => void setDefaultProject(event.target.value || null)}
          className="bioflow-field h-8 w-full rounded-md px-2 text-sm text-text-primary outline-none"
        >
          <option value="">Choose a project</option>
          {projectOptions.map((project) => (
            <option key={project.value} value={project.value}>
              {project.label}
            </option>
          ))}
        </select>
      </div>

      <div className="rounded-md bg-bg-tertiary px-3 py-3 shadow-inner">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-text-primary">UKB extraction applet</div>
            <div className="mt-1 text-[11px] text-text-muted">
              Installs or refreshes the bundled <code className="font-mono">bioflow-ukb-extract</code> applet in the selected DNAnexus project.
            </div>
          </div>
          <Button variant="secondary" size="sm" icon={<Sparkles size={12} />} onClick={() => void reinstallApplet()} disabled={busy !== null || !defaultProjectId}>
            {busy === 'applet' ? 'Installing...' : installedAppletId ? 'Reinstall applet' : 'Install applet'}
          </Button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-text-secondary">
          <div className="rounded bg-bg-secondary px-2 py-2 shadow-sm">
            <div className="font-medium text-text-primary">Applet id</div>
            <div className="mt-1 break-all">{installedAppletId || 'Not installed yet'}</div>
          </div>
          <div className="rounded bg-bg-secondary px-2 py-2 shadow-sm">
            <div className="font-medium text-text-primary">Bundled hash</div>
            <div className="mt-1 break-all">{installedAppletHash || 'Unknown'}</div>
          </div>
        </div>
        {appletInstallProgress && (
          <div className="mt-3 rounded bg-accent/10 px-2 py-2 text-[11px] text-text-primary shadow-sm">
            <div className="font-medium capitalize">{appletInstallProgress.stage.replace('-', ' ')}</div>
            {appletInstallProgress.message && <div className="mt-1">{appletInstallProgress.message}</div>}
            {typeof appletInstallProgress.percent === 'number' && (
              <div className="mt-1 text-cyan-200">{appletInstallProgress.percent}%</div>
            )}
          </div>
        )}
      </div>

      <div className="rounded-md bg-bg-tertiary px-3 py-3 shadow-inner">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-text-primary">Instance catalog</div>
            <div className="mt-1 text-[11px] text-text-muted">
              Runtime specs are cached locally. Pricing is intentionally not stored in-app because RAP pricing changes.
            </div>
          </div>
          <Button variant="secondary" size="sm" icon={<RefreshCw size={12} />} onClick={() => void refreshInstances()} disabled={busy !== null}>
            {busy === 'instances' ? 'Refreshing...' : 'Refresh specs'}
          </Button>
        </div>
        <div className="mt-2 text-[11px] text-text-muted">
          Last refreshed: {instanceCatalog?.lastRefreshed ? new Date(instanceCatalog.lastRefreshed).toLocaleString() : 'Never'}
          {' · '}
          <a
            href="https://documentation.dnanexus.com/developer/api/running-analyses/instance-types"
            target="_blank"
            rel="noreferrer"
            className="text-accent underline"
          >
            View current pricing
          </a>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {instanceSpecs.map((spec) => (
            <div key={spec.id} className="rounded bg-bg-secondary px-2 py-2 text-[11px] text-text-secondary shadow-sm">
              <div className="font-medium text-text-primary">{spec.name}</div>
              <div className="mt-1">{spec.cpu} cores · {spec.memoryGB} GB RAM · {spec.localSsdGB ?? 0} GB SSD</div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-md bg-bg-tertiary px-3 py-3 shadow-inner">
        <div className="text-sm font-medium text-text-primary">Field presets</div>
        <div className="mt-1 text-[11px] text-text-muted">
          Built-in presets ship with BioFlow Studio. Saved presets are editable here and are reused by the node inspector and Quick Extract launcher.
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {BUILTIN_UKB_FIELD_PRESETS.map((preset) => (
            <div key={preset.id} className="rounded bg-bg-secondary px-2 py-2 text-[11px] text-text-secondary shadow-sm">
              <div className="font-medium text-text-primary">{preset.name}</div>
              <div className="mt-1">{preset.fields.length} field{preset.fields.length === 1 ? '' : 's'} · built in</div>
            </div>
          ))}
          {fieldPresets.map((preset) => (
            <div key={preset.id} className="rounded bg-bg-secondary px-2 py-2 text-[11px] text-text-secondary shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium text-text-primary">{preset.name}</div>
                  <div className="mt-1">{preset.fields.length} field{preset.fields.length === 1 ? '' : 's'} · saved</div>
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" className="rounded p-1 text-text-muted transition-colors hover:text-text-primary" onClick={() => void renamePreset(preset.id)} title="Rename preset">
                    <Pencil size={12} />
                  </button>
                  <button type="button" className="rounded p-1 text-text-muted transition-colors hover:text-error" onClick={() => void deletePreset(preset.id)} title="Delete preset">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </div>
          ))}
          {fieldPresets.length === 0 && (
            <div className="rounded bg-bg-secondary/60 px-2 py-2 text-[11px] text-text-muted shadow-inner">
              No saved presets yet. Save one from a UKB extraction node or from Quick Extract.
            </div>
          )}
        </div>
      </div>

      <p className="text-[11px] text-text-muted">
        The RAP bridge creates its own Python environment under BioFlow Studio&apos;s user data folder and installs <code className="font-mono">dxpy</code> there. Spark and <code className="font-mono">dxdata</code> stay on the RAP side.
      </p>
    </div>
  )
}
