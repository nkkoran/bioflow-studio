import { useMemo, useState } from 'react'
import { GripVertical, Info, ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Tooltip } from '@/components/ui/Tooltip'
import { LocalPathField } from '@/components/file-browser/LocalPathField'
import { RemotePathField } from '@/components/file-browser/RemotePathField'
import {
  blockHasValue,
  blockFlag,
  blockLabel,
  buildPresetFlagBlocks,
  createCustomFlagBlock,
  getFlagDef,
  getToolFlagDefs,
  getToolPresetOptions,
  CUSTOM_FLAG_ID,
} from '@/lib/flagRegistry'
import { columnParamValues, connectedInputPath, type SchemaCache } from '@/lib/schemaResolver'
import { resolveUpstreamSchema } from '@/lib/resolveUpstreamSchema'
import { classNames } from '@/lib/utils'
import type {
  PipelineSnapshot,
  ToolDef,
  ToolFlagBlock,
  ToolFlagDef,
  ToolNodeData,
  ValueSource,
} from '@/types/pipeline'

interface FlagBuilderProps {
  nodeId: string
  tool: ToolDef
  nodeData: ToolNodeData
  snapshot: PipelineSnapshot
  schemas: SchemaCache
  refreshingSchemaPath?: string | null
  advancedExpanded: boolean
  onSetAdvancedExpanded: (expanded: boolean) => void
  onLoadSchema: (path: string, options?: { force?: boolean }) => Promise<void>
  onChange: (blocks: ToolFlagBlock[]) => void
}

type DragPayload =
  | { type: 'palette'; flagId: string }
  | { type: 'active'; blockId: string }

function isValueSource(value: unknown): value is ValueSource {
  return Boolean(value) && typeof value === 'object' && 'kind' in (value as Record<string, unknown>)
}

function sourceValue(value: unknown, fallbackKind: ValueSource['kind']): ValueSource {
  return isValueSource(value) ? value : { kind: fallbackKind, value: value === undefined || value === null ? '' : String(value) }
}

function updateBlock(
  blocks: ToolFlagBlock[],
  blockId: string,
  patch: Partial<ToolFlagBlock>,
): ToolFlagBlock[] {
  return blocks.map((block) => (block.id === blockId ? { ...block, ...patch } : block))
}

function moveBlock(blocks: ToolFlagBlock[], from: number, to: number): ToolFlagBlock[] {
  const next = [...blocks]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

function quotePreview(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value
}

function previewPlinkInput(path: string): string {
  if (!path) return '<genotypes>'
  if (/\.(pgen|pvar|psam|bed|bim|fam)$/i.test(path)) return path.replace(/\.[^.]+$/, '')
  return path
}

function previewValue(value: unknown, fallback = '<value>'): string {
  if (isValueSource(value)) return value.value?.trim() || fallback
  if (Array.isArray(value)) return value.join(' ')
  if (value === undefined || value === null || value === '') return fallback
  return String(value)
}

function buildPreviewCommand(
  tool: ToolDef,
  nodeId: string,
  snapshot: PipelineSnapshot,
  blocks: ToolFlagBlock[],
): string {
  const parts: string[] = [tool.command]
  const genotype = connectedInputPath(snapshot, nodeId, 'input')
  if (genotype) {
    parts.push(`${/\.bed$/i.test(genotype) ? '--bfile' : '--pfile'} ${quotePreview(previewPlinkInput(genotype))}`)
  } else {
    parts.push('--pfile <genotypes>')
  }

  const enabled = blocks.filter((block) => block.enabled)
  const byFlagId = new Map(enabled.map((block) => [block.flagId, block]))

  for (const block of enabled) {
    const def = getFlagDef(tool.id, block.flagId)
    if (!def) continue
    const renderedFlag = blockFlag(tool.id, block)
    if (!renderedFlag) continue
    if (tool.id === 'plink2.assoc' && ['hide-covar', 'allow-no-covars', 'omit-ref', 'skip-invalid-pheno'].includes(def.id)) {
      continue
    }
    if (tool.id === 'plink2.assoc' && ['pheno-iid-only', 'covar-iid-only'].includes(def.id)) {
      continue
    }
    if (tool.id === 'plink2.score' && ['score-col-nums', 'header', 'center', 'variance-standardize', 'no-mean-imputation'].includes(def.id)) {
      continue
    }
    if (tool.id === 'plink2.assoc' && def.id === 'glm') {
      const extras: string[] = []
      const mode = previewValue(block.value, 'firth-fallback')
      if (mode && mode !== '<value>') extras.push(mode)
      for (const modifier of ['hide-covar', 'allow-no-covars', 'omit-ref', 'skip-invalid-pheno']) {
        if (byFlagId.get(modifier)?.enabled) extras.push(modifier)
      }
      parts.push(`--glm${extras.length ? ` ${extras.join(' ')}` : ''}`)
      continue
    }
    if (tool.id === 'plink2.score' && def.id === 'score') {
      const source = sourceValue(block.value, 'upstream-file')
      const file = source.kind === 'upstream-file'
        ? connectedInputPath(snapshot, nodeId, def.sourcePortId ?? 'score') ?? `<${def.sourcePortId ?? 'score'}>`
        : source.value?.trim() || '<score file>'
      const extras: string[] = []
      const scoreCols = previewValue(byFlagId.get('score-col-nums')?.value, '3 4 5')
      if (scoreCols) extras.push(scoreCols)
      for (const modifier of ['header', 'center', 'variance-standardize', 'no-mean-imputation']) {
        if (byFlagId.get(modifier)?.enabled) extras.push(modifier)
      }
      parts.push(`--score ${quotePreview(file)}${extras.length ? ` ${extras.join(' ')}` : ''}`)
      continue
    }
    if (def.kind === 'toggle') {
      parts.push(renderedFlag)
      continue
    }
    if (def.kind === 'fileInput') {
      const source = sourceValue(block.value, 'upstream-file')
      const file = source.kind === 'upstream-file'
        ? connectedInputPath(snapshot, nodeId, def.sourcePortId ?? source.portId ?? 'input') ?? `<${def.sourcePortId ?? source.portId ?? 'input'}>`
        : source.value?.trim() || `<${def.label.toLowerCase()}>`
      const flag = tool.id === 'plink2.assoc' && def.id === 'pheno' && previewSwitchBlockEnabled(byFlagId.get('pheno-iid-only'))
        ? `${renderedFlag} iid-only`
        : tool.id === 'plink2.assoc' && def.id === 'covar' && previewSwitchBlockEnabled(byFlagId.get('covar-iid-only'))
          ? `${renderedFlag} iid-only`
          : renderedFlag
      parts.push(`${flag} ${quotePreview(file)}`)
      continue
    }
    if (block.flagId === CUSTOM_FLAG_ID && block.customInputKind === 'file') {
      const source = sourceValue(block.value, 'path')
      const file = source.value?.trim() || '<file>'
      parts.push(`${renderedFlag} ${quotePreview(file)}`)
      continue
    }
    if (def.kind === 'raw') {
      const value = previewValue(block.value, '')
      parts.push(value ? `${renderedFlag} ${value}` : renderedFlag)
      continue
    }
    const value = previewValue(block.value)
    if (value === '<value>') continue
    parts.push(`${renderedFlag} ${value}`)
  }

  parts.push('--out <output-prefix>')
  return parts.join(' \\\n  ')
}

function previewSwitchBlockEnabled(block: ToolFlagBlock | undefined): boolean {
  return Boolean(block?.enabled) && block?.value !== false
}

function docsChip(def: ToolFlagDef) {
  if (!def.docUrl && !def.description) return <>{def.label}</>
  return (
    <Tooltip
      side="right"
      content={
        <span className="block max-w-[280px] whitespace-normal leading-relaxed">
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

function ColumnSourceEditor({
  block,
  def,
  columns,
  loading,
  refreshing,
  onRefresh,
  onChange,
}: {
  block: ToolFlagBlock
  def: ToolFlagDef
  columns: string[]
  loading: boolean
  refreshing: boolean
  onRefresh?: () => void
  onChange: (value: unknown) => void
}) {
  const current = sourceValue(block.value, 'literal')
  const selected = columnParamValues(current.value, { whitespaceSeparated: def.multiValue })
  const [draft, setDraft] = useState('')
  const suggestions = columns
    .filter((column) => column.toLowerCase().includes((def.multiValue ? draft : current.value ?? '').toLowerCase()))
    .slice(0, 10)

  const setSourceKind = (kind: ValueSource['kind']) => {
    onChange({ ...current, kind })
  }

  const setSourceValue = (value: string) => {
    onChange({ ...current, value })
  }

  const addColumn = (column: string) => {
    if (def.multiValue) {
      const next = [...selected, column].filter((value, index, values) => values.indexOf(value) === index)
      setDraft('')
      setSourceValue(next.join(' '))
      return
    }
    setSourceValue(column)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {([
          ['literal', 'Literal'],
          ['upstream-column', 'Upstream column'],
        ] as Array<[ValueSource['kind'], string]>).map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            onClick={() => setSourceKind(kind)}
            className={classNames(
              'rounded border px-2 py-1 text-[10px]',
              current.kind === kind ? 'border-accent bg-accent/10 text-text-primary' : 'border-border bg-bg-tertiary text-text-muted',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {def.multiValue && current.kind === 'upstream-column' && selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((column) => (
            <span key={column} className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-[11px] text-text-primary">
              <span className="font-mono">{column}</span>
              <button
                type="button"
                onClick={() => setSourceValue(selected.filter((value) => value !== column).join(' '))}
                className="text-text-muted hover:text-text-primary"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-end gap-1.5">
        <Input
          label=""
          value={def.multiValue && current.kind === 'upstream-column' ? draft : current.value ?? ''}
          placeholder={current.kind === 'upstream-column' ? 'Pick from upstream columns' : def.placeholder}
          onChange={(event) => {
            if (def.multiValue && current.kind === 'upstream-column') setDraft(event.target.value)
            else setSourceValue(event.target.value)
          }}
          className="flex-1"
        />
        {onRefresh && (
          <Button variant="secondary" size="sm" className="h-8 px-2 text-[11px]" onClick={onRefresh}>
            {refreshing ? 'Refreshing...' : 'Columns'}
          </Button>
        )}
      </div>
      {current.kind === 'upstream-column' && suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {suggestions.map((column) => (
            <button
              key={column}
              type="button"
              onClick={() => addColumn(column)}
              className="rounded border border-border bg-bg-tertiary px-2 py-1 text-[11px] font-mono text-text-secondary hover:text-text-primary"
            >
              {column}
            </button>
          ))}
        </div>
      )}
      {current.kind === 'upstream-column' && columns.length === 0 && (
        <p className="text-[10px] text-text-muted">
          {loading ? 'Reading the upstream header…' : 'Connect or preview the upstream table to enable column picks.'}
        </p>
      )}
    </div>
  )
}

function FileSourceEditor({
  nodeId,
  snapshot,
  block,
  def,
  onChange,
}: {
  nodeId: string
  snapshot: PipelineSnapshot
  block: ToolFlagBlock
  def: ToolFlagDef
  onChange: (value: unknown) => void
}) {
  const current = sourceValue(block.value, 'upstream-file')
  const connectedPath = connectedInputPath(snapshot, nodeId, def.sourcePortId ?? current.portId ?? 'input')

  const setKind = (kind: ValueSource['kind']) => {
    onChange({ ...current, kind })
  }

  const pathLabel = current.kind === 'local-path' ? 'Local path' : 'Path'

  const sourceOptions = def.sourcePortId
    ? ([['upstream-file', 'Upstream file'], ['path', 'Remote path'], ['local-path', 'Local path']] as Array<[ValueSource['kind'], string]>)
    : ([['path', 'Remote path'], ['local-path', 'Local path']] as Array<[ValueSource['kind'], string]>)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {sourceOptions.map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            onClick={() => setKind(kind)}
            className={classNames(
              'rounded border px-2 py-1 text-[10px]',
              current.kind === kind ? 'border-accent bg-accent/10 text-text-primary' : 'border-border bg-bg-tertiary text-text-muted',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {current.kind === 'upstream-file' ? (
        <div className="rounded border border-border bg-bg-tertiary px-2 py-1.5 text-[11px] text-text-secondary">
          {connectedPath ? (
            <>
              Connected on <span className="font-mono text-text-primary">{def.sourcePortId ?? current.portId ?? 'input'}</span>:
              <div className="mt-1 truncate font-mono text-[10px] text-text-muted" title={connectedPath}>{connectedPath}</div>
            </>
          ) : (
            <>No upstream file is connected on <span className="font-mono text-text-primary">{def.sourcePortId ?? current.portId ?? 'input'}</span>.</>
          )}
        </div>
      ) : current.kind === 'local-path' ? (
        <LocalPathField
          label={pathLabel}
          value={current.value ?? ''}
          placeholder="/Users/you/input.tsv"
          onChange={(value) => onChange({ ...current, value })}
          mode="file"
        />
      ) : (
        <RemotePathField
          label={pathLabel}
          value={current.value ?? ''}
          placeholder="/project/.../input.tsv"
          onChange={(value) => onChange({ ...current, value })}
          mode="file"
          title={`Select ${def.label}`}
          buttonLabel="Browse"
        />
      )}
    </div>
  )
}

function CustomFlagEditor({
  nodeId,
  snapshot,
  block,
  onChange,
}: {
  nodeId: string
  snapshot: PipelineSnapshot
  block: ToolFlagBlock
  onChange: (patch: Partial<ToolFlagBlock>) => void
}) {
  const inputKind = block.customInputKind ?? 'text'
  const customFileDef: ToolFlagDef = {
    id: CUSTOM_FLAG_ID,
    flag: block.customFlag?.trim() || '--custom',
    label: block.customLabel?.trim() || 'Custom file',
    group: 'Advanced',
    kind: 'fileInput',
  }

  return (
    <div className="grid gap-2 md:grid-cols-2">
      <Input
        label="Flag"
        value={block.customFlag ?? ''}
        placeholder="--set-all-var-ids"
        onChange={(event) => onChange({ customFlag: event.target.value })}
      />
      <Input
        label="Label (optional)"
        value={block.customLabel ?? ''}
        placeholder="Variant ID rewrite"
        onChange={(event) => onChange({ customLabel: event.target.value })}
      />
      <div className="md:col-span-2">
        <div className="mb-1 text-text-secondary text-xs font-medium">Input type</div>
        <div className="flex flex-wrap gap-1">
          {([
            ['text', 'Text'],
            ['file', 'File'],
          ] as const).map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              onClick={() => onChange({
                customInputKind: kind,
                value: kind === 'file'
                  ? (isValueSource(block.value) ? block.value : { kind: 'path', value: String(block.value ?? '') })
                  : (isValueSource(block.value) ? (block.value.value ?? '') : String(block.value ?? '')),
              })}
              className={classNames(
                'rounded border px-2 py-1 text-[10px]',
                inputKind === kind ? 'border-accent bg-accent/10 text-text-primary' : 'border-border bg-bg-tertiary text-text-muted',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="md:col-span-2">
        {inputKind === 'file' ? (
          <FileSourceEditor
            nodeId={nodeId}
            snapshot={snapshot}
            block={{
              ...block,
              value: isValueSource(block.value) ? block.value : { kind: 'path', value: String(block.value ?? '') },
            }}
            def={customFileDef}
            onChange={(value) => onChange({ value, customInputKind: 'file' })}
          />
        ) : (
          <Input
            label="Value (optional)"
            value={isValueSource(block.value) ? (block.value.value ?? '') : (block.value === undefined || block.value === null ? '' : String(block.value))}
            placeholder="@:#$r,$a or leave blank for a switch flag"
            onChange={(event) => onChange({ value: event.target.value, customInputKind: 'text' })}
          />
        )}
      </div>
      <p className="md:col-span-2 text-[10px] text-text-muted">
        Leave Value empty when the flag is just a switch. File mode uses the same remote/local browse controls as the built-in file flags.
      </p>
    </div>
  )
}

function BlockControl({
  nodeId,
  snapshot,
  block,
  def,
  schemas,
  refreshingSchemaPath,
  onLoadSchema,
  onChange,
}: {
  nodeId: string
  snapshot: PipelineSnapshot
  block: ToolFlagBlock
  def: ToolFlagDef
  schemas: SchemaCache
  refreshingSchemaPath?: string | null
  onLoadSchema: (path: string, options?: { force?: boolean }) => Promise<void>
  onChange: (value: unknown) => void
}) {
  if (block.flagId === CUSTOM_FLAG_ID) {
    return (
      <CustomFlagEditor
        nodeId={nodeId}
        snapshot={snapshot}
        block={block}
        onChange={(patch) => onChange({
          value: patch.value ?? block.value ?? '',
          flag: patch.customFlag ?? block.customFlag ?? '',
          label: patch.customLabel ?? block.customLabel ?? '',
          inputKind: patch.customInputKind ?? block.customInputKind ?? 'text',
        })}
      />
    )
  }

  if (def.kind === 'toggle') {
    return (
      <div className="text-[11px] text-text-muted">
        This is a standalone switch flag. Use the enabled toggle in the block header to include or omit it.
      </div>
    )
  }

  if (def.kind === 'enum') {
    return (
      <select
        value={block.value === undefined || block.value === null ? '' : String(block.value)}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent"
      >
        <option value="">-- select --</option>
        {def.options?.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    )
  }

  if (def.kind === 'columnRef') {
    const inputPath = connectedInputPath(snapshot, nodeId, def.sourcePortId ?? 'input')
    const schema = resolveUpstreamSchema(snapshot, nodeId, def.sourcePortId ?? 'input', schemas)
    return (
      <ColumnSourceEditor
        block={block}
        def={def}
        columns={schema?.columns ?? []}
        loading={Boolean(inputPath && !schema)}
        refreshing={refreshingSchemaPath === inputPath}
        onRefresh={inputPath ? () => void onLoadSchema(inputPath, { force: true }) : undefined}
        onChange={onChange}
      />
    )
  }

  if (def.kind === 'fileInput') {
    return (
      <FileSourceEditor
        nodeId={nodeId}
        snapshot={snapshot}
        block={block}
        def={def}
        onChange={onChange}
      />
    )
  }

  return (
    <Input
      label=""
      value={block.value === undefined || block.value === null ? '' : String(block.value)}
      placeholder={def.placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export function FlagBuilder({
  nodeId,
  tool,
  nodeData,
  snapshot,
  schemas,
  refreshingSchemaPath,
  advancedExpanded,
  onSetAdvancedExpanded,
  onLoadSchema,
  onChange,
}: FlagBuilderProps) {
  const [search, setSearch] = useState('')
  const defs = useMemo(() => getToolFlagDefs(tool.id), [tool.id])
  const groupedDefs = useMemo(() => {
    const term = search.trim().toLowerCase()
    const filtered = defs.filter((def) =>
      !term || def.label.toLowerCase().includes(term) || def.flag.toLowerCase().includes(term),
    )
    return ['Input', 'Model', 'Filters', 'Output', 'Resources', 'Advanced'].map((group) => ({
      group,
      defs: filtered.filter((def) => def.group === group),
    })).filter((entry) => entry.defs.length > 0)
  }, [defs, search])
  const activeBlocks = nodeData.flagBlocks ?? []
  const activeFlagIds = new Set(activeBlocks.map((block) => block.flagId))
  const preview = useMemo(() => buildPreviewCommand(tool, nodeId, snapshot, activeBlocks), [tool, nodeId, snapshot, activeBlocks])
  const presetOptions = getToolPresetOptions(tool.id)

  const applyBlocks = (next: ToolFlagBlock[]) => {
    onChange(next)
  }

  const addFlag = (flagIdValue: string, index?: number) => {
    if (flagIdValue !== CUSTOM_FLAG_ID && activeBlocks.some((block) => block.flagId === flagIdValue)) return
    const block = flagIdValue === CUSTOM_FLAG_ID
      ? createCustomFlagBlock(tool.id)
      : {
          id: `${flagIdValue}_${Math.random().toString(36).slice(2, 10)}`,
          flagId: flagIdValue,
          enabled: true,
          value: getFlagDef(tool.id, flagIdValue)?.kind === 'toggle'
            ? true
            : structuredClone(getFlagDef(tool.id, flagIdValue)?.defaultValue),
        } satisfies ToolFlagBlock
    if (typeof index === 'number') {
      const next = [...activeBlocks]
      next.splice(index, 0, block)
      applyBlocks(next)
      return
    }
    applyBlocks([...activeBlocks, block])
  }

  const handleDrop = (event: React.DragEvent, index: number) => {
    event.preventDefault()
    const raw = event.dataTransfer.getData('application/x-bioflow-flag')
    if (!raw) return
    const payload = JSON.parse(raw) as DragPayload
    if (payload.type === 'palette') {
      addFlag(payload.flagId, index)
      return
    }
    const from = activeBlocks.findIndex((block) => block.id === payload.blockId)
    if (from === -1) return
    const target = from < index ? index - 1 : index
    applyBlocks(moveBlock(activeBlocks, from, target))
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[280px_1fr]">
      <div className="rounded-md border border-border bg-bg-tertiary/30 p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h5 className="text-[10px] font-medium uppercase tracking-wide text-text-muted">Flag Palette</h5>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" className="h-7 px-2 text-[11px]" onClick={() => addFlag(CUSTOM_FLAG_ID)}>
              Custom flag
            </Button>
            {presetOptions.length > 0 && (
              <select
                value=""
                onChange={(event) => {
                  if (!event.target.value) return
                  applyBlocks(buildPresetFlagBlocks(tool.id, event.target.value as Parameters<typeof buildPresetFlagBlocks>[1]))
                  event.target.value = ''
                }}
                className="h-7 rounded-md border border-border bg-bg-tertiary px-2 text-[11px] text-text-primary"
              >
                <option value="">Apply preset…</option>
                {presetOptions.map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.label}</option>
                ))}
              </select>
            )}
          </div>
        </div>
        <Input
          label=""
          value={search}
          placeholder="Search flags"
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="mt-3 flex max-h-[620px] flex-col gap-3 overflow-y-auto">
          {groupedDefs.map(({ group, defs: groupDefs }) => {
            if (group === 'Advanced') {
              return (
                <div key={group} className="rounded-md border border-border bg-bg-secondary/60">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between px-2 py-1.5 text-left text-xs font-medium text-text-secondary hover:bg-bg-hover"
                    onClick={() => onSetAdvancedExpanded(!advancedExpanded)}
                  >
                    <span>{group}</span>
                    <span className="text-[10px] text-text-muted">{groupDefs.length}</span>
                  </button>
                  {advancedExpanded && (
                    <div className="border-t border-border px-2 py-2">
                      <div className="flex flex-col gap-1.5">
                        {groupDefs.map((def) => (
                          <button
                            key={def.id}
                            type="button"
                            draggable
                            onDragStart={(event) => event.dataTransfer.setData('application/x-bioflow-flag', JSON.stringify({ type: 'palette', flagId: def.id } satisfies DragPayload))}
                            onClick={() => addFlag(def.id)}
                            className={classNames(
                              'flex items-center justify-between rounded border px-2 py-1.5 text-left text-xs',
                              activeFlagIds.has(def.id) ? 'border-accent/30 bg-accent/10 text-text-primary' : 'border-border bg-bg-tertiary text-text-secondary',
                            )}
                          >
                            <span className="min-w-0 truncate">{docsChip(def)}</span>
                            <Plus size={12} className="shrink-0" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            }

            return (
              <div key={group}>
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-text-muted">{group}</div>
                <div className="flex flex-col gap-1.5">
                  {groupDefs.map((def) => (
                    <button
                      key={def.id}
                      type="button"
                      draggable
                      onDragStart={(event) => event.dataTransfer.setData('application/x-bioflow-flag', JSON.stringify({ type: 'palette', flagId: def.id } satisfies DragPayload))}
                      onClick={() => addFlag(def.id)}
                      className={classNames(
                        'flex items-center justify-between rounded border px-2 py-1.5 text-left text-xs',
                        activeFlagIds.has(def.id) ? 'border-accent/30 bg-accent/10 text-text-primary' : 'border-border bg-bg-tertiary text-text-secondary',
                      )}
                    >
                      <span className="min-w-0 truncate">{docsChip(def)}</span>
                      <Plus size={12} className="shrink-0" />
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="rounded-md border border-border bg-bg-tertiary/30 p-3">
        <h5 className="mb-2 text-[10px] font-medium uppercase tracking-wide text-text-muted">Active Flags</h5>
        <div
          className="mb-2 rounded border border-dashed border-border px-2 py-1.5 text-[11px] text-text-muted"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => handleDrop(event, 0)}
        >
          Drag flags here from the palette, or reorder the active list.
        </div>
        <div className="flex flex-col gap-2">
          {activeBlocks.map((block, index) => {
            const def = getFlagDef(tool.id, block.flagId)
            if (!def) return null
            const isInvalid = block.enabled && (
              (def.requiredValue && !blockHasValue(block.value))
              || (block.flagId === CUSTOM_FLAG_ID && (
                !block.customFlag?.trim()
                || (block.customInputKind === 'file' && !blockHasValue(block.value))
              ))
            )
            return (
              <div
                key={block.id}
                draggable
                onDragStart={(event) => event.dataTransfer.setData('application/x-bioflow-flag', JSON.stringify({ type: 'active', blockId: block.id } satisfies DragPayload))}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => handleDrop(event, index)}
                className={classNames(
                  'rounded-md border p-2',
                  isInvalid ? 'border-error/40 bg-error/5' : 'border-border bg-bg-secondary',
                )}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <GripVertical size={14} className="shrink-0 text-text-muted" />
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-text-primary">{blockLabel(tool.id, block)}</div>
                      <div className="text-[10px] font-mono text-text-muted">{blockFlag(tool.id, block) || def.flag}</div>
                      </div>
                    </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => index > 0 && applyBlocks(moveBlock(activeBlocks, index, index - 1))}
                      className="rounded border border-border bg-bg-tertiary p-1 text-text-muted hover:text-text-primary"
                      title="Move up"
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => index < activeBlocks.length - 1 && applyBlocks(moveBlock(activeBlocks, index, index + 1))}
                      className="rounded border border-border bg-bg-tertiary p-1 text-text-muted hover:text-text-primary"
                      title="Move down"
                    >
                      <ArrowDown size={12} />
                    </button>
                    <label className="flex items-center gap-1 rounded border border-border bg-bg-tertiary px-2 py-1 text-[10px] text-text-secondary">
                      <input
                        type="checkbox"
                        checked={block.enabled}
                        onChange={(event) => applyBlocks(updateBlock(
                          activeBlocks,
                          block.id,
                          def.kind === 'toggle' && event.target.checked
                            ? { enabled: true, value: true }
                            : { enabled: event.target.checked },
                        ))}
                        className="accent-accent"
                      />
                      Enabled
                    </label>
                    <button
                      type="button"
                      onClick={() => applyBlocks(activeBlocks.filter((entry) => entry.id !== block.id))}
                      className="rounded border border-border bg-bg-tertiary p-1 text-text-muted hover:text-text-primary"
                      title="Remove block"
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>
                {block.enabled && (
                  <div className="flex flex-col gap-2">
                    <BlockControl
                      nodeId={nodeId}
                      snapshot={snapshot}
                      block={block}
                      def={def}
                      schemas={schemas}
                      refreshingSchemaPath={refreshingSchemaPath}
                      onLoadSchema={onLoadSchema}
                      onChange={(value) => {
                        if (block.flagId === CUSTOM_FLAG_ID && value && typeof value === 'object') {
                          const patch = value as { value?: unknown; flag?: string; label?: string; inputKind?: 'text' | 'file' }
                          applyBlocks(updateBlock(activeBlocks, block.id, {
                            value: patch.value ?? '',
                            customFlag: patch.flag ?? '',
                            customLabel: patch.label ?? '',
                            customInputKind: patch.inputKind ?? block.customInputKind ?? 'text',
                          }))
                          return
                        }
                        if (def.kind === 'toggle' && typeof value === 'boolean') {
                          applyBlocks(updateBlock(activeBlocks, block.id, { enabled: value }))
                          return
                        }
                        applyBlocks(updateBlock(activeBlocks, block.id, { value }))
                      }}
                    />
                    {isInvalid && (
                      <div className="text-[10px] text-error">
                        {block.flagId === CUSTOM_FLAG_ID
                          ? block.customInputKind === 'file' && !blockHasValue(block.value)
                            ? 'Choose a file path and enter the exact flag name before Run can proceed.'
                            : 'Enter the exact flag name before Run can proceed.'
                          : 'This flag needs a value before Run can proceed.'}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          <div
            className="rounded border border-dashed border-border px-2 py-1.5 text-[11px] text-text-muted"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => handleDrop(event, activeBlocks.length)}
          >
            Drop here to append
          </div>
          {activeBlocks.length === 0 && (
            <div className="rounded border border-border bg-bg-secondary px-3 py-2 text-xs text-text-muted">
              No flags selected yet. Add one from the palette, apply a preset, or use Custom flag for anything BioFlow does not expose yet.
            </div>
          )}
        </div>

        <div className="mt-4">
          <h5 className="mb-2 text-[10px] font-medium uppercase tracking-wide text-text-muted">Command Preview</h5>
          <pre className="overflow-x-auto rounded-md border border-border bg-[#0e1320] px-3 py-2 text-[11px] leading-relaxed text-slate-100">
            <code>{preview}</code>
          </pre>
        </div>
      </div>
    </div>
  )
}
