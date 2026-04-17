/**
 * NodeInspector — right-side panel showing editable properties for the selected node.
 *
 * Dispatches to the appropriate editor based on node type:
 *   - tool → parameter editor + Slurm resource overrides
 *   - file → label, path (with file browser), file type
 *   - note → text, color
 *
 * All edits flow through `pipelineStore.updateNodeData`, which sets the dirty flag.
 */
import { X, Trash2, Copy, Plus, Folder } from 'lucide-react'
import { useCallback, useMemo } from 'react'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { usePipelineStore, useSelectedNode } from '@/stores/pipelineStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { useUIStore } from '@/stores/uiStore'
import { getTool } from '@/lib/toolRegistry'
import type {
  FileNodeData,
  FileNodeSplit,
  MergeNodeData,
  MergeStrategy,
  NoteNodeData,
  ToolNodeData,
  ToolParam,
} from '@/types/pipeline'
import { classNames } from '@/lib/utils'

function ParamField({
  param,
  value,
  onChange,
}: {
  param: ToolParam
  value: unknown
  onChange: (v: unknown) => void
}) {
  switch (param.type) {
    case 'boolean':
      return (
        <label className="flex items-center gap-2 cursor-pointer py-1">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="accent-accent"
          />
          <span className="text-xs text-text-primary">{param.label}</span>
          {param.required && <span className="text-error text-[10px]">*</span>}
        </label>
      )

    case 'number':
      return (
        <Input
          label={param.label + (param.required ? ' *' : '')}
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          min={param.min}
          max={param.max}
          step={param.step ?? 'any'}
          placeholder={param.placeholder}
          onChange={(e) => {
            const v = e.target.value
            onChange(v === '' ? undefined : Number(v))
          }}
        />
      )

    case 'select':
      return (
        <div className="flex flex-col gap-1">
          <label className="text-text-secondary text-xs font-medium">
            {param.label}
            {param.required && <span className="text-error ml-0.5">*</span>}
          </label>
          <select
            value={value === undefined ? '' : String(value)}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent focus:border-accent"
          >
            <option value="">-- select --</option>
            {param.options?.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </div>
      )

    case 'string':
    case 'file':
    default:
      return (
        <Input
          label={param.label + (param.required ? ' *' : '')}
          type="text"
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={param.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )
  }
}

function ToolInspector({ nodeId, data }: { nodeId: string; data: ToolNodeData }) {
  const updateNodeData = usePipelineStore((s) => s.updateNodeData)
  const nodes = usePipelineStore((s) => s.nodes)
  const edges = usePipelineStore((s) => s.edges)
  const tool = getTool(data.toolId)

  /**
   * Inputs whose upstream source carries an axis — either a file node with
   * `split` set, or a tool/merge upstream that itself ran as an array
   * (approximated here by checking file nodes only; the runner-side planner
   * handles propagation through tools).
   */
  const axedInputPorts = useMemo(() => {
    const result: Array<{ portId: string; axis: string }> = []
    for (const edge of edges) {
      if (edge.target !== nodeId) continue
      const portId = edge.targetHandle
      if (!portId) continue
      const src = nodes.find((n) => n.id === edge.source)
      if (!src) continue
      if (src.type === 'file') {
        const fd = src.data as FileNodeData
        if (fd.split?.axis && fd.split.items.length > 0) {
          result.push({ portId, axis: fd.split.axis })
        }
      }
    }
    return result
  }, [nodes, edges, nodeId])

  const setParam = useCallback(
    (name: string, value: unknown) => {
      updateNodeData(nodeId, {
        paramValues: { ...data.paramValues, [name]: value },
      })
    },
    [nodeId, data.paramValues, updateNodeData],
  )

  const setSlurm = useCallback(
    (patch: Partial<NonNullable<ToolNodeData['slurmOverride']>>) => {
      updateNodeData(nodeId, {
        slurmOverride: { ...data.slurmOverride, ...patch },
      })
    },
    [nodeId, data.slurmOverride, updateNodeData],
  )

  if (!tool) {
    return <div className="p-4 text-xs text-error">Unknown tool: {data.toolId}</div>
  }

  const slurm = { ...tool.slurm, ...data.slurmOverride }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div>
        <Input
          label="Label"
          value={data.label}
          onChange={(e) => updateNodeData(nodeId, { label: e.target.value })}
        />
        <div className="text-[10px] text-text-muted mt-2 flex flex-col gap-0.5">
          <div>Tool: <span className="font-mono text-text-secondary">{tool.id}</span></div>
          <div>Command: <span className="font-mono text-text-secondary">{tool.command}</span></div>
          {tool.module && <div>Module: <span className="font-mono text-text-secondary">{tool.module}</span></div>}
        </div>
        <p className="text-xs text-text-muted mt-2">{tool.description}</p>
      </div>

      {/* Parameters */}
      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Parameters
        </h4>
        <div className="flex flex-col gap-2">
          {tool.params.map((p) => (
            <ParamField
              key={p.name}
              param={p}
              value={data.paramValues[p.name]}
              onChange={(v) => setParam(p.name, v)}
            />
          ))}
          {tool.params.length === 0 && (
            <div className="text-xs text-text-muted italic">No parameters</div>
          )}
        </div>
      </div>

      {/* Array over (fan-out control) */}
      {axedInputPorts.length > 0 && (
        <div>
          <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
            Loop / Array
          </h4>
          <div className="flex flex-col gap-1">
            <label className="text-text-secondary text-xs font-medium">
              Array over input
            </label>
            <select
              value={data.arrayOver === null ? '__none__' : (data.arrayOver ?? '__auto__')}
              onChange={(e) => {
                const v = e.target.value
                if (v === '__auto__') updateNodeData(nodeId, { arrayOver: undefined })
                else if (v === '__none__') updateNodeData(nodeId, { arrayOver: null })
                else updateNodeData(nodeId, { arrayOver: v })
              }}
              className="h-8 rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent focus:border-accent"
            >
              <option value="__auto__">Auto (pick the only axed input)</option>
              <option value="__none__">No array (single job)</option>
              {axedInputPorts.map((p) => {
                const port = tool.inputs.find((ip) => ip.id === p.portId)
                return (
                  <option key={p.portId} value={p.portId}>
                    {port?.label ?? p.portId} — axis "{p.axis}"
                  </option>
                )
              })}
            </select>
            <p className="text-[10px] text-text-muted mt-1">
              {axedInputPorts.length === 1
                ? 'Auto-fans out over the single axed input.'
                : 'Multiple axed inputs detected — pick one to fan out over.'}
            </p>
          </div>
        </div>
      )}

      {/* Slurm resources */}
      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Slurm Resources
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <Input
            label="CPUs"
            type="number"
            min={1}
            value={slurm.cpus ?? ''}
            placeholder={String(tool.slurm?.cpus ?? 1)}
            onChange={(e) => setSlurm({ cpus: e.target.value ? Number(e.target.value) : undefined })}
          />
          <Input
            label="Memory (GB)"
            type="number"
            min={1}
            value={slurm.memoryGB ?? ''}
            placeholder={String(tool.slurm?.memoryGB ?? 4)}
            onChange={(e) => setSlurm({ memoryGB: e.target.value ? Number(e.target.value) : undefined })}
          />
          <Input
            label="Time (hours)"
            type="number"
            min={0.1}
            step={0.5}
            value={slurm.timeHours ?? ''}
            placeholder={String(tool.slurm?.timeHours ?? 1)}
            onChange={(e) => setSlurm({ timeHours: e.target.value ? Number(e.target.value) : undefined })}
          />
          <Input
            label="Partition"
            type="text"
            value={slurm.partition ?? ''}
            placeholder={tool.slurm?.partition ?? 'default'}
            onChange={(e) => setSlurm({ partition: e.target.value || undefined })}
          />
        </div>
      </div>

      {/* Execution status */}
      {(data.status && data.status !== 'idle') && (
        <div>
          <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
            Execution
          </h4>
          <div className="flex flex-col gap-1 text-xs">
            <div>Status: <span className="text-text-primary font-medium">{data.status}</span></div>
            {data.jobId && <div>Job ID: <span className="font-mono text-text-primary">{data.jobId}</span></div>}
            {data.error && (
              <div className="px-2 py-1 rounded bg-error/10 border border-error/20 text-error text-[11px]">
                {data.error}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function FileInspector({ nodeId, data }: { nodeId: string; data: FileNodeData }) {
  const updateNodeData = usePipelineStore((s) => s.updateNodeData)
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)

  const split = data.split

  const setSplit = useCallback(
    (next: FileNodeSplit | undefined) => {
      updateNodeData(nodeId, { split: next })
    },
    [nodeId, updateNodeData],
  )

  const addRow = useCallback(() => {
    const items = split?.items ?? []
    setSplit({
      axis: split?.axis ?? 'chrom',
      items: [...items, { key: String(items.length + 1), path: '' }],
      glob: split?.glob,
    })
  }, [split, setSplit])

  const updateRow = useCallback(
    (i: number, patch: Partial<{ key: string; path: string }>) => {
      if (!split) return
      const items = split.items.map((row, idx) => (idx === i ? { ...row, ...patch } : row))
      setSplit({ ...split, items })
    },
    [split, setSplit],
  )

  const removeRow = useCallback(
    (i: number) => {
      if (!split) return
      setSplit({ ...split, items: split.items.filter((_, idx) => idx !== i) })
    },
    [split, setSplit],
  )

  const resolveGlob = useCallback(async () => {
    if (!split) return
    const pattern = split.glob?.trim()
    if (!pattern) {
      alert('Set a glob pattern first, e.g. /path/to/chr{1..22}.pgen')
      return
    }
    if (!activeConnectionId) {
      alert('Connect to a host first')
      return
    }

    const range = pattern.match(/^(.*)\{(\d+)\.\.(\d+)\}(.*)$/)
    if (range) {
      const [, prefix, startS, endS, suffix] = range
      const start = Number(startS)
      const end = Number(endS)
      const items: FileNodeSplit['items'] = []
      for (let k = start; k <= end; k++) {
        items.push({ key: String(k), path: `${prefix}${k}${suffix}` })
      }
      setSplit({ ...split, items })
      return
    }

    const starIdx = pattern.indexOf('*')
    if (starIdx >= 0) {
      const dir = pattern.slice(0, pattern.lastIndexOf('/'))
      try {
        const entries = await window.api.sftp.ls(activeConnectionId, dir)
        const re = new RegExp(
          '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '(.+)') + '$',
        )
        const items: FileNodeSplit['items'] = []
        for (const e of entries) {
          const m = re.exec(e.path)
          if (m) items.push({ key: m[1], path: e.path })
        }
        items.sort((a, b) => {
          const na = Number(a.key)
          const nb = Number(b.key)
          if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
          return a.key.localeCompare(b.key)
        })
        setSplit({ ...split, items })
      } catch (err: any) {
        alert(`Could not list ${dir}: ${err?.message ?? err}`)
      }
      return
    }

    alert('Pattern must contain {N..M} range or a * wildcard')
  }, [split, setSplit, activeConnectionId])

  return (
    <div className="flex flex-col gap-3">
      <Input
        label="Label"
        value={data.label}
        onChange={(e) => updateNodeData(nodeId, { label: e.target.value })}
      />
      <div className="flex flex-col gap-1">
        <label className="text-text-secondary text-xs font-medium">Remote path</label>
        <div className="flex items-end gap-1.5">
          <Input
            value={data.path}
            placeholder="/project/username/data/input.vcf.gz"
            onChange={(e) => updateNodeData(nodeId, { path: e.target.value })}
            className="flex-1"
          />
          <Button
            variant="secondary"
            size="sm"
            className="h-8 px-2 shrink-0"
            title="Pick a file from the sidebar"
            onClick={() =>
              useUIStore.getState().startFilePick({
                nodeId,
                requesterLabel: data.label,
                accept: data.fileType !== 'any' ? [data.fileType] : undefined,
              })
            }
          >
            <Folder size={12} className="mr-1" />
            Pick…
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-text-secondary text-xs font-medium">File type</label>
        <select
          value={data.fileType}
          onChange={(e) => updateNodeData(nodeId, { fileType: e.target.value as FileNodeData['fileType'] })}
          className="h-8 rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent focus:border-accent"
        >
          {['any', 'vcf', 'bcf', 'fastq', 'fasta', 'bam', 'sam', 'cram', 'bed', 'gff', 'gtf', 'plink', 'bgen', 'pgen', 'tsv', 'csv', 'txt', 'json', 'yaml'].map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={data.isInput}
          onChange={(e) => updateNodeData(nodeId, { isInput: e.target.checked })}
          className="accent-accent"
        />
        <span className="text-xs text-text-primary">Input file (vs. output)</span>
      </label>

      {/* Split by axis (enables per-axis SLURM arrays downstream) */}
      <div className="border-t border-border pt-3 mt-1">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium">
            Split by axis
          </h4>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={!!split}
              onChange={(e) => {
                if (e.target.checked) {
                  setSplit({ axis: 'chrom', items: [] })
                } else {
                  setSplit(undefined)
                }
              }}
              className="accent-accent"
            />
            <span className="text-[11px] text-text-secondary">Enable</span>
          </label>
        </div>

        {split && (
          <div className="flex flex-col gap-2">
            <Input
              label="Axis name"
              value={split.axis}
              placeholder="chrom"
              onChange={(e) => setSplit({ ...split, axis: e.target.value })}
            />
            <div className="flex flex-col gap-1">
              <label className="text-text-secondary text-xs font-medium">
                Glob / range (optional helper)
              </label>
              <div className="flex gap-1">
                <input
                  type="text"
                  value={split.glob ?? ''}
                  placeholder="/path/chr{1..22}.pgen"
                  onChange={(e) => setSplit({ ...split, glob: e.target.value })}
                  className="h-8 flex-1 rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent focus:border-accent font-mono"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={resolveGlob}
                  className="h-8 px-2 text-[11px]"
                  title="Resolve glob to items"
                >
                  <Folder size={12} />
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between mt-1">
              <label className="text-text-secondary text-xs font-medium">
                Items ({split.items.length})
              </label>
              <button
                onClick={addRow}
                className="flex items-center gap-1 text-[11px] text-accent hover:underline"
              >
                <Plus size={10} /> Add
              </button>
            </div>
            <div className="flex flex-col gap-1 max-h-56 overflow-y-auto">
              {split.items.map((row, i) => (
                <div key={i} className="flex gap-1 items-center">
                  <input
                    type="text"
                    value={row.key}
                    onChange={(e) => updateRow(i, { key: e.target.value })}
                    className="h-7 w-14 rounded border border-border bg-bg-tertiary px-1.5 text-xs text-text-primary font-mono"
                    placeholder="key"
                  />
                  <input
                    type="text"
                    value={row.path}
                    onChange={(e) => updateRow(i, { path: e.target.value })}
                    className="h-7 flex-1 rounded border border-border bg-bg-tertiary px-1.5 text-xs text-text-primary font-mono"
                    placeholder="/path/chrN.pgen"
                  />
                  <button
                    onClick={() => removeRow(i)}
                    className="p-1 rounded hover:bg-error/20 text-text-muted hover:text-error transition-colors"
                    title="Remove"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
              {split.items.length === 0 && (
                <div className="text-[11px] text-text-muted italic px-1">
                  No items — add rows or resolve a glob.
                </div>
              )}
            </div>
            <p className="text-[10px] text-text-muted">
              Downstream tools will auto-fan-out over axis "{split.axis || '?'}".
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

const MERGE_STRATEGIES: { value: MergeStrategy; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto (by upstream type)', hint: 'Picks the best strategy from the upstream file type.' },
  { value: 'tsv-concat-header', label: 'TSV concat (keep header)', hint: 'Keep first header, append data rows from each task.' },
  { value: 'bcftools-concat', label: 'bcftools concat', hint: 'VCF/BCF per-chrom outputs → single VCF.' },
  { value: 'plink-pmerge-list', label: 'plink2 --pmerge-list', hint: 'Merge per-chrom PLINK2 filesets.' },
  { value: 'cat', label: 'cat (plain concat)', hint: 'Fallback: shell cat of all per-task outputs.' },
]

function MergeInspector({ nodeId, data }: { nodeId: string; data: MergeNodeData }) {
  const updateNodeData = usePipelineStore((s) => s.updateNodeData)

  const setSlurm = useCallback(
    (patch: Partial<NonNullable<MergeNodeData['slurmOverride']>>) => {
      updateNodeData(nodeId, {
        slurmOverride: { ...data.slurmOverride, ...patch },
      })
    },
    [nodeId, data.slurmOverride, updateNodeData],
  )

  const selectedStrategy = MERGE_STRATEGIES.find((s) => s.value === data.strategy)

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Input
          label="Label"
          value={data.label}
          onChange={(e) => updateNodeData(nodeId, { label: e.target.value })}
        />
        <p className="text-xs text-text-muted mt-2">
          Collapses an axed edge (per-chrom, per-sample, ...) back into a single
          file. Submitted as a single Slurm job with
          <code className="px-1 font-mono text-[11px]">--dependency=afterok</code>
          on the upstream array.
        </p>
      </div>

      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Strategy
        </h4>
        <select
          value={data.strategy}
          onChange={(e) => updateNodeData(nodeId, { strategy: e.target.value as MergeStrategy })}
          className="h-8 w-full rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent focus:border-accent"
        >
          {MERGE_STRATEGIES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        {selectedStrategy && (
          <p className="text-[10px] text-text-muted mt-1">{selectedStrategy.hint}</p>
        )}
      </div>

      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Slurm Resources
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <Input
            label="CPUs"
            type="number"
            min={1}
            value={data.slurmOverride?.cpus ?? ''}
            placeholder="1"
            onChange={(e) => setSlurm({ cpus: e.target.value ? Number(e.target.value) : undefined })}
          />
          <Input
            label="Memory (GB)"
            type="number"
            min={1}
            value={data.slurmOverride?.memoryGB ?? ''}
            placeholder="4"
            onChange={(e) => setSlurm({ memoryGB: e.target.value ? Number(e.target.value) : undefined })}
          />
          <Input
            label="Time (hours)"
            type="number"
            min={0.1}
            step={0.5}
            value={data.slurmOverride?.timeHours ?? ''}
            placeholder="1"
            onChange={(e) => setSlurm({ timeHours: e.target.value ? Number(e.target.value) : undefined })}
          />
          <Input
            label="Partition"
            type="text"
            value={data.slurmOverride?.partition ?? ''}
            placeholder="default"
            onChange={(e) => setSlurm({ partition: e.target.value || undefined })}
          />
        </div>
      </div>

      {data.status && data.status !== 'idle' && (
        <div>
          <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
            Execution
          </h4>
          <div className="flex flex-col gap-1 text-xs">
            <div>Status: <span className="text-text-primary font-medium">{data.status}</span></div>
            {data.jobId && <div>Job ID: <span className="font-mono text-text-primary">{data.jobId}</span></div>}
            {data.error && (
              <div className="px-2 py-1 rounded bg-error/10 border border-error/20 text-error text-[11px]">
                {data.error}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function NoteInspector({ nodeId, data }: { nodeId: string; data: NoteNodeData }) {
  const updateNodeData = usePipelineStore((s) => s.updateNodeData)
  const colors = ['#fbbf24', '#f87171', '#60a5fa', '#34d399', '#c084fc']

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className="text-text-secondary text-xs font-medium">Text</label>
        <textarea
          value={data.text}
          onChange={(e) => updateNodeData(nodeId, { text: e.target.value })}
          rows={6}
          className="rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent focus:border-accent resize-none"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-text-secondary text-xs font-medium">Color</label>
        <div className="flex gap-2">
          {colors.map((c) => (
            <button
              key={c}
              onClick={() => updateNodeData(nodeId, { color: c })}
              className={classNames(
                'w-6 h-6 rounded-full border-2 transition-all',
                data.color === c ? 'border-text-primary scale-110' : 'border-transparent',
              )}
              style={{ background: c }}
              aria-label={`Color ${c}`}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export function NodeInspector() {
  const node = useSelectedNode()
  const setSelectedNode = usePipelineStore((s) => s.setSelectedNode)
  const deleteNode = usePipelineStore((s) => s.deleteNode)
  const duplicateNode = usePipelineStore((s) => s.duplicateNode)

  if (!node) {
    return (
      <div className="w-80 h-full bg-bg-secondary border-l border-border flex items-center justify-center">
        <p className="text-xs text-text-muted text-center px-6">
          Select a node on the canvas to edit its properties.
        </p>
      </div>
    )
  }

  return (
    <div className="w-80 h-full bg-bg-secondary border-l border-border flex flex-col">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wide text-text-muted font-medium">
          {node.type} inspector
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => duplicateNode(node.id)}
            className="p-1 rounded hover:bg-bg-tertiary text-text-muted hover:text-text-primary transition-colors"
            title="Duplicate"
          >
            <Copy size={12} />
          </button>
          <button
            onClick={() => deleteNode(node.id)}
            className="p-1 rounded hover:bg-error/20 text-text-muted hover:text-error transition-colors"
            title="Delete"
          >
            <Trash2 size={12} />
          </button>
          <button
            onClick={() => setSelectedNode(null)}
            className="p-1 rounded hover:bg-bg-tertiary text-text-muted hover:text-text-primary transition-colors"
            title="Close"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-3">
        {node.type === 'tool' && (
          <ToolInspector nodeId={node.id} data={node.data as ToolNodeData} />
        )}
        {node.type === 'file' && (
          <FileInspector nodeId={node.id} data={node.data as FileNodeData} />
        )}
        {node.type === 'merge' && (
          <MergeInspector nodeId={node.id} data={node.data as MergeNodeData} />
        )}
        {node.type === 'note' && (
          <NoteInspector nodeId={node.id} data={node.data as NoteNodeData} />
        )}
      </div>
    </div>
  )
}
