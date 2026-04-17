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
import { useCallback, useEffect, useMemo } from 'react'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { usePipelineStore, useSelectedNode } from '@/stores/pipelineStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { useUIStore } from '@/stores/uiStore'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import { getTool } from '@/lib/toolRegistry'
import {
  connectedInputPath,
  connectedInputSchema,
  delimiterForPath,
  parseHeaderLine,
} from '@/lib/schemaResolver'
import type {
  FileNodeData,
  FileNodeSplit,
  MergeNodeData,
  MergeStrategy,
  NoteNodeData,
  ToolNodeData,
  ToolParam,
  TransformFilterOp,
  TransformFilterRule,
  TransformNodeData,
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

function ColumnParamField({
  param,
  value,
  columns,
  loading,
  onChange,
}: {
  param: ToolParam
  value: unknown
  columns: string[]
  loading: boolean
  onChange: (v: unknown) => void
}) {
  const current = String(value ?? '')
  const selected = current.split(',').map((v) => v.trim()).filter(Boolean)
  const toggleColumn = (column: string) => {
    const next = selected.includes(column)
      ? selected.filter((value) => value !== column)
      : [...selected, column]
    onChange(next.join(','))
  }

  return (
    <div className="flex flex-col gap-1">
      <Input
        label={param.label + (param.required ? ' *' : '')}
        type="text"
        value={current}
        placeholder={columns.length > 0 ? 'Pick columns below or type names' : (loading ? 'Loading columns...' : param.placeholder)}
        onChange={(e) => onChange(e.target.value)}
      />
      {columns.length > 0 ? (
        <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
          {columns.map((column) => {
            const active = selected.includes(column)
            return (
              <button
                key={column}
                type="button"
                onClick={() => toggleColumn(column)}
                className={classNames(
                  'rounded border px-1.5 py-0.5 text-[10px]',
                  active
                    ? 'border-accent/50 bg-accent/10 text-text-primary'
                    : 'border-border bg-bg-primary text-text-muted hover:text-text-primary',
                )}
              >
                {active ? '✓ ' : ''}{column}
              </button>
            )
          })}
        </div>
      ) : (
        <p className="text-[10px] text-text-muted">
          {loading ? 'Reading the upstream header…' : 'Connect a tabular input or preview it once to enable column picks.'}
        </p>
      )}
    </div>
  )
}

function ShellScriptField({
  value,
  onChange,
}: {
  value: unknown
  onChange: (v: unknown) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-text-secondary text-xs font-medium">
        Shell script <span className="text-error">*</span>
      </label>
      <textarea
        value={value === undefined || value === null ? '' : String(value)}
        placeholder={'cat "$INPUT"'}
        onChange={(e) => onChange(e.target.value)}
        rows={7}
        className="rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent focus:border-accent resize-y font-mono leading-relaxed"
      />
      <div className="rounded-md border border-accent/20 bg-accent/5 px-2 py-1.5 text-[10px] text-text-secondary leading-relaxed">
        Connected files are available as <code className="font-mono text-text-primary">$INPUT</code>,{' '}
        <code className="font-mono text-text-primary">$INPUT_1</code>,{' '}
        <code className="font-mono text-text-primary">$INPUT_2</code>, and{' '}
        <code className="font-mono text-text-primary">{'${INPUTS[@]}'}</code> for all inputs. The node captures stdout into{' '}
        <code className="font-mono text-text-primary">$OUTPUT</code>, so{' '}
        <code className="font-mono text-text-primary">cat "$INPUT"</code> creates the output file.
      </div>
    </div>
  )
}

function ToolInspector({ nodeId, data }: { nodeId: string; data: ToolNodeData }) {
  const updateNodeData = usePipelineStore((s) => s.updateNodeData)
  const nodes = usePipelineStore((s) => s.nodes)
  const edges = usePipelineStore((s) => s.edges)
  const exportSnapshot = usePipelineStore((s) => s.exportSnapshot)
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const schemas = useDataPreviewStore((s) => s.schemas)
  const setSchema = useDataPreviewStore((s) => s.setSchema)
  const tool = getTool(data.toolId)
  const snapshot = useMemo(() => exportSnapshot(), [exportSnapshot, nodes, edges])
  const loadingSchemaKey = useMemo(() => `${nodeId}:${Object.keys(schemas).length}`, [nodeId, schemas])

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

  useEffect(() => {
    if (!activeConnectionId || !tool) return
    const refs = tool.params.filter((param) => param.columnRef)
    if (refs.length === 0) return
    let cancelled = false
    async function loadSchemas() {
      for (const param of refs) {
        const path = connectedInputPath(snapshot, nodeId, param.columnSourcePortId ?? 'input')
        if (!path || schemas[path]) continue
        try {
          const delimiter = delimiterForPath(path)
          const text = await window.api.sftp.head(activeConnectionId!, path, 1)
          if (cancelled) return
          const columns = parseHeaderLine(text, delimiter)
          if (columns.length > 0) setSchema(path, { columns, delimiter })
        } catch {
          // Missing schema is non-blocking; users can still type values.
        }
      }
    }
    void loadSchemas()
    return () => { cancelled = true }
  }, [activeConnectionId, loadingSchemaKey, nodeId, schemas, setSchema, snapshot, tool])

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
          {tool.params.map((p) => {
            const schema = p.columnRef
              ? connectedInputSchema(snapshot, nodeId, p.columnSourcePortId ?? 'input', schemas)
              : null
            const inputPath = p.columnRef
              ? connectedInputPath(snapshot, nodeId, p.columnSourcePortId ?? 'input')
              : null
            return tool.id === 'custom.shell' && p.name === 'script'
              ? (
                  <ShellScriptField
                    key={p.name}
                    value={data.paramValues[p.name]}
                    onChange={(v) => setParam(p.name, v)}
                  />
                )
              : p.columnRef
                ? (
                    <ColumnParamField
                      key={p.name}
                      param={p}
                      value={data.paramValues[p.name]}
                      columns={schema?.columns ?? []}
                      loading={Boolean(inputPath && !schema)}
                      onChange={(v) => setParam(p.name, v)}
                    />
                  )
              : (
                  <ParamField
                    key={p.name}
                    param={p}
                    value={data.paramValues[p.name]}
                    onChange={(v) => setParam(p.name, v)}
                  />
                )
          })}
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

      {/* Output folder override */}
      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Output folder
        </h4>
        <Input
          type="text"
          value={(data.outputDirOverride as string | undefined) ?? ''}
          placeholder="(default — run's outputs folder)"
          onChange={(e) =>
            updateNodeData(nodeId, { outputDirOverride: e.target.value || undefined })
          }
        />
        <p className="text-[10px] text-text-muted mt-1">
          Absolute path or <code className="font-mono">~/…</code>. Applies to this node only.
        </p>
      </div>

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
  const outputParts = !data.isInput ? splitOutputPath(data) : null

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
      {data.isInput ? (
        <div className="flex flex-col gap-1">
          <label className="text-text-secondary text-xs font-medium">Input file path</label>
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
      ) : (
        <div className="flex flex-col gap-2">
          <Input
            label="Output filename"
            value={outputParts?.filename ?? ''}
            placeholder="results.tsv"
            onChange={(e) => {
              const filename = e.target.value
              const folder = outputParts?.folder ?? ''
              updateNodeData(nodeId, {
                outputFilename: filename,
                outputDir: folder || undefined,
                path: joinOutputPath(folder, filename),
              })
            }}
          />
          <Input
            label="Output folder"
            value={outputParts?.folder ?? ''}
            placeholder="(default — connected tool output folder)"
            onChange={(e) => {
              const folder = e.target.value
              const filename = outputParts?.filename ?? ''
              updateNodeData(nodeId, {
                outputFilename: filename || undefined,
                outputDir: folder || undefined,
                path: joinOutputPath(folder, filename),
              })
            }}
          />
          <p className="text-[10px] text-text-muted">
            Connect a tool output to this node to name where that output should be written. Leave folder blank to use the tool's output folder.
          </p>
        </div>
      )}
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

function splitOutputPath(data: FileNodeData): { folder: string; filename: string } {
  if (data.outputFilename || data.outputDir) {
    return { folder: data.outputDir ?? '', filename: data.outputFilename ?? '' }
  }
  const path = data.path ?? ''
  const idx = path.lastIndexOf('/')
  if (idx < 0) return { folder: '', filename: path }
  return { folder: path.slice(0, idx), filename: path.slice(idx + 1) }
}

function joinOutputPath(folder: string, filename: string): string {
  if (!folder.trim()) return filename.trim()
  if (!filename.trim()) return folder.trim()
  return `${folder.replace(/\/+$/, '')}/${filename.trim()}`
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
          Output folder
        </h4>
        <Input
          type="text"
          value={(data.outputDirOverride as string | undefined) ?? ''}
          placeholder="(default — run's outputs folder)"
          onChange={(e) =>
            updateNodeData(nodeId, { outputDirOverride: e.target.value || undefined })
          }
        />
        <p className="text-[10px] text-text-muted mt-1">
          Absolute path or <code className="font-mono">~/…</code>. Applies to this merge only.
        </p>
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

const TRANSFORM_FILTER_OPS: Array<{ value: TransformFilterOp; label: string; needsValue: boolean }> = [
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'equals', label: 'equals', needsValue: true },
  { value: 'notEquals', label: 'does not equal', needsValue: true },
  { value: 'gt', label: '>', needsValue: true },
  { value: 'gte', label: '>=', needsValue: true },
  { value: 'lt', label: '<', needsValue: true },
  { value: 'lte', label: '<=', needsValue: true },
  { value: 'notEmpty', label: 'is not empty', needsValue: false },
]

function makeTransformFilter(column: string): TransformFilterRule {
  return {
    id: `filter-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    column,
    op: 'contains',
    value: '',
  }
}

function TransformInspector({ nodeId, data }: { nodeId: string; data: TransformNodeData }) {
  const updateNodeData = usePipelineStore((s) => s.updateNodeData)
  const nodes = usePipelineStore((s) => s.nodes)
  const edges = usePipelineStore((s) => s.edges)
  const exportSnapshot = usePipelineStore((s) => s.exportSnapshot)
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const schemas = useDataPreviewStore((s) => s.schemas)
  const previewFilters = useDataPreviewStore((s) => s.filters)
  const setSchema = useDataPreviewStore((s) => s.setSchema)
  const snapshot = useMemo(() => exportSnapshot(), [exportSnapshot, nodes, edges])
  const inputPath = connectedInputPath(snapshot, nodeId, 'input')
  const schema = connectedInputSchema(snapshot, nodeId, 'input', schemas)
  const columns = schema?.columns ?? []
  const selected = data.selectedColumns?.length ? data.selectedColumns : columns
  const filters = data.filters ?? []
  const renames = data.renames ?? []

  useEffect(() => {
    if (!activeConnectionId || !inputPath || schemas[inputPath]) return
    let cancelled = false
    async function loadSchema() {
      try {
        const delimiter = delimiterForPath(inputPath!)
        const text = await window.api.sftp.head(activeConnectionId!, inputPath!, 1)
        if (cancelled) return
        const parsed = parseHeaderLine(text, delimiter)
        if (parsed.length > 0) setSchema(inputPath!, { columns: parsed, delimiter })
      } catch {
        // A transform remains editable without schema; command generation will still run.
      }
    }
    void loadSchema()
    return () => { cancelled = true }
  }, [activeConnectionId, inputPath, schemas, setSchema])

  const setSlurm = useCallback(
    (patch: Partial<NonNullable<TransformNodeData['slurmOverride']>>) => {
      updateNodeData(nodeId, {
        slurmOverride: { ...data.slurmOverride, ...patch },
      })
    },
    [nodeId, data.slurmOverride, updateNodeData],
  )

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Input
          label="Label"
          value={data.label}
          onChange={(e) => updateNodeData(nodeId, { label: e.target.value })}
        />
        <p className="text-xs text-text-muted mt-2">
          Materializes preview-style row filters and column selection as a pipeline step.
        </p>
      </div>

      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Columns
        </h4>
        {columns.length > 0 ? (
          <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto">
            {columns.map((column) => {
              const active = selected.includes(column)
              return (
                <button
                  key={column}
                  onClick={() => {
                    const next = active
                      ? selected.filter((value) => value !== column)
                      : [...selected, column]
                    updateNodeData(nodeId, { selectedColumns: next.length > 0 ? next : [column] })
                  }}
                  className={classNames(
                    'rounded border px-1.5 py-0.5 text-[10px]',
                    active
                      ? 'border-accent/50 bg-accent/10 text-text-primary'
                      : 'border-border bg-bg-primary text-text-muted hover:text-text-primary',
                  )}
                >
                  {active ? '✓ ' : ''}{column}
                </button>
              )
            })}
          </div>
        ) : (
          <div className="rounded-md border border-border bg-bg-primary px-2 py-2 text-[11px] text-text-muted">
            Connect a tabular input to load column names. You can still run the transform with row filters that do not need column picks.
          </div>
        )}
        <div className="mt-2 flex items-center gap-2">
          <button
            className="text-[11px] text-accent hover:underline"
            onClick={() => updateNodeData(nodeId, { selectedColumns: columns })}
            disabled={columns.length === 0}
          >
            Select all
          </button>
          <button
            className="text-[11px] text-text-muted hover:text-text-primary"
            onClick={() => updateNodeData(nodeId, { selectedColumns: columns.slice(0, 8) })}
            disabled={columns.length === 0}
          >
            First 8
          </button>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium">
            Row filters
          </h4>
          <button
            className="text-[11px] text-accent hover:underline"
            onClick={() => updateNodeData(nodeId, { filters: [...filters, makeTransformFilter(columns[0] ?? '')] })}
          >
            Add filter
          </button>
        </div>
        <div className="flex flex-col gap-1">
          {filters.map((rule) => {
            const op = TRANSFORM_FILTER_OPS.find((candidate) => candidate.value === rule.op) ?? TRANSFORM_FILTER_OPS[0]
            return (
              <div key={rule.id} className="flex items-center gap-1">
                <select
                  value={rule.column}
                  onChange={(e) => updateNodeData(nodeId, { filters: filters.map((r) => r.id === rule.id ? { ...r, column: e.target.value } : r) })}
                  className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg-tertiary px-1.5 text-xs text-text-primary"
                >
                  {(columns.length > 0 ? columns : [rule.column]).map((column) => <option key={column} value={column}>{column || '(column)'}</option>)}
                </select>
                <select
                  value={rule.op}
                  onChange={(e) => {
                    const nextOp = e.target.value as TransformFilterOp
                    const nextMeta = TRANSFORM_FILTER_OPS.find((candidate) => candidate.value === nextOp)
                    updateNodeData(nodeId, { filters: filters.map((r) => r.id === rule.id ? { ...r, op: nextOp, value: nextMeta?.needsValue === false ? undefined : (r.value ?? '') } : r) })
                  }}
                  className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg-tertiary px-1.5 text-xs text-text-primary"
                >
                  {TRANSFORM_FILTER_OPS.map((candidate) => <option key={candidate.value} value={candidate.value}>{candidate.label}</option>)}
                </select>
                {op.needsValue && (
                  <input
                    value={rule.value ?? ''}
                    placeholder="value"
                    onChange={(e) => updateNodeData(nodeId, { filters: filters.map((r) => r.id === rule.id ? { ...r, value: e.target.value } : r) })}
                    className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg-tertiary px-1.5 text-xs text-text-primary"
                  />
                )}
                <button
                  onClick={() => updateNodeData(nodeId, { filters: filters.filter((r) => r.id !== rule.id) })}
                  className="h-7 px-1.5 rounded text-text-muted hover:bg-error/10 hover:text-error"
                >
                  <X size={10} />
                </button>
              </div>
            )
          })}
          {filters.length === 0 && (
            <div className="rounded-md border border-border bg-bg-primary px-2 py-1.5 text-[11px] text-text-muted">
              No row filters. All rows pass through.
            </div>
          )}
        </div>
        {inputPath && previewFilters[inputPath]?.length > 0 && (
          <button
            className="mt-2 text-[11px] text-accent hover:underline"
            onClick={() => updateNodeData(nodeId, { filters: previewFilters[inputPath] })}
          >
            Copy filters from current preview
          </button>
        )}
      </div>

      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Rename columns
        </h4>
        <div className="flex flex-col gap-1">
          {renames.map((rule, idx) => (
            <div key={`${rule.from}-${idx}`} className="flex items-center gap-1">
              <select
                value={rule.from}
                onChange={(e) => updateNodeData(nodeId, { renames: renames.map((r, i) => i === idx ? { ...r, from: e.target.value } : r) })}
                className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg-tertiary px-1.5 text-xs text-text-primary"
              >
                {(columns.length > 0 ? columns : [rule.from]).map((column) => <option key={column} value={column}>{column || '(column)'}</option>)}
              </select>
              <input
                value={rule.to}
                placeholder="new name"
                onChange={(e) => updateNodeData(nodeId, { renames: renames.map((r, i) => i === idx ? { ...r, to: e.target.value } : r) })}
                className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg-tertiary px-1.5 text-xs text-text-primary"
              />
              <button
                onClick={() => updateNodeData(nodeId, { renames: renames.filter((_, i) => i !== idx) })}
                className="h-7 px-1.5 rounded text-text-muted hover:bg-error/10 hover:text-error"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
        <button
          className="mt-2 text-[11px] text-accent hover:underline"
          onClick={() => updateNodeData(nodeId, { renames: [...renames, { from: columns[0] ?? '', to: '' }] })}
        >
          Add rename
        </button>
      </div>

      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Output
        </h4>
        <select
          value={data.fileType}
          onChange={(e) => updateNodeData(nodeId, { fileType: e.target.value as TransformNodeData['fileType'] })}
          className="h-8 w-full rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent focus:border-accent"
        >
          {['tsv', 'csv', 'txt', 'any'].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <Input
          type="text"
          value={(data.outputDirOverride as string | undefined) ?? ''}
          placeholder="(default — run's outputs folder)"
          onChange={(e) => updateNodeData(nodeId, { outputDirOverride: e.target.value || undefined })}
          className="mt-2"
        />
      </div>

      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Slurm Resources
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <Input label="CPUs" type="number" min={1} value={data.slurmOverride?.cpus ?? ''} placeholder="1" onChange={(e) => setSlurm({ cpus: e.target.value ? Number(e.target.value) : undefined })} />
          <Input label="Memory (GB)" type="number" min={1} value={data.slurmOverride?.memoryGB ?? ''} placeholder="4" onChange={(e) => setSlurm({ memoryGB: e.target.value ? Number(e.target.value) : undefined })} />
          <Input label="Time (hours)" type="number" min={0.1} step={0.5} value={data.slurmOverride?.timeHours ?? ''} placeholder="1" onChange={(e) => setSlurm({ timeHours: e.target.value ? Number(e.target.value) : undefined })} />
          <Input label="Partition" type="text" value={data.slurmOverride?.partition ?? ''} placeholder="default" onChange={(e) => setSlurm({ partition: e.target.value || undefined })} />
        </div>
      </div>
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
        {node.type === 'transform' && (
          <TransformInspector nodeId={node.id} data={node.data as TransformNodeData} />
        )}
        {node.type === 'note' && (
          <NoteInspector nodeId={node.id} data={node.data as NoteNodeData} />
        )}
      </div>
    </div>
  )
}
