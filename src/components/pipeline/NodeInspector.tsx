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
import { X, Trash2, Copy, Plus, Info, RefreshCcw, FolderOpen } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Tooltip } from '@/components/ui/Tooltip'
import { HelpButton } from '@/components/ui/HelpButton'
import { AnalysisOptionsPanel } from '@/components/pipeline/inspector/AnalysisOptionsPanel'
import { UkbFieldBuilder } from '@/components/pipeline/inspector/UkbFieldBuilder'
import { RemoteFileBrowser } from '@/components/file-browser/RemoteFileBrowser'
import { RemotePathField } from '@/components/file-browser/RemotePathField'
import { RemotePathInput } from '@/components/file-browser/RemotePathInput'
import { LocalPathField } from '@/components/file-browser/LocalPathField'
import { usePipelineStore, useSelectedNode } from '@/stores/pipelineStore'
import { LOCAL_CONNECTION_ID, useConnectionStore } from '@/stores/connectionStore'
import { useUIStore } from '@/stores/uiStore'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import { useFileSizeStore } from '@/stores/fileSizeStore'
import { headPreviewFileForConnection, statFileForConnection } from '@/stores/fileStore'
import { useDnxStore } from '@/stores/dnxStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useClusterInfoStore } from '@/stores/clusterInfoStore'
import { useDialogStore } from '@/stores/dialogStore'
import type { FileOrigin } from '@/constants/connections'
import { getTool } from '@/lib/toolRegistry'
import { iconForTool } from '@/lib/toolIcons'
import { estimateResources, type EstimateOutput } from '@/lib/resourceEstimator'
import { ANNOVAR_FEATURES, VEP_FEATURES, annovarDbNames, annovarParamsForFeatures } from '@/lib/annotationCatalog'
import {
  columnParamValues,
  connectedInputPath,
  parseHeader,
  type SchemaCache,
} from '@/lib/schemaResolver'
import { resolveUpstreamSchema } from '@/lib/resolveUpstreamSchema'
import { defaultTransformPresetConfig, getTransformPreset, TRANSFORM_PRESETS } from '@/lib/transformPresets'
import { suggestRoleMappings } from '@/lib/roleMappings'
import { inferFileType } from '@/lib/fileTypeInference'
import { SPARK_INSTANCE_TYPES } from '@/lib/dnxInstanceCatalog'
import {
  syncFlagBlocksFromParamValues,
  toolUsesFlagBuilder,
} from '@/lib/flagRegistry'
import {
  analysisOptionsToParamValues,
  getActiveToolInputs,
  getAnalysisOptionDefs,
  normalizeAnalysisOptions,
  type AnalysisOptionDef,
} from '@/lib/analysisOptions'
import {
  detectSplitInFolder as detectSmartSplitInFolder,
  type DetectedSplit,
  rangeTextFromItems as sharedRangeTextFromItems,
  type SplitDetectMode,
} from '@/lib/splitDetection'
import { resolveSplitItemsForRange } from '@/lib/splitRange'
import type {
  FileNodeData,
  FileNodeSplit,
  PipelineSnapshot,
  SplitPattern,
  MergeNodeData,
  MergeStrategy,
  NoteNodeData,
  TransferNodeData,
  ToolNodeData,
  ToolParam,
  ToolPort,
  TransformFilterOp,
  TransformFilterRule,
  TransformNodeData,
} from '@/types/pipeline'
import type { RemoteFileEntry } from '@/types/files'
import type { AnnovarInstallProgress, AnnovarStatusResult } from '@/types/annotation'
import type { ClusterModuleSuggestion, LearnedResourceSummary } from '@/types/ssh'
import { classNames, pathBasename, pathDirname } from '@/lib/utils'
import { expandHomePath } from '@/lib/remotePath'
import { MiddleEllipsis } from '@/components/ui/MiddleEllipsis'
import { buildAxisAlignmentReport } from '@/lib/dataArtifacts'
import { computeToolPortOutputPreview, computeToolPortPhysicalOutputPreviews } from '@/lib/outputPathPreview'
import { validateCustomShellScript } from '@/lib/customShellValidation'
import { rPackagesForTool } from '@/lib/rPackages'
import { nodeBackend } from '@/lib/transferPlanner'
import { isLikelyLocalPath } from '@/lib/pathOrigin'
import { optionDisplayLabel } from '@/lib/optionLabels'

const EMPTY_MODULE_SUGGESTIONS: readonly ClusterModuleSuggestion[] = []
const GENOME_BUILD_OPTIONS = ['', 'GRCh38', 'GRCh37', 'hg38', 'hg19'] as const

function moduleDefaultKey(toolIdOrCommand: string): 'plink' | 'r' | 'bcftools' | 'regenie' | null {
  const value = toolIdOrCommand.toLowerCase()
  if (value.includes('plink')) return 'plink'
  if (value.includes('regenie')) return 'regenie'
  if (value.includes('bcftools')) return 'bcftools'
  if (value === 'rscript' || value.startsWith('r.') || value.startsWith('plot.') || value === 'custom.r') return 'r'
  return null
}

function resolvedModuleDefault(
  toolIdOrCommand: string,
  registryModule: string | undefined,
  settings: ReturnType<typeof useSettingsStore.getState>['settings'],
): string {
  const key = moduleDefaultKey(toolIdOrCommand)
  return (key ? settings.moduleDefaults[key]?.trim() : '') || registryModule || ''
}

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
      const splitItems = safeSplitItems(data.split)
      paths[portId] = splitItems.length
        ? splitItems.map((item) => item.path).filter(Boolean)
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
    const splitItems = safeSplitItems(data.split)
    if (splitItems.length) return `${splitItems.length} files split by ${data.split?.axis || 'item'}`
    return data.path || 'File path not set'
  }
  if (node.type === 'tool') return `Output: ${sourceHandle}`
  if (node.type === 'merge') return 'Merged output'
  if (node.type === 'transfer') return 'Transferred output'
  if (node.type === 'transform') return 'Transformed output'
  return 'Connected'
}

function connectedInputOrigin(
  snapshot: PipelineSnapshot,
  nodeId: string,
  portId: string,
): FileOrigin | null {
  const edge = snapshot.edges.find((candidate) => candidate.target === nodeId && (candidate.targetHandle ?? 'input') === portId)
  const source = edge ? snapshot.nodes.find((candidate) => candidate.id === edge.source) : undefined
  return source ? nodeBackend(source, 'output') : null
}

function pathOriginInSnapshot(snapshot: PipelineSnapshot, path: string): FileOrigin | null {
  for (const node of snapshot.nodes) {
    if (node.type !== 'file') continue
    const data = node.data as FileNodeData
    if (data.path === path || safeSplitItems(data.split).some((item) => item.path === path)) {
      return nodeBackend(node, 'output')
    }
  }
  return null
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
  const label = <ParamLabel param={param} />
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
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
          <span className="text-xs text-text-primary">{label}</span>
          {param.required && <span className="text-error text-[10px]">*</span>}
        </label>
      )

    case 'number':
      return (
        <Input
          label={param.label + (param.required ? ' *' : '')}
          labelNode={label}
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          min={param.min}
          max={param.max}
          step={param.step ?? 'any'}
          placeholder={param.placeholder}
          className="text-xs"
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
            {label}
          </label>
          <select
            value={value === undefined ? '' : String(value)}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 rounded-md border border-border bg-bg-tertiary px-2 text-xs text-text-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          >
            <option value="">-- select --</option>
            {param.options?.map((opt) => (
              <option key={opt} value={opt}>{optionDisplayLabel(opt, param.name)}</option>
            ))}
          </select>
        </div>
      )

    case 'string':
      return (
        <Input
          label={param.label + (param.required ? ' *' : '')}
          labelNode={label}
          type="text"
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={param.placeholder}
          className="text-xs"
          onChange={(e) => onChange(e.target.value)}
        />
      )

    case 'file':
      return (
        <RemotePathField
          label={param.label + (param.required ? ' *' : '')}
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={param.placeholder}
          mode="file"
          title={`Choose file for ${param.label}`}
          buttonLabel={activeConnectionId ? 'Browse' : 'Connect first'}
          onChange={onChange}
        />
      )

    default:
      return (
        <Input
          label={param.label + (param.required ? ' *' : '')}
          labelNode={label}
          type="text"
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={param.placeholder}
          className="text-xs"
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
  refreshing,
  onRefresh,
  onChange,
}: {
  param: ToolParam
  value: unknown
  columns: string[]
  loading: boolean
  refreshing?: boolean
  onRefresh?: () => void
  onChange: (v: unknown) => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [focused, setFocused] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0)
  const [draft, setDraft] = useState('')
  const current = String(value ?? '')
  const allowsMultiple = Boolean(param.columnMulti)
  const selected = columnParamValues(value, { whitespaceSeparated: allowsMultiple })
  const token = allowsMultiple ? draft.trim().toLowerCase() : current.split(/[,\s]+/).pop()?.toLowerCase() ?? ''
  const suggestions = columns
    .filter((column) => !allowsMultiple || !selected.includes(column))
    .filter((column) => column.toLowerCase().includes(token))
    .slice(0, 12)
  useEffect(() => {
    setActiveSuggestionIndex((index) => Math.min(index, Math.max(suggestions.length - 1, 0)))
  }, [suggestions.length])
  useEffect(() => {
    if (!allowsMultiple && draft) setDraft('')
  }, [allowsMultiple, draft])

  const removeColumn = (column: string) => {
    onChange(selected.filter((value) => value !== column).join(' '))
  }

  const addColumn = (column: string) => {
    if (selected.includes(column)) return
    onChange([...selected, column].join(' '))
    setDraft('')
    setShowSuggestions(false)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  const insertColumn = (column: string) => {
    if (allowsMultiple) {
      addColumn(column)
      return
    }
    const cursor = inputRef.current?.selectionStart ?? current.length
    const before = current.slice(0, cursor)
    const after = current.slice(cursor)
    const start = Math.max(before.lastIndexOf(','), before.lastIndexOf(' '), before.lastIndexOf('\t')) + 1
    const endOffset = after.search(/[,\s]/)
    const end = endOffset === -1 ? current.length : cursor + endOffset
    const separator = current.includes(',') ? ', ' : ' '
    const prefix = current.slice(0, start).replace(/[,\s]*$/, '')
    const suffix = current.slice(end).replace(/^[,\s]*/, '')
    const next = [prefix, column, suffix].filter(Boolean).join(separator)
    onChange(next)
    setShowSuggestions(false)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-end gap-1.5">
        <div className="relative flex flex-1 flex-col gap-1">
          <label className="text-text-secondary text-xs font-medium">
            <ParamLabel param={param} />
          </label>
          <input
            ref={inputRef}
            type="text"
            value={allowsMultiple ? draft : current}
            placeholder={columns.length > 0 ? (allowsMultiple ? 'Type to add a column...' : 'Start typing a column name...') : (loading ? 'Loading columns...' : param.placeholder)}
            onFocus={() => {
              setFocused(true)
              setShowSuggestions(true)
              setActiveSuggestionIndex(0)
              if (columns.length === 0 && !loading && onRefresh) onRefresh()
            }}
            onBlur={() => window.setTimeout(() => {
              setFocused(false)
              setShowSuggestions(false)
            }, 120)}
            onChange={(e) => {
              if (allowsMultiple) {
                setDraft(e.target.value)
                setShowSuggestions(true)
              } else {
                onChange(e.target.value)
                setShowSuggestions(true)
              }
              setActiveSuggestionIndex(0)
            }}
            onKeyDown={(event) => {
              if (allowsMultiple && event.key === 'Backspace' && draft.length === 0 && selected.length > 0) {
                event.preventDefault()
                removeColumn(selected[selected.length - 1])
                return
              }
              if (!showSuggestions || suggestions.length === 0) return
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveSuggestionIndex((index) => Math.min(index + 1, suggestions.length - 1))
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveSuggestionIndex((index) => Math.max(index - 1, 0))
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                insertColumn(suggestions[activeSuggestionIndex] ?? suggestions[0])
                return
              }
              if (event.key === 'Escape') {
                setShowSuggestions(false)
              }
            }}
            className="h-8 w-full rounded-md border border-border bg-bg-tertiary px-3 text-xs text-text-primary placeholder-text-muted outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent"
          />
          {focused && showSuggestions && columns.length > 0 && suggestions.length > 0 && (
            <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-52 overflow-y-auto rounded-md border border-border bg-bg-secondary py-1 shadow-xl">
              {suggestions.map((column, index) => (
                <button
                  key={column}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault()
                    insertColumn(column)
                  }}
                  onMouseEnter={() => setActiveSuggestionIndex(index)}
                  className={classNames(
                    'block w-full truncate px-2 py-1.5 text-left font-mono text-xs text-text-primary hover:bg-bg-hover',
                    index === activeSuggestionIndex && 'bg-bg-hover',
                  )}
                >
                  {column}
                </button>
              ))}
            </div>
          )}
        </div>
        {onRefresh && (
          <button
            type="button"
            title="Refresh upstream columns"
            onClick={onRefresh}
            className="mb-0 flex h-8 items-center gap-1 rounded-md border border-border bg-bg-tertiary px-2 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text-primary"
          >
            <RefreshCcw size={13} className={refreshing ? 'animate-spin' : ''} />
            Columns
          </button>
        )}
      </div>
      {allowsMultiple && selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((column) => (
            <span
              key={column}
              className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-[11px] text-text-primary"
            >
              <span className="font-mono">{column}</span>
              <button
                type="button"
                onClick={() => removeColumn(column)}
                className="text-text-muted transition-colors hover:text-text-primary"
                title={`Remove ${column}`}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {columns.length === 0 && (
        <p className="text-[10px] text-text-muted">
          {loading ? 'Reading the upstream header…' : 'Connect a tabular input or preview it once to enable column picks.'}
        </p>
      )}
    </div>
  )
}

function ParamLabel({ param }: { param: ToolParam }) {
  const text = (
    <>
      {param.label}
      {param.required && <span className="text-error ml-0.5">*</span>}
    </>
  )
  if (!param.description && !param.docUrl) {
    return <span className="bioflow-param-label inline-flex min-w-0 items-center gap-1">{text}<HelpButton id="params.row" /></span>
  }
  return (
    <Tooltip
      side="right"
      content={
        <span className="block max-w-[260px] whitespace-normal leading-relaxed">
          {param.description && <span className="block">{param.description}</span>}
          {param.docUrl && (
            <button
              type="button"
              className="mt-1 text-accent underline"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                window.open(param.docUrl, '_blank', 'noopener,noreferrer')
              }}
            >
              View docs
            </button>
          )}
        </span>
      }
    >
      <span className="bioflow-param-label inline-flex min-w-0 cursor-help items-center gap-1">
        <span className="text-nowrap min-w-0">{text}</span>
        <Info size={11} className="text-text-muted" />
        <HelpButton id={param.name.toLowerCase().includes('flag') ? 'params.customFlags' : 'params.row'} />
      </span>
    </Tooltip>
  )
}

function toolParamSection(param: ToolParam): 'Inputs' | 'Analysis' | 'Filters' | 'Output' | 'Runtime' {
  return param.section ?? 'Analysis'
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
    <RemotePathField
      label={label}
      value={value}
      placeholder={placeholder}
      onChange={onChange}
      mode="directory"
      title={`Choose folder for ${requesterLabel}`}
    />
  )
}

function ModuleAutocompleteField({
  connectionId,
  value,
  loading,
  placeholder,
  onChange,
  onRefresh,
}: {
  connectionId: string | null
  value: string
  loading: boolean
  placeholder?: string
  onChange: (value: string) => void
  onRefresh?: () => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [focused, setFocused] = useState(false)
  const [suggestionRect, setSuggestionRect] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
  const modules = useClusterInfoStore((s) => {
    if (!connectionId) return EMPTY_MODULE_SUGGESTIONS
    return s.modulesByConnection[connectionId]?.modules ?? EMPTY_MODULE_SUGGESTIONS
  })
  const loadModules = useClusterInfoStore((s) => s.loadModules)
  const suggestions = modules
    .flatMap((entry) => entry.versions.length > 0 ? entry.versions.map((version) => `${entry.name}/${version}`) : [entry.name])
    .filter((name) => moduleSuggestionMatches(name, value))
    .slice(0, 12)

  useEffect(() => {
    if (!focused || !connectionId || connectionId === LOCAL_CONNECTION_ID) return
    void loadModules(connectionId, moduleQuery(value) || undefined).catch(() => undefined)
  }, [connectionId, focused, loadModules, value])

  const updateSuggestionRect = useCallback(() => {
    const rect = inputRef.current?.getBoundingClientRect()
    if (!rect) {
      setSuggestionRect(null)
      return
    }
    const gap = 4
    const viewportPadding = 12
    const preferredMaxHeight = 280
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding
    const spaceAbove = rect.top - viewportPadding
    const openAbove = spaceBelow < 160 && spaceAbove > spaceBelow
    const maxHeight = Math.max(120, Math.min(preferredMaxHeight, (openAbove ? spaceAbove : spaceBelow) - gap))
    setSuggestionRect({
      top: openAbove ? Math.max(viewportPadding, rect.top - maxHeight - gap) : rect.bottom + gap,
      left: Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - rect.width - viewportPadding)),
      width: rect.width,
      maxHeight,
    })
  }, [])

  useEffect(() => {
    if (!focused) {
      setSuggestionRect(null)
      return
    }
    updateSuggestionRect()
    window.addEventListener('resize', updateSuggestionRect)
    window.addEventListener('scroll', updateSuggestionRect, true)
    return () => {
      window.removeEventListener('resize', updateSuggestionRect)
      window.removeEventListener('scroll', updateSuggestionRect, true)
    }
  }, [focused, suggestions.length, loading, updateSuggestionRect])

  const suggestionList = focused && suggestionRect && connectionId && connectionId !== LOCAL_CONNECTION_ID && typeof document !== 'undefined'
    ? createPortal(
        <div
          className="bioflow-inspector-popover surface-popover fixed z-[1300] overflow-y-auto rounded-md py-1 shadow-xl"
          style={{
            top: suggestionRect.top,
            left: suggestionRect.left,
            width: suggestionRect.width,
            maxHeight: suggestionRect.maxHeight,
          }}
          onWheel={(event) => event.stopPropagation()}
        >
          {loading && suggestions.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-text-muted">Loading modules...</div>
          ) : suggestions.length > 0 ? (
            suggestions.map((name) => (
              <button
                key={name}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault()
                  onChange(name)
                  window.setTimeout(() => inputRef.current?.focus(), 0)
                }}
                className="block w-full truncate px-2 py-1.5 text-left font-mono text-xs text-text-primary hover:bg-bg-hover"
              >
                {name}
              </button>
            ))
          ) : (
            <div className="px-2 py-1.5 text-xs text-text-muted">No matching modules. Free text is allowed.</div>
          )}
        </div>,
        document.body,
      )
    : null

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-end gap-1.5">
        <div className="flex flex-1 flex-col gap-1">
          <label className="text-text-secondary text-xs font-medium">Module override</label>
          <input
            ref={inputRef}
            type="text"
            value={value}
            placeholder={placeholder}
            onFocus={() => setFocused(true)}
            onBlur={() => window.setTimeout(() => setFocused(false), 150)}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 w-full rounded-md border border-border bg-bg-tertiary px-3 text-sm text-text-primary placeholder-text-muted outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent"
          />
          {suggestionList}
        </div>
        <button
          type="button"
          title="Refresh module list"
          onClick={onRefresh}
          className="mb-0 flex h-8 items-center gap-1 rounded-md border border-border bg-bg-tertiary px-2 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
          disabled={!connectionId || connectionId === LOCAL_CONNECTION_ID}
        >
          <RefreshCcw size={13} className={loading ? 'animate-spin' : ''} />
          Modules
        </button>
      </div>
    </div>
  )
}

function moduleQuery(value: string): string {
  return value.trim().split('/')[0]?.trim() ?? ''
}

function moduleSuggestionMatches(name: string, value: string): boolean {
  const needle = value.trim().toLowerCase()
  if (!needle) return true
  const lower = name.toLowerCase()
  const packageName = moduleQuery(value).toLowerCase()
  return lower.includes(needle) || (packageName.length > 0 && lower.includes(packageName))
}

function ShellScriptField({
  value,
  onChange,
  outputContract,
  onOutputContractChange,
}: {
  value: unknown
  onChange: (v: unknown) => void
  outputContract: ToolNodeData['outputContract']
  onOutputContractChange: (contract: ToolNodeData['outputContract']) => void
}) {
  const mode = outputContract?.mode ?? 'capture-stdout'
  const requireNonEmpty = outputContract?.requireNonEmpty ?? true
  const script = value === undefined || value === null ? '' : String(value)
  const validationIssues = validateCustomShellScript(script, outputContract)
  return (
    <div className="flex flex-col gap-1">
      <label className="text-text-secondary text-xs font-medium">
        Shell script <span className="text-error">*</span>
      </label>
      <textarea
        value={script}
        placeholder={'cat "$INPUT"'}
        onChange={(e) => onChange(e.target.value)}
        rows={7}
        className="rounded-lg border border-border-light bg-bg-primary px-3 py-2 text-sm text-slate-100 shadow-inner outline-none focus:border-accent focus:ring-2 focus:ring-accent/25 resize-y font-mono leading-relaxed"
      />
      <div className="rounded-md bg-accent/10 px-2 py-1.5 text-[10px] text-text-secondary leading-relaxed">
        Variables: <code className="font-mono text-text-primary">$INPUT</code>,{' '}
        <code className="font-mono text-text-primary">$INPUT_1</code>,{' '}
        <code className="font-mono text-text-primary">$INPUT_2</code>,{' '}
        <code className="font-mono text-text-primary">{'${INPUTS[@]}'}</code>, and{' '}
        <code className="font-mono text-text-primary">$OUTPUT</code>.
      </div>
      {validationIssues.length > 0 && (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[10px] leading-relaxed">
          <div className="mb-1 font-medium text-text-primary">Basic bash validation</div>
          <div className="flex flex-col gap-1">
            {validationIssues.map((issue) => (
              <div key={issue.code} className={issue.severity === 'error' ? 'text-error' : 'text-warning'}>
                {issue.message}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="mt-1 rounded-md border border-border bg-bg-tertiary/60 p-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">Output behavior</div>
        <div className="grid grid-cols-2 gap-1 rounded border border-border bg-bg-primary p-1">
          {[
            { value: 'capture-stdout', label: 'Capture stdout' },
            { value: 'script-writes-output', label: 'Script writes $OUTPUT' },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onOutputContractChange({ mode: option.value as 'capture-stdout' | 'script-writes-output', requireNonEmpty })}
              className={classNames(
                'h-7 rounded text-[11px] transition-colors',
                mode === option.value ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-text-secondary">
          <input
            type="checkbox"
            checked={requireNonEmpty}
            onChange={(event) => onOutputContractChange({ mode, requireNonEmpty: event.target.checked })}
            className="accent-accent"
          />
          Require the output file to exist and be non-empty
        </label>
      </div>
    </div>
  )
}

function RScriptField({
  value,
  onChange,
}: {
  value: unknown
  onChange: (v: unknown) => void
}) {
  const script = value === undefined || value === null ? '' : String(value)
  const referencesOutput = /\b(output_table|plot_png|plot_pdf|output_dir)\b/.test(script)
  return (
    <div className="flex flex-col gap-1">
      <label className="text-text-secondary text-xs font-medium">
        R script <span className="text-error">*</span>
      </label>
      <textarea
        value={script}
        placeholder={'df <- read_table(input_file)\ndata.table::fwrite(df, output_table, sep = "\\t")'}
        onChange={(e) => onChange(e.target.value)}
        rows={9}
        className="rounded-lg border border-border-light bg-bg-primary px-3 py-2 text-sm text-slate-100 shadow-inner outline-none focus:border-accent focus:ring-2 focus:ring-accent/25 resize-y font-mono leading-relaxed"
      />
      <div className="rounded-md bg-accent/10 px-2 py-1.5 text-[10px] text-text-secondary leading-relaxed">
        Variables: <code className="font-mono text-text-primary">input_files</code>,{' '}
        <code className="font-mono text-text-primary">input_file</code>,{' '}
        <code className="font-mono text-text-primary">output_table</code>,{' '}
        <code className="font-mono text-text-primary">plot_png</code>,{' '}
        <code className="font-mono text-text-primary">plot_pdf</code>, and{' '}
        <code className="font-mono text-text-primary">output_dir</code>. Helper:{' '}
        <code className="font-mono text-text-primary">read_table(path)</code>.
      </div>
      {script.trim() && !referencesOutput && (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[10px] leading-relaxed text-warning">
          This script does not reference an output variable. BioFlow will create placeholder outputs unless the script writes one.
        </div>
      )}
    </div>
  )
}

function ToolInputRow({
  nodeId,
  port,
  connections,
  snapshot,
  optionDef,
  onRemoveOption,
}: {
  nodeId: string
  port: ToolPort
  connections: PipelineSnapshot['edges']
  snapshot: PipelineSnapshot
  optionDef?: AnalysisOptionDef
  onRemoveOption?: () => void
}) {
  const deleteEdge = usePipelineStore((s) => s.deleteEdge)
  const addFileNode = usePipelineStore((s) => s.addFileNode)
  const addTransformNode = usePipelineStore((s) => s.addTransformNode)
  const onConnect = usePipelineStore((s) => s.onConnect)
  const setSelectedNode = usePipelineStore((s) => s.setSelectedNode)
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const [browserOpen, setBrowserOpen] = useState(false)
  const missingRequired = port.required && connections.length === 0
  const accept = port.fileType === 'any' ? undefined : [port.fileType]
  const initialPath = useMemo(() => {
    const firstEdge = connections[0]
    if (!firstEdge) return undefined
    const source = snapshot.nodes.find((node) => node.id === firstEdge.source)
    if (source?.type !== 'file') return undefined
    const data = source.data as FileNodeData
    return data.path || undefined
  }, [connections, snapshot.nodes])

  const attachInputFiles = (paths: string[], pickedOrigin?: 'local' | 'ssh' | 'dnx') => {
    if (paths.length === 0) return
    if (!port.multi) {
      for (const edge of connections) deleteEdge(edge.id)
    }
    const target = snapshot.nodes.find((node) => node.id === nodeId)
    paths.forEach((path, index) => {
      const label = pathBasename(path) || port.label
      const origin = pickedOrigin ?? (activeConnectionId === LOCAL_CONNECTION_ID ? 'local' : 'ssh')
      const source: FileNodeData['source'] = origin === 'local' ? 'local' : 'remote'
      const fileId = addFileNode(
        target
          ? { x: target.position.x - 220, y: target.position.y + Math.max(0, (connections.length + index) * 44) }
          : { x: 80, y: 80 + index * 44 },
        {
          isInput: true,
          label,
          path,
          fileType: inferFileType(path),
          source,
          origin,
        },
      )
      onConnect({
        source: fileId,
        sourceHandle: 'output',
        target: nodeId,
        targetHandle: port.id,
      })
    })
  }

  const buildKeepFileFromPhenotype = () => {
    const target = snapshot.nodes.find((node) => node.id === nodeId)
    const phenotypeEdge = snapshot.edges.find((edge) => edge.target === nodeId && (edge.targetHandle ?? 'input') === 'pheno')
    if (!target || !phenotypeEdge) return
    const transformId = addTransformNode(
      { x: target.position.x - 260, y: target.position.y + snapshot.nodes.length * 18 },
      {
        label: `${port.label} builder`,
        fileType: 'txt',
        preset: 'cohort-filter',
        presetConfig: { ...defaultTransformPresetConfig('cohort-filter'), artifactMode: 'keep-file' },
        filters: [],
        renames: [],
        outputIntermediate: { output: false },
        status: 'idle',
      },
    )
    onConnect({ source: phenotypeEdge.source, sourceHandle: phenotypeEdge.sourceHandle ?? 'output', target: transformId, targetHandle: 'input' })
    onConnect({ source: transformId, sourceHandle: 'output', target: nodeId, targetHandle: port.id })
    setSelectedNode(transformId)
  }

  return (
    <div className={classNames(
      'rounded-md border px-2 py-1.5 text-xs',
      missingRequired ? 'border-error/40 bg-error/5' : 'border-border bg-bg-tertiary',
    )}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-medium text-text-primary">{port.label}</span>
          <span className="rounded bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-muted">{port.fileType}</span>
          {optionDef?.flag && <span className="rounded bg-bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-muted">{optionDef.flag}</span>}
          {port.required && <span className="rounded bg-error/10 px-1.5 py-0.5 text-[10px] text-error">required</span>}
          {port.multi && <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">multiple</span>}
        </div>
        {onRemoveOption && (
          <button
            type="button"
            onClick={onRemoveOption}
            className="shrink-0 rounded border border-border bg-bg-secondary p-1 text-text-muted hover:text-text-primary"
            title={`Remove ${optionDef?.label ?? port.label}`}
          >
            <X size={12} />
          </button>
        )}
      </div>
      <div className="mt-1 text-[11px] leading-relaxed text-text-muted">
        {port.description ?? `Connect a ${port.fileType} file here.`}
      </div>
      <div className="mt-1.5 flex flex-col gap-0.5">
        {connections.length === 0 ? (
          <div className="flex items-center justify-between gap-2">
            <div className={missingRequired ? 'text-error' : 'text-text-muted'}>
              {missingRequired ? `Connect a ${port.fileType} source before running.` : 'Optional input not connected.'}
            </div>
          <button
            type="button"
            onClick={() => setBrowserOpen(true)}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded border border-border bg-bg-secondary px-2 text-[10px] text-text-muted hover:text-text-primary"
            title={`Pick ${port.label} from the file browser`}
            >
              <FolderOpen size={12} />
              Pick
            </button>
          </div>
        ) : connections.map((edge) => {
          const source = snapshot.nodes.find((node) => node.id === edge.source)
          if (!source) return null
          const detail = inputConnectionDetail(source, edge.sourceHandle ?? 'output')
          return (
            <div key={edge.id} className="flex items-start justify-between gap-2 text-text-secondary">
              <div className="min-w-0">
                <span className="text-success">Connected</span>
                {' to '}
                <span className="text-text-primary" title={inspectorNodeLabel(source)}>
                  <MiddleEllipsis value={inspectorNodeLabel(source)} max={28} />
                </span>
                <span className="text-text-muted" title={detail}> · <MiddleEllipsis value={detail} max={54} /></span>
              </div>
              <button
                type="button"
                onClick={() => deleteEdge(edge.id)}
                className="shrink-0 rounded border border-border bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-muted hover:text-text-primary"
                title="Disconnect"
              >
                Disconnect
              </button>
            </div>
          )
        })}
        {connections.length > 0 && (
          <button
            type="button"
            onClick={() => setBrowserOpen(true)}
            className="mt-1 inline-flex h-7 w-fit items-center gap-1 rounded border border-border bg-bg-secondary px-2 text-[10px] text-text-muted hover:text-text-primary"
            title={port.multi ? `Pick another ${port.label} file` : `Replace ${port.label} file`}
          >
            <FolderOpen size={12} />
            {port.multi ? 'Pick another' : 'Replace'}
          </button>
        )}
        {port.id === 'keep' && (
          <button
            type="button"
            onClick={buildKeepFileFromPhenotype}
            disabled={!snapshot.edges.some((edge) => edge.target === nodeId && (edge.targetHandle ?? 'input') === 'pheno')}
            className="mt-1 inline-flex h-7 w-fit items-center gap-1 rounded border border-border bg-bg-secondary px-2 text-[10px] text-text-muted hover:text-text-primary disabled:opacity-50"
            title="Create a cohort-filter transform from the connected phenotype input and wire it into this keep port"
          >
            <FolderOpen size={12} />
            Build from phenotype
          </button>
        )}
      </div>
      <RemoteFileBrowser
        open={browserOpen}
        onClose={() => setBrowserOpen(false)}
        title={`Select ${port.label}`}
        mode={port.multi ? 'multi-file' : 'file'}
        initialPath={initialPath}
        accept={accept}
        onSelect={attachInputFiles}
      />
    </div>
  )
}

function ToolOutputRow({
  port,
  consumers,
  nodeId,
  data,
  updateNodeData,
  showMergeBehavior,
  snapshot,
}: {
  port: ToolPort
  consumers: PipelineSnapshot['edges']
  nodeId: string
  data: ToolNodeData
  updateNodeData: (nodeId: string, patch: Partial<ToolNodeData>) => void
  showMergeBehavior: boolean
  snapshot: PipelineSnapshot
}) {
  const deleteEdge = usePipelineStore((s) => s.deleteEdge)
  const pathSettings = useSettingsStore((s) => s.settings.paths)
  const mergeConfig = data.outputMerge?.[port.id]
  const autoMergeEnabled = mergeConfig ? mergeConfig.mode === 'auto-merge' : Boolean(port.autoMergeDefault)
  const intermediate = data.outputIntermediate?.[port.id] ?? false
  const finalOutputPreview = useMemo(
    () => computeToolPortOutputPreview(nodeId, port.id, snapshot, pathSettings),
    [nodeId, pathSettings, port.id, snapshot],
  )
  const physicalOutputPreviews = useMemo(
    () => computeToolPortPhysicalOutputPreviews(nodeId, port.id, snapshot, pathSettings),
    [nodeId, pathSettings, port.id, snapshot],
  )
  const showPhysicalPlotOutputs = physicalOutputPreviews.length > 1
    || Boolean(physicalOutputPreviews[0] && physicalOutputPreviews[0] !== finalOutputPreview)
  const outputTypeLabel = showPhysicalPlotOutputs ? 'png/pdf' : port.fileType
  return (
    <div className="rounded-md border border-border bg-bg-tertiary px-2 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium text-text-primary">{port.label}</span>
        <span className="rounded bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-muted">{outputTypeLabel}</span>
      </div>
      <div className="mt-1 text-[11px] leading-relaxed text-text-muted">
        {port.description ?? `Produces a ${port.fileType} output.`}
      </div>
      <div className="mt-1.5 text-text-secondary">
        {consumers.length > 0
          ? `${consumers.length} downstream connection${consumers.length === 1 ? '' : 's'}`
          : 'Not connected downstream; the file is still written when the node runs.'}
      </div>
      {finalOutputPreview && (
        <div className="mt-1.5 rounded border border-border bg-bg-primary px-2 py-1 text-[11px] text-text-muted">
          <span className="text-text-secondary">{autoMergeEnabled && showMergeBehavior ? 'Final merged file: ' : 'Final file: '}</span>
          <span className="font-mono text-text-primary" title={finalOutputPreview}>
            <MiddleEllipsis value={finalOutputPreview} max={48} />
          </span>
        </div>
      )}
      {showPhysicalPlotOutputs && (
        <div data-wrap className="mt-1.5 rounded border border-accent/20 bg-accent/10 px-2 py-1 text-[11px] text-text-muted">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">Plot files written</div>
          <div className="flex flex-col gap-1">
            {physicalOutputPreviews.map((path) => (
              <div key={path} data-wrap className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-2">
                <span className="font-mono text-text-secondary">{path.toLowerCase().endsWith('.pdf') ? 'PDF' : 'PNG'}</span>
                <span className="break-all font-mono text-text-primary" title={path}>{path}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {consumers.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {consumers.map((edge) => {
            const target = snapshot.nodes.find((node) => node.id === edge.target)
            if (!target) return null
            return (
              <div key={edge.id} className="flex items-start justify-between gap-2 text-[11px] text-text-secondary">
                <div className="min-w-0">
                  Downstream:
                  {' '}
                  <span className="text-text-primary" title={inspectorNodeLabel(target)}>
                    <MiddleEllipsis value={inspectorNodeLabel(target)} max={32} />
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => deleteEdge(edge.id)}
                  className="shrink-0 rounded border border-border bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-muted hover:text-text-primary"
                  title="Disconnect"
                >
                  Disconnect
                </button>
              </div>
            )
          })}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {showMergeBehavior && (
          <div className="flex items-center gap-1">
            <span className="text-[10px] uppercase tracking-wide text-text-muted">Array output</span>
            <select
              value={autoMergeEnabled ? 'auto-merge' : 'fan-out'}
              onChange={(e) => updateNodeData(nodeId, {
                outputMerge: {
                  ...(data.outputMerge ?? {}),
                  [port.id]: {
                    mode: e.target.value as 'fan-out' | 'auto-merge',
                    strategy: mergeConfig?.strategy ?? port.autoMergeDefault,
                  },
                },
              })}
              className="h-7 rounded border border-border bg-bg-primary px-2 text-[11px] text-text-primary"
            >
              <option value="fan-out">Fan-out</option>
              <option value="auto-merge">Auto-merge</option>
            </select>
          </div>
        )}
        <label className="flex items-center gap-1.5 text-[11px] text-text-secondary">
          <input
            type="checkbox"
            checked={intermediate}
            onChange={(e) => updateNodeData(nodeId, {
              outputIntermediate: {
                ...(data.outputIntermediate ?? {}),
                [port.id]: e.target.checked,
              },
            })}
            className="accent-accent"
          />
          Delete this output after a successful run
        </label>
        <span className="text-[10px] text-text-muted">
          Off by default; only generated files from this output are eligible.
        </span>
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

function isRBackedTool(toolId: string): boolean {
  return toolId === 'plot.manhattan'
    || toolId === 'plot.qq'
    || toolId === 'r.plot'
    || toolId === 'custom.r'
    || toolId === 'table.gtsummary'
    || toolId === 'r.regression'
}

function RPackageSetupPanel({ data }: { data: ToolNodeData }) {
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const settings = useSettingsStore((s) => s.settings)
  const [message, setMessage] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const toolsRoot = settings.toolsRoot || '~/bioflow/tools'
  const rLibPath = `${toolsRoot.replace(/\/+$/, '')}/R/library`
  const moduleName = data.moduleOverride?.trim() || resolvedModuleDefault(data.toolId, 'r/4.4.0', settings)
  const packages = rPackagesForTool(data.toolId, data)

  const installCommand = [
    'module --force purge >/dev/null 2>&1 || true',
    'module load StdEnv/2023 >/dev/null 2>&1 || true',
    `module load ${shellQuoteClient(moduleName)}`,
    `mkdir -p ${shellQuoteClient(rLibPath)}`,
    `export R_LIBS_USER=${shellQuoteClient(rLibPath)}`,
    `cat > ${shellQuoteClient(`${rLibPath}/bioflow-r-packages.R`)} <<'RS'`,
    'lib <- Sys.getenv("R_LIBS_USER")',
    'if (!dir.exists(lib)) dir.create(lib, recursive = TRUE, showWarnings = FALSE)',
    '.libPaths(unique(c(lib, .libPaths())))',
    `packages <- c(${packages.map((pkg) => JSON.stringify(pkg)).join(', ')})`,
    'missing <- packages[!vapply(packages, requireNamespace, logical(1), quietly = TRUE)]',
    'if (length(missing) > 0) install.packages(missing, repos = Sys.getenv("BIOFLOW_CRAN_MIRROR", "https://cloud.r-project.org"), lib = lib)',
    'missing <- packages[!vapply(packages, requireNamespace, logical(1), quietly = TRUE)]',
    'if (length(missing) > 0) stop("Missing R packages after install: ", paste(missing, collapse = ", "))',
    'cat("R packages ready in ", lib, "\\n", sep = "")',
    'RS',
    `if command -v flock >/dev/null 2>&1; then (flock -w 900 9 && Rscript ${shellQuoteClient(`${rLibPath}/bioflow-r-packages.R`)}) 9>${shellQuoteClient(`${rLibPath}/.bioflow-r-packages.lock`)}; else Rscript ${shellQuoteClient(`${rLibPath}/bioflow-r-packages.R`)}; fi`,
  ].join('\n')

  const runInstall = async () => {
    if (!activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID) {
      setMessage('Connect to Rorqual before checking R packages.')
      return
    }
    setRunning(true)
    setMessage('Checking R packages on the login node...')
    try {
      const result = await window.api.ssh.exec(activeConnectionId, installCommand)
      setMessage(result.exitCode === 0 ? (result.stdout.trim() || 'R packages are ready.') : `Failed (${result.exitCode}): ${result.stderr || result.stdout}`)
    } catch (err: any) {
      setMessage(`Failed: ${err?.message ?? err}`)
    } finally {
      setRunning(false)
    }
  }

  return (
    <details>
      <summary className="cursor-pointer select-none text-[10px] font-medium uppercase tracking-wide text-text-muted hover:text-text-secondary">
        Advanced R package check
      </summary>
      <div className="rounded-md border border-border bg-bg-tertiary/50 p-2">
        <div className="text-[11px] text-text-muted">
          Run will check/install these automatically in <span className="font-mono text-text-secondary">{rLibPath}</span>: {packages.join(', ')}.
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={running || !activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID}
            onClick={() => void runInstall()}
            className="h-7 px-2 text-[11px]"
          >
            {running ? 'Checking...' : 'Check/install packages'}
          </Button>
          <span className="text-[10px] text-text-muted">Module: <span className="font-mono">{moduleName}</span></span>
        </div>
        {message && (
          <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-bg-primary p-2 text-[10px] text-text-secondary">
            {message}
          </pre>
        )}
      </div>
    </details>
  )
}

function ManhattanPlotPanel({
  nodeId,
  data,
  snapshot,
  schemas,
  refreshingSchemaPath,
  onLoadSchema,
  onParam,
}: {
  nodeId: string
  data: ToolNodeData
  snapshot: PipelineSnapshot
  schemas: SchemaCache
  refreshingSchemaPath: string | null
  onLoadSchema: (path: string, options?: { force?: boolean; origin?: FileOrigin | null }) => Promise<void>
  onParam: (name: string, value: unknown) => void
}) {
  const settings = useSettingsStore((s) => s.settings)
  const tool = getTool('plot.manhattan')
  const inputPath = connectedInputPath(snapshot, nodeId, 'sumstats')
  const schema = resolveUpstreamSchema(snapshot, nodeId, 'sumstats', schemas)
  const columns = schema?.columns ?? []
  const paramByName = new Map((tool?.params ?? []).map((param) => [param.name, param]))
  const plotPaths = computeToolPortPhysicalOutputPreviews(nodeId, 'plot', snapshot, settings.paths)
  const columnParams = ['chrCol', 'bpCol', 'pCol', 'snpCol']
    .map((name) => paramByName.get(name))
    .filter((param): param is ToolParam => Boolean(param))
  const outputParams = ['outputFormats', 'title']
    .map((name) => paramByName.get(name))
    .filter((param): param is ToolParam => Boolean(param))
  const styleParams = ['genomewide', 'suggestive', 'width', 'height', 'dpi']
    .map((name) => paramByName.get(name))
    .filter((param): param is ToolParam => Boolean(param))

  if (!tool) return null

  return (
    <div data-wrap className="flex flex-col gap-3">
      <section data-wrap className="rounded-md border border-border bg-bg-tertiary/40 p-2">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h4 className="text-[10px] font-medium uppercase tracking-wide text-text-muted">Required columns</h4>
          {inputPath && (
            <button
              type="button"
              onClick={() => void onLoadSchema(inputPath, { force: true, origin: connectedInputOrigin(snapshot, nodeId, 'sumstats') })}
              className="rounded border border-border bg-bg-secondary px-2 py-1 text-[10px] text-text-muted hover:text-text-primary"
            >
              {refreshingSchemaPath === inputPath ? 'Refreshing...' : 'Refresh columns'}
            </button>
          )}
        </div>
        {inputPath ? (
          <div className="mb-2 break-all font-mono text-[10px] text-text-muted" title={inputPath}>{inputPath}</div>
        ) : (
          <div className="mb-2 text-[11px] text-warning">Connect PLINK/summary statistics to choose plot columns.</div>
        )}
        <div className="grid grid-cols-1 gap-2">
          {columnParams.map((param) => (
            <ColumnParamField
              key={param.name}
              param={param}
              value={data.paramValues[param.name]}
              columns={columns}
              loading={Boolean(inputPath && columns.length === 0)}
              refreshing={refreshingSchemaPath === inputPath}
              onRefresh={inputPath ? () => void onLoadSchema(inputPath, { force: true, origin: connectedInputOrigin(snapshot, nodeId, 'sumstats') }) : undefined}
              onChange={(value) => onParam(param.name, value)}
            />
          ))}
        </div>
      </section>

      <section data-wrap className="rounded-md border border-border bg-bg-tertiary/40 p-2">
        <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wide text-text-muted">Output files</h4>
        <div className="grid grid-cols-1 gap-2">
          {outputParams.map((param) => (
            <ParamField key={param.name} param={param} value={data.paramValues[param.name]} onChange={(value) => onParam(param.name, value)} />
          ))}
        </div>
        <div data-wrap className="mt-2 rounded border border-accent/20 bg-accent/10 px-2 py-1.5">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">Files BioFlow will write</div>
          <div className="flex flex-col gap-1 text-[11px]">
            {plotPaths.map((path) => (
              <div key={path} data-wrap className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-2">
                <span className="font-mono text-text-secondary">{path.toLowerCase().endsWith('.pdf') ? 'PDF' : 'PNG'}</span>
                <span className="break-all font-mono text-text-primary" title={path}>{path}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section data-wrap className="rounded-md border border-border bg-bg-tertiary/40 p-2">
        <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wide text-text-muted">Plot styling</h4>
        <div className="grid grid-cols-2 gap-2">
          {styleParams.map((param) => (
            <ParamField key={param.name} param={param} value={data.paramValues[param.name]} onChange={(value) => onParam(param.name, value)} />
          ))}
        </div>
      </section>
    </div>
  )
}

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
  const confirmDialog = useDialogStore((s) => s.confirm)
  const setSetting = useSettingsStore((s) => s.setSetting)
  const [message, setMessage] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [annovarStatus, setAnnovarStatus] = useState<AnnovarStatusResult | null>(null)
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
  const toolPath = params.toolPath === undefined ? defaultToolPath : String(params.toolPath ?? '')
  const dbPath = params.annotationDbPath === undefined ? defaultDbPath : String(params.annotationDbPath ?? '')

  const patchParams = (patch: Record<string, unknown>) => {
    updateNodeData(nodeId, { paramValues: { ...params, ...patch } })
  }

  useEffect(() => {
    if (!isAnnovar || !activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID) return
    const databases = annovarDbNames(featureIds)
    if (databases.length === 0) {
      setAnnovarStatus(null)
      return
    }
    let cancelled = false
    void window.api.annovar.status(activeConnectionId, dbPath, build, databases).then((status) => {
      if (!cancelled) setAnnovarStatus(status)
    }).catch(() => {
      if (!cancelled) setAnnovarStatus(null)
    })
    return () => { cancelled = true }
  }, [activeConnectionId, build, dbPath, featureIds, isAnnovar])

  useEffect(() => {
    if (!isAnnovar) return
    return window.api.annovar.onInstallProgress((progress) => {
      if (progress.connectionId !== activeConnectionId) return
      setMessage((prev) => `${progress.database}: ${progress.phase}${progress.chunk ? `\n${progress.chunk.trim()}` : prev ? `\n${prev}` : ''}`)
    })
  }, [activeConnectionId, isAnnovar])

  const toggleAnnovarFeature = (id: string) => {
    const next = featureIds.includes(id) ? featureIds.filter((value) => value !== id) : [...featureIds, id]
    const generated = annovarParamsForFeatures(next)
    patchParams({ annotationFeatures: next.join(','), ...generated })
  }

  const toggleVepFeature = (id: string) => {
    const next = featureIds.includes(id) ? featureIds.filter((value) => value !== id) : [...featureIds, id]
    const selected = VEP_FEATURES.filter((feature) => next.includes(feature.id))
    const merged: Record<string, unknown> = { annotationFeatures: next.join(',') }
    for (const feature of VEP_FEATURES) {
      for (const [key, value] of Object.entries(feature.params)) {
        merged[key] = typeof value === 'boolean' ? false : undefined
      }
    }
    for (const feature of selected) Object.assign(merged, feature.params)
    patchParams(merged)
  }

  const runLoginCommand = async (command: string) => {
    if (!activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID) {
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

  const pendingAnnovarDatabases = annovarStatus?.databases
    .filter((row) => row.status !== 'installed')
    .map((row) => row.database) ?? annovarDbNames(featureIds)

  return (
    <div>
      <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
        Annotation setup
      </h4>
      <div className="flex flex-col gap-3 rounded-md border border-border bg-bg-primary p-2">
        <div className="rounded-md border border-border bg-bg-tertiary p-2">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-text-muted">
            {isAnnovar ? 'Scripts folder' : 'Tool path'}
          </div>
          {isAnnovar ? (
            <RemotePathField
              label="ANNOVAR scripts folder"
              value={toolPath}
              placeholder="~/bioflow/tools/annovar"
              onChange={(value) => patchParams({ toolPath: value })}
              mode="directory"
              title="Choose ANNOVAR scripts folder"
            />
          ) : (
            <RemotePathField
              label="VEP executable or folder"
              value={toolPath}
              placeholder="vep or ~/bioflow/tools/ensembl-vep/vep"
              onChange={(value) => patchParams({ toolPath: value })}
              mode="file"
              title="Choose VEP executable or folder"
            />
          )}
          {isAnnovar && (
            <p className="mt-1 text-[10px] text-text-muted">
              Point this to the folder that contains <code className="font-mono">table_annovar.pl</code> and <code className="font-mono">annotate_variation.pl</code>.
            </p>
          )}
        </div>

        <div className="rounded-md border border-border bg-bg-tertiary p-2">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-text-muted">
            {isAnnovar ? 'Database folder' : 'Cache folder'}
          </div>
          <RemotePathField
            label={isAnnovar ? 'ANNOVAR humandb folder' : 'VEP cache folder'}
            value={dbPath}
            placeholder={isAnnovar ? '~/bioflow/tools/annovar/humandb' : '~/bioflow/tools/vep/cache'}
            onChange={(value) => patchParams({ annotationDbPath: value })}
            mode="directory"
            title={isAnnovar ? 'Choose ANNOVAR humandb folder' : 'Choose VEP cache folder'}
          />
          {isAnnovar && annovarStatus && (
            <div className="mt-2 rounded border border-border/70 bg-bg-primary/70 px-2 py-2 text-[11px]">
              <div className="mb-1 text-text-secondary">Required databases</div>
              <div className="flex flex-wrap gap-1">
                {annovarStatus.databases.map((row) => (
                  <span
                    key={`${row.buildver}:${row.database}`}
                    className={classNames(
                      'rounded px-1.5 py-0.5',
                      row.status === 'installed'
                        ? 'bg-emerald-500/15 text-emerald-200'
                        : row.status === 'stale'
                          ? 'bg-red-500/15 text-red-200'
                          : 'bg-amber-500/15 text-amber-200',
                    )}
                    title={row.expectedPath}
                  >
                    {row.database} · {row.status} · {row.estimatedSizeGB.toFixed(1)} GB
                  </span>
                ))}
              </div>
            </div>
          )}
          {isAnnovar && (
            <div className="mt-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={running || featureIds.length === 0 || !activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID}
                onClick={async () => {
                  if (!activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID) return
                  setRunning(true)
                  setMessage('Saving the humandb path and downloading missing ANNOVAR databases...')
                  try {
                    await setSetting('settings:annovarDbPath', dbPath)
                    if (toolPath.trim()) await setSetting('settings:annovarScriptsPath', toolPath)
                    if (pendingAnnovarDatabases.length === 0) {
                      setMessage('Saved the humandb path. All selected ANNOVAR databases are already installed.')
                      return
                    }
                    await window.api.annovar.install({
                      connectionId: activeConnectionId,
                      scriptsPath: toolPath,
                      humandbPath: dbPath,
                      buildver: build,
                      databases: pendingAnnovarDatabases,
                    })
                    const refreshed = await window.api.annovar.status(activeConnectionId, dbPath, build, annovarDbNames(featureIds))
                    setAnnovarStatus(refreshed)
                    setMessage('Saved the humandb path and finished downloading missing ANNOVAR databases.')
                  } catch (err: any) {
                    setMessage(err?.message ?? String(err))
                  } finally {
                    setRunning(false)
                  }
                }}
              >
                Download selected DBs ({(annovarStatus?.totalDownloadSizeGB ?? 0).toFixed(1)} GB)
              </Button>
            </div>
          )}
        </div>

        <div className="rounded-md border border-border bg-bg-tertiary p-2">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-text-muted">
            Build
          </div>
          <div className="grid grid-cols-2 gap-2">
            {isAnnovar ? (
              <div className="flex flex-col gap-1">
                <label className="text-text-secondary text-xs font-medium">Reference build</label>
                <select
                  value={build}
                  onChange={(event) => patchParams({ buildver: event.target.value })}
                  className="h-8 rounded-md border border-border bg-bg-primary px-2 text-sm text-text-primary"
                >
                  <option value="hg38">hg38</option>
                  <option value="hg19">hg19</option>
                </select>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <label className="text-text-secondary text-xs font-medium">Assembly</label>
                <select
                  value={assembly}
                  onChange={(event) => patchParams({ assembly: event.target.value })}
                  className="h-8 rounded-md border border-border bg-bg-primary px-2 text-sm text-text-primary"
                >
                  <option value="GRCh38">GRCh38</option>
                  <option value="GRCh37">GRCh37</option>
                </select>
              </div>
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
        </div>

        <div className="rounded-md border border-border bg-bg-tertiary p-2">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-text-muted">
            Annotations to add
          </div>
          <div className="flex flex-col gap-1.5">
            {(isAnnovar ? ANNOVAR_FEATURES : VEP_FEATURES).map((feature) => {
              const active = featureIds.includes(feature.id)
              return (
                <button
                  key={feature.id}
                  type="button"
                  onClick={() => isAnnovar ? toggleAnnovarFeature(feature.id) : toggleVepFeature(feature.id)}
                  className={classNames(
                    'rounded-md border px-2 py-1.5 text-left',
                    active ? 'border-accent/50 bg-accent/10' : 'border-border bg-bg-primary hover:bg-bg-hover',
                  )}
                >
                  <div className="text-xs font-medium text-text-primary">{active ? '✓ ' : ''}{feature.label}</div>
                  <div className="text-[11px] text-text-muted">{feature.description}</div>
                </button>
              )
            })}
          </div>
        </div>

        {!isAnnovar && (
          <div className="flex flex-wrap gap-1.5">
            <Button variant="secondary" size="sm" disabled={running || !activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID} onClick={() => void runLoginCommand(prepareToolCommand())}>
              Install VEP
            </Button>
            <Button variant="secondary" size="sm" disabled={running || featureIds.length === 0 || !activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID} onClick={() => void runLoginCommand(databaseCommand())}>
              Install selected databases
            </Button>
          </div>
        )}

        {message && <div className="text-[11px] text-text-muted whitespace-pre-wrap break-all">{message}</div>}
      </div>
    </div>
  )
}

function ToolInspector({ nodeId, data }: { nodeId: string; data: ToolNodeData }) {
  const updateNodeData = usePipelineStore((s) => s.updateNodeData)
  const undoPipelineChange = usePipelineStore((s) => s.undo)
  const nodes = usePipelineStore((s) => s.nodes)
  const edges = usePipelineStore((s) => s.edges)
  const exportSnapshot = usePipelineStore((s) => s.exportSnapshot)
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const dnxDefaultProjectId = useDnxStore((s) => s.defaultProjectId)
  const dnxCatalog = useDnxStore((s) => s.instanceCatalog)
  const refreshDnxCatalog = useDnxStore((s) => s.refreshInstanceCatalog)
  const settings = useSettingsStore((s) => s.settings)
  const devMode = useSettingsStore((s) => s.devMode)
  const loadModules = useClusterInfoStore((s) => s.loadModules)
  const loadingModules = useClusterInfoStore((s) => activeConnectionId ? s.loadingModules[activeConnectionId] : false)
  const schemas = useDataPreviewStore((s) => s.schemas)
  const setSchema = useDataPreviewStore((s) => s.setSchema)
  const tool = getTool(data.toolId)
  const snapshot = useMemo(() => exportSnapshot(), [exportSnapshot, nodes, edges])
  const loadingSchemaKey = useMemo(() => `${nodeId}:${Object.keys(schemas).length}`, [nodeId, schemas])
  const [estimate, setEstimate] = useState<EstimateOutput | null>(null)
  const [learnedEstimate, setLearnedEstimate] = useState<LearnedResourceSummary | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [showEstimateWhy, setShowEstimateWhy] = useState(false)
  const [refreshingSchemaPath, setRefreshingSchemaPath] = useState<string | null>(null)

  /**
   * Inputs whose upstream source carries an axis — either a file node with
   * `split` set, or a tool/merge upstream that itself ran as an array
   * (approximated here by checking file nodes only; the runner-side planner
   * handles propagation through tools).
   */
  const axedInputPorts = useMemo(() => {
    const result: Array<{ portId: string; axis: string }> = []
    const activePortIds = tool ? new Set(getActiveToolInputs(tool, data, { connectedPortIds: snapshot.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.targetHandle ?? 'input') }).map((port) => port.id)) : null
    for (const edge of edges) {
      if (edge.target !== nodeId) continue
      const portId = edge.targetHandle
      if (!portId) continue
      if (activePortIds && !activePortIds.has(portId)) continue
      const src = nodes.find((n) => n.id === edge.source)
      if (!src) continue
      if (src.type === 'file') {
        const fd = src.data as FileNodeData
        if (fd.split?.axis && safeSplitItems(fd.split).length > 0) {
          result.push({ portId, axis: fd.split.axis })
        }
      }
    }
    return result
  }, [nodes, edges, nodeId, tool, data])
  const axisAlignment = useMemo(() => buildAxisAlignmentReport(snapshot, nodeId), [snapshot, nodeId])

  const setParam = useCallback(
    (name: string, value: unknown) => {
      const nextParamValues = { ...data.paramValues, [name]: value }
      updateNodeData(nodeId, {
        paramValues: nextParamValues,
        flagBlocks: toolUsesFlagBuilder(data.toolId)
          ? syncFlagBlocksFromParamValues(data.toolId, data.flagBlocks, nextParamValues)
          : data.flagBlocks,
      })
    },
    [nodeId, data.flagBlocks, data.paramValues, data.toolId, updateNodeData],
  )

  const setSlurm = useCallback(
    (patch: Partial<NonNullable<ToolNodeData['slurmOverride']>>) => {
      updateNodeData(nodeId, {
        slurmOverride: { ...data.slurmOverride, ...patch },
      })
    },
    [nodeId, data.slurmOverride, updateNodeData],
  )

  const loadSchemaForPath = useCallback(async (path: string, options?: { force?: boolean; origin?: FileOrigin | null }) => {
    if (!activeConnectionId || !path) return
    const origin = options?.origin ?? pathOriginInSnapshot(snapshot, path)
    if (origin === 'dnx') return
    if (origin === 'ssh' && activeConnectionId === LOCAL_CONNECTION_ID) return
    const schemaConnectionId = origin === 'local' ? LOCAL_CONNECTION_ID : activeConnectionId
    if (!options?.force && schemas[path]) return
    setRefreshingSchemaPath(path)
    try {
      const [stat, text] = await Promise.all([
        statFileForConnection(schemaConnectionId, path).catch(() => null),
        headPreviewFileForConnection(schemaConnectionId, path, 30),
      ])
      const current = useDataPreviewStore.getState().schemas[path]
      if (!options?.force && current && stat?.modified && current.modified === stat.modified) return
      const schema = parseHeader(text, path)
      if (schema.columns.length > 0) {
        setSchema(path, { columns: schema.columns, delimiter: schema.delimiter, modified: stat?.modified })
      }
    } finally {
      setRefreshingSchemaPath(null)
    }
  }, [activeConnectionId, schemas, setSchema, snapshot])

  useEffect(() => {
    if (!activeConnectionId || !tool) return
    const refs = tool.params.filter((param) => param.columnRef)
    if (refs.length === 0) return
    let cancelled = false
    async function loadSchemas() {
      for (const param of refs) {
        const portId = param.columnSourcePortId ?? 'input'
        const path = connectedInputPath(snapshot, nodeId, portId)
        if (!path || schemas[path]) continue
        try {
          if (cancelled) return
          await loadSchemaForPath(path, { origin: connectedInputOrigin(snapshot, nodeId, portId) })
        } catch {
          // Missing schema is non-blocking; users can still type values.
        }
      }
    }
    void loadSchemas()
    return () => { cancelled = true }
  }, [activeConnectionId, loadingSchemaKey, loadSchemaForPath, nodeId, schemas, snapshot, tool])

  useEffect(() => {
    if (!activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID || !tool) {
      setLearnedEstimate(null)
      return
    }
    let cancelled = false
    void window.api.cluster.getLearnedResources(activeConnectionId, tool.id).then((result) => {
      if (!cancelled) setLearnedEstimate(result)
    }).catch(() => {
      if (!cancelled) setLearnedEstimate(null)
    })
    return () => { cancelled = true }
  }, [activeConnectionId, tool])

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
            ? safeSplitItems((snapshot.nodes.find((node) =>
                snapshot.edges.some((edge) => edge.target === nodeId && edge.targetHandle === firstAxed.portId && edge.source === node.id),
              )?.data as FileNodeData | undefined)?.split).length
            : undefined,
          hasFilter: hasFilteringParam(data),
          partitionMaxMemGB: settings.partitionMaxMemGB,
          learned: learnedEstimate,
        }))
      } finally {
        if (!cancelled) setEstimating(false)
      }
    }
    void loadEstimate()
    return () => { cancelled = true }
  }, [activeConnectionId, axedInputPorts, data, learnedEstimate, nodeId, settings.partitionMaxMemGB, snapshot, tool])

  useEffect(() => {
    const supported = (tool?.backends ?? ['ssh']).filter((backend) => devMode || backend !== 'dnx')
    const currentBackend = supported.includes('dnx') && data.backend === 'dnx' ? 'dnx' : supported[0] === 'dnx' ? 'dnx' : 'ssh'
    if (currentBackend !== 'dnx' || dnxCatalog?.specs?.length) return
    void refreshDnxCatalog().catch(() => undefined)
  }, [data.backend, devMode, dnxCatalog?.specs?.length, refreshDnxCatalog, tool])

  if (!tool) {
    return <div className="p-4 text-xs text-error">Unknown tool: {data.toolId}</div>
  }

  const ToolIcon = iconForTool(data.toolId)
  const moduleDefault = resolvedModuleDefault(tool.command || tool.id, tool.module, settings)
  const supportedBackends = (tool.backends ?? ['ssh']).filter((item) => devMode || item !== 'dnx')
  const backend = supportedBackends.includes('dnx') && data.backend === 'dnx' ? 'dnx' : supportedBackends[0] === 'dnx' ? 'dnx' : 'ssh'
  const dnxInstanceOptions = dnxCatalog?.specs?.length ? dnxCatalog.specs : SPARK_INSTANCE_TYPES
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
  const activeInputs = getActiveToolInputs(tool, data, { connectedPortIds: inputEdgesByPort.keys() })
  const analysisDefs = getAnalysisOptionDefs(tool)
  const analysisOptions = normalizeAnalysisOptions(tool, data, { connectedPortIds: inputEdgesByPort.keys() })
  const analysisOptionsById = new Map(analysisOptions.map((option) => [option.optionId, option]))
  const inputOptionByPort = new Map<string, AnalysisOptionDef>()
  for (const def of analysisDefs) {
    const portId = def.filePortId
    if (!portId || !(def.kind === 'file' || def.kind === 'compound')) continue
    if (analysisOptionsById.get(def.id)?.enabled) inputOptionByPort.set(portId, def)
  }
  const visibleParams = tool.requiresDatabase
    ? tool.params.filter((param) => !param.internal && !ANNOTATION_INTERNAL_PARAMS.has(param.name))
    : tool.params.filter((param) => !param.internal)
  const commonParams = visibleParams.filter((param) => param.core || !param.advanced)
  const paramSections: Array<'Inputs' | 'Analysis' | 'Filters' | 'Output' | 'Runtime'> = ['Inputs', 'Analysis', 'Filters', 'Output', 'Runtime']
  const sortParams = (params: typeof visibleParams) =>
    [...params].sort((a, b) => Number(b.core) - Number(a.core) || a.label.localeCompare(b.label))
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
  const setAnalysisOptions = useCallback((patch: Partial<Pick<ToolNodeData, 'analysisOptions' | 'paramValues' | 'commandOverride'>>) => {
    updateNodeData(nodeId, {
      analysisOptions: patch.analysisOptions,
      paramValues: patch.paramValues,
      commandOverride: patch.commandOverride,
    })
  }, [nodeId, updateNodeData])

  const disableOptionPort = useCallback((portId: string) => {
    let removed = 0
    for (const edge of snapshot.edges) {
      if (edge.target === nodeId && (edge.targetHandle ?? 'input') === portId) {
        usePipelineStore.getState().deleteEdge(edge.id)
        removed += 1
      }
    }
    return removed
  }, [nodeId, snapshot.edges])

  const removeInputOption = (def: AnalysisOptionDef) => {
    const nextOptions = analysisOptions.map((option) =>
      option.optionId === def.id ? { ...option, enabled: false } : option,
    )
    disableOptionPort(def.filePortId ?? def.sourcePortId ?? '')
    updateNodeData(nodeId, {
      analysisOptions: nextOptions,
      paramValues: analysisOptionsToParamValues(tool, nextOptions, data.paramValues),
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
          <div className="flex items-center gap-1.5">
            <ToolIcon size={11} className="text-text-muted" />
            <span>Tool: <span className="font-mono text-text-secondary">{tool.id}</span></span>
          </div>
          <div>Command: <span className="font-mono text-text-secondary">{tool.command}</span></div>
          {tool.module && <div>Module: <span className="font-mono text-text-secondary">{tool.module}</span></div>}
        </div>
        <p className="text-xs text-text-muted mt-2">{tool.description}</p>
        {tool.docUrl && (
          <button
            type="button"
            className="mt-2 text-[11px] text-accent underline"
            onClick={() => window.open(tool.docUrl!, '_blank', 'noopener,noreferrer')}
          >
            Open official docs
          </button>
        )}
      </div>

      {supportedBackends.length > 1 && (
        <div>
          <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
            Backend
          </h4>
          <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-bg-tertiary p-1">
            {supportedBackends.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => updateNodeData(nodeId, { backend: option })}
                className={classNames(
                  'h-7 rounded text-xs transition-colors',
                  backend === option
                    ? 'bg-accent text-white'
                    : 'text-text-secondary hover:text-text-primary',
                )}
              >
                {option === 'dnx' ? 'DNAnexus' : 'Rorqual'}
              </button>
            ))}
          </div>
          {backend === 'dnx' && !dnxDefaultProjectId && (
            <p className="text-[10px] text-warning mt-2">
              Choose a default DNAnexus project in Settings before running this node on DNAnexus.
            </p>
          )}
        </div>
      )}

      {backend === 'dnx' && (
        <div>
          <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
            DNAnexus Runtime
          </h4>
          <select
            value={data.dnxInstanceType ?? ''}
            onChange={(e) => updateNodeData(nodeId, { dnxInstanceType: e.target.value || undefined })}
            className="h-8 w-full rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent focus:border-accent"
          >
            <option value="">Default instance</option>
            {dnxInstanceOptions.map((spec) => (
              <option key={spec.id} value={spec.id}>
                {spec.name} ({spec.cpu} CPU, {spec.memoryGB} GB)
              </option>
            ))}
          </select>
          <div className="mt-1 text-[10px] text-text-muted">
            {dnxCatalog?.lastRefreshed
              ? `Specs refreshed ${new Date(dnxCatalog.lastRefreshed).toLocaleString()}.`
              : 'Using bundled instance specs until the live catalog is refreshed.'}
            {' '}
            <a
              href="https://documentation.dnanexus.com/developer/api/running-analyses/instance-types"
              target="_blank"
              rel="noreferrer"
              className="text-accent underline"
            >
              View current pricing
            </a>
          </div>
        </div>
      )}

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
              onClick={() => {
                if (backend === 'dnx' && option.value === 'login') return
                updateNodeData(nodeId, { executionMode: option.value === 'sbatch' ? undefined : 'login' })
              }}
              className={classNames(
                'h-7 rounded text-xs transition-colors',
                executionMode === option.value
                  ? 'bg-accent text-white'
                  : 'text-text-secondary hover:text-text-primary',
              )}
              disabled={backend === 'dnx' && option.value === 'login'}
            >
              {option.label}
            </button>
          ))}
        </div>
        {backend === 'dnx' ? (
          <div className="mt-2 rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-1.5 text-[11px] text-cyan-100">
            DNAnexus-backed tools run as platform jobs. Login-node execution is not available on this backend.
          </div>
        ) : executionMode === 'login' && (
          <div className="mt-2 rounded border border-yellow-500/30 bg-yellow-500/10 px-2 py-1.5 text-[11px] text-yellow-200">
            Running an array or heavy job on the login node will likely be killed by cluster admins. Consider Slurm for anything beyond quick commands.
          </div>
        )}
        {backend !== 'dnx' && (
          <div className="mt-2">
          <ModuleAutocompleteField
            connectionId={activeConnectionId}
            value={data.moduleOverride ?? moduleDefault}
            loading={Boolean(loadingModules)}
            placeholder={moduleDefault || tool.module || 'plink/2.00a3'}
            onChange={(value) => updateNodeData(nodeId, { moduleOverride: value.trim() || undefined })}
            onRefresh={() => {
              if (activeConnectionId && activeConnectionId !== LOCAL_CONNECTION_ID) {
                void loadModules(activeConnectionId, data.moduleOverride ?? moduleDefault, { force: true })
              }
            }}
          />
          <p className="mt-1 text-[10px] text-text-muted">
            Leave blank to use the configured default for this tool family. Free text still works if the module list is incomplete.
          </p>
          </div>
        )}
      </div>

      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Inputs
        </h4>
        <div className="flex flex-col gap-1.5">
          {activeInputs.map((port) => (
            <ToolInputRow
              key={port.id}
              nodeId={nodeId}
              port={port}
              connections={inputEdgesByPort.get(port.id) ?? []}
              snapshot={snapshot}
              optionDef={inputOptionByPort.get(port.id)}
              onRemoveOption={
                inputOptionByPort.get(port.id) && !port.required
                  ? () => removeInputOption(inputOptionByPort.get(port.id)!)
                  : undefined
              }
            />
          ))}
          {activeInputs.length === 0 && (
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
              nodeId={nodeId}
              data={data}
              updateNodeData={updateNodeData}
              showMergeBehavior={axedInputPorts.length > 0}
              snapshot={snapshot}
            />
          ))}
          {tool.outputs.length === 0 && (
            <div className="text-xs text-text-muted italic">This tool has no declared outputs.</div>
          )}
        </div>
      </div>

      {tool.id === 'ukb.spark-extract' && (
        <div className="flex flex-col gap-4">
          <div>
            <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
              UKB Fields
            </h4>
            <UkbFieldBuilder nodeId={nodeId} value={data.paramValues?.fields} />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <select
              value={String(data.paramValues?.codingValues ?? 'replace')}
              onChange={(e) => setParam('codingValues', e.target.value)}
              className="h-8 w-full rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent focus:border-accent"
            >
              <option value="replace">Replace coding values</option>
              <option value="raw">Keep raw coding values</option>
            </select>
            <Input
              label="Output filename"
              value={String(data.paramValues?.outputName ?? 'ukb_extracted_traits.tsv')}
              onChange={(e) => setParam('outputName', e.target.value)}
            />
          </div>

          <Input
            label="DNAnexus output folder"
            value={String(data.paramValues?.outputFolder ?? '/')}
            onChange={(e) => {
              setParam('outputFolder', e.target.value)
              updateNodeData(nodeId, { outputDirOverride: e.target.value || undefined })
            }}
            placeholder="/BioFlow/extracts"
          />
        </div>
      )}

      {tool.requiresDatabase && <AnnotationConfigPanel nodeId={nodeId} data={data} />}
      {isRBackedTool(tool.id) && <RPackageSetupPanel data={data} />}

      {/* Parameters */}
      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Parameters
        </h4>
        {tool.id === 'plot.manhattan' ? (
          <ManhattanPlotPanel
            nodeId={nodeId}
            data={data}
            snapshot={snapshot}
            schemas={schemas}
            refreshingSchemaPath={refreshingSchemaPath}
            onLoadSchema={loadSchemaForPath}
            onParam={setParam}
          />
        ) : tool.id === 'custom.shell' || tool.id === 'custom.r' ? (
          <div className="flex flex-col gap-2">
            {paramSections.map((section) => {
              const sectionParams = sortParams(commonParams.filter((param) => toolParamSection(param) === section))
              if (sectionParams.length === 0) return null
              return (
                <div key={section} className="rounded-md border border-border bg-bg-tertiary/40 p-2">
                  <div className="mb-2 text-[10px] uppercase tracking-wide text-text-muted">{section}</div>
                  <div className="flex flex-col gap-2">
                    {sectionParams.map((p) => (
                      p.name === 'script' && tool.id === 'custom.shell'
                        ? (
                            <ShellScriptField
                              key={p.name}
                              value={data.paramValues[p.name]}
                              onChange={(v) => setParam(p.name, v)}
                              outputContract={data.outputContract}
                              onOutputContractChange={(contract) => updateNodeData(nodeId, { outputContract: contract })}
                            />
                          )
                        : p.name === 'script' && tool.id === 'custom.r'
                          ? (
                              <RScriptField
                                key={p.name}
                                value={data.paramValues[p.name]}
                                onChange={(v) => setParam(p.name, v)}
                              />
                            )
                        : <ParamField key={p.name} param={p} value={data.paramValues[p.name]} onChange={(v) => setParam(p.name, v)} />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <AnalysisOptionsPanel
            nodeId={nodeId}
            tool={tool}
            nodeData={data}
            snapshot={snapshot}
            schemas={schemas}
            refreshingSchemaPath={refreshingSchemaPath}
            onLoadSchema={loadSchemaForPath}
            onChange={setAnalysisOptions}
            onDisablePort={disableOptionPort}
            onUndoDisconnect={undoPipelineChange}
          />
        )}
      </div>

      {/* Array over (fan-out control) */}
      {axedInputPorts.length > 0 && (
        <div>
          <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
            Split input behavior
          </h4>
          <div className="mb-2 rounded border border-border bg-bg-tertiary px-2 py-1.5 text-[11px] leading-5 text-text-muted">
            This tool receives at least one split input. BioFlow can submit one Slurm array task per accepted item,
            passing that item's path into the selected input port.
          </div>
          {axisAlignment.rows.length > 1 && (
            <div className={classNames(
              'mb-2 rounded border px-2 py-1.5 text-[11px] leading-5',
              axisAlignment.status === 'ok'
                ? 'border-success/30 bg-success/10 text-success'
                : 'border-warning/30 bg-warning/10 text-warning',
            )}>
              <div className="font-medium">{axisAlignment.message}</div>
              <div className="mt-1 grid gap-1">
                {axisAlignment.rows.map((row) => (
                  <div key={row.portId} className="flex items-center justify-between gap-2">
                    <span className="font-mono">{row.portId}</span>
                    <span className="truncate text-right">
                      {row.keys.length} keys
                      {row.missingKeys.length > 0 ? ` · missing ${row.missingKeys.slice(0, 4).join(', ')}` : ''}
                      {row.extraKeys.length > 0 ? ` · extra ${row.extraKeys.slice(0, 4).join(', ')}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <label className="text-text-secondary text-xs font-medium">
              Split input behavior
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
              <option value="__auto__">Auto array over the split input</option>
              <option value="__none__">Force one single job</option>
              {axedInputPorts.map((p) => {
                const port = activeInputs.find((ip) => ip.id === p.portId)
                return (
                  <option key={p.portId} value={p.portId}>
                    Use {port?.label ?? p.portId} as the array axis ({p.axis})
                  </option>
                )
              })}
            </select>
            <p className="text-[10px] text-text-muted mt-1">
              {axedInputPorts.length === 1
                ? 'Auto submits one Slurm array task per accepted item, such as one task per chromosome.'
                : 'Multiple split inputs are connected. Choose which input defines the task keys, or force a single fan-in job.'}
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
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-text-muted">
                  <span>Confidence: {estimate.confidence}</span>
                  <span>{estimate.source === 'learned' ? `Learned from ${estimate.learnedSampleCount} jobs` : 'Registry default'}</span>
                  {estimate.source === 'learned' && activeConnectionId && activeConnectionId !== LOCAL_CONNECTION_ID && (
                    <button
                      type="button"
                      className="underline hover:text-text-primary"
                      onClick={() => {
                        void window.api.cluster.resetLearnedResources(activeConnectionId, tool.id).then(() => {
                          setLearnedEstimate(null)
                        })
                      }}
                    >
                      Reset learned values
                    </button>
                  )}
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
    </div>
  )
}

function FileInspector({ nodeId, data }: { nodeId: string; data: FileNodeData }) {
  const updateNodeData = usePipelineStore((s) => s.updateNodeData)
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const settings = useSettingsStore((s) => s.settings)
  const confirmDialog = useDialogStore((s) => s.confirm)

  const split = useMemo(() => normalizeSplitForInspector(data.split), [data.split])
  const outputParts = !data.isInput ? splitOutputPath(data) : null
  const [uploading, setUploading] = useState(false)
  const [uploadMessage, setUploadMessage] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ items: FileNodeSplit['items']; missing: Set<string>; loading: boolean; error: string | null }>({
    items: [],
    missing: new Set(),
    loading: false,
    error: null,
  })
  const [splitFolder, setSplitFolder] = useState(() => splitFolderFromData(data))
  const [splitDetectMode, setSplitDetectMode] = useState<SplitDetectMode>('auto')
  const [detectingSplit, setDetectingSplit] = useState(false)
  const [detectMessage, setDetectMessage] = useState<string | null>(null)
  const splitListingCacheRef = useRef(new Map<string, RemoteFileEntry[]>())
  const [rangeDraft, setRangeDraft] = useState('')
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [splitBrowseRow, setSplitBrowseRow] = useState<number | null>(null)
  const setSplit = useCallback(
    (next: FileNodeSplit | undefined) => {
      updateNodeData(nodeId, { split: next })
    },
    [nodeId, updateNodeData],
  )

  const addRow = useCallback(() => {
    if (!split) return
    const items = split?.items ?? []
    setSplit({
      ...split,
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
  const splitSeedPath = splitFolder.trim() || split?.folderPath || data.path

  const setPattern = useCallback((next: SplitPattern) => {
    if (!split) return
    setSplit({ ...split, pattern: next })
  }, [split, setSplit])

  const acceptedRange = useMemo(() => split ? sharedRangeTextFromItems(split.items) : '', [split])

  useEffect(() => {
    setRangeDraft(acceptedRange)
  }, [acceptedRange])

  useEffect(() => {
    if (splitBrowseRow === null) return
    if (split && split.items[splitBrowseRow]) return
    setSplitBrowseRow(null)
  }, [split, splitBrowseRow])

  useEffect(() => {
    if (!split) return
    const missingPathCount = split.items.filter((item) => !item.path.trim()).length
    if (missingPathCount === 0) return
    const rangeText = sharedRangeTextFromItems(split.items)
    if (!rangeText) return
    const resolved = resolveSplitItemsForRange(rangeText, split.items, pattern, split.axis || 'items')
    if (resolved.error || resolved.items.some((item) => !item.path.trim())) return
    const changed = resolved.items.length !== split.items.length
      || resolved.items.some((item, index) => item.key !== split.items[index]?.key || item.path !== split.items[index]?.path)
    if (!changed) return
    setSplit({ ...split, items: resolved.items })
    setDetectMessage(`Filled ${missingPathCount} missing split path${missingPathCount === 1 ? '' : 's'} from the accepted-row pattern.`)
  }, [pattern, setSplit, split])

  useEffect(() => {
    const folder = splitFolderFromData(data)
    const staleParentForDroppedFolder = data.pathKind === 'directory' && splitFolder === pathDirname(data.path)
    if (folder && (!splitFolder || data.split?.folderPath === folder || staleParentForDroppedFolder)) setSplitFolder(folder)
  }, [data, splitFolder])

  const detectSplit = useCallback(async () => {
    if (!split) return
    if (!activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID) {
      setDetectMessage('Connect to a remote host before detecting split files.')
      return
    }
    if (!splitFolder.trim()) {
      setDetectMessage('Pick the folder containing the split files or split folders first.')
      return
    }
    setDetectingSplit(true)
    setDetectMessage(null)
    try {
      const folder = await resolveRemotePathForSftp(activeConnectionId, splitFolder.trim())
      const seedPath = await resolveRemotePathForSftp(activeConnectionId, splitSeedPath)
      const detected = await detectSmartSplitInFolder({
        listFolder: async (path) => {
          const key = path.replace(/\/+$/, '')
          const cached = splitListingCacheRef.current.get(key)
          if (cached) return cached
          const listed = await window.api.sftp.ls(activeConnectionId, path)
          splitListingCacheRef.current.set(key, listed)
          return listed
        },
        folder,
        mode: splitDetectMode,
        axis: split.axis || 'item',
        fileType: data.fileType,
        seedPath,
      })
      if (folder !== splitFolder.trim()) setSplitFolder(folder)
      updateNodeData(nodeId, {
        split: { ...split, folderPath: detected.folderPath, items: detected.items, pattern: detected.pattern },
        fileType: inferSplitFileType(detected.items, data.fileType),
      })
      setPreview({
        items: detected.items,
        missing: new Set(detected.missing),
        loading: false,
        error: null,
      })
      setDetectMessage(detected.summary)
    } catch (err: any) {
      setDetectMessage(err?.message ?? String(err))
    } finally {
      setDetectingSplit(false)
    }
  }, [activeConnectionId, data.fileType, nodeId, split, splitDetectMode, splitFolder, splitSeedPath, updateNodeData])

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

  const applyRange = useCallback(() => {
    if (!split) return
    const resolved = resolveSplitItemsForRange(rangeDraft, split.items, pattern, split.axis || 'items')
    if (resolved.error) {
      setDetectMessage(resolved.error)
      return
    }
    setSplit({ ...split, items: resolved.items })
    setDetectMessage(`Using ${resolved.items.length} ${split.axis || 'items'}: ${sharedRangeTextFromItems(resolved.items)}.`)
  }, [pattern, rangeDraft, setSplit, split])

  const uploadLocalFile = useCallback(async () => {
    if (!activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID || !data.path.trim()) return
    setUploading(true)
    setUploadMessage(null)
    try {
      await window.api.local.stat(data.path)
      await uploadLocalFileForPath(activeConnectionId, data.path, settings.paths.uploadsSubfolder, nodeId, updateNodeData, setUploadMessage)
    } catch (err: any) {
      setUploadMessage(err?.message ?? String(err))
    } finally {
      setUploading(false)
    }
  }, [activeConnectionId, data.path, nodeId, settings.paths.uploadsSubfolder, updateNodeData])

  const acceptDroppedLocalFile = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const files = Array.from(event.dataTransfer.files ?? [])
    const localPath = files[0] ? window.api.local.pathForFile(files[0]) : ''
    if (!localPath) return
    if (files.length > 1) {
      setUploadMessage('Drop one file at a time for now.')
      return
    }
    const stat = await window.api.local.stat(localPath)
    if (stat.isDirectory) {
      setUploadMessage('Dropping folders is not supported yet.')
      return
    }
    updateNodeData(nodeId, {
      source: 'local',
      origin: 'local',
      path: localPath,
      fileType: inferFileType(localPath),
      status: 'present',
    })
    setUploadMessage(`Using ${pathBasename(localPath)}`)
    if (activeConnectionId && activeConnectionId !== LOCAL_CONNECTION_ID && await confirmDialog({
      title: 'Upload local input',
      message: 'Upload this file to the cluster now?',
      detail: 'Choose Upload now to copy it into the configured uploads folder and switch the node to the remote path.',
      confirmLabel: 'Upload now',
      cancelLabel: 'Keep local',
    })) {
      await uploadLocalFileForPath(activeConnectionId, localPath, settings.paths.uploadsSubfolder, nodeId, updateNodeData, setUploadMessage)
    }
  }, [activeConnectionId, confirmDialog, nodeId, settings.paths.uploadsSubfolder, updateNodeData])

  const sourceMode: NonNullable<FileNodeData['source']> = data.origin === 'local' || isLikelyLocalPath(data.path) ? 'local' : data.source ?? 'remote'

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
          <div className="flex rounded-md border border-border bg-bg-tertiary p-1">
            {[
              { value: 'remote', label: 'Remote' },
              { value: 'local', label: 'Local' },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => updateNodeData(nodeId, {
                  source: option.value as FileNodeData['source'],
                  origin: option.value === 'local' ? 'local' : 'ssh',
                })}
                className={classNames(
                  'h-7 flex-1 rounded text-xs transition-colors',
                  sourceMode === option.value
                    ? 'bg-accent text-white'
                    : 'text-text-secondary hover:text-text-primary',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div
            className="flex items-end gap-1.5"
            onDragOver={(event) => {
              if (sourceMode === 'local') event.preventDefault()
            }}
            onDrop={(event) => {
              if (sourceMode === 'local') void acceptDroppedLocalFile(event)
            }}
          >
            {sourceMode === 'local' ? (
              <LocalPathField
                value={data.path}
                placeholder="/Users/you/data/phenotype.txt"
                onChange={(value) => updateNodeData(nodeId, { path: value, source: 'local', origin: 'local', status: 'unknown' })}
                className="flex-1"
                mode="file"
              />
            ) : (
              <RemotePathField
                value={data.path}
                placeholder="/project/username/data/input.vcf.gz"
                onChange={(value) => {
                  const inferred = inferFileType(value)
                  updateNodeData(nodeId, {
                    path: value,
                    origin: 'ssh',
                    fileType: data.fileType === 'plink' && inferred === 'bed' ? 'plink' : inferred,
                    status: 'unknown',
                  })
                }}
                className="flex-1"
                title={`Choose file for ${data.label}`}
                mode="file"
                accept={data.fileType !== 'any' ? [data.fileType] : undefined}
              />
            )}
          </div>
          {sourceMode === 'local' && activeConnectionId && activeConnectionId !== LOCAL_CONNECTION_ID && data.path.trim() && (
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" className="h-7 text-[11px]" disabled={uploading} onClick={() => void uploadLocalFile()}>
                {uploading ? 'Uploading...' : 'Upload to cluster'}
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
                status: 'unknown',
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
                status: 'unknown',
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
      <div className="flex flex-col gap-1">
        <label className="text-text-secondary text-xs font-medium">File role</label>
        <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-bg-tertiary p-1">
          {[
            { value: true, label: 'Input source' },
            { value: false, label: 'Named output' },
          ].map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => updateNodeData(nodeId, { isInput: option.value })}
              className={classNames(
                'h-7 rounded text-xs transition-colors',
                data.isInput === option.value
                  ? 'bg-accent text-white'
                  : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* Split by axis (enables per-axis SLURM arrays downstream) */}
      {data.isInput && <div className="border-t border-border pt-3 mt-1">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h4 className="text-xs uppercase tracking-wide text-text-muted font-medium">
              Split into per-item files
            </h4>
            <p className="text-wrap mt-0.5 text-xs text-text-muted">
              Use this when one logical input is really many files, such as one genotype file per chromosome.
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={!!split}
              onChange={(e) => {
                if (e.target.checked) {
                  const folder = defaultSplitFolderForData(data)
                  setSplitFolder(folder)
                  setSplit({ axis: 'chrom', folderPath: folder || undefined, items: [] })
                } else {
                  setSplit(undefined)
                }
              }}
              className="accent-accent"
            />
            <span className="text-xs text-text-secondary">Enable</span>
          </label>
        </div>

        {split && (
          <div className="flex flex-col gap-2">
            <div className="rounded border border-accent/25 bg-accent/10 px-2 py-1.5 text-[11px] leading-5 text-text-secondary">
              BioFlow creates one job per item. The <span className="font-medium text-text-primary">key</span> becomes the array label
              and the <span className="font-medium text-text-primary">path</span> is the file used for that job.
              Example: key <span className="font-mono text-text-primary">1</span> uses chromosome 1's path, key <span className="font-mono text-text-primary">2</span> uses chromosome 2's path.
            </div>
            <Input
              label="Axis name shown on edges"
              value={split.axis}
              placeholder="chrom"
              onChange={(e) => setSplit({ ...split, axis: e.target.value })}
            />
            <div className="rounded border border-border bg-bg-primary p-2">
              <div className="mb-2 text-[10px] uppercase tracking-wide text-text-muted">
                Detect from folder
              </div>
              <FolderPickerField
                label="Data folder"
                value={splitFolder}
                placeholder="/scratch/project/genotypes"
                requesterLabel={`${data.label} split folder`}
                onChange={setSplitFolder}
              />
              <div className="mt-2 grid grid-cols-3 rounded border border-border bg-bg-tertiary p-0.5">
                {([
                  ['auto', 'Auto'],
                  ['files', 'Files here'],
                  ['folders', 'Folders here'],
                ] as Array<[SplitDetectMode, string]>).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setSplitDetectMode(mode)}
                    className={classNames(
                      'rounded px-1.5 py-1 text-[10px]',
                      splitDetectMode === mode ? 'bg-accent/15 text-text-primary' : 'text-text-muted hover:text-text-primary',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  disabled={detectingSplit || !splitFolder.trim()}
                  onClick={() => void detectSplit()}
                >
                  {detectingSplit ? 'Detecting...' : 'Detect split'}
                </Button>
                {detectMessage && (
                  <span className={classNames(
                    'min-w-0 flex-1 break-words text-[10px] leading-4',
                    detectMessage.toLowerCase().includes('could not') || detectMessage.toLowerCase().includes('connect')
                      ? 'text-error'
                      : 'text-text-muted',
                  )}>
                    {detectMessage}
                  </span>
                )}
              </div>
            </div>
            <div className="text-[10px] uppercase tracking-wide text-text-muted">
              Manual recipe
            </div>
            <div className="grid grid-cols-2 rounded border border-border bg-bg-primary p-0.5">
              {(['manual', 'brace', 'glob', 'crossFolder'] as SplitPattern['kind'][]).map((kind) => (
                <button
                  key={kind}
                  onClick={() => setPattern(defaultPattern(kind, pattern, splitSeedPath))}
                  className={classNames(
                    'rounded px-1.5 py-1 text-[10px]',
                    pattern.kind === kind ? 'bg-accent/15 text-text-primary' : 'text-text-muted hover:text-text-primary',
                  )}
                >
                  {splitPatternLabel(kind)}
                </button>
              ))}
            </div>
            <SplitPatternExplainer pattern={pattern} axis={split.axis} />

            {pattern.kind === 'brace' && (
              <BraceFormulaEditor
                pattern={pattern}
                axis={split.axis}
                onChange={setPattern}
              />
            )}
            {pattern.kind === 'glob' && (
              <div className="grid grid-cols-1 gap-2">
                <Input
                  label="Path glob"
                  value={pattern.template}
                  placeholder="/scratch/project/chr*/geno.pgen"
                  onChange={(e) => setPattern({ ...pattern, template: e.target.value })}
                />
                <Input
                  label="Name for the first * match"
                  value={pattern.capture}
                  placeholder={split.axis || 'chrom'}
                  onChange={(e) => setPattern({ ...pattern, capture: e.target.value })}
                />
              </div>
            )}
            {pattern.kind === 'crossFolder' && (
              <div className="grid grid-cols-1 gap-2">
                <FolderPickerField
                  label="Parent directory containing the item folders"
                  value={pattern.parentDir}
                  placeholder="/scratch/project/genotypes"
                  requesterLabel="split parent directory"
                  onChange={(value) => setPattern({ ...pattern, parentDir: value })}
                />
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    label="Item folders"
                    value={pattern.childGlob}
                    placeholder="chr*"
                    onChange={(e) => setPattern({ ...pattern, childGlob: e.target.value })}
                  />
                  <Input
                    label="File inside each folder"
                    value={pattern.file}
                    placeholder="geno.pgen"
                    onChange={(e) => setPattern({ ...pattern, file: e.target.value })}
                  />
                </div>
                <div className="rounded border border-border bg-bg-tertiary px-2 py-1.5 text-[10px] leading-4 text-text-muted">
                  BioFlow lists the parent directory, keeps child folders matching <span className="font-mono text-text-secondary">{pattern.childGlob || 'chr*'}</span>,
                  then appends <span className="font-mono text-text-secondary">{pattern.file || 'geno.pgen'}</span> inside each one.
                  {pattern.parentDir && pattern.childGlob && pattern.file && (
                    <div className="mt-1 font-mono text-text-secondary">
                      {pattern.parentDir.replace(/\/+$/, '')}/{pattern.childGlob}/{pattern.file.replace(/^\/+/, '')}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="rounded border border-border bg-bg-primary p-2">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <label className="text-[9px] uppercase tracking-wide text-text-muted">
                  Keys used for array jobs
                </label>
                {acceptedRange && (
                  <span className="truncate text-[9px] font-mono text-text-secondary" title={acceptedRange}>
                    {acceptedRange}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
                <div className="min-w-0">
                  <Input
                    label={`${split.axis || 'item'} range/list`}
                    value={rangeDraft}
                    placeholder="1-22 or 1,2,3,X,Y"
                    onChange={(e) => setRangeDraft(e.target.value)}
                    className="h-7 px-2 text-[11px]"
                  />
                </div>
                <Button variant="secondary" size="sm" className="h-8 px-2 text-[11px]" onClick={applyRange}>
                  Apply
                </Button>
              </div>
              <p className="mt-1 text-[10px] text-text-muted">
                Change this after auto-detect to add or remove array items without rebuilding the full path recipe.
              </p>
            </div>

            <div data-wrap className="overflow-hidden rounded border border-border bg-bg-primary">
              <div data-wrap className="flex items-start justify-between gap-2 border-b border-border px-2 py-1.5">
                <div className="min-w-0">
                  <label className="text-text-secondary text-xs font-medium">
                    Accepted items ({split.items.length})
                  </label>
                  <div className="mt-0.5 truncate text-[10px] font-mono text-text-muted" title={acceptedRange || 'No accepted items yet'}>
                    {acceptedRange || 'No accepted items yet'}
                  </div>
                </div>
                <button
                  onClick={addRow}
                  className="flex shrink-0 items-center gap-1 text-[11px] text-accent hover:underline"
                >
                  <Plus size={10} /> Add
                </button>
              </div>
              <div data-wrap className="bioflow-split-items-list scroll-region max-h-56 min-h-0 overflow-y-auto px-1.5 py-1.5 space-y-1">
                {split.items.map((row, i) => (
                  <div key={i} data-wrap className="grid shrink-0 grid-cols-[2.75rem_minmax(0,1fr)_1.75rem_1.5rem] items-center gap-1 rounded bg-bg-tertiary/50 p-1">
                    <input
                      type="text"
                      value={row.key}
                      onChange={(e) => updateRow(i, { key: e.target.value })}
                      className="bioflow-field h-6 min-w-0 rounded border border-border bg-bg-tertiary px-1.5 font-mono text-[11px] text-text-primary outline-none"
                      placeholder="1"
                      title="Item key: this becomes the Slurm array item label."
                    />
                    <RemotePathInput
                      value={row.path}
                      onChange={(value) => updateRow(i, { path: value })}
                      placeholder="/path/to/item/file"
                      mode="file"
                      className="h-6 px-2 text-[10px]"
                      tailBiasWhenBlurred
                    />
                    <button
                      type="button"
                      onClick={() => setSplitBrowseRow(i)}
                      className="flex h-6 items-center justify-center rounded bg-bg-tertiary text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                      title={activeConnectionId ? `Choose file for split item ${row.key || i + 1}` : 'Connect first to browse remote paths'}
                      disabled={!activeConnectionId}
                    >
                      <FolderOpen size={10} />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeRow(i)}
                      className="flex h-6 items-center justify-center rounded text-text-muted transition-colors hover:bg-error/20 hover:text-error"
                      title="Remove"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
                {split.items.length === 0 && (
                  <div className="px-1 py-1 text-[11px] italic text-text-muted">
                    No accepted items yet. Fill a recipe above, check the preview, then click Accept preview.
                  </div>
                )}
              </div>
              <RemoteFileBrowser
                open={splitBrowseRow !== null}
                onClose={() => setSplitBrowseRow(null)}
                title={`Choose file for split item ${(splitBrowseRow !== null ? split.items[splitBrowseRow]?.key : '') || ''}`}
                mode="file"
                initialPath={splitBrowseRow !== null ? split.items[splitBrowseRow]?.path ?? '' : ''}
                onSelect={(paths) => {
                  if (splitBrowseRow === null || !paths[0]) return
                  updateRow(splitBrowseRow, { path: paths[0] })
                  setSplitBrowseRow(null)
                }}
              />
            </div>
            <div data-wrap className="bioflow-split-preview overflow-hidden rounded border border-border bg-bg-primary">
              <div data-wrap className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-2 py-1.5">
                <div className="min-w-0">
                  <span className="text-[9px] uppercase tracking-wide text-text-muted">Preview before accepting</span>
                  {!preview.loading && !preview.error && preview.items.length > 0 && (
                    <span className="ml-2 text-[9px] text-text-muted">
                      {preview.items.length} found, {preview.missing.size} missing
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    disabled={preview.loading}
                    onClick={() => {
                      splitListingCacheRef.current.clear()
                      setRefreshNonce((value) => value + 1)
                    }}
                  >
                    Refresh
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    disabled={preview.loading || preview.items.length === 0}
                    onClick={acceptPreview}
                    title="Accept the previewed split items"
                  >
                    Accept
                  </Button>
                </div>
              </div>
              <div data-wrap className="bioflow-split-preview-list scroll-region max-h-64 min-h-0 overflow-y-auto overflow-x-hidden">
                {preview.loading && <div className="px-2 py-2 text-[11px] text-text-muted">Checking files...</div>}
                {preview.error && <div className="px-2 py-2 text-[11px] text-error">{preview.error}</div>}
                {!preview.loading && !preview.error && preview.items.length === 0 && (
                  <div className="px-2 py-2 text-[11px] text-text-muted">
                    Enter a recipe above to see the exact key → path pairs that will be used.
                  </div>
                )}
                {!preview.loading && !preview.error && preview.items.length > 0 && (
                  <div data-wrap className="min-w-[18rem] space-y-px p-1 text-[10px]">
                    {preview.items.map((item) => {
                      const missing = preview.missing.has(item.key)
                      return (
                        <div
                          key={`${item.key}:${item.path}`}
                          data-wrap
                          className={classNames(
                            'grid shrink-0 grid-cols-[2.75rem_minmax(0,1fr)_3.5rem] items-start gap-2 rounded px-1.5 py-1.5',
                            missing ? 'bg-error/10 text-error' : 'text-text-secondary',
                          )}
                        >
                          <span className="font-mono text-text-primary">{item.key}</span>
                          <span className="break-all font-mono leading-4" title={item.path}>{item.path}</span>
                          <span className="text-right">{missing ? 'missing' : 'exists'}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
            {isPlinkLikeSplit(split) && (
              <div className="rounded border border-accent/25 bg-accent/10 p-2">
                <div className="text-[11px] font-medium text-text-primary">PLINK2 prefix files detected</div>
                <p className="mt-1 text-[10px] leading-4 text-text-muted">
                  BioFlow checks the selected <span className="font-mono">.pgen</span> files exist, then runs PLINK2 with
                  the fileset prefix, like <span className="font-mono">--pfile /path/chr1/output</span>.
                  The matching <span className="font-mono">.pvar</span> and <span className="font-mono">.psam</span> stay implicit.
                </p>
              </div>
            )}
            <p className="text-[10px] text-text-muted">
              Downstream compatible tools will auto-run once per accepted item. Edges from this file show "{split.axis || '?'}×{split.items.length}" after items are accepted.
            </p>
          </div>
        )}
      </div>}
      {data.isInput && settings.showInputGenomeBuild && (
        <details className="border-t border-border pt-3">
          <summary className="cursor-pointer select-none text-[10px] font-medium uppercase tracking-wide text-text-muted hover:text-text-secondary">
            Advanced
          </summary>
          <div className="mt-2 flex flex-col gap-1">
            <label className="text-text-secondary text-xs font-medium">Genome build</label>
            <select
              value={String(data.genomeBuild ?? '')}
              onChange={(e) => updateNodeData(nodeId, { genomeBuild: e.target.value || undefined })}
              className="h-8 rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent focus:border-accent"
            >
              <option value="">Unknown / not genomic</option>
              {GENOME_BUILD_OPTIONS.filter(Boolean).map((build) => (
                <option key={build} value={build}>{build}</option>
              ))}
            </select>
            <p className="text-[10px] text-text-muted">
              Used to catch mixed GRCh37/GRCh38 inputs before a run.
            </p>
          </div>
        </details>
      )}
    </div>
  )
}

async function uploadLocalFileForPath(
  activeConnectionId: string,
  localPath: string,
  uploadsSubfolder: string,
  nodeId: string,
  updateNodeData: (nodeId: string, patch: Partial<FileNodeData>) => void,
  setUploadMessage: (message: string | null) => void,
) {
  const home = (await window.api.ssh.exec(activeConnectionId, 'printf %s "$HOME"')).stdout.trim()
  const fileName = localPath.split('/').pop() || 'input'
  const uploadDir = `${home}/${uploadsSubfolder.replace(/^\/+|\/+$/g, '')}`
  const remotePath = `${uploadDir}/${fileName}`
  await window.api.sftp.mkdir(activeConnectionId, uploadDir).catch(() => undefined)
  await window.api.sftp.upload(activeConnectionId, localPath, remotePath)
  updateNodeData(nodeId, { path: remotePath, source: 'remote', origin: 'ssh', status: 'present' })
  setUploadMessage(`Uploaded to ${remotePath}`)
}

async function resolveRemotePathForSftp(connectionId: string, path: string): Promise<string> {
  const trimmed = path.trim()
  if (trimmed !== '~' && !trimmed.startsWith('~/')) return trimmed
  const home = (await window.api.ssh.exec(connectionId, 'printf %s "$HOME"')).stdout.trim() || null
  return expandHomePath(trimmed, home)
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

function splitPatternLabel(kind: SplitPattern['kind']): string {
  switch (kind) {
    case 'manual': return 'Type rows'
    case 'brace': return 'Number/list range'
    case 'glob': return 'Match files'
    case 'crossFolder': return 'Match folders'
  }
}

function SplitPatternExplainer({ pattern, axis }: { pattern: SplitPattern; axis: string }) {
  const axisLabel = axis.trim() || 'chrom'
  const rows = splitPatternHelp(pattern, axisLabel)
  return (
    <div className="rounded border border-border bg-bg-tertiary px-2 py-1.5 text-[10px] leading-4 text-text-muted">
      <div className="font-medium text-text-secondary">{rows.title}</div>
      <div>{rows.body}</div>
      <div className="mt-1 grid grid-cols-[42px_1fr] gap-x-2 gap-y-0.5 font-mono">
        {rows.examples.map((example) => (
          <div key={`${example.key}:${example.path}`} className="contents">
            <span className="text-text-secondary">{example.key}</span>
            <span className="truncate" title={example.path}>{example.path}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function BraceFormulaEditor({
  pattern,
  axis,
  onChange,
}: {
  pattern: Extract<SplitPattern, { kind: 'brace' }>
  axis: string
  onChange: (pattern: SplitPattern) => void
}) {
  const formula = parseBraceFormula(pattern.template)
  const setFormula = (patch: Partial<typeof formula>) => {
    const next = { ...formula, ...patch }
    onChange({ kind: 'brace', template: `${joinFormulaPrefix(next.folder, next.prefix)}{${next.range}}${next.suffix}` })
  }
  const axisName = axis.trim() || 'variable'
  return (
    <div className="rounded border border-border bg-bg-primary p-2">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-text-muted">
        Path formula
      </div>
      <div className="grid grid-cols-1 gap-2">
        <FolderPickerField
          label="Folder/path"
          value={formula.folder}
          placeholder="/scratch/project/genotypes"
          requesterLabel="split path formula"
          onChange={(value) => setFormula({ folder: value })}
        />
        <Input
          label="Filename or folder prefix before the changing value"
          value={formula.prefix}
          placeholder="chr"
          onChange={(e) => setFormula({ prefix: e.target.value })}
        />
        <div className="grid grid-cols-[1fr_96px_1fr] gap-2">
          <Input
            label={`${axisName} values`}
            value={formula.range}
            placeholder="1..22"
            onChange={(e) => setFormula({ range: e.target.value })}
          />
          <div className="flex flex-col gap-1">
            <label className="text-text-secondary text-xs font-medium">Variable</label>
            <div className="flex h-8 items-center justify-center rounded-md border border-border bg-bg-tertiary px-2 text-xs font-mono text-accent">
              {axisName}
            </div>
          </div>
          <Input
            label="Suffix after the changing value"
            value={formula.suffix}
            placeholder="/geno.pgen"
            onChange={(e) => setFormula({ suffix: e.target.value })}
          />
        </div>
      </div>
      <div className="mt-2 rounded border border-border bg-bg-tertiary px-2 py-1.5 text-[10px] text-text-muted">
        Formula:{' '}
        <span className="font-mono text-text-secondary">
          {joinFormulaPrefix(formula.folder, formula.prefix) || '<path-and-prefix>'}
          {'{'}
          {formula.range || '1..22'}
          {'}'}
          {formula.suffix || '<suffix>'}
        </span>
      </div>
    </div>
  )
}

function splitPatternHelp(
  pattern: SplitPattern,
  axis: string,
): { title: string; body: string; examples: Array<{ key: string; path: string }> } {
  if (pattern.kind === 'manual') {
    return {
      title: 'Type rows manually',
      body: `Use this when there are only a few ${axis} files or when names are irregular. Each row is one array task.`,
      examples: [
        { key: '1', path: '/scratch/project/chr1/genotypes.pgen' },
        { key: '2', path: '/scratch/project/chr2/genotypes.pgen' },
      ],
    }
  }
  if (pattern.kind === 'brace') {
    return {
      title: 'Expand a number range or list inside braces',
      body: 'The path template is expanded first, then BioFlow checks whether each resulting file exists.',
      examples: [
        { key: '1', path: '/scratch/project/chr1/genotypes.pgen' },
        { key: '2', path: '/scratch/project/chr2/genotypes.pgen' },
      ],
    }
  }
  if (pattern.kind === 'glob') {
    return {
      title: 'Match files in one folder',
      body: 'The first * becomes the item key. Use this when files differ by filename or by one folder segment.',
      examples: [
        { key: '1', path: '/scratch/project/genotypes.chr1.pgen' },
        { key: '2', path: '/scratch/project/genotypes.chr2.pgen' },
      ],
    }
  }
  return {
    title: 'Match folders, then append the same file name inside each folder',
    body: 'Use this when every item lives in its own folder and the file has the same relative name in each folder.',
    examples: [
      { key: '1', path: '/scratch/project/genotypes/chr1/genotypes.pgen' },
      { key: '2', path: '/scratch/project/genotypes/chr2/genotypes.pgen' },
    ],
  }
}

function parseBraceFormula(template: string): { folder: string; prefix: string; range: string; suffix: string } {
  const match = template.match(/^(.*)\{([^{}]+)\}(.*)$/)
  const rawPrefix = match ? match[1] : template
  const slash = rawPrefix.lastIndexOf('/')
  const folder = slash >= 0 ? rawPrefix.slice(0, slash) : ''
  const prefix = slash >= 0 ? rawPrefix.slice(slash + 1) : rawPrefix
  return { folder, prefix, range: match ? match[2] : '1..22', suffix: match ? match[3] : '' }
}

function joinFormulaPrefix(folder: string, prefix: string): string {
  if (!folder.trim()) return prefix
  if (!prefix.trim()) return folder.replace(/\/+$/, '')
  return `${folder.replace(/\/+$/, '')}/${prefix}`
}

function joinOutputPath(folder: string, filename: string): string {
  if (!folder.trim()) return filename.trim()
  if (!filename.trim()) return folder.trim()
  return `${folder.replace(/\/+$/, '')}/${filename.trim()}`
}

function splitFolderFromData(data: FileNodeData): string {
  if (data.split?.folderPath?.trim()) return data.split.folderPath
  const pattern = data.split?.pattern
  if (pattern?.kind === 'crossFolder') return pattern.parentDir
  if (pattern?.kind === 'glob' || pattern?.kind === 'brace') {
    const template = pattern.template
    const beforeVariable = template.includes('*') ? template.slice(0, template.indexOf('*')) : template
    return pathDirname(beforeVariable || template)
  }
  return defaultSplitFolderForData(data)
}

function defaultSplitFolderForData(data: FileNodeData): string {
  if (!data.path) return ''
  if (data.pathKind === 'directory') return data.path
  return pathDirname(data.path)
}

function defaultPattern(kind: SplitPattern['kind'], current: SplitPattern, seedPath = ''): SplitPattern {
  if (kind === current.kind) return current
  if (kind === 'manual') return { kind: 'manual' }
  if (kind === 'brace') return { kind: 'brace', template: current.kind === 'glob' ? current.template : seedPath }
  if (kind === 'glob') return { kind: 'glob', template: current.kind === 'brace' ? current.template : seedPath, capture: 'key' }
  const seeded = crossFolderSeed(seedPath)
  return { kind: 'crossFolder', parentDir: seeded.parentDir, childGlob: seeded.childGlob, file: seeded.file }
}

function crossFolderSeed(path: string): { parentDir: string; childGlob: string; file: string } {
  const parts = path.split('/').filter(Boolean)
  if (parts.length < 3) return { parentDir: '', childGlob: 'chr*', file: '' }
  const file = parts[parts.length - 1]
  const child = parts[parts.length - 2]
  const parent = `/${parts.slice(0, -2).join('/')}`
  return {
    parentDir: parent,
    childGlob: child.replace(/\d+$/, '*') || 'chr*',
    file,
  }
}

async function detectSplitInFolder({
  connectionId,
  folder,
  mode,
  axis,
  fileType,
  seedPath,
}: {
  connectionId: string
  folder: string
  mode: SplitDetectMode
  axis: string
  fileType: FileNodeData['fileType']
  seedPath: string
}): Promise<DetectedSplit> {
  return detectSmartSplitInFolder({
    listFolder: (path) => window.api.sftp.ls(connectionId, path),
    folder,
    mode,
    axis,
    fileType,
    seedPath,
  })
}
function safeSplitItems(split: FileNodeSplit | undefined): FileNodeSplit['items'] {
  const rawItems = (split as { items?: unknown } | undefined)?.items
  if (!Array.isArray(rawItems)) return []
  return rawItems.map((item, index) => {
    const row = item as { key?: unknown; path?: unknown }
    return {
      key: typeof row.key === 'string' && row.key.trim() ? row.key : String(index + 1),
      path: typeof row.path === 'string' ? row.path : '',
    }
  })
}

function normalizeSplitForInspector(split: FileNodeSplit | undefined): FileNodeSplit | undefined {
  if (!split) return undefined
  return {
    ...split,
    axis: split.axis || 'item',
    items: safeSplitItems(split),
    pattern: split.pattern ?? (split.glob ? { kind: 'brace', template: split.glob } : { kind: 'manual' }),
  }
}

function inferSplitFileType(items: FileNodeSplit['items'], current: FileNodeData['fileType']): FileNodeData['fileType'] {
  if (items.length === 0) return current
  const paths = items.map((item) => item.path.toLowerCase())
  if (paths.every((path) => path.endsWith('.pgen'))) return 'pgen'
  if (current !== 'any') return current
  if (paths.every((path) => path.endsWith('.bgen'))) return 'bgen'
  if (paths.every((path) => path.endsWith('.vcf') || path.endsWith('.vcf.gz'))) return 'vcf'
  if (paths.every((path) => path.endsWith('.bcf'))) return 'bcf'
  if (paths.every((path) => path.endsWith('.tsv') || path.endsWith('.txt'))) return 'tsv'
  if (paths.every((path) => path.endsWith('.csv'))) return 'csv'
  return current
}

function isPlinkLikeSplit(split: FileNodeSplit): boolean {
  return split.items.some((item) => /\.pgen$/i.test(item.path))
}

const MERGE_STRATEGIES: { value: MergeStrategy; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto (by upstream type)', hint: 'Picks the best strategy from the upstream file type.' },
  { value: 'tabular-inner', label: 'Tabular inner merge', hint: 'Join tabular files on a shared id column and keep rows present in every file.' },
  { value: 'tabular-outer', label: 'Tabular outer merge', hint: 'Join tabular files on a shared id column and keep every row.' },
  { value: 'tabular-left', label: 'Tabular left merge', hint: 'Join tabular files on a shared id column and keep rows from the first file.' },
  { value: 'tsv-concat-header', label: 'TSV concat (keep header)', hint: 'Keep first header, append data rows from each task.' },
  { value: 'bcftools-concat', label: 'bcftools concat', hint: 'VCF/BCF per-chrom outputs → single VCF.' },
  { value: 'plink-pmerge-list', label: 'plink2 --pmerge-list', hint: 'Merge per-chrom PLINK2 filesets.' },
  { value: 'cat', label: 'cat (plain concat)', hint: 'Fallback: shell cat of all per-task outputs.' },
]

function MergeInspector({ nodeId, data }: { nodeId: string; data: MergeNodeData }) {
  const updateNodeData = usePipelineStore((s) => s.updateNodeData)
  const nodes = usePipelineStore((s) => s.nodes)
  const edges = usePipelineStore((s) => s.edges)
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const handles = data.inputHandles?.length ? data.inputHandles : [{ id: 'input', label: 'Input 1' }]

  const setSlurm = useCallback(
    (patch: Partial<NonNullable<MergeNodeData['slurmOverride']>>) => {
      updateNodeData(nodeId, {
        slurmOverride: { ...data.slurmOverride, ...patch },
      })
    },
    [nodeId, data.slurmOverride, updateNodeData],
  )

  const selectedStrategy = MERGE_STRATEGIES.find((s) => s.value === data.strategy)

  useEffect(() => {
    let cancelled = false
    const connectedFiles = edges
      .filter((edge) => edge.target === nodeId)
      .flatMap((edge) => {
        const source = nodes.find((node) => node.id === edge.source)
        if (source?.type !== 'file') return []
        const file = source.data as FileNodeData
        if (file.split?.items?.length) return file.split.items.map((item) => ({ path: item.path, label: item.key }))
        return file.path ? [{ path: file.path, label: file.label || pathBasename(file.path) }] : []
      })
    if (connectedFiles.length === 0) return
    void Promise.all(connectedFiles.map(async (file) => {
      try {
        const sourceNode = nodes.find((node) => node.type === 'file' && ((node.data as FileNodeData).path === file.path || (node.data as FileNodeData).split?.items?.some((item) => item.path === file.path)))
        const origin = sourceNode?.type === 'file' ? (sourceNode.data as FileNodeData).origin : 'ssh'
        const text = origin === 'local'
          ? await window.api.local.head(file.path, 1)
          : activeConnectionId && activeConnectionId !== LOCAL_CONNECTION_ID
            ? await window.api.sftp.head(activeConnectionId, file.path, 1)
            : ''
        return { ...file, columns: parseHeader(text, file.path).columns }
      } catch {
        return { ...file, columns: [] }
      }
    })).then((files) => {
      if (cancelled) return
      const columnSets = files.map((file) => new Set(file.columns))
      const sharedColumns = files[0]?.columns.filter((column) => columnSets.every((set) => set.has(column))) ?? []
      const allColumns = [...new Set(files.flatMap((file) => file.columns))]
      const divergentColumns = allColumns
        .filter((column) => !sharedColumns.includes(column))
        .map((name) => ({ name, files: files.filter((file) => file.columns.includes(name)).map((file) => file.label) }))
      const next = { files, sharedColumns, divergentColumns }
      if (JSON.stringify(data.columnPreview ?? null) !== JSON.stringify(next)) {
        updateNodeData(nodeId, { columnPreview: next })
      }
    })
    return () => { cancelled = true }
  }, [activeConnectionId, data.columnPreview, edges, nodeId, nodes, updateNodeData])

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Input
          label="Label"
          value={data.label}
          onChange={(e) => updateNodeData(nodeId, { label: e.target.value })}
        />
        <p className="text-xs text-text-muted mt-2">
          <span className="inline-flex items-center gap-1">
            Combines many upstream outputs into one file.
            <HelpButton id="inspector.merge" />
          </span>{' '}
          Use axed fan-in for
          per-chromosome arrays, or parallel branches for independent branches
          that should converge.
        </p>
      </div>

      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Converge Mode
        </h4>
        <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-bg-tertiary p-1">
          {[
            { value: 'axed-fan-in', label: 'Axed fan-in' },
            { value: 'parallel-branches', label: 'Parallel branches' },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => updateNodeData(nodeId, { convergeMode: option.value as MergeNodeData['convergeMode'] })}
              className={classNames(
                'h-7 rounded text-xs transition-colors',
                (data.convergeMode ?? 'axed-fan-in') === option.value
                  ? 'bg-accent text-white'
                  : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium">Inputs</h4>
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus size={12} />}
            onClick={() => updateNodeData(nodeId, { inputHandles: [...handles, { id: `input-${handles.length + 1}`, label: `Input ${handles.length + 1}` }] })}
          >
            Add input
          </Button>
        </div>
        <div className="space-y-1">
          {handles.map((handle, index) => (
            <Input
              key={handle.id}
              label={`Handle ${index + 1}`}
              value={handle.label}
              onChange={(e) => updateNodeData(nodeId, { inputHandles: handles.map((item) => item.id === handle.id ? { ...item, label: e.target.value } : item) })}
            />
          ))}
        </div>
      </div>

      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Strategy <HelpButton id="merge.columns" />
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

      <div className="rounded-md border border-border bg-bg-tertiary p-3">
        <div className="mb-2 flex items-center gap-1 text-xs font-medium text-text-primary">
          Column assignment preview
          <HelpButton id="merge.columns" />
        </div>
        <div className="space-y-2 text-[11px]">
          <div>
            <div className="text-text-muted">Shared columns</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {(data.columnPreview?.sharedColumns ?? []).map((column) => (
                <span key={column} className="rounded bg-success/10 px-1.5 py-0.5 text-success">{column}</span>
              ))}
              {(!data.columnPreview?.sharedColumns?.length) && <span className="text-text-muted">No shared columns detected yet.</span>}
            </div>
          </div>
          <div>
            <div className="text-text-muted">Divergent columns</div>
            <div className="mt-1 max-h-28 overflow-auto space-y-1">
              {(data.columnPreview?.divergentColumns ?? []).map((column) => (
                <div key={column.name} className="rounded border border-border bg-bg-secondary px-2 py-1">
                  <span className="font-mono text-text-primary">{column.name}</span>
                  <span className="ml-2 text-text-muted">from {column.files.join(', ')}</span>
                </div>
              ))}
              {(!data.columnPreview?.divergentColumns?.length) && <span className="text-text-muted">No divergent columns detected yet.</span>}
            </div>
          </div>
        </div>
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
        <label className="mt-2 flex items-center gap-2 text-[11px] text-text-secondary">
          <input
            type="checkbox"
            checked={Boolean(data.outputIntermediate?.output)}
            onChange={(e) => updateNodeData(nodeId, { outputIntermediate: { output: e.target.checked } })}
            className="accent-accent"
          />
          Temporary output: delete after successful run
        </label>
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

function TransferInspector({ nodeId, data }: { nodeId: string; data: TransferNodeData }) {
  const updateNodeData = usePipelineStore((s) => s.updateNodeData)
  const dnxDefaultProjectId = useDnxStore((s) => s.defaultProjectId)
  const devMode = useSettingsStore((s) => s.devMode)

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Input
          label="Label"
          value={data.label}
          onChange={(e) => updateNodeData(nodeId, { label: e.target.value })}
        />
        <p className="text-xs text-text-muted mt-2">
          Use Transfer to make cross-backend copies explicit.
        </p>
      </div>

      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Route
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <select
            value={data.from}
            onChange={(e) => updateNodeData(nodeId, { from: e.target.value as TransferNodeData['from'] })}
            className="h-8 w-full rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent focus:border-accent"
          >
            <option value="local">From Local</option>
            <option value="ssh">From Rorqual</option>
            {devMode && <option value="dnx">From DNAnexus</option>}
          </select>
          <select
            value={data.to}
            onChange={(e) => updateNodeData(nodeId, { to: e.target.value as TransferNodeData['to'] })}
            className="h-8 w-full rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent focus:border-accent"
          >
            <option value="local">To Local</option>
            <option value="ssh">To Rorqual</option>
            {devMode && <option value="dnx">To DNAnexus</option>}
          </select>
        </div>
      </div>

      <Input
        label="Output filename"
        value={data.outputName ?? ''}
        placeholder="(keep upstream name)"
        onChange={(e) => updateNodeData(nodeId, { outputName: e.target.value || undefined })}
      />

      {data.to === 'ssh' && (
        <FolderPickerField
          label="Rorqual folder"
          value={data.sshFolder ?? ''}
          placeholder="(default run output folder)"
          requesterLabel={`${data.label} SSH folder`}
          onChange={(value) => updateNodeData(nodeId, { sshFolder: value || undefined })}
        />
      )}

      {data.to === 'local' && (
        <div>
          <LocalPathField
            label="Local destination folder on this Mac"
            value={data.localFolder ?? ''}
            placeholder="Required, e.g. ~/BioFlow/transfers"
            onChange={(value) => updateNodeData(nodeId, { localFolder: value || undefined })}
            mode="directory"
          />
          <p className="mt-1 text-[10px] text-text-muted">
            Downloads fail validation until this folder is set, so SCP results never disappear into an implicit path.
          </p>
        </div>
      )}

      {devMode && data.to === 'dnx' && (
        <div className="flex flex-col gap-2">
          <Input
            label="DNAnexus folder"
            value={data.dnxFolder ?? ''}
            placeholder="/BioFlow/transfers"
            onChange={(e) => updateNodeData(nodeId, { dnxFolder: e.target.value || undefined })}
          />
          <Input
            label="Project ID"
            value={data.dnxProjectId ?? dnxDefaultProjectId ?? ''}
            placeholder={dnxDefaultProjectId ?? 'project-xxxx'}
            onChange={(e) => updateNodeData(nodeId, { dnxProjectId: e.target.value || undefined })}
          />
        </div>
      )}

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
  { value: 'regex', label: 'matches regex', needsValue: true },
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
    join: 'and',
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
  const inputOrigin = connectedInputOrigin(snapshot, nodeId, 'input')
  const schema = resolveUpstreamSchema(snapshot, nodeId, 'input', schemas)
  const columns = schema?.columns ?? []
  const preset = getTransformPreset(data.preset)
  const selected = data.selectedColumns?.length ? data.selectedColumns : columns
  const filters = data.filters ?? []
  const renames = data.renames ?? []
  const artifactMode = String(data.presetConfig?.artifactMode ?? 'filtered-table')
  const lockedFileType =
    data.preset === 'cohort-filter'
      ? (artifactMode === 'keep-file' ? 'txt' : null)
      : data.preset === 'clump-lead-list'
        ? 'txt'
        : data.preset === 'plink-score-file'
          ? 'tsv'
          : null
  const presetRoleMappings = useMemo(
    () => (preset ? suggestRoleMappings(columns, preset.roles, data.roleMappings ?? {}) : {}),
    [preset, columns, data.roleMappings],
  )
  const canProjectColumns = !preset || data.preset === 'cohort-filter' || data.preset === 'gwas-pval-filter'
  const canRenameColumns = !preset || data.preset === 'cohort-filter' || data.preset === 'gwas-pval-filter'
  const canUseGenericFilters = !preset

  const setRoleMapping = useCallback((mappingKey: string, roleId: string, column: string) => {
    const next = { ...(data.roleMappings ?? {}) }
    if (!column) {
      delete next[mappingKey]
    } else {
      next[mappingKey] = {
        ...(next[mappingKey] ?? { roleId }),
        roleId,
        column,
        confirmed: true,
        confidence: 1,
      }
    }
    updateNodeData(nodeId, { roleMappings: next })
  }, [data.roleMappings, nodeId, updateNodeData])

  const applyPreset = useCallback((presetId: TransformNodeData['preset']) => {
    if (!presetId) {
      updateNodeData(nodeId, {
        preset: undefined,
        presetConfig: undefined,
        roleMappings: undefined,
      })
      return
    }
    const presetDef = getTransformPreset(presetId)
    if (!presetDef) return
    const presetConfig = defaultTransformPresetConfig(presetId)
    const presetFileType =
      presetId === 'cohort-filter'
        ? (String(presetConfig.artifactMode ?? 'filtered-table') === 'keep-file' ? 'txt' : presetDef.fileType)
        : presetDef.fileType
    updateNodeData(nodeId, {
      preset: presetId,
      presetConfig,
      roleMappings: {},
      fileType: presetFileType,
    })
  }, [nodeId, updateNodeData])

  useEffect(() => {
    if (!activeConnectionId || !inputPath || schemas[inputPath]) return
    if (inputOrigin === 'dnx') return
    if (inputOrigin === 'ssh' && activeConnectionId === LOCAL_CONNECTION_ID) return
    const schemaConnectionId = inputOrigin === 'local' ? LOCAL_CONNECTION_ID : activeConnectionId
    let cancelled = false
    async function loadSchema() {
      try {
        const text = await headPreviewFileForConnection(schemaConnectionId, inputPath!, 30)
        if (cancelled) return
        const parsed = parseHeader(text, inputPath!)
        if (parsed.columns.length > 0) setSchema(inputPath!, { columns: parsed.columns, delimiter: parsed.delimiter })
      } catch {
        // A transform remains editable without schema; command generation will still run.
      }
    }
    void loadSchema()
    return () => { cancelled = true }
  }, [activeConnectionId, inputOrigin, inputPath, schemas, setSchema])

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

      <div className="rounded-lg border border-border bg-bg-primary/60 p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium">
              Transform mode
            </h4>
            <p className="mt-1 text-[11px] text-text-muted">
              Use a workflow-aware preset when this transform should create a specific analysis artifact.
            </p>
          </div>
          <select
            value={data.preset ?? ''}
            onChange={(e) => applyPreset((e.target.value || undefined) as TransformNodeData['preset'])}
            className="h-8 min-w-[220px] rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary"
          >
            <option value="">Manual transform</option>
            {TRANSFORM_PRESETS.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
            ))}
          </select>
        </div>

        {preset && (
          <div className="mt-3 flex flex-col gap-3">
            <div className="rounded-md border border-border-light bg-bg-secondary px-3 py-2 text-[11px] text-text-secondary">
              {preset.description}
            </div>

            <div>
              <h5 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
                Role mappings
              </h5>
              <div className="flex flex-col gap-2">
                {preset.roles.map((role) => {
                  const bindingKey = role.binding?.kind === 'roleMapping' ? role.binding.key : role.id
                  const mapping = presetRoleMappings[bindingKey] ?? presetRoleMappings[role.id]
                  const suggested = !data.roleMappings?.[bindingKey] && mapping?.column
                  return (
                    <div key={role.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-2 items-center">
                      <div className="text-[11px] text-text-secondary">
                        <div className="text-text-primary">
                          {role.label}{role.required ? ' *' : ''}
                        </div>
                        {suggested && (
                          <div className="text-[10px] text-accent">
                            Suggested: {mapping?.column}
                          </div>
                        )}
                      </div>
                      <select
                        value={mapping?.column ?? ''}
                        onChange={(e) => setRoleMapping(bindingKey, role.id, e.target.value)}
                        className="h-8 rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary"
                      >
                        <option value="">-- select column --</option>
                        {columns.map((column) => (
                          <option key={column} value={column}>{column}</option>
                        ))}
                      </select>
                    </div>
                  )
                })}
              </div>
            </div>

            {data.preset === 'cohort-filter' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase tracking-wide text-text-muted font-medium">
                    Cohort value
                  </label>
                  <input
                    value={String(data.presetConfig?.matchValue ?? '')}
                    onChange={(e) => updateNodeData(nodeId, {
                      presetConfig: { ...(data.presetConfig ?? defaultTransformPresetConfig('cohort-filter')), matchValue: e.target.value },
                    })}
                    className="mt-1 h-8 w-full rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary"
                    placeholder="EUR"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wide text-text-muted font-medium">
                    Artifact mode
                  </label>
                  <select
                    value={artifactMode}
                    onChange={(e) => {
                      const nextMode = e.target.value
                      updateNodeData(nodeId, {
                        presetConfig: { ...(data.presetConfig ?? defaultTransformPresetConfig('cohort-filter')), artifactMode: nextMode },
                        fileType: nextMode === 'keep-file' ? 'txt' : 'tsv',
                      })
                    }}
                    className="mt-1 h-8 w-full rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary"
                  >
                    <option value="filtered-table">Filtered table</option>
                    <option value="keep-file">PLINK keep file</option>
                  </select>
                </div>
                {artifactMode === 'keep-file' && (
                  <div className="col-span-2 rounded-md border border-border-light bg-bg-secondary px-3 py-2 text-[11px] text-text-muted">
                    Keep-file mode writes two tab-separated columns with no header. If no family ID column is mapped, BioFlow will duplicate the sample ID into both FID and IID.
                  </div>
                )}
              </div>
            )}

            {data.preset === 'gwas-pval-filter' && (
              <div>
                <label className="text-[10px] uppercase tracking-wide text-text-muted font-medium">
                  P-value threshold
                </label>
                <input
                  type="number"
                  value={String(data.presetConfig?.threshold ?? 5e-8)}
                  onChange={(e) => updateNodeData(nodeId, {
                    presetConfig: { ...(data.presetConfig ?? defaultTransformPresetConfig('gwas-pval-filter')), threshold: e.target.value === '' ? '' : Number(e.target.value) },
                  })}
                  className="mt-1 h-8 w-full rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary"
                  step="any"
                />
              </div>
            )}

            {data.preset === 'plink-score-file' && (
              <div>
                <label className="text-[10px] uppercase tracking-wide text-text-muted font-medium">
                  Weight transform
                </label>
                <select
                  value={String(data.presetConfig?.weightTransform ?? 'identity')}
                  onChange={(e) => updateNodeData(nodeId, {
                    presetConfig: { ...(data.presetConfig ?? defaultTransformPresetConfig('plink-score-file')), weightTransform: e.target.value },
                  })}
                  className="mt-1 h-8 w-full rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary"
                >
                  <option value="identity">Use values as-is</option>
                  <option value="log">log(OR)</option>
                </select>
              </div>
            )}
          </div>
        )}
      </div>

      {canProjectColumns && (
        <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          {preset ? 'Output columns' : 'Columns'}
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
      )}

      {canUseGenericFilters && (
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
      )}

      {canRenameColumns && (
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
      )}

      <div>
        <h4 className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Output
        </h4>
        {lockedFileType ? (
          <div className="rounded-md border border-border bg-bg-primary px-2 py-2 text-[11px] text-text-secondary">
            This preset writes a fixed <span className="text-text-primary">{lockedFileType}</span> artifact.
          </div>
        ) : (
          <select
            value={data.fileType}
            onChange={(e) => updateNodeData(nodeId, { fileType: e.target.value as TransformNodeData['fileType'] })}
            className="h-8 w-full rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent focus:border-accent"
          >
            {['tsv', 'csv', 'txt', 'any'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        <div className="mt-2">
          <FolderPickerField
            label=""
            value={(data.outputDirOverride as string | undefined) ?? ''}
            placeholder="(default — run's outputs folder)"
            requesterLabel={`${data.label} output folder`}
            onChange={(v) => updateNodeData(nodeId, { outputDirOverride: v || undefined })}
          />
        </div>
        <label className="mt-2 flex items-center gap-2 text-[11px] text-text-secondary">
          <input
            type="checkbox"
            checked={Boolean(data.outputIntermediate?.output)}
            onChange={(e) => updateNodeData(nodeId, { outputIntermediate: { output: e.target.checked } })}
            className="accent-accent"
          />
          Temporary output: delete after successful run
        </label>
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
    return null
  }

  return (
    <div data-tour="inspector" className="bioflow-inspector-surface bioflow-panel-text surface-panel nowheel nopan nodrag h-full flex flex-col">
      {/* Header */}
      <div className="px-3 py-3 flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wide text-text-muted font-medium">
          {node.type} inspector
        </div>
        <HelpButton id={node.type === 'merge' ? 'inspector.merge' : node.type === 'tool' ? 'inspector.tool' : node.type === 'file' ? 'inspector.file' : 'inspector.custom'} />
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
      <div
        className="bioflow-inspector-scroll scroll-region nowheel nopan nodrag p-3"
        onWheelCapture={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {node.type === 'tool' && (
          <ToolInspector nodeId={node.id} data={node.data as ToolNodeData} />
        )}
        {node.type === 'file' && (
          <FileInspector nodeId={node.id} data={node.data as FileNodeData} />
        )}
        {node.type === 'merge' && (
          <MergeInspector nodeId={node.id} data={node.data as MergeNodeData} />
        )}
        {node.type === 'transfer' && (
          <TransferInspector nodeId={node.id} data={node.data as TransferNodeData} />
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
