import { useState } from 'react'
import { Copy } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'

interface GuideCommand {
  label: string
  command: string
}

interface Guide {
  title: string
  summary: string
  disk: string
  pathHint: string
  commands: GuideCommand[]
}

const GUIDES: Record<string, Guide> = {
  'annovar-humandb': {
    title: 'ANNOVAR humandb',
    summary: 'Download ANNOVAR databases into a shared humandb folder, then set that folder on the ANNOVAR node.',
    disk: 'Usually tens of GB, depending on selected protocols.',
    pathHint: 'Use the humandb directory as the node database path, for example /project/<group>/<user>/annovar/humandb.',
    commands: [
      {
        label: 'Create database folder',
        command: 'mkdir -p /project/<group>/<user>/annovar/humandb',
      },
      {
        label: 'Download example databases',
        command: 'annotate_variation.pl -buildver hg38 -downdb -webfrom annovar refGene /project/<group>/<user>/annovar/humandb\nannotate_variation.pl -buildver hg38 -downdb -webfrom annovar gnomad211_exome /project/<group>/<user>/annovar/humandb',
      },
    ],
  },
  'vep-cache': {
    title: 'VEP cache',
    summary: 'Install the VEP cache on the login node, then point the VEP node at the cache root.',
    disk: 'Usually 20-50 GB for human cache data.',
    pathHint: 'Use the cache root as the node database path, for example /project/<group>/<user>/vep/cache.',
    commands: [
      {
        label: 'Create cache folder',
        command: 'mkdir -p /project/<group>/<user>/vep/cache',
      },
      {
        label: 'Install cache',
        command: 'vep_install -a cf -s homo_sapiens -y GRCh38 -c /project/<group>/<user>/vep/cache',
      },
    ],
  },
}

export function DatasetGuideDialog({
  guideKey,
  open,
  onClose,
}: {
  guideKey: string | null
  open: boolean
  onClose: () => void
}) {
  const guide = guideKey ? GUIDES[guideKey] : null
  const [copied, setCopied] = useState<string | null>(null)

  if (!guide) return null

  const copy = async (label: string, command: string) => {
    await navigator.clipboard.writeText(command)
    setCopied(label)
    window.setTimeout(() => setCopied(null), 1500)
  }

  return (
    <Dialog open={open} onClose={onClose} title={guide.title} width="max-w-2xl">
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-text-secondary">{guide.summary}</p>
        <div className="rounded border border-border bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">
          <div><span className="text-text-muted">Expected disk: </span>{guide.disk}</div>
          <div className="mt-1"><span className="text-text-muted">Set on node: </span>{guide.pathHint}</div>
        </div>
        {guide.commands.map((entry) => (
          <div key={entry.label} className="rounded border border-border bg-bg-primary">
            <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
              <span className="text-xs font-medium text-text-primary">{entry.label}</span>
              <Button
                variant="secondary"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => void copy(entry.label, entry.command)}
              >
                <Copy size={11} className="mr-1" />
                {copied === entry.label ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all p-3 text-xs text-text-secondary">{entry.command}</pre>
          </div>
        ))}
      </div>
    </Dialog>
  )
}
