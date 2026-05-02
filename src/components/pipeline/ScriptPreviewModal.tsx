import { useEffect, useMemo, useState } from 'react'
import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import type { DryRunScript } from '@/types/pipeline'

interface Props {
  scripts: DryRunScript[]
  onClose: () => void
}

export function ScriptPreviewModal({ scripts, onClose }: Props) {
  const [selectedId, setSelectedId] = useState(scripts[0]?.nodeId ?? '')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setSelectedId((current) => (scripts.some((script) => script.nodeId === current) ? current : scripts[0]?.nodeId ?? ''))
  }, [scripts])

  const selectedScript = useMemo(
    () => scripts.find((script) => script.nodeId === selectedId) ?? scripts[0] ?? null,
    [scripts, selectedId],
  )

  const handleCopy = async () => {
    if (!selectedScript?.script) return
    await copyText(selectedScript.script)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Preview generated scripts"
      subtitle="Dry-run only. No files are written and no Slurm jobs are submitted."
      className="bioflow-workbench-dialog"
      bodyClassName="bioflow-workbench-body"
    >
        <div className="flex min-h-0 flex-1">
          <div className="w-72 overflow-y-auto border-r border-border bg-bg-secondary/40">
            {scripts.length === 0 ? (
              <div className="p-4 text-xs text-text-muted">No runnable nodes.</div>
            ) : (
              scripts.map((script) => (
                <button
                  key={script.nodeId}
                  onClick={() => setSelectedId(script.nodeId)}
                  className={`w-full border-b border-border-light/60 px-3 py-2 text-left hover:bg-bg-hover ${
                    selectedScript?.nodeId === script.nodeId ? 'border-l-2 border-l-accent bg-bg-hover' : ''
                  }`}
                >
                  <div className="truncate text-xs text-text-primary">{script.label}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-text-muted">
                    <span>{formatMode(script)}</span>
                    {script.arraySize ? <span>{script.arraySize} tasks</span> : null}
                  </div>
                  {script.summary ? (
                    <div className="mt-1 line-clamp-2 text-[10px] text-text-muted">{script.summary}</div>
                  ) : null}
                </button>
              ))
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-border-light bg-bg-secondary/30 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-text-primary">
                  {selectedScript?.label || 'No step selected'}
                </div>
                <div className="truncate text-[10px] text-text-muted">
                  {selectedScript ? formatMode(selectedScript) : 'No runnable nodes.'}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                icon={<Copy size={11} />}
                onClick={() => void handleCopy()}
                disabled={!selectedScript}
                className="h-6 px-2 text-[10px]"
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>

            {selectedScript ? (
              <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_280px]">
                <div className="min-h-0 overflow-auto p-3">
                  <pre className="m-0 whitespace-pre-wrap rounded-md border border-border bg-bg-primary p-3 text-[11px] leading-relaxed text-slate-100">
                    {selectedScript.script}
                  </pre>
                </div>
                <div className="min-h-0 overflow-auto border-l border-border bg-bg-secondary/20 p-3">
                  <div className="rounded-md border border-border bg-bg-secondary p-3">
                    <div className="text-[10px] uppercase tracking-wide text-text-muted">Summary</div>
                    <div className="mt-1 text-sm text-text-primary">
                      {selectedScript.summary || 'No summary available.'}
                    </div>
                  </div>

                  <div className="mt-3 rounded-md border border-border bg-bg-secondary p-3">
                    <div className="text-[10px] uppercase tracking-wide text-text-muted">Commands</div>
                    <div className="mt-2 space-y-2">
                      {(selectedScript.commands && selectedScript.commands.length > 0 ? selectedScript.commands : ['No extracted commands.']).map((command, index) => (
                        <pre key={index} className="m-0 whitespace-pre-wrap rounded border border-border-light bg-bg-tertiary p-2 font-mono text-[10px] text-text-primary">
                          {command}
                        </pre>
                      ))}
                    </div>
                  </div>

                  <div className="mt-3 rounded-md border border-border bg-bg-secondary p-3">
                    <div className="text-[10px] uppercase tracking-wide text-text-muted">Outputs</div>
                    <div className="mt-2 space-y-2">
                      {(selectedScript.outputPaths.length > 0 ? selectedScript.outputPaths : ['No declared outputs.']).map((path, index) => (
                        <div key={index} className="break-all rounded border border-border-light bg-bg-tertiary p-2 font-mono text-[10px] text-text-primary">
                          {path}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
                No runnable nodes.
              </div>
            )}
          </div>
        </div>
    </Dialog>
  )
}

function formatMode(script: DryRunScript): string {
  if (script.mode === 'array') return `Array job${script.arraySize ? ` (${script.arraySize} tasks)` : ''}`
  if (script.mode === 'fanIn') return 'Fan-in dependency job'
  if (script.mode === 'branchFanIn') return 'Branch fan-in job'
  if (script.mode === 'skip') return 'Skipped'
  return 'Single job'
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // Fallback for Electron clipboard permission quirks.
  }
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', 'true')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  document.execCommand('copy')
  document.body.removeChild(el)
}
