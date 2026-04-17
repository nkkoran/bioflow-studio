import { useMemo, useState } from 'react'
import { Copy, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { DryRunScript } from '@/types/pipeline'

interface Props {
  scripts: DryRunScript[]
  onClose: () => void
}

export function ScriptPreviewModal({ scripts, onClose }: Props) {
  const [selectedId, setSelectedId] = useState(scripts[0]?.nodeId ?? '')
  const selected = useMemo(
    () => scripts.find((script) => script.nodeId === selectedId) ?? scripts[0],
    [scripts, selectedId],
  )

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-[900px] max-w-[95vw] h-[720px] max-h-[90vh] flex flex-col rounded-xl border border-border bg-bg-primary shadow-2xl overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-bg-secondary">
          <div>
            <div className="text-sm font-semibold text-text-primary">Preview generated scripts</div>
            <div className="text-[11px] text-text-muted">Dry-run only. No files are written and no Slurm jobs are submitted.</div>
          </div>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            icon={<X size={13} />}
            onClick={onClose}
            className="h-7 px-2"
          />
        </div>

        <div className="flex-1 min-h-0 flex">
          <div className="w-64 border-r border-border-light overflow-y-auto bg-bg-secondary/40">
            {scripts.map((script) => (
              <button
                key={script.nodeId}
                onClick={() => setSelectedId(script.nodeId)}
                className={`w-full text-left px-3 py-2 border-l-2 border-b border-border-light/60 hover:bg-bg-hover ${
                  selected?.nodeId === script.nodeId ? 'border-accent bg-bg-hover' : 'border-transparent'
                }`}
              >
                <div className="text-xs text-text-primary truncate">{script.label}</div>
                <div className="text-[10px] text-text-muted">
                  {script.mode}{script.arraySize ? ` · array ${script.arraySize}` : ''}
                </div>
              </button>
            ))}
          </div>

          <div className="flex-1 min-w-0 flex flex-col">
            {selected ? (
              <>
                <div className="px-3 py-2 border-b border-border-light bg-bg-secondary/30">
                  <div className="flex items-center gap-2">
                    <div className="text-xs font-medium text-text-primary truncate">{selected.label}</div>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-hover text-text-secondary">{selected.mode}</span>
                    <div className="flex-1" />
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Copy size={11} />}
                      onClick={() => void navigator.clipboard.writeText(selected.script)}
                      className="h-6 px-2 text-[10px]"
                    >
                      Copy
                    </Button>
                  </div>
                  {selected.outputPaths.length > 0 && (
                    <div className="mt-1 text-[10px] text-text-muted font-mono truncate" title={selected.outputPaths.join('\n')}>
                      outputs: {selected.outputPaths.join(', ')}
                    </div>
                  )}
                </div>
                <pre className="flex-1 m-0 overflow-auto p-3 text-[11px] leading-relaxed font-mono bg-bg-primary text-text-primary whitespace-pre">
                  {selected.script}
                </pre>
              </>
            ) : (
              <div className="h-full flex items-center justify-center text-sm text-text-muted">
                No runnable nodes.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
