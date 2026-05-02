import { useState } from 'react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { LOCAL_CONNECTION_ID, useConnectionStore } from '@/stores/connectionStore'
import { useSettingsStore } from '@/stores/settingsStore'

export function AnnovarSetupWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const settings = useSettingsStore((s) => s.settings)
  const setSetting = useSettingsStore((s) => s.setSetting)
  const [message, setMessage] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const scriptsPath = settings.annovarScriptsPath || `${settings.toolsRoot.replace(/\/+$/, '')}/annovar`
  const dbPath = settings.annovarDbPath || `${scriptsPath.replace(/\/+$/, '')}/humandb`
  const installCommand = [
    `mkdir -p ${shellQuote(scriptsPath)} ${shellQuote(dbPath)}`,
    `cd ${shellQuote(scriptsPath)}`,
    'echo "Place the ANNOVAR package contents here, including table_annovar.pl and annotate_variation.pl."',
    'echo "After the scripts are present, install databases from the node inspector or with annotate_variation.pl."',
  ].join(' && ')

  const runSetup = async () => {
    if (!activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID) {
      setMessage('Connect to Rorqual first.')
      return
    }
    setRunning(true)
    setMessage(null)
    try {
      const result = await window.api.ssh.exec(activeConnectionId, installCommand)
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `exit ${result.exitCode}`)
      await Promise.all([
        setSetting('settings:annovarScriptsPath', scriptsPath),
        setSetting('settings:annovarDbPath', dbPath),
      ])
      setMessage('Folders created and settings saved. Add the ANNOVAR scripts to the scripts folder, then install databases.')
    } catch (err: any) {
      setMessage(err?.message ?? String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="ANNOVAR setup">
      <div className="flex flex-col gap-3 text-xs text-text-secondary">
        <p>
          ANNOVAR is usually not a module on fresh Rorqual accounts. BioFlow can create the folder layout and save the paths, but the ANNOVAR scripts still need to come from the ANNOVAR download package.
        </p>
        <div className="rounded bg-bg-primary p-3 font-mono text-[11px] text-text-primary shadow-inner">
          <div>Scripts: {scriptsPath}</div>
          <div>Databases: {dbPath}</div>
        </div>
        <pre className="max-h-44 overflow-auto rounded bg-black/30 p-3 text-[11px] text-text-primary shadow-inner">{installCommand}</pre>
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" disabled={running || !activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID} onClick={() => void runSetup()}>
            {running ? 'Running...' : 'Create folders on login node'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => navigator.clipboard.writeText(installCommand)}>
            Copy command
          </Button>
          {message && <span className="text-[11px] text-text-muted">{message}</span>}
        </div>
      </div>
    </Dialog>
  )
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
