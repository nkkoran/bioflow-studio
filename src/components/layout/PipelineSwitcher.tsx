import { useEffect, useState } from 'react'
import { ChevronDown, FilePlus2, Pencil } from 'lucide-react'
import { usePipelineStore } from '@/stores/pipelineStore'
import { savePipelineSnapshot } from '@/lib/pipelinePersistence'
import type { PipelineSnapshot } from '@/types/pipeline'

interface PipelineRow {
  id: string
  name: string
  updatedAt: number
}

export function PipelineSwitcher({ compact = false }: { compact?: boolean }) {
  const pipelineId = usePipelineStore((s) => s.pipelineId)
  const pipelineName = usePipelineStore((s) => s.pipelineName)
  const dirty = usePipelineStore((s) => s.dirty)
  const loadSnapshot = usePipelineStore((s) => s.loadSnapshot)
  const reset = usePipelineStore((s) => s.reset)
  const setPipelineName = usePipelineStore((s) => s.setPipelineName)
  const listPipelines = usePipelineStore((s) => s.listPipelines)
  const exportSnapshot = usePipelineStore((s) => s.exportSnapshot)
  const markSaved = usePipelineStore((s) => s.markSaved)
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<PipelineRow[]>([])

  const refresh = async () => {
    setRows(await listPipelines())
  }

  useEffect(() => {
    if (open) void refresh()
  }, [open])

  const switchTo = async (id: string) => {
    setOpen(false)
    if (id === pipelineId) return
    if (dirty && !confirm('Discard unsaved changes and switch pipelines?')) return
    const snap = await window.api.store.get<PipelineSnapshot>(`pipeline:${id}`)
    if (snap) loadSnapshot(snap)
  }

  const makeNew = () => {
    setOpen(false)
    if (dirty && !confirm('Discard unsaved changes and start a new pipeline?')) return
    reset()
  }

  const rename = async () => {
    setOpen(false)
    const next = prompt('Rename pipeline', pipelineName)
    if (!next || next === pipelineName) return
    setPipelineName(next)
    const snapshot = { ...exportSnapshot(), name: next, updatedAt: Date.now() }
    await savePipelineSnapshot(snapshot)
    markSaved()
  }

  const recentCutoff = Date.now() - 24 * 60 * 60 * 1000

  return (
    <div className="relative min-w-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex max-w-[280px] items-center gap-1 rounded px-2 py-1 text-sm font-semibold text-text-primary hover:bg-bg-hover"
        title={pipelineName}
      >
        <span className="truncate">{compact ? pipelineName : pipelineName || 'Untitled pipeline'}</span>
        {dirty && <span className="h-1.5 w-1.5 rounded-full bg-accent" title="Unsaved changes" />}
        <ChevronDown size={13} className="shrink-0 text-text-muted" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded border border-border bg-bg-secondary py-1 shadow-xl">
            {rows.map((row) => (
              <button
                key={row.id}
                onClick={() => void switchTo(row.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-bg-hover"
              >
                <span className={`h-1.5 w-1.5 rounded-full ${row.updatedAt > recentCutoff ? 'bg-accent' : 'bg-transparent'}`} />
                <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{row.name}</span>
                {row.id === pipelineId && <span className="text-[10px] text-accent">current</span>}
              </button>
            ))}
            {rows.length === 0 && (
              <div className="px-3 py-2 text-xs text-text-muted">No saved pipelines yet.</div>
            )}
            <div className="my-1 h-px bg-border" />
            <button onClick={makeNew} className="flex w-full items-center gap-2 px-3 py-2 text-xs text-text-primary hover:bg-bg-hover">
              <FilePlus2 size={12} /> New
            </button>
            <button onClick={() => void rename()} className="flex w-full items-center gap-2 px-3 py-2 text-xs text-text-primary hover:bg-bg-hover">
              <Pencil size={12} /> Rename...
            </button>
          </div>
        </>
      )}
    </div>
  )
}
