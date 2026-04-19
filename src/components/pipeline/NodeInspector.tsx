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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { DatasetGuideDialog } from '@/components/settings/DatasetGuideDialog'
import { usePipelineStore, useSelectedNode } from '@/stores/pipelineStore'
import { LOCAL_CONNECTION_ID, useConnectionStore } from '@/stores/connectionStore'
import { useUIStore } from '@/stores/uiStore'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import { useFileSizeStore } from '@/stores/fileSizeStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { getTool } from '@/lib/toolRegistry'
import { estimateResources, type EstimateOutput } from '@/lib/resourceEstimator'
import { ANNOVAR_FEATURES, VEP_FEATURES, annovarDbNames, annovarParamsForFeatures } from '@/lib/annotationCatalog'
import {
  connectedInputPath,
  connectedInputSchema,
  delimiterForPath,
  parseHeaderLine,
} from '@/lib/schemaResolver'
import type {
  FileNodeData,
  FileNodeSplit,
  PipelineSnapshot,
  SplitPattern,
  MergeNodeData,
  MergeStrategy,
  NoteNodeData,
  ToolNodeData,
  ToolParam,
  ToolPort,
  TransformFilterOp,
  TransformFilterRule,
  TransformNodeData,
} from '@/types/pipeline'
import { classNames } from '@/lib/utils'

function connectedInputPaths(
  snapshot: PipelineSnapshot,
  nodeId: string,
): Record<string, string[]> {
  const paths: Record<string, string[]> = {}
  for (const edge of snapshot.edges) {
    if (edge.target !== nodeId) continue
    const portId = edge.targetHandle ?? 'input'
    const source = snapshot.nodes.find((node) => node.id === edge.source)
    if (!source) continue
    if (source.type === 'file') {
      const data = source.data as FileNodeData
      paths[portId] = data.split?.items.length
        ? data.split.items.map((item) => item.path).filter(Boolean)
        : data.path ? [data.path] : []
      continue
    }
    const path = connectedInputPath(snapshot, nodeId, portId)
    if (path) paths[portId] = [path]
  }
  return paths
}

function hasFilteringParam(data: ToolNodeData): boolean {
  const names = ['extract', 'keep', 'chr', 'region', 'regions', 'samples']
  return Object.entries(data.paramValues ?? {}).some(([name, value]) => {
    if (value === undefined || value === null || value === '' || value === false) return false
    return names.some((candidate) => name.toLowerCase().includes(candidate))
  })
}

function deviatesByTwo(current: number | undefined, suggested: number | undefined): boolean {
  if (!current || !suggested) return false
  return current >= suggested * 2 || current <= suggested / 2
}

function inspectorNodeLabel(node: PipelineSnapshot['nodes'][number]): string {
  const data = node.data as { label?: unknown; text?: unknown; path?: unknown }
  if (typeof data.label === 'string' && data.label.trim()) return data.label
  if (typeof data.path === 'string' && data.path.trim()) return data.path.split('/').pop() ?? data.path
  if (typeof data.text === 'string' && data.text.trim()) return data.text
  return node.id
}

function inputConnectionDetail(node: PipelineSnapshot['nodes'][number], sourceHandle: string): string {
  if (node.type === 'file') {
    const data = node.data as FileNodeData
    if (data.split?.items.length) return `${data.split.items.length} files split by ${data.split.axis}`
    return data.path || 'File path not set'
  }
  if (node.type === 'tool') return `Output: ${sourceHandle}`
  if (node.type === 'merge') return 'Merged output'
  if (node.type === 'transform') return 'Transformed output'
  return 'Connected'
}

function shellQuoteClient(value: string): string {
  if (/^[A-Za-z0-9_\-./~:]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

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

/**
 * Folder picker. Renders a text input + "Browse…" button that opens the
 * FileExplorer directory-pick banner and writes the chosen path back via
 * `onChange`.
 */
function FolderPickerField({
  label,
  value,
  placeholder,
  requesterLabel,
  onChange,
}: {
  label: string
  value: string
  placeholder?: string
  requesterLabel: string
  onChange: (value: string) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      {label && <label className="text-text-secondary text-xs font-medium">{label}</label>}
      <div className="flex items-end gap-1.5">
        <Input
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1"
        />
        <Button
          variant="secondary"
          size="sm"
          className="h-8 px-2 shrink-0"
          title="Browse folders in the sidebar"
          onClick={() =>
            useUIStore.getState().startFilePick({
              target: 'directory',
              requesterLabel,
              onResolve: ({ path }) => onChange(path),
            })
          }
        >
          <Folder size={12} className="mr-1" />
          Browse
        </Button>
      </div>
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

function ToolInputRow({
  port,
  connections,
  snapshot,
}: {
  port: ToolPort
  connections: PipelineSnapshot['edges']
  snapshot: PipelineSnapshot
}) {
  const missingRequired = port.required && connections.length === 0

  return (
    <div className={classNames(
      'rounded-md border px-2 py-1.5 text-xs',
      missingRequired ? 'border-error/40 bg-error/5' : 'border-border bg-bg-tertiary',
    )}>
      <div className="flex items-center gap-2">
        <span className="font-medium text-text-primary">{port.label}</span>
        <span className="rounded bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-muted">{port.fileType}</span>
        {port.required && <span className="rounded bg-error/10 px-1.5 py-0.5 text-[10px] text-error">required</span>}
        {port.multi && <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">multiple</span>}
      </div>
      <div className="mt-1 text-[11px] leading-relaxed text-text-muted">
        {port.description ?? `Connect a ${port.fileType} file here.`}
      </div>
      <div className="mt-1.5 flex flex-col gap-0.5">
        {connections.length === 0 ? (
          <div className={missingRequired ? 'text-error' : 'text-text-muted'}>
            {missingRequired ? `Connect a ${port.fileType} source before running.` : 'Optional input not connected.'}
          </div>
        ) : connections.map((edge) => {
          const source = snapshot.nodes.find((node) => node.id === edge.source)
          if (!source) return null
          const detail = inputConnectionDetail(source, edge.sourceHandle ?? 'output')
          return (
            <div key={edge.id} className="min-w-0 text-text-secondary">
              <span className="text-success">Connected</span>
              {' to '}
              <span className="text-text-primary">{inspectorNodeLabel(source)}</span>
              <span className="text-text-muted"> · {detail}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ToolOutputRow({
  port,
  consumers,
}: {
  port: ToolPort
  consumers: PipelineSnapshot['edges']
}) {
  return (
    <div className="rounded-md border border-border bg-bg-tertiary px-2 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium text-text-primary">{port.label}</span>
        <span className="rounded bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-muted">{port.fileType}</span>
      </div>
      <div className="mt-1 text-[11px] leading-relaxed text-text-muted">
        {port.description ?? `Produces a ${port.fileType} output.`}
      </div>
      <div className="mt-1.5 text-text-secondary">
        {consumers.length > 0
          ? `${consumers.length} downstream connection${consumers.length === 1 ? '' : 's'}`
          : 'Not connected downstream; the file is still written when the node runs.'}
      </div>
    </div>
  )
}

const ANNOTATION_INTERNAL_PARAMS = new Set([
  'toolPath',
  'annotationDbPath',
  'annotationFeatures',
  'buildver',
  'protocol',
  'operation',
  'remove',
  'nastring',
  'vcfinput',
  'assembly',
  'cache',
  'offline',
  'everything',
  'check_existing',
  'af_gnomad',
  'nearest',
  'fork',
])

function AnnotationConfigPanel({
  nodeId,
  data,
}: {
  nodeId: string
  data: ToolNodeData
}) {
  const updateNodeData = usePipelineStore((s) => s.updateNodeData)
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const settings = useSettingsStore((s) => s.settings)
  const setSetting = useSettingsStore((s) => s.setSetting)
  const [message, setMessage] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const isAnnovar = data.toolId === 'annovar.table_annovar'
  const isVep = data.toolId === 'vep'
  if (!isAnnovar && !isVep) return null

  const params = data.paramValues ?? {}
  const featureIds = String(params.annotationFeatures ?? (isAnnovar ? 'gene,rsid' : 'consequence,rsid'))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const build = String(params.buildver ?? 'hg38')
  const assembly = String(params.assembly ?? 'GRCh38')
  const toolsRoot = settings.toolsRoot || '~/bioflow/tools'
  const defaultToolPath = isAnnovar
    ? (settings.annovarScriptsPath || `${toolsRoot}/annovar`)
    : (settings.vepPath || `${toolsRoot}/ensembl-vep/vep`)
  const defaultDbPath = isAnnovar
    ? (settings.annovarDbPath || `${toolsRoot}/annovar/humandb`)
    : (settings.vepCachePath || `${toolsRoot}/vep/cache`)
  const toolPath = String(params.toolPath ?? '') || defaultToolPath
  const dbPath = String(params.annotationDbPath ?? '') || defaultDbPath

  const patchParams = (patch: Record<string, unknown>) => {
    updateNodeData(nodeId, { paramValues: { ...params, ...patch } })
  }

  const toggleAnnovarFeature = (id: string) => {
    const next = featureIds.includes(id) ? featureIds.filter((value) => value !== id) : [...featureIds, id]
    const generated = annovarParamsForFeatures(next)
    patchParams({ annotationFeatures: next.join(','), ...generated })
  }

  const toggleVepFeature = (id: string) => {
    const next = featureIds.includes(id) ? featureIds.filter((value) => value !== id) : [...featureIds, id]
    const selected = VEP_FEATURES.filter((feature) => next.includes(feature.id))
    const merged: Record<string, unknown> = {
      annotationFeatures: next.join(','),
      everything: false,
      check_existing: false,
      af_gnomad: false,
      nearest: undefined,
    }
    for (const feature of selected) Object.assign(merged, feature.params)
    patchParams(merged)
  }

  const runLoginCommand = async (command: string) => {
    if (!activeConnectionId) {
      setMessage('Connect to Rorqual before running a login-node installer.')
      return
    }
    setRunning(true)
    setMessage('Running on login node...')
    try {
      const result = await window.api.ssh.exec(activeConnectionId, command)
      setMessage(result.exitCode === 0 ? 'Finished.' : `Failed (${result.exitCode}): ${result.stderr || result.stdout}`)
    } catch (err: any) {
      setMessage(`Failed: ${err?.message ?? err}`)
    } finally {
      setRunning(false)
    }
  }

  const prepareToolCommand = () => {
    if (isAnnovar) {
      return [
        `mkdir -p ${shellQuoteClient(toolPath)} ${shellQuoteClient(dbPath)}`,
        `cat > ${shellQuoteClient(`${toolPath}/README_BioFlow.txt`)} <<'EOF'`,
        'ANNOVAR scripts are license-gated. Download ANNOVAR from https://annovar.openbioinformatics.org/, unpack table_annovar.pl and annotate_variation.pl into this folder, then use BioFlow to install databases.',
        'EOF',
      ].join('\n')
    }
    const vepDir = toolPath.endsWith('/vep') ? toolPath.slice(0, -4) : toolPath.replace(/\/+$/, '')
    return [
      `mkdir -p ${shellQuoteClient(toolsRoot)} ${shellQuoteClient(dbPath)}`,
      `cd ${shellQuoteClient(toolsRoot)}`,
      'if [ ! -d ensembl-vep ]; then git clone https://github.com/Ensembl/ensembl-vep.git; fi',
      `cd ${shellQuoteClient(vepDir)}`,
      'perl INSTALL.pl --AUTO a --NO_HTSLIB --NO_TEST',
    ].join('\n')
  }

  const databaseCommand = () => {
    if (isAnnovar) {
      const dbs = annovarDbNames(featureIds)
      const script = `${toolPath.replace(/\/+$/, '')}/annotate_variation.pl`
      return [
        `mkdir -p ${shellQuoteClient(dbPath)}`,
        ...dbs.map((db) => `perl ${shellQuoteClient(script)} -buildver ${shellQuoteClient(build)} -downdb -webfrom annovar ${shellQuoteClient(db)} ${shellQuoteClient(dbPath)}`),
      ].join('\n')
    }
    const installer = toolPath.endsWith('/vep') ? `${toolPath.slice(0, -4)}/INSTALL.pl` : `${toolPath.replace(/\/+$/, '')}/INSTALL.pl`
    return [
      `mkdir -p ${shellQuoteClient(dbPath)}`,
      `perl ${shellQuoteClient(installer)} -a cf -s homo_sapiens -y ${shellQuoteClient(assembly)} -c ${shellQuoteClient(dbPath)}`,
    ].join('\n')
  }

  return (
    <div>
      <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
        Annotation setup
      </h4>
      <div className="flex flex-col gap-2 rounded-md border border-border bg-bg-primary p-2">
        <Input
          label={isAnnovar ? 'ANNOVAR scripts folder' : 'VEP executable or folder'}
          value={toolPath}
          onChange={(event) => patchParams({ toolPath: event.target.value })}
        />
        <Input
          label={isAnnovar ? 'Database folder (humandb)' : 'Cache folder'}
          value={dbPath}
          onChange={(event) => patchParams({ annotationDbPath: event.target.value })}
        />
        <div className="grid grid-cols-2 gap-2">
          {isAnnovar ? (
            <select
              value={build}
              onChange={(event) => patchParams({ buildver: event.target.value })}
              className="h-8 rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary"
            >
              <option value="hg38">hg38</option>
              <option value="hg19">hg19</option>
            </select>
          ) : (
            <select
              value={assembly}
              onChange={(event) => patchParams({ assembly: event.target.value })}
              className="h-8 rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary"
            >
              <option value="GRCh38">GRCh38</option>
              <option value="GRCh37">GRCh37</option>
            </select>
          )}
          {isVep && (
            <Input
              label="Forks"
              type="number"
              min={1}
              value={String(params.fork ?? 4)}
              onChange={(event) => patchParams({ fork: Number(event.target.value) })}
            />
          )}
        </div>
        <div>
          <div className="text-xs font-medium text-text-secondary mb-1">Add information</div>
          <div className="flex flex-col gap-1">
            {(isAnnovar ? ANNOVAR_FEATURES : VEP_FEATURES).map((feature) => {
              const active = featureIds.includes(feature.id)
              return (
                <button
                  key={feature.id}
                  type="button"
                  onClick={() => isAnnovar ? toggleAnnovarFeature(feature.id) : toggleVepFeature(feature.id)}
                  className={classNames(
                    'rounded-md border px-2 py-1.5 text-left',
                    active ? 'border-accent/50 bg-accent/10' : 'border-border bg-bg-tertiary hover:bg-bg-hover',
                  )}
                >
                  <div className="text-xs font-medium text-text-primary">{active ? '✓ ' : ''}{feature.label}</div>
                  <div className="text-[11px] text-text-muted">{feature.description}</div>
                </button>
              )
            })}
          </div>
        </div>
        {isAnnovar && (
          <div className="rounded border border-border bg-bg-tertiary px-2 py-1.5 text-[11px] text-text-muted">
            BioFlow will generate ANNOVAR protocol/operation lists from the selected information. You do not need to type comma-separated protocol strings.
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Button variant="secondary" size="sm" disabled={running} onClick={() => void setSetting(isAnnovar ? 'settings:annovarScriptsPath' : 'settings:vepPath', toolPath)}>
            Save tool path
          </Button>
          <Button variant="secondary" size="sm" disabled={running} onClick={() => void setSetting(isAnnovar ? 'settings:annovarDbPath' : 'settings:vepCachePath', dbPath)}>
            Save DB path
          </Button>
          <Button variant="secondary" size="sm" disabled={running} onClick={() => void runLoginCommand(prepareToolCommand())}>
            {isAnnovar ? 'Prepare scripts folder' : 'Install VEP'}
          </Button>
          <Button variant="secondary" size="sm" disabled={running || featureIds.length === 0} onClick={() => void runLoginCommand(databaseCommand())}>
            Install selected databases
          </Button>
        </div>
        {message && <div className="text-[11px] text-text-muted whitespace-pre-wrap break-all">{message}</div>}
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
  const settings = useSettingsStore((s) => s.settings)
  const schemas = useDataPreviewStore((s) => s.schemas)
  const setSchema = useDataPreviewStore((s) => s.setSchema)
  const tool = getTool(data.toolId)
  const snapshot = useMemo(() => exportSnapshot(), [exportSnapshot, nodes, edges])
  const loadingSchemaKey = useMemo(() => `${nodeId}:${Object.keys(schemas).length}`, [nodeId, schemas])
  const [estimate, setEstimate] = useState<EstimateOutput | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [showEstimateWhy, setShowEstimateWhy] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)

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

  useEffect(() => {
    if (!activeConnectionId || !tool) {
      setEstimate(null)
      return
    }
    const connectionId = activeConnectionId
    const currentTool = tool
    let cancelled = false
    async function loadEstimate() {
      setEstimating(true)
      try {
        const pathsByPort = connectedInputPaths(snapshot, nodeId)
        const sizes: Record<string, number> = {}
        const getSize = useFileSizeStore.getState().getSize
        for (const [portId, paths] of Object.entries(pathsByPort)) {
          const values = await Promise.all(paths.map((path) => getSize(connectionId, path)))
          sizes[portId] = axedInputPorts.some((port) => port.portId === portId)
            ? Math.max(0, ...values)
            : values.reduce((sum, value) => sum + value, 0)
        }
        if (cancelled) return
        const firstAxed = axedInputPorts[0]
        setEstimate(estimateResources({
          tool: currentTool,
          nodeData: data,
          inputSizes: sizes,
          isArray: data.arrayOver !== null && axedInputPorts.length > 0,
          arraySize: firstAxed
            ? (snapshot.nodes.find((node) =>
                snapshot.edges.some((edge) => edge.target === nodeId && edge.targetHandle === firstAxed.portId && edge.source === node.id),
              )?.data as FileNodeData | undefined)?.split?.items.length
            : undefined,
          hasFilter: hasFilteringParam(data),
          partitionMaxMemGB: settings.partitionMaxMemGB,
        }))
      } finally {
        if (!cancelled) setEstimating(false)
      }
    }
    void loadEstimate()
    return () => { cancelled = true }
  }, [activeConnectionId, axedInputPorts, data, nodeId, settings.partitionMaxMemGB, snapshot, tool])

  if (!tool) {
    return <div className="p-4 text-xs text-error">Unknown tool: {data.toolId}</div>
  }

  const slurm = { ...tool.slurm, ...data.slurmOverride }
  const executionMode = data.executionMode ?? 'sbatch'
  const inputEdgesByPort = new Map<string, PipelineSnapshot['edges']>()
  for (const edge of snapshot.edges) {
    if (edge.target !== nodeId) continue
    const portId = edge.targetHandle ?? 'input'
    inputEdgesByPort.set(portId, [...(inputEdgesByPort.get(portId) ?? []), edge])
  }
  const outputEdgesByPort = new Map<string, PipelineSnapshot['edges']>()
  for (const edge of snapshot.edges) {
    if (edge.source !== nodeId) continue
    const portId = edge.sourceHandle ?? 'output'
    outputEdgesByPort.set(portId, [...(outputEdgesByPort.get(portId) ?? []), edge])
  }
  const visibleParams = tool.requiresDatabase
    ? tool.params.filter((param) => !ANNOTATION_INTERNAL_PARAMS.has(param.name))
    : tool.params
  const applyEstimate = () => {
    if (!estimate) return
    updateNodeData(nodeId, {
      slurmOverride: {
        ...data.slurmOverride,
        cpus: estimate.cpus,
        memoryGB: estimate.memGB,
        timeHours: estimate.timeHours,
      },
    })
  }

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
        {tool.requiresDatabase && (
          <div className="mt-2 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] text-text-secondary">
            <div className="flex items-center justify-between gap-2">
              <span>
                Needs {tool.requiresDatabase.name}. Set the database path before running.
              </span>
              <Button variant="secondary" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setGuideOpen(true)}>
                Guide
              </Button>
            </div>
          </div>
        )}
      </div>

      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Execution Mode
        </h4>
        <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-bg-tertiary p-1">
          {[
            { value: 'sbatch', label: 'Slurm job' },
            { value: 'login', label: 'Login node' },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => updateNodeData(nodeId, { executionMode: option.value === 'sbatch' ? undefined : 'login' })}
              className={classNames(
                'h-7 rounded text-xs transition-colors',
                executionMode === option.value
                  ? 'bg-accent text-white'
                  : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        {executionMode === 'login' && (
          <div className="mt-2 rounded border border-yellow-500/30 bg-yellow-500/10 px-2 py-1.5 text-[11px] text-yellow-200">
            Running an array or heavy job on the login node will likely be killed by cluster admins. Consider Slurm for anything beyond quick commands.
          </div>
        )}
      </div>

      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Inputs
        </h4>
        <div className="flex flex-col gap-1.5">
          {tool.inputs.map((port) => (
            <ToolInputRow
              key={port.id}
              port={port}
              connections={inputEdgesByPort.get(port.id) ?? []}
              snapshot={snapshot}
            />
          ))}
          {tool.inputs.length === 0 && (
            <div className="text-xs text-text-muted italic">This tool has no inputs.</div>
          )}
        </div>
      </div>

      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Outputs
        </h4>
        <div className="flex flex-col gap-1.5">
          {tool.outputs.map((port) => (
            <ToolOutputRow
              key={port.id}
              port={port}
              consumers={outputEdgesByPort.get(port.id) ?? []}
            />
          ))}
          {tool.outputs.length === 0 && (
            <div className="text-xs text-text-muted italic">This tool has no declared outputs.</div>
          )}
        </div>
      </div>

      {tool.requiresDatabase && <AnnotationConfigPanel nodeId={nodeId} data={data} />}

      {/* Parameters */}
      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Parameters
        </h4>
        <div className="flex flex-col gap-2">
          {visibleParams.map((p) => {
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
          {visibleParams.length === 0 && (
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
        <FolderPickerField
          label=""
          value={(data.outputDirOverride as string | undefined) ?? ''}
          placeholder="(default — run's outputs folder)"
          requesterLabel={`${data.label} output folder`}
          onChange={(v) => updateNodeData(nodeId, { outputDirOverride: v || undefined })}
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
        <div className="mb-2 rounded-md border border-border bg-bg-tertiary p-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-xs font-medium text-text-primary">
                {estimate
                  ? `Suggested: ${estimate.cpus} CPU / ${estimate.memGB} GB / ${estimate.timeHours} h`
                  : estimating ? 'Estimating resources...' : 'No resource suggestion yet'}
              </div>
              {estimate && (
                <div className="text-[10px] text-text-muted mt-0.5">
                  Confidence: {estimate.confidence}
                </div>
              )}
            </div>
            {estimate && (
              <div className="flex gap-1 shrink-0">
                <Button size="sm" variant="secondary" className="h-7 px-2 text-[11px]" onClick={applyEstimate}>
                  Apply
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => {
                    applyEstimate()
                    setShowEstimateWhy(true)
                  }}
                >
                  Apply + why
                </Button>
              </div>
            )}
          </div>
          {estimate && showEstimateWhy && (
            <ul className="mt-2 list-disc pl-4 text-[11px] text-text-secondary">
              {estimate.rationale.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Input
            label="CPUs"
            type="number"
            min={1}
            value={slurm.cpus ?? ''}
            placeholder={String(tool.slurm?.cpus ?? 1)}
            className={deviatesByTwo(slurm.cpus, estimate?.cpus) ? 'border-yellow-500' : undefined}
            onChange={(e) => setSlurm({ cpus: e.target.value ? Number(e.target.value) : undefined })}
          />
          <Input
            label="Memory (GB)"
            type="number"
            min={1}
            value={slurm.memoryGB ?? ''}
            placeholder={String(tool.slurm?.memoryGB ?? 4)}
            className={deviatesByTwo(slurm.memoryGB, estimate?.memGB) ? 'border-yellow-500' : undefined}
            onChange={(e) => setSlurm({ memoryGB: e.target.value ? Number(e.target.value) : undefined })}
          />
          <Input
            label="Time (hours)"
            type="number"
            min={0.1}
            step={0.5}
            value={slurm.timeHours ?? ''}
            placeholder={String(tool.slurm?.timeHours ?? 1)}
            className={deviatesByTwo(slurm.timeHours, estimate?.timeHours) ? 'border-yellow-500' : undefined}
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
      <DatasetGuideDialog
        guideKey={tool.requiresDatabase?.guideKey ?? null}
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
      />
    </div>
  )
}

function FileInspector({ nodeId, data }: { nodeId: string; data: FileNodeData }) {
  const updateNodeData = usePipelineStore((s) => s.updateNodeData)
  const addFileNode = usePipelineStore((s) => s.addFileNode)
  const onConnect = usePipelineStore((s) => s.onConnect)
  const nodes = usePipelineStore((s) => s.nodes)
  const edges = usePipelineStore((s) => s.edges)
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const settings = useSettingsStore((s) => s.settings)

  const split = data.split
  const outputParts = !data.isInput ? splitOutputPath(data) : null
  const [uploading, setUploading] = useState(false)
  const [uploadMessage, setUploadMessage] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ items: FileNodeSplit['items']; missing: Set<string>; loading: boolean; error: string | null }>({
    items: [],
    missing: new Set(),
    loading: false,
    error: null,
  })
  const [refreshNonce, setRefreshNonce] = useState(0)

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
      pattern: split?.pattern ?? { kind: 'manual' },
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

  const pattern = split?.pattern ?? (split?.glob ? { kind: 'brace', template: split.glob } : { kind: 'manual' }) as SplitPattern

  const setPattern = useCallback((next: SplitPattern) => {
    if (!split) return
    setSplit({ ...split, pattern: next })
  }, [split, setSplit])

  useEffect(() => {
    if (!split) return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      if (!activeConnectionId) {
        setPreview({ items: [], missing: new Set(), loading: false, error: 'Connect to a host to preview files.' })
        return
      }
      const currentPattern = split.pattern ?? (split.glob ? { kind: 'brace', template: split.glob } : { kind: 'manual' }) as SplitPattern
      const hasPattern =
        currentPattern.kind === 'manual' ||
        (currentPattern.kind === 'brace' && currentPattern.template.trim()) ||
        (currentPattern.kind === 'glob' && currentPattern.template.trim()) ||
        (currentPattern.kind === 'crossFolder' && currentPattern.parentDir.trim() && currentPattern.childGlob.trim() && currentPattern.file.trim())
      if (!hasPattern) {
        setPreview({ items: [], missing: new Set(), loading: false, error: null })
        return
      }
      setPreview((prev) => ({ ...prev, loading: true, error: null }))
      try {
        const resolved = await window.api.fs.resolveSplit(activeConnectionId, currentPattern, split.items)
        if (cancelled) return
        setPreview({ items: resolved.items, missing: new Set(resolved.missing), loading: false, error: null })
      } catch (err: any) {
        if (cancelled) return
        setPreview({ items: [], missing: new Set(), loading: false, error: err?.message ?? String(err) })
      }
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activeConnectionId, refreshNonce, split])

  const acceptPreview = useCallback(() => {
    if (!split) return
    setSplit({ ...split, items: preview.items, pattern })
  }, [split, setSplit, preview.items, pattern])

  const addPlinkFileSet = useCallback(() => {
    if (!split) return
    const siblingExts: Array<'pvar' | 'psam'> = ['pvar', 'psam']
    const outgoing = edges.filter((edge) => edge.source === nodeId)
    for (const ext of siblingExts) {
      const nextSplit: FileNodeSplit = {
        ...split,
        items: split.items.map((item) => ({ ...item, path: replacePlinkExt(item.path, ext) })),
      }
      const fileId = addFileNode(
        { x: (nodes.find((node) => node.id === nodeId)?.position.x ?? 0) - 180, y: (nodes.find((node) => node.id === nodeId)?.position.y ?? 0) + (ext === 'pvar' ? 80 : 160) },
        { isInput: true, label: `${data.label}.${ext}`, path: replacePlinkExt(data.path, ext), fileType: ext === 'psam' ? 'tsv' : 'pgen', split: nextSplit },
      )
      for (const edge of outgoing) {
        const target = nodes.find((node) => node.id === edge.target)
        if (!target || target.type !== 'tool') continue
        const tool = getTool((target.data as ToolNodeData).toolId)
        const port = tool?.inputs.find((candidate) => candidate.id.toLowerCase().includes(ext) || candidate.label.toLowerCase().includes(ext))
        if (port) {
          onConnect({ source: fileId, sourceHandle: 'output', target: target.id, targetHandle: port.id })
        }
      }
    }
  }, [addFileNode, data.label, data.path, edges, nodeId, nodes, onConnect, split])

  const uploadLocalFile = useCallback(async () => {
    if (!activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID || !data.path.trim()) return
    setUploading(true)
    setUploadMessage(null)
    try {
      await window.api.local.stat(data.path)
      const home = (await window.api.ssh.exec(activeConnectionId, 'printf %s "$HOME"')).stdout.trim()
      const fileName = data.path.split('/').pop() || 'input'
      const uploadDir = `${home}/${settings.paths.uploadsSubfolder.replace(/^\/+|\/+$/g, '')}`
      const remotePath = `${uploadDir}/${fileName}`
      await window.api.sftp.mkdir(activeConnectionId, uploadDir).catch(() => undefined)
      await window.api.sftp.upload(activeConnectionId, data.path, remotePath)
      updateNodeData(nodeId, { path: remotePath })
      setUploadMessage(`Uploaded to ${remotePath}`)
    } catch (err: any) {
      setUploadMessage(err?.message ?? String(err))
    } finally {
      setUploading(false)
    }
  }, [activeConnectionId, data.path, nodeId, settings.paths.uploadsSubfolder, updateNodeData])

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
          {activeConnectionId && activeConnectionId !== LOCAL_CONNECTION_ID && data.path.trim() && (
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" className="h-7 text-[11px]" disabled={uploading} onClick={() => void uploadLocalFile()}>
                {uploading ? 'Uploading...' : 'Upload local file'}
              </Button>
              {uploadMessage && <span className="truncate text-[10px] text-text-muted">{uploadMessage}</span>}
            </div>
          )}
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
          <FolderPickerField
            label="Output folder"
            value={outputParts?.folder ?? ''}
            placeholder="(default — connected tool output folder)"
            requesterLabel={`${data.label} output folder`}
            onChange={(folder) => {
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
            <div className="grid grid-cols-4 rounded border border-border bg-bg-primary p-0.5">
              {(['manual', 'brace', 'glob', 'crossFolder'] as SplitPattern['kind'][]).map((kind) => (
                <button
                  key={kind}
                  onClick={() => setPattern(defaultPattern(kind, pattern))}
                  className={classNames(
                    'rounded px-1.5 py-1 text-[10px]',
                    pattern.kind === kind ? 'bg-accent/15 text-text-primary' : 'text-text-muted hover:text-text-primary',
                  )}
                >
                  {kind === 'crossFolder' ? 'Cross-folder' : kind === 'brace' ? 'Brace range' : kind[0].toUpperCase() + kind.slice(1)}
                </button>
              ))}
            </div>

            {pattern.kind === 'brace' && (
              <Input
                label="Brace template"
                value={pattern.template}
                placeholder="/scratch/chr{1..22}/geno.pgen"
                onChange={(e) => setPattern({ kind: 'brace', template: e.target.value })}
              />
            )}
            {pattern.kind === 'glob' && (
              <div className="grid grid-cols-[1fr_88px] gap-2">
                <Input
                  label="Glob template"
                  value={pattern.template}
                  placeholder="/scratch/chr*/geno.pgen"
                  onChange={(e) => setPattern({ ...pattern, template: e.target.value })}
                />
                <Input
                  label="Capture"
                  value={pattern.capture}
                  placeholder="chrom"
                  onChange={(e) => setPattern({ ...pattern, capture: e.target.value })}
                />
              </div>
            )}
            {pattern.kind === 'crossFolder' && (
              <div className="grid grid-cols-1 gap-2">
                <Input
                  label="Parent directory"
                  value={pattern.parentDir}
                  placeholder="/scratch/chroms"
                  onChange={(e) => setPattern({ ...pattern, parentDir: e.target.value })}
                />
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    label="Child folders"
                    value={pattern.childGlob}
                    placeholder="chr*"
                    onChange={(e) => setPattern({ ...pattern, childGlob: e.target.value })}
                  />
                  <Input
                    label="File"
                    value={pattern.file}
                    placeholder="geno.pgen"
                    onChange={(e) => setPattern({ ...pattern, file: e.target.value })}
                  />
                </div>
              </div>
            )}

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
            <div className="rounded border border-border bg-bg-primary">
              <div className="flex items-center justify-between border-b border-border px-2 py-1">
                <span className="text-[10px] uppercase tracking-wide text-text-muted">Preview</span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    disabled={preview.loading}
                    onClick={() => setRefreshNonce((value) => value + 1)}
                  >
                    Refresh
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    disabled={preview.loading || preview.items.length === 0}
                    onClick={acceptPreview}
                  >
                    Accept
                  </Button>
                </div>
              </div>
              <div className="max-h-40 overflow-y-auto">
                {preview.loading && <div className="px-2 py-2 text-[11px] text-text-muted">Checking files...</div>}
                {preview.error && <div className="px-2 py-2 text-[11px] text-error">{preview.error}</div>}
                {!preview.loading && !preview.error && preview.items.length === 0 && (
                  <div className="px-2 py-2 text-[11px] text-text-muted">Enter a pattern above to see which files would be used.</div>
                )}
                {!preview.loading && !preview.error && preview.items.length > 0 && (
                  <table className="w-full text-[10px]">
                    <tbody>
                      {preview.items.map((item) => {
                        const missing = preview.missing.has(item.key)
                        return (
                          <tr key={`${item.key}:${item.path}`} className={missing ? 'bg-error/10 text-error' : 'text-text-secondary'}>
                            <td className="w-12 px-2 py-1 font-mono">{item.key}</td>
                            <td className="px-2 py-1 font-mono truncate" title={item.path}>{item.path}</td>
                            <td className="w-14 px-2 py-1 text-right">{missing ? 'missing' : 'exists'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
            {data.fileType === 'pgen' && split.items.length > 0 && (
              <Button variant="secondary" size="sm" className="h-7 text-[11px]" onClick={addPlinkFileSet}>
                PLINK2 file-set
              </Button>
            )}
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

function defaultPattern(kind: SplitPattern['kind'], current: SplitPattern): SplitPattern {
  if (kind === current.kind) return current
  if (kind === 'manual') return { kind: 'manual' }
  if (kind === 'brace') return { kind: 'brace', template: current.kind === 'glob' ? current.template : '' }
  if (kind === 'glob') return { kind: 'glob', template: current.kind === 'brace' ? current.template : '', capture: 'key' }
  return { kind: 'crossFolder', parentDir: '', childGlob: 'chr*', file: '' }
}

function replacePlinkExt(path: string, ext: 'pvar' | 'psam'): string {
  if (!path) return ''
  return path.replace(/\.(pgen|pvar|psam)$/i, `.${ext}`)
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
        <FolderPickerField
          label=""
          value={(data.outputDirOverride as string | undefined) ?? ''}
          placeholder="(default — run's outputs folder)"
          requesterLabel={`${data.label} output folder`}
          onChange={(v) => updateNodeData(nodeId, { outputDirOverride: v || undefined })}
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
        <div className="mt-2">
          <FolderPickerField
            label=""
            value={(data.outputDirOverride as string | undefined) ?? ''}
            placeholder="(default — run's outputs folder)"
            requesterLabel={`${data.label} output folder`}
            onChange={(v) => updateNodeData(nodeId, { outputDirOverride: v || undefined })}
          />
        </div>
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
