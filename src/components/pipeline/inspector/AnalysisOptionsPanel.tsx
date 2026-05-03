import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, Info, ListChecks, Plus, X, XCircle } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Tooltip } from '@/components/ui/Tooltip'
import { LocalPathField } from '@/components/file-browser/LocalPathField'
import { RemotePathField } from '@/components/file-browser/RemotePathField'
import {
  analysisOptionsToParamValues,
  customFileOptionPortId,
  getAnalysisOptionDefs,
  isValueSource,
  normalizeAnalysisOptions,
  previewAnalysisCommand,
  validateAnalysisOptions,
  type AnalysisOptionDef,
} from '@/lib/analysisOptions'
import { parseToolCommand } from '@/lib/commandEditing'
import { columnParamValues, connectedInputPath, type SchemaCache } from '@/lib/schemaResolver'
import { resolveUpstreamSchema } from '@/lib/resolveUpstreamSchema'
import { classNames } from '@/lib/utils'
import type { AnalysisOptionState, PipelineSnapshot, ToolDef, ToolNodeData, ValueSource } from '@/types/pipeline'

interface AnalysisOptionsPanelProps {
  nodeId: string
  tool: ToolDef
  nodeData: ToolNodeData
  snapshot: PipelineSnapshot
  schemas: SchemaCache
  refreshingSchemaPath?: string | null
  onLoadSchema: (path: string, options?: { force?: boolean }) => Promise<void>
  onChange: (patch: Partial<Pick<ToolNodeData, 'analysisOptions' | 'paramValues' | 'commandOverride'>>) => void
  onDisablePort: (portId: string) => number
  onUndoDisconnect: () => void
}

const RECOMMENDED_BY_TOOL: Record<string, string[]> = {
  'plink2.assoc': ['pheno-name', 'covar', 'covar-name', 'keep'],
  'plink2.qc': ['keep', 'maf', 'geno', 'mind', 'hwe'],
  'plink2.clump': ['clump-snp-field', 'clump-field', 'keep'],
  'plink2.score': ['score', 'extract', 'keep'],
  'plink2.pca': ['keep', 'chr'],
}

function optionValue(option: AnalysisOptionState): string {
  if (option.source) return option.source.value ?? ''
  if (option.value === undefined || option.value === null) return ''
  return String(option.value)
}

function sourceValue(option: AnalysisOptionState, fallbackKind: ValueSource['kind'], portId?: string): ValueSource {
  if (option.source) return { ...option.source, portId: option.source.portId ?? portId }
  if (isValueSource(option.value)) return { ...option.value, portId: option.value.portId ?? portId }
  return { kind: fallbackKind, value: option.value === undefined || option.value === null ? '' : String(option.value), portId }
}

function helpLabel(def: AnalysisOptionDef) {
  if (!def.description && !def.docUrl) return def.label
  return (
    <Tooltip
      side="left"
      content={
        <span className="block max-w-[300px] whitespace-normal leading-relaxed">
          {def.description && <span className="block">{def.description}</span>}
          {def.docUrl && (
            <button
              type="button"
              className="mt-1 text-accent underline"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                window.open(def.docUrl, '_blank', 'noopener,noreferrer')
              }}
            >
              View docs
            </button>
          )}
        </span>
      }
    >
      <span className="inline-flex items-center gap-1">
        <span>{def.label}</span>
        <Info size={11} className="text-text-muted" />
      </span>
    </Tooltip>
  )
}

function updateOption(options: AnalysisOptionState[], optionId: string, patch: Partial<AnalysisOptionState>): AnalysisOptionState[] {
  return options.map((option) => option.optionId === optionId ? { ...option, ...patch } : option)
}

function isCanvasInputOption(def: AnalysisOptionDef): boolean {
  return Boolean(def.filePortId && (def.kind === 'file' || def.kind === 'compound'))
}

function optionSearchText(def: AnalysisOptionDef): string {
  return [
    def.label,
    def.flag,
    def.id,
    def.description,
    def.group,
  ].filter(Boolean).join(' ').toLowerCase()
}

interface ReadablePreviewItem {
  label: string
  detail: string
  meta?: string
}

function sourcePreviewText(source: ValueSource, connectedPathForPort: (portId: string) => string | null, fallbackPortId?: string): string {
  if (source.kind === 'upstream-file') {
    const portId = source.portId ?? fallbackPortId ?? 'input'
    return connectedPathForPort(portId) ?? `Connect a file on ${portId}`
  }
  if (source.kind === 'local-path') return source.value ? `Local file: ${source.value}` : 'Choose a local file'
  if (source.kind === 'path') return source.value ? `Remote file: ${source.value}` : 'Choose a remote file'
  if (source.kind === 'upstream-column') return source.value ? `Column: ${source.value}` : 'Choose an upstream column'
  return source.value ?? ''
}

function subOptionPreview(option: AnalysisOptionState, def: AnalysisOptionDef): string[] {
  return (def.subOptions ?? []).flatMap((sub) => {
    const state = option.subOptions?.[sub.id]
    if (!state?.enabled) return []
    if (sub.kind === 'switch') return [sub.label]
    const value = state.value === undefined || state.value === null || state.value === '' ? '' : String(state.value)
    return value ? [`${sub.label}: ${value}`] : []
  })
}

function optionPreviewDetail(def: AnalysisOptionDef, option: AnalysisOptionState, connectedPathForPort: (portId: string) => string | null): string {
  if (def.kind === 'switch') return 'Enabled'
  if (def.kind === 'file' || (def.kind === 'compound' && def.filePortId)) {
    const source = sourceValue(option, def.filePortId ? 'upstream-file' : 'path', def.filePortId ?? def.sourcePortId)
    const base = sourcePreviewText(source, connectedPathForPort, def.filePortId ?? def.sourcePortId)
    const extras = subOptionPreview(option, def)
    return extras.length ? `${base}; ${extras.join(', ')}` : base
  }
  if (def.kind === 'column') {
    const value = sourcePreviewText(sourceValue(option, 'literal', def.sourcePortId), connectedPathForPort, def.sourcePortId)
    return value || 'Choose a column'
  }
  if (def.kind === 'compound') {
    const main = optionValue(option)
    const extras = subOptionPreview(option, def)
    return [main ? `Mode: ${main}` : '', ...extras].filter(Boolean).join('; ') || 'Enabled'
  }
  const value = optionValue(option)
  return value || 'Needs a value'
}

function readablePreviewItems(
  tool: ToolDef,
  nodeData: ToolNodeData,
  options: AnalysisOptionState[],
  connectedPathForPort: (portId: string) => string | null,
): ReadablePreviewItem[] {
  if (nodeData.commandOverride?.trim()) {
    return [{ label: 'Command override', detail: 'Using the manually edited command instead of generated settings.' }]
  }
  const defsById = new Map(getAnalysisOptionDefs(tool).map((def) => [def.id, def]))
  return options.flatMap((option) => {
    if (!option.enabled) return []
    const def = defsById.get(option.optionId)
    if (!def) {
      const label = option.customLabel?.trim() || option.customFlag?.trim() || 'Custom flag'
      if (option.customInputKind === 'file') {
        const source = sourceValue(option, 'path')
        return [{ label, detail: sourcePreviewText(source, connectedPathForPort, source.portId), meta: option.customFlag }]
      }
      return [{ label, detail: option.value === undefined || option.value === null || option.value === '' ? 'Enabled' : String(option.value), meta: option.customFlag }]
    }
    return [{
      label: def.label,
      detail: optionPreviewDetail(def, option, connectedPathForPort),
      meta: def.flag ?? def.id,
    }]
  })
}

function compoundSubOptionEditor(
  def: AnalysisOptionDef,
  option: AnalysisOptionState,
  onPatch: (patch: Partial<AnalysisOptionState>) => void,
) {
  if (!def.subOptions?.length) return null
  return (
    <div className="grid gap-2 rounded-md bg-bg-primary/50 p-2 shadow-inner">
      {def.subOptions.map((sub) => {
        const state = option.subOptions?.[sub.id] ?? { enabled: Boolean(sub.defaultEnabled), value: sub.defaultValue }
        if (sub.kind === 'switch') {
          return (
            <label key={sub.id} className="flex items-center gap-2 text-[11px] text-text-secondary">
              <input
                type="checkbox"
                checked={Boolean(state.enabled)}
                onChange={(event) => onPatch({
                  subOptions: {
                    ...(option.subOptions ?? {}),
                    [sub.id]: { ...state, enabled: event.target.checked },
                  },
                })}
                className="accent-accent"
              />
              {sub.label}
            </label>
          )
        }
        return (
          <Input
            key={sub.id}
            label={sub.label}
            value={state.value === undefined || state.value === null ? '' : String(state.value)}
            placeholder={sub.placeholder}
            onChange={(event) => onPatch({
              subOptions: {
                ...(option.subOptions ?? {}),
                [sub.id]: { ...state, enabled: true, value: event.target.value },
              },
            })}
          />
        )
      })}
    </div>
  )
}

function ColumnOptionEditor(props: {
  nodeId: string
  snapshot: PipelineSnapshot
  def: AnalysisOptionDef
  option: AnalysisOptionState
  schemas: SchemaCache
  refreshingSchemaPath?: string | null
  onLoadSchema: (path: string, options?: { force?: boolean }) => Promise<void>
  onPatch: (patch: Partial<AnalysisOptionState>) => void
}) {
  const { nodeId, snapshot, def, option, schemas, refreshingSchemaPath, onLoadSchema, onPatch } = props
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [focused, setFocused] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0)
  const [draft, setDraft] = useState('')
  const [suggestionRect, setSuggestionRect] = useState<{ top: number; left: number; width: number } | null>(null)
  const source = sourceValue(option, 'literal', def.sourcePortId)
  const inputPath = connectedInputPath(snapshot, nodeId, def.sourcePortId ?? 'input')
  const schema = resolveUpstreamSchema(snapshot, nodeId, def.sourcePortId ?? 'input', schemas)
  const columns = schema?.columns ?? []
  const allowsMultiple = Boolean(def.multiValue)
  const current = source.value ?? ''
  const selected = columnParamValues(current, { whitespaceSeparated: allowsMultiple })
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

  const updateSuggestionRect = useCallback(() => {
    const rect = inputRef.current?.getBoundingClientRect()
    setSuggestionRect(rect ? { top: rect.bottom + 4, left: rect.left, width: rect.width } : null)
  }, [])

  useEffect(() => {
    if (!focused || !showSuggestions || columns.length === 0) {
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
  }, [columns.length, focused, showSuggestions, suggestions.length, updateSuggestionRect])

  useEffect(() => {
    if (focused && columns.length > 0) setShowSuggestions(true)
  }, [columns.length, focused])

  const removeColumn = (column: string) => {
    onPatch({ source: { ...source, value: selected.filter((value) => value !== column).join(' ') } })
  }

  const addColumn = (column: string) => {
    if (selected.includes(column)) return
    onPatch({ source: { ...source, value: [...selected, column].join(' ') } })
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
    onPatch({ source: { ...source, value: [prefix, column, suffix].filter(Boolean).join(separator) } })
    setShowSuggestions(false)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  const suggestionList = focused && showSuggestions && columns.length > 0 && suggestions.length > 0 && suggestionRect && typeof document !== 'undefined'
    ? createPortal(
        <div
          className="bioflow-suggestion-popover surface-popover fixed z-[1300] max-h-56 overflow-y-auto rounded-md py-1"
          style={{
            top: suggestionRect.top,
            left: suggestionRect.left,
            width: suggestionRect.width,
          }}
        >
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
        </div>,
        document.body,
      )
    : null

  return (
    <div className="flex flex-col gap-2">
      {allowsMultiple && selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((column) => (
            <span key={column} className="inline-flex items-center gap-1 rounded-md bg-accent/10 px-2 py-1 text-[11px] text-text-primary shadow-sm">
              <span className="font-mono">{column}</span>
              <button
                type="button"
                onClick={() => removeColumn(column)}
                className="text-text-muted hover:text-text-primary"
                title={`Remove ${column}`}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <div className="bioflow-suggestion-root relative flex-1 overflow-visible">
          <input
            ref={inputRef}
            type="text"
            value={allowsMultiple ? draft : current}
            placeholder={columns.length ? (allowsMultiple ? 'Type a column and press Enter...' : 'Start typing a column name...') : def.placeholder}
            onFocus={() => {
              setFocused(true)
              setShowSuggestions(true)
              setActiveSuggestionIndex(0)
              if (columns.length === 0 && inputPath) void onLoadSchema(inputPath, { force: true })
            }}
            onBlur={() => window.setTimeout(() => {
              setFocused(false)
              setShowSuggestions(false)
            }, 120)}
            onChange={(event) => {
              if (allowsMultiple) {
                setDraft(event.target.value)
                setShowSuggestions(true)
              } else {
                onPatch({ source: { ...source, value: event.target.value } })
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
              if (event.key === 'Enter') {
                event.preventDefault()
                const suggestion = suggestions[activeSuggestionIndex] ?? suggestions[0]
                if (suggestion) insertColumn(suggestion)
                else if (allowsMultiple && draft.trim()) addColumn(draft.trim())
                return
              }
              if (event.key === 'Escape') {
                setShowSuggestions(false)
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
            }}
            className="bioflow-field h-8 w-full rounded-md px-3 text-sm text-text-primary placeholder-text-muted outline-none transition-colors"
          />
          {suggestionList}
        </div>
        {inputPath && (
          <Button
            variant="secondary"
            size="sm"
            className="h-8 px-2 text-[11px]"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setFocused(true)
              setShowSuggestions(true)
              inputRef.current?.focus()
              void onLoadSchema(inputPath, { force: true }).finally(() => {
                setShowSuggestions(true)
                window.setTimeout(updateSuggestionRect, 0)
              })
            }}
          >
            {refreshingSchemaPath === inputPath ? 'Refreshing...' : 'Columns'}
          </Button>
        )}
      </div>
      {columns.length === 0 && (
        <p className="text-[10px] text-text-muted">
          {inputPath ? 'Reading the upstream header enables column suggestions.' : 'Connect a tabular input to enable column suggestions.'}
        </p>
      )}
    </div>
  )
}

function optionEditor(props: {
  nodeId: string
  snapshot: PipelineSnapshot
  def: AnalysisOptionDef
  option: AnalysisOptionState
  schemas: SchemaCache
  refreshingSchemaPath?: string | null
  onLoadSchema: (path: string, options?: { force?: boolean }) => Promise<void>
  onPatch: (patch: Partial<AnalysisOptionState>) => void
}) {
  const { nodeId, snapshot, def, option, schemas, refreshingSchemaPath, onLoadSchema, onPatch } = props
  if (!option.enabled) return null

  if (def.kind === 'switch') {
    return <div className="text-[11px] text-text-muted">Switch flag. Disable the option to omit it.</div>
  }

  if (def.kind === 'enum') {
    return (
      <select
        value={optionValue(option)}
        onChange={(event) => onPatch({ value: event.target.value })}
        className="bioflow-field h-8 rounded-md px-2 text-sm text-text-primary outline-none"
      >
        <option value="">-- select --</option>
        {def.options?.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
    )
  }

  if (def.kind === 'compound' && !def.filePortId) {
    return (
      <div className="flex flex-col gap-2">
        {def.options?.length ? (
          <select
            value={optionValue(option)}
            onChange={(event) => onPatch({ value: event.target.value })}
            className="bioflow-field h-8 rounded-md px-2 text-sm text-text-primary outline-none"
          >
            <option value="">-- select --</option>
            {def.options.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        ) : (
          <Input
            label=""
            value={optionValue(option)}
            placeholder={def.placeholder}
            onChange={(event) => onPatch({ value: event.target.value })}
          />
        )}
        {compoundSubOptionEditor(def, option, onPatch)}
      </div>
    )
  }

  if (def.kind === 'file' || def.kind === 'compound') {
    const source = sourceValue(option, def.filePortId ? 'upstream-file' : 'path', def.filePortId ?? def.sourcePortId)
    const connectedPath = def.filePortId ? connectedInputPath(snapshot, nodeId, def.filePortId) : null
    const sourceOptions: Array<[ValueSource['kind'], string]> = def.filePortId
      ? [['upstream-file', 'Connect on canvas'], ['path', 'Remote path'], ['local-path', 'Local path']]
      : [['path', 'Remote path'], ['local-path', 'Local path']]
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-1">
          {sourceOptions.map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              onClick={() => onPatch({ source: { ...source, kind, portId: def.filePortId ?? def.sourcePortId } })}
              className={classNames(
                'rounded px-2 py-1 text-[10px] transition-all duration-150',
                source.kind === kind ? 'bg-accent/10 text-text-primary shadow-sm' : 'bg-bg-tertiary text-text-muted hover:bg-bg-hover hover:text-text-primary',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {source.kind === 'upstream-file' ? (
          <div className="rounded bg-bg-tertiary px-2 py-1.5 text-[11px] text-text-secondary shadow-inner">
            {connectedPath ? (
              <>
                Connected on <span className="font-mono text-text-primary">{def.filePortId}</span>
                <div className="mt-1 truncate font-mono text-[10px] text-text-muted" title={connectedPath}>{connectedPath}</div>
              </>
            ) : (
              <>A canvas port named <span className="font-mono text-text-primary">{def.filePortId}</span> is now available. Connect a file node there.</>
            )}
          </div>
        ) : source.kind === 'local-path' ? (
          <LocalPathField
            label=""
            value={source.value ?? ''}
            placeholder="/Users/you/input.tsv"
            onChange={(value) => onPatch({ source: { ...source, value } })}
            mode="file"
          />
        ) : (
          <RemotePathField
            label=""
            value={source.value ?? ''}
            placeholder="/project/.../input.tsv"
            onChange={(value) => onPatch({ source: { ...source, value } })}
            mode="file"
            title={`Select ${def.label}`}
            buttonLabel="Browse"
          />
        )}
        {def.kind === 'compound' && compoundSubOptionEditor(def, option, onPatch)}
      </div>
    )
  }

  if (def.kind === 'column') {
    return (
      <ColumnOptionEditor
        nodeId={nodeId}
        snapshot={snapshot}
        def={def}
        option={option}
        schemas={schemas}
        refreshingSchemaPath={refreshingSchemaPath}
        onLoadSchema={onLoadSchema}
        onPatch={onPatch}
      />
    )
  }

  return (
    <Input
      label=""
      type={def.kind === 'number' ? 'number' : 'text'}
      value={optionValue(option)}
      placeholder={def.placeholder}
      onChange={(event) => onPatch({ value: def.kind === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value })}
    />
  )
}

export function AnalysisOptionsPanel({
  nodeId,
  tool,
  nodeData,
  snapshot,
  schemas,
  refreshingSchemaPath,
  onLoadSchema,
  onChange,
  onDisablePort,
  onUndoDisconnect,
}: AnalysisOptionsPanelProps) {
  const [search, setSearch] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [customDialogOpen, setCustomDialogOpen] = useState(false)
  const [customFlag, setCustomFlag] = useState('--')
  const [customLabel, setCustomLabel] = useState('')
  const [customKind, setCustomKind] = useState<'text' | 'file'>('text')
  const [customValue, setCustomValue] = useState('')
  const [commandDraft, setCommandDraft] = useState(nodeData.commandOverride?.trim() ?? '')
  const [disconnectNotice, setDisconnectNotice] = useState<{ count: number; portId: string } | null>(null)
  const [validationOpen, setValidationOpen] = useState(false)
  const connectedPortIds = useMemo(
    () => snapshot.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.targetHandle ?? 'input'),
    [snapshot.edges, nodeId],
  )
  const defs = useMemo(() => getAnalysisOptionDefs(tool), [tool])
  const options = useMemo(() => normalizeAnalysisOptions(tool, nodeData, { connectedPortIds }), [tool, nodeData, connectedPortIds])
  const issues = validateAnalysisOptions(tool, { ...nodeData, analysisOptions: options }, connectedPortIds)
  const issueByOption = new Map(issues.map((issue) => [issue.optionId, issue.message]))
  const errorCount = issues.length
  const preview = useMemo(
    () => previewAnalysisCommand(tool, { ...nodeData, analysisOptions: options }, (portId) => connectedInputPath(snapshot, nodeId, portId)),
    [tool, nodeData, options, snapshot, nodeId],
  )
  const readablePreview = useMemo(
    () => readablePreviewItems(tool, nodeData, options, (portId) => connectedInputPath(snapshot, nodeId, portId)),
    [tool, nodeData, options, snapshot, nodeId],
  )
  const mainInputPath = tool.inputs.some((port) => port.id === 'input')
    ? connectedInputPath(snapshot, nodeId, 'input')
    : null
  const supportsCommandApply = tool.command === 'plink2' || tool.command === 'plink'

  useEffect(() => {
    setCommandDraft(nodeData.commandOverride?.trim() ?? preview)
  }, [nodeData.commandOverride, preview])

  const commit = (nextOptions: AnalysisOptionState[]) => {
    onChange({
      analysisOptions: nextOptions,
      paramValues: analysisOptionsToParamValues(tool, nextOptions, nodeData.paramValues),
    })
  }

  const patchOption = (optionId: string, patch: Partial<AnalysisOptionState>) => {
    commit(updateOption(options, optionId, patch))
  }

  const toggleOption = (def: AnalysisOptionDef, option: AnalysisOptionState, enabled: boolean) => {
    if (!enabled) {
      const portId = def.filePortId ?? def.sourcePortId
      if (portId && (def.kind === 'file' || def.kind === 'compound')) {
        const count = onDisablePort(portId)
        if (count > 0) setDisconnectNotice({ count, portId })
      }
    }
    patchOption(def.id, def.kind === 'switch' && enabled ? { enabled, value: true } : { enabled })
  }

  const addCustomOption = () => {
    const optionId = `custom_${Math.random().toString(36).slice(2, 10)}`
    const portId = customFileOptionPortId({ optionId })
    commit([
      ...options,
      {
        optionId,
        enabled: true,
        customFlag: customFlag.trim(),
        customLabel: customLabel.trim(),
        customInputKind: customKind,
        value: customKind === 'text' ? customValue : undefined,
        source: customKind === 'file' ? { kind: 'path', value: customValue, portId } : undefined,
      },
    ])
    setCustomDialogOpen(false)
    setCustomFlag('--')
    setCustomLabel('')
    setCustomKind('text')
    setCustomValue('')
  }

  const term = search.trim().toLowerCase()
  const selectedOptionIds = new Set(options.filter((option) => option.enabled).map((option) => option.optionId))
  const selectedDefs = defs
    .filter((def) => selectedOptionIds.has(def.id) && !isCanvasInputOption(def))
    .sort((a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required)) || a.group.localeCompare(b.group) || a.label.localeCompare(b.label))
  const recommendedDefs = defs
    .filter((def) => !selectedOptionIds.has(def.id) && !isCanvasInputOption(def) && (RECOMMENDED_BY_TOOL[tool.id] ?? []).includes(def.id))
    .sort((a, b) => (RECOMMENDED_BY_TOOL[tool.id] ?? []).indexOf(a.id) - (RECOMMENDED_BY_TOOL[tool.id] ?? []).indexOf(b.id))
  const commonSelectedDefs = selectedDefs.filter((def) => !def.advanced && def.group !== 'Advanced')
  const advancedSelectedDefs = selectedDefs.filter((def) => def.advanced || def.group === 'Advanced')
  const searchResults = term
    ? defs
        .filter((def) => !selectedOptionIds.has(def.id) && optionSearchText(def).includes(term))
        .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label))
        .slice(0, 8)
    : []
  const selectedCustomOptions = options.filter((option) => option.enabled && (option.customFlag !== undefined || option.customInputKind !== undefined))

  const applyCommandDraft = () => {
    if (!supportsCommandApply) return
    const parsed = parseToolCommand(tool, nodeData, commandDraft)
    onChange({
      analysisOptions: parsed.analysisOptions,
      paramValues: parsed.paramValues,
      commandOverride: undefined,
    })
  }

  useEffect(() => {
    if (!disconnectNotice) return
    const timer = window.setTimeout(() => setDisconnectNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [disconnectNotice])

  return (
    <div className="bioflow-analysis-options flex flex-col gap-3 overflow-visible">
      {disconnectNotice && (
        <div className="flex items-center justify-between gap-3 rounded-md bg-accent/10 px-3 py-2 text-[11px] text-text-secondary shadow-sm">
          <span>
            Removed {disconnectNotice.count} connection{disconnectNotice.count === 1 ? '' : 's'} from <span className="font-mono text-text-primary">{disconnectNotice.portId}</span>.
          </span>
          <button
            type="button"
            className="shrink-0 rounded bg-accent/10 px-2 py-1 text-text-primary shadow-sm hover:bg-accent/15"
            onClick={() => {
              onUndoDisconnect()
              setDisconnectNotice(null)
            }}
          >
            Undo
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-[1_1_10rem]">
          <Input
            label=""
            value={search}
            placeholder="Search options"
            className="text-xs"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Button variant="secondary" size="sm" className="h-8 shrink-0 px-2 text-xs" onClick={() => setCustomDialogOpen(true)}>
          <Plus size={13} />
          Custom
        </Button>
        <Button variant="secondary" size="sm" className="h-8 shrink-0 px-2 text-xs" onClick={() => setValidationOpen((value) => !value)}>
          <ListChecks size={13} />
          Validate settings
        </Button>
      </div>
      {validationOpen && (
        <div className={classNames('rounded-md px-3 py-2 text-[11px] shadow-sm', errorCount > 0 ? 'bg-error/10' : 'bg-success/10')}>
          <div className="mb-1 flex items-center gap-2 font-medium text-text-primary">
            {errorCount > 0 ? <XCircle size={13} className="text-error" /> : <CheckCircle2 size={13} className="text-success" />}
            {issues.length === 0 ? 'Settings are ready' : `${errorCount} setting error${errorCount === 1 ? '' : 's'}`}
          </div>
          {issues.length > 0 ? (
            <div className="flex flex-col gap-1">
              {issues.map((issue) => (
                <div key={`${issue.optionId}-${issue.code}`} className="rounded bg-bg-primary px-2 py-1 shadow-inner">
                  <span className="text-error">{issue.code}</span>
                  <span className="ml-2 text-text-secondary">{issue.message}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-text-secondary">Required flags and file-valued options have usable values or connected inputs.</div>
          )}
        </div>
      )}
      {recommendedDefs.length > 0 && !term && (
        <div className="rounded-md bg-bg-tertiary/30 p-2 shadow-inner">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-text-muted">Recommended</div>
          <div className="flex flex-wrap gap-1.5">
            {recommendedDefs.map((def) => (
              <button
                key={def.id}
                type="button"
                onClick={() => {
                  const option = options.find((candidate) => candidate.optionId === def.id) ?? { optionId: def.id, enabled: false, value: def.defaultValue }
                  toggleOption(def, option, true)
                  if (def.advanced || def.group === 'Advanced') setAdvancedOpen(true)
                }}
                className="rounded bg-bg-secondary px-2 py-1 text-[11px] text-text-secondary shadow-sm hover:bg-bg-hover hover:text-text-primary"
              >
                {def.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {term && (
        <div className="surface-popover rounded-md bg-bg-tertiary/30 p-1.5 shadow-inner">
          {searchResults.length > 0 ? (
            <div className="flex flex-col gap-1">
              {searchResults.map((def) => {
                const option = options.find((candidate) => candidate.optionId === def.id) ?? { optionId: def.id, enabled: false, value: def.defaultValue }
                return (
                  <button
                    key={def.id}
                    type="button"
                    onClick={() => {
                      toggleOption(def, option, true)
                      setSearch('')
                    }}
                    className="flex items-start justify-between gap-3 rounded px-2 py-1.5 text-left transition-colors hover:bg-bg-secondary"
                  >
                    <span className="min-w-0">
                      <span className="text-nowrap block text-xs font-medium text-text-primary">{def.label}</span>
                      <span className="text-nowrap block font-mono text-[10px] text-text-muted">{def.flag ?? def.id}</span>
                    </span>
                    <span className="shrink-0 rounded bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-muted">
                      {isCanvasInputOption(def) ? 'input' : def.group}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="px-2 py-1.5 text-xs text-text-muted">No matching options.</div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2 overflow-visible">
        {commonSelectedDefs.map((def) => {
          const option = options.find((candidate) => candidate.optionId === def.id) ?? { optionId: def.id, enabled: true, value: def.defaultValue }
          const invalid = issueByOption.get(def.id)
          return (
            <div key={def.id} className={classNames('overflow-visible rounded-md p-2 shadow-sm', invalid ? 'bg-error/5 ring-1 ring-error/30' : 'bg-bg-secondary')}>
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-medium leading-4 text-text-primary">{helpLabel(def)}</div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-nowrap font-mono text-[10px] text-text-muted">{def.flag ?? def.id}</span>
                    <span className="bioflow-badge text-nowrap rounded bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-muted">{def.group}</span>
                  </div>
                </div>
                {!def.required && (
                  <button
                    type="button"
                    onClick={() => toggleOption(def, option, false)}
                    className="shrink-0 rounded bg-bg-tertiary p-1 text-text-muted shadow-sm hover:bg-bg-hover hover:text-text-primary"
                    title={`Remove ${def.label}`}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              {optionEditor({
                nodeId,
                snapshot,
                def,
                option,
                schemas,
                refreshingSchemaPath,
                onLoadSchema,
                onPatch: (patch) => patchOption(def.id, patch),
              })}
              {invalid && <div className="mt-2 text-[10px] text-error">{invalid}</div>}
            </div>
          )
        })}
        {selectedDefs.length === 0 && selectedCustomOptions.length === 0 && (
          <div className="rounded-md bg-bg-tertiary/30 px-3 py-3 text-xs text-text-muted shadow-inner">
            Search above to add analysis options. File options are added to the Inputs section.
          </div>
        )
        }
      </div>

      {(advancedSelectedDefs.length > 0 || term.length > 0) && (
        <div className="rounded-md bg-bg-tertiary/20 shadow-inner">
          <button
            type="button"
            onClick={() => setAdvancedOpen((value) => !value)}
            className="flex w-full items-center justify-between px-3 py-2 text-left"
          >
            <span className="text-[10px] uppercase tracking-wide text-text-muted">Advanced options</span>
            <span className="text-[11px] text-text-secondary">{advancedOpen ? 'Hide' : 'Show'}</span>
          </button>
          {advancedOpen && (
            <div className="px-2 py-2">
              <div className="flex flex-col gap-2">
                {advancedSelectedDefs.length === 0 && (
                  <div className="rounded-md bg-bg-secondary px-3 py-3 text-xs text-text-muted shadow-inner">
                    Search for advanced flags above to add them here.
                  </div>
                )}
                {advancedSelectedDefs.map((def) => {
                  const option = options.find((candidate) => candidate.optionId === def.id) ?? { optionId: def.id, enabled: true, value: def.defaultValue }
                  const invalid = issueByOption.get(def.id)
                  return (
                    <div key={def.id} className={classNames('overflow-visible rounded-md p-2 shadow-sm', invalid ? 'bg-error/5 ring-1 ring-error/30' : 'bg-bg-secondary')}>
                      <div className="mb-2 flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-text-primary">{helpLabel(def)}</div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-[10px] text-text-muted">{def.flag ?? def.id}</span>
                            <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-muted">{def.group}</span>
                          </div>
                        </div>
                        {!def.required && (
                          <button type="button" onClick={() => toggleOption(def, option, false)} className="shrink-0 rounded bg-bg-tertiary p-1 text-text-muted shadow-sm hover:bg-bg-hover hover:text-text-primary">
                            <X size={12} />
                          </button>
                        )}
                      </div>
                      {optionEditor({
                        nodeId,
                        snapshot,
                        def,
                        option,
                        schemas,
                        refreshingSchemaPath,
                        onLoadSchema,
                        onPatch: (patch) => patchOption(def.id, patch),
                      })}
                      {invalid && <div className="mt-2 text-[10px] text-error">{invalid}</div>}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {selectedCustomOptions.map((option) => {
        const isFile = option.customInputKind === 'file'
        const customPortId = option.source?.portId || customFileOptionPortId(option)
        const customFileDef: AnalysisOptionDef = {
          id: option.optionId,
          label: option.customLabel?.trim() || option.customFlag?.trim() || 'Custom file flag',
          group: 'Advanced',
          kind: 'file',
          flag: option.customFlag,
          description: 'Custom file-valued flag. Choose a path or expose it as a canvas input.',
          filePortId: customPortId,
          sourcePortId: customPortId,
        }
        return (
          <div key={option.optionId} className="overflow-visible rounded-md bg-bg-secondary p-2 shadow-sm">
            <div className="mb-2 flex items-center justify-between gap-2">
              <Input label="Custom flag" value={option.customFlag ?? ''} placeholder="--set-all-var-ids" onChange={(event) => patchOption(option.optionId, { customFlag: event.target.value })} />
              <button type="button" className="mt-5 rounded bg-bg-tertiary p-1 text-text-muted shadow-sm hover:bg-bg-hover hover:text-text-primary" onClick={() => commit(options.filter((candidate) => candidate.optionId !== option.optionId))}>
                <X size={13} />
              </button>
            </div>
            <div className="mb-2 flex gap-1">
              {(['text', 'file'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => patchOption(option.optionId, { customInputKind: kind })}
                  className={classNames('rounded px-2 py-1 text-[10px] transition-all duration-150', option.customInputKind === kind ? 'bg-accent/10 text-text-primary shadow-sm' : 'bg-bg-tertiary text-text-muted hover:bg-bg-hover hover:text-text-primary')}
                >
                  {kind === 'file' ? 'File value' : 'Text value'}
                </button>
              ))}
            </div>
            {isFile ? (
              optionEditor({
                nodeId,
                snapshot,
                def: customFileDef,
                option: {
                  ...option,
                  source: sourceValue(option, 'path', customPortId),
                },
                schemas,
                refreshingSchemaPath,
                onLoadSchema,
                onPatch: (patch) => patchOption(option.optionId, patch),
              })
            ) : (
              <Input label="" value={option.value === undefined || option.value === null ? '' : String(option.value)} placeholder="Optional value" onChange={(event) => patchOption(option.optionId, { value: event.target.value })} />
            )}
          </div>
        )
      })}

      <div className="bioflow-readable-preview">
        <h5 className="mb-2 text-[10px] font-medium uppercase tracking-wide text-text-muted">Preview</h5>
        <div className="rounded-md bg-bg-primary px-3 py-2 text-xs leading-5 text-text-secondary shadow-inner">
          <div className="mb-2 text-text-primary">
            {nodeData.commandOverride?.trim()
              ? 'This node will use a manual command override.'
              : `Run ${tool.name} with ${mainInputPath ? 'the connected input' : 'no primary input connected yet'}.`}
          </div>
          {mainInputPath && (
            <div className="mb-1 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
              <span className="text-text-muted">Input</span>
              <span className="break-all font-mono text-text-secondary">{mainInputPath}</span>
            </div>
          )}
          {readablePreview.length > 0 ? (
            <div className="flex flex-col gap-1">
              {readablePreview.map((item) => (
                <div key={`${item.label}-${item.meta ?? item.detail}`} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
                  <span className="text-text-muted">{item.label}</span>
                  <span className="min-w-0">
                    <span className="text-wrap text-text-secondary">{item.detail}</span>
                    {item.meta && <span className="ml-1 font-mono text-[10px] text-text-muted">({item.meta})</span>}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-text-muted">No optional analysis settings are enabled yet.</div>
          )}
        </div>
        <details className="mt-2 rounded-md bg-bg-secondary px-3 py-2 text-[11px] text-text-muted shadow-sm">
          <summary className="cursor-pointer text-text-secondary">Raw command</summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-bg-primary px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-100 shadow-inner">
            <code>{preview}</code>
          </pre>
        </details>
      </div>

      <div className="rounded-md bg-bg-secondary p-2 shadow-sm">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-text-muted">Command editing</div>
            <div className="text-[11px] text-text-secondary">Edit the generated command directly, then either sync fields or keep it as an override.</div>
          </div>
          <label className="flex items-center gap-2 text-[11px] text-text-secondary">
            <input
              type="checkbox"
              checked={Boolean(nodeData.commandOverride?.trim())}
              onChange={(event) => onChange({ commandOverride: event.target.checked ? commandDraft : undefined })}
              className="accent-accent"
            />
            Use override
          </label>
        </div>
        <textarea
          value={commandDraft}
          onChange={(event) => {
            setCommandDraft(event.target.value)
            if (nodeData.commandOverride?.trim()) onChange({ commandOverride: event.target.value })
          }}
          rows={6}
          className="w-full rounded-md bg-bg-primary px-3 py-2 font-mono text-[11px] text-slate-100 shadow-inner outline-none focus:ring-2 focus:ring-accent/30"
        />
        {supportsCommandApply && commandDraft.trim() !== preview.trim() && (
          <div className="mt-2 rounded-md bg-accent/10 px-3 py-2 shadow-sm">
            <div className="text-[11px] text-text-secondary">Applying this command will update: {parseToolCommand(tool, nodeData, commandDraft).changes.join(', ') || 'No structured changes detected'}.</div>
            <div className="mt-2 flex gap-2">
              <Button variant="secondary" size="sm" className="h-7 text-[11px]" onClick={applyCommandDraft}>
                Apply command edits to fields
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => onChange({ commandOverride: commandDraft })}>
                Use as override
              </Button>
            </div>
          </div>
        )}
      </div>

      <Dialog
        open={customDialogOpen}
        onClose={() => setCustomDialogOpen(false)}
        title="Add custom flag"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setCustomDialogOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={addCustomOption} disabled={!customFlag.trim() || !customFlag.trim().startsWith('--')}>Add</Button>
          </>
        )}
      >
        <div className="flex flex-col gap-3">
          <Input label="Flag" value={customFlag} placeholder="--set-all-var-ids" onChange={(event) => setCustomFlag(event.target.value)} />
          <Input label="Label (optional)" value={customLabel} placeholder="Readable name" onChange={(event) => setCustomLabel(event.target.value)} />
          <div className="flex gap-2">
            {(['text', 'file'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => setCustomKind(kind)}
                className={classNames('rounded px-2 py-1 text-[11px] transition-all duration-150', customKind === kind ? 'bg-accent/10 text-text-primary shadow-sm' : 'bg-bg-tertiary text-text-muted hover:bg-bg-hover hover:text-text-primary')}
              >
                {kind === 'file' ? 'File parameter' : 'Text parameter'}
              </button>
            ))}
          </div>
          {customKind === 'file' ? (
            <RemotePathField
              label="File path"
              value={customValue}
              placeholder="/project/.../input.txt"
              onChange={setCustomValue}
              mode="file"
              title="Select custom flag file"
              buttonLabel="Browse"
            />
          ) : (
            <Input label="Value (optional)" value={customValue} placeholder="Optional value" onChange={(event) => setCustomValue(event.target.value)} />
          )}
        </div>
      </Dialog>
    </div>
  )
}
