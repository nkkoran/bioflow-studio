import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
  type ColumnDef,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'

import { Tooltip } from '@/components/ui/Tooltip'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import type { TransformFilterOp, TransformFilterRule } from '@/types/pipeline'
import { getColumnSummary } from './DelimiterDetector'
import { ColumnSummary } from './ColumnSummary'

interface DataTableProps {
  filePath: string
  headers: string[]
  rows: string[][]
  onAddFilteredToPipeline?: () => void
  onExportFilteredFile?: (filteredRows: string[][]) => void
}

const columnHelper = createColumnHelper<string[]>()
const EMPTY_FILTERS: TransformFilterRule[] = []
const DEFAULT_VISIBLE_COLUMNS = 24
const SUMMARY_SAMPLE_ROWS = 400

export function DataTable({ filePath, headers, rows, onAddFilteredToPipeline, onExportFilteredFile }: DataTableProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const visibleColumns = useDataPreviewStore((s) => s.visibleColumns[filePath])
  const setVisibleColumns = useDataPreviewStore((s) => s.setVisibleColumns)
  const filters = useDataPreviewStore((s) => s.filters[filePath] ?? EMPTY_FILTERS)
  const draftFilters = useDataPreviewStore((s) => s.draftFilters[filePath] ?? filters)
  const setDraftFilters = useDataPreviewStore((s) => s.setDraftFilters)
  const applyDraftFilters = useDataPreviewStore((s) => s.applyDraftFilters)
  const resetDraftFilters = useDataPreviewStore((s) => s.resetDraftFilters)
  const sort = useDataPreviewStore((s) => s.sort[filePath])
  const setSort = useDataPreviewStore((s) => s.setSort)
  const setScrollOffset = useDataPreviewStore((s) => s.setScrollOffset)
  const [columnDraft, setColumnDraft] = useState('')
  const [filterExpression, setFilterExpression] = useState('')
  const hasDraftChanges = JSON.stringify(draftFilters) !== JSON.stringify(filters)
  const deferredColumnDraft = useDeferredValue(columnDraft)

  const defaultVisible = useMemo(
    () => headers.length > DEFAULT_VISIBLE_COLUMNS ? headers.slice(0, DEFAULT_VISIBLE_COLUMNS) : headers,
    [headers],
  )
  const visible = visibleColumns && visibleColumns.length > 0 ? visibleColumns : defaultVisible
  const visibleIndexes = useMemo(
    () => headers.map((header, index) => ({ header, index })).filter(({ header }) => visible.includes(header)),
    [headers, visible],
  )

  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    el.scrollTop = useDataPreviewStore.getState().scrollOffset[filePath] ?? 0
    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current)
      }
    }
  }, [filePath, rows.length])

  const filteredRows = useMemo(() => {
    let next = filters.length > 0
      ? rows.filter((row) => rowMatchesFilters(row, headers, filters))
      : rows
    if (sort) {
      const idx = headers.indexOf(sort.column)
      if (idx >= 0) {
        next = [...next].sort((a, b) => {
          const av = a[idx] ?? ''
          const bv = b[idx] ?? ''
          const an = Number(av)
          const bn = Number(bv)
          const cmp = !Number.isNaN(an) && !Number.isNaN(bn)
            ? an - bn
            : av.localeCompare(bv, undefined, { numeric: true })
          return sort.dir === 'asc' ? cmp : -cmp
        })
      }
    }
    return next
  }, [filters, headers, rows, sort])
  const removedRows = rows.length - filteredRows.length

  const summaryRows = useMemo(
    () => filteredRows.length > SUMMARY_SAMPLE_ROWS ? filteredRows.slice(0, SUMMARY_SAMPLE_ROWS) : filteredRows,
    [filteredRows],
  )

  const columnSummaries = useMemo(() => new Map(
    visibleIndexes.map(({ header, index }) => [header, getColumnSummary(summaryRows, index)]),
  ), [summaryRows, visibleIndexes])

  const availableColumns = useMemo(() => {
    const needle = deferredColumnDraft.trim().toLowerCase()
    return headers
      .filter((header) => !visible.includes(header))
      .filter((header) => needle.length === 0 || header.toLowerCase().includes(needle))
      .sort((a, b) => {
        const aStarts = a.toLowerCase().startsWith(needle)
        const bStarts = b.toLowerCase().startsWith(needle)
        if (aStarts !== bStarts) return aStarts ? -1 : 1
        return a.localeCompare(b, undefined, { numeric: true })
      })
      .slice(0, 12)
  }, [deferredColumnDraft, headers, visible])

  const columns = useMemo<ColumnDef<string[], string>[]>(
    () =>
      visibleIndexes.map(({ header, index }) =>
        columnHelper.accessor((row) => row[index], {
          id: header,
          header: () => {
            const summary = columnSummaries.get(header)
            const activeSort = sort?.column === header ? sort.dir : null
            return (
              <Tooltip
                content={summary ? <ColumnSummary summary={summary} columnName={header} /> : header}
                side="bottom"
                delay={200}
              >
                <button
                  className="block cursor-pointer truncate text-left hover:text-accent"
                  onClick={() => {
                    if (!activeSort) setSort(filePath, { column: header, dir: 'asc' })
                    else if (activeSort === 'asc') setSort(filePath, { column: header, dir: 'desc' })
                    else setSort(filePath, undefined)
                  }}
                >
                  {header}{activeSort ? (activeSort === 'asc' ? ' ↑' : ' ↓') : ''}
                </button>
              </Tooltip>
            )
          },
          cell: (info) => (
            <span className="block truncate" title={info.getValue()}>
              {info.getValue()}
            </span>
          ),
          size: 150,
          maxSize: 300,
        }),
      ),
    [columnSummaries, filePath, setSort, sort, visibleIndexes],
  )

  const table = useReactTable({
    data: filteredRows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  const { rows: tableRows } = table.getRowModel()
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 18,
  })

  const addVisibleColumn = (column: string) => {
    if (!column || visible.includes(column)) return
    setVisibleColumns(filePath, [...visible, column])
    setColumnDraft('')
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="shrink-0 border-b border-border bg-bg-secondary px-3 py-2 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-text-muted">Rows</div>
            <div className="text-xs text-text-secondary">Build draft filters, then apply them when the result looks right.</div>
          </div>
          <button
            onClick={() => setDraftFilters(filePath, [...draftFilters, newFilter(headers[0] ?? '', headers, rows)])}
            className="h-7 rounded-md border border-accent/40 bg-accent/10 px-2 text-[11px] text-accent hover:bg-accent/15"
          >
            Add filter
          </button>
        </div>

        <div className="flex items-center gap-2 text-[10px] text-text-muted">
          <button
            onClick={() => applyDraftFilters(filePath)}
            disabled={!hasDraftChanges}
            className="rounded border border-accent/40 bg-accent/10 px-2 py-0.5 text-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            Apply
          </button>
          <button
            onClick={() => resetDraftFilters(filePath)}
            disabled={!hasDraftChanges}
            className="rounded border border-border px-2 py-0.5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Revert draft
          </button>
          <button
            onClick={() => onExportFilteredFile?.(filteredRows)}
            disabled={filteredRows.length === 0}
            className="rounded border border-border px-2 py-0.5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Export as file
          </button>
          <button
            onClick={() => onAddFilteredToPipeline?.()}
            disabled={filters.length === 0}
            className="rounded border border-border px-2 py-0.5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add to pipeline
          </button>
          {hasDraftChanges && <span>Unapplied changes</span>}
        </div>
        <div className="rounded-md border border-border bg-bg-primary/60 px-2 py-1 text-[11px] text-text-muted">
          Rows: {rows.length} original · {removedRows} removed · {filteredRows.length} remaining
        </div>
        <div className="flex items-center gap-2">
          <input
            value={filterExpression}
            onChange={(e) => setFilterExpression(e.target.value)}
            placeholder='R-like filter, e.g. age > 50 & status == "case"'
            className="h-7 flex-1 rounded-md border border-border bg-bg-tertiary px-2 text-xs text-text-primary placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            onClick={() => {
              const parsed = parseFilterExpression(filterExpression, headers)
              if (!parsed) return
              setDraftFilters(filePath, parsed)
            }}
            className="h-7 rounded-md border border-accent/40 bg-accent/10 px-2 text-[11px] text-accent"
          >
            Apply expression
          </button>
        </div>

        {draftFilters.length > 0 ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-text-muted">
                {draftFilters.length} draft filter{draftFilters.length === 1 ? '' : 's'}
              </span>
              <button
                onClick={() => setDraftFilters(filePath, [])}
                className="text-[10px] text-text-muted hover:text-error"
              >
                Clear all filters
              </button>
            </div>
            {draftFilters.map((rule, index) => (
              <FilterRuleRow
                key={rule.id}
                index={index}
                headers={headers}
                rows={rows}
                rule={rule}
                onChange={(next) => setDraftFilters(filePath, draftFilters.map((entry) => entry.id === rule.id ? next : entry))}
                onRemove={() => setDraftFilters(filePath, draftFilters.filter((entry) => entry.id !== rule.id))}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-border bg-bg-primary/60 px-2 py-1.5 text-[11px] text-text-muted">
            No filters active. Try expressions like <span className="font-mono text-text-secondary">age &gt; 50</span>, <span className="font-mono text-text-secondary">status equals case</span>, or combine rows with <span className="font-mono text-text-secondary">AND / OR</span>.
          </div>
        )}

        <div className="border-t border-border-light pt-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-text-muted">Columns shown</div>
              {visibleColumns === undefined && headers.length > DEFAULT_VISIBLE_COLUMNS && (
                <div className="text-[10px] text-text-muted">
                  Showing the first {DEFAULT_VISIBLE_COLUMNS} columns by default for smoother scrolling on wide tables.
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 text-[10px]">
              <button className="text-accent hover:underline" onClick={() => setVisibleColumns(filePath, headers)}>All</button>
              <button
                className="text-text-muted hover:text-text-primary"
                onClick={() => setVisibleColumns(filePath, defaultVisible)}
              >
                First {defaultVisible.length}
              </button>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <ColumnAutocompleteInput
              headers={headers}
              value={columnDraft}
              onChange={setColumnDraft}
              exclude={visible}
              placeholder="Type a column name to add…"
              className="flex-1"
            />
            <button
              onClick={() => addVisibleColumn(
                headers.find((header) => header === columnDraft.trim()) ?? availableColumns[0] ?? '',
              )}
              disabled={availableColumns.length === 0}
              className="h-8 rounded-md border border-border px-2 text-[11px] text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              Add
            </button>
          </div>
          <div className="mt-2 flex max-h-20 flex-wrap gap-1 overflow-y-auto">
            {visible.map((header) => (
              <button
                key={header}
                onClick={() => {
                  const next = visible.filter((column) => column !== header)
                  setVisibleColumns(filePath, next.length > 0 ? next : [header])
                }}
                className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] text-text-primary"
                title={`Hide ${header}`}
              >
                {header} ×
              </button>
            ))}
          </div>
        </div>
      </div>

      <div
        ref={parentRef}
        className="flex-1 overflow-auto"
        onScroll={(event) => {
          const offset = event.currentTarget.scrollTop
          if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
          scrollFrameRef.current = requestAnimationFrame(() => {
            setScrollOffset(filePath, offset)
          })
        }}
      >
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-bg-tertiary">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="border-b border-border px-3 py-1.5 font-mono text-xs font-medium text-text-secondary"
                    style={{ maxWidth: header.column.columnDef.maxSize }}
                  >
                    {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {virtualizer.getVirtualItems().length > 0 && (
              <tr>
                <td
                  colSpan={Math.max(visibleIndexes.length, 1)}
                  style={{ height: virtualizer.getVirtualItems()[0].start, padding: 0 }}
                />
              </tr>
            )}
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = tableRows[virtualRow.index]
              const isEven = virtualRow.index % 2 === 0
              return (
                <tr
                  key={row.id}
                  className={`border-b border-border/50 hover:bg-bg-hover ${isEven ? 'bg-bg-primary' : 'bg-bg-secondary'}`}
                  style={{ height: 28 }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="px-3 py-1 font-mono text-xs text-text-primary"
                      style={{ maxWidth: cell.column.columnDef.maxSize }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              )
            })}
            {virtualizer.getVirtualItems().length > 0 && (
              <tr>
                <td
                  colSpan={Math.max(visibleIndexes.length, 1)}
                  style={{
                    height: virtualizer.getTotalSize() - (virtualizer.getVirtualItems().at(-1)?.end ?? 0),
                    padding: 0,
                  }}
                />
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="shrink-0 border-t border-border bg-bg-secondary px-3 py-1.5">
        <span className="text-xs text-text-muted">
          Showing {filteredRows.length} of {rows.length} rows · {visibleIndexes.length} of {headers.length} columns
        </span>
      </div>
    </div>
  )
}

const FILTER_OPS: Array<{ value: TransformFilterOp; label: string; needsValue: boolean }> = [
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

function newFilter(column: string, headers: string[], rows: string[][]): TransformFilterRule {
  return {
    id: `filter-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    column,
    join: 'and',
    op: inferDefaultFilterOp(column, headers, rows),
    value: '',
  }
}

function FilterRuleRow({
  index,
  headers,
  rows,
  rule,
  onChange,
  onRemove,
}: {
  index: number
  headers: string[]
  rows: string[][]
  rule: TransformFilterRule
  onChange: (rule: TransformFilterRule) => void
  onRemove: () => void
}) {
  const op = FILTER_OPS.find((candidate) => candidate.value === rule.op) ?? FILTER_OPS[0]
  const active = rule.column && (op.needsValue === false || String(rule.value ?? '').trim() !== '')

  return (
    <div className={`flex flex-wrap items-center gap-1 rounded-md border px-1 py-1 ${
      active ? 'border-accent/40 bg-accent/10' : 'border-border bg-bg-primary/40'
    }`}>
      {index > 0 && (
        <select
          value={rule.join ?? 'and'}
          onChange={(e) => onChange({ ...rule, join: e.target.value as 'and' | 'or' })}
          className="h-7 rounded-md border border-border bg-bg-tertiary px-2 text-xs text-text-primary outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="and">AND</option>
          <option value="or">OR</option>
        </select>
      )}
      <ColumnAutocompleteInput
        headers={headers}
        value={rule.column}
        onChange={(column) => {
          const opShouldFollowColumn = rule.op === 'contains' || rule.op === 'equals'
          onChange({
            ...rule,
            column,
            op: opShouldFollowColumn ? inferDefaultFilterOp(column, headers, rows) : rule.op,
          })
        }}
        placeholder="Column name"
        className="min-w-[180px] flex-[1.3]"
      />
      <select
        value={rule.op}
        onChange={(e) => {
          const nextOp = e.target.value as TransformFilterOp
          const nextMeta = FILTER_OPS.find((candidate) => candidate.value === nextOp)
          onChange({ ...rule, op: nextOp, value: nextMeta?.needsValue === false ? undefined : (rule.value ?? '') })
        }}
        className="h-7 min-w-[130px] flex-1 rounded-md border border-border bg-bg-tertiary px-2 text-xs text-text-primary outline-none focus:ring-1 focus:ring-accent"
      >
        {FILTER_OPS.map((candidate) => <option key={candidate.value} value={candidate.value}>{candidate.label}</option>)}
      </select>
      {op.needsValue && (
        <input
          value={rule.value ?? ''}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
          placeholder="Value or regex"
          className="h-7 min-w-[180px] flex-1 rounded-md border border-border bg-bg-tertiary px-2 text-xs text-text-primary placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent"
        />
      )}
      <button
        onClick={onRemove}
        className="h-7 rounded-md px-2 text-[11px] text-text-muted hover:bg-error/10 hover:text-error"
      >
        Remove
      </button>
    </div>
  )
}

function ColumnAutocompleteInput({
  headers,
  value,
  onChange,
  placeholder,
  exclude = [],
  className,
}: {
  headers: string[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  exclude?: string[]
  className?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const deferredValue = useDeferredValue(value)

  const suggestions = useMemo(() => {
    const needle = deferredValue.trim().toLowerCase()
    return headers
      .filter((header) => !exclude.includes(header))
      .filter((header) => needle.length === 0 || header.toLowerCase().includes(needle))
      .sort((a, b) => {
        const aStarts = a.toLowerCase().startsWith(needle)
        const bStarts = b.toLowerCase().startsWith(needle)
        if (aStarts !== bStarts) return aStarts ? -1 : 1
        return a.localeCompare(b, undefined, { numeric: true })
      })
      .slice(0, 8)
  }, [deferredValue, exclude, headers])

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(suggestions.length - 1, 0)))
  }, [suggestions.length])

  const applySuggestion = (column: string) => {
    onChange(column)
    setFocused(false)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  return (
    <div className={`relative ${className ?? ''}`}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => window.setTimeout(() => setFocused(false), 120)}
        onChange={(e) => {
          onChange(e.target.value)
          setActiveIndex(0)
        }}
        onKeyDown={(event) => {
          if (suggestions.length === 0) return
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActiveIndex((current) => Math.min(current + 1, suggestions.length - 1))
            return
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActiveIndex((current) => Math.max(current - 1, 0))
            return
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const suggestion = suggestions[activeIndex] ?? suggestions[0]
            if (!suggestion) return
            event.preventDefault()
            applySuggestion(suggestion)
          }
        }}
        className="h-7 w-full rounded-md border border-border bg-bg-tertiary px-2 text-xs text-text-primary placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent"
      />
      {focused && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-44 overflow-y-auto rounded-md border border-border bg-bg-secondary py-1 shadow-xl">
          {suggestions.map((column, index) => (
            <button
              key={column}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault()
                applySuggestion(column)
              }}
              className={`block w-full truncate px-2 py-1.5 text-left text-xs ${
                index === activeIndex ? 'bg-accent/10 text-text-primary' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              {column}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function rowMatchesFilters(row: string[], headers: string[], rules: TransformFilterRule[]): boolean {
  if (rules.length === 0) return true
  let result = rowMatchesRule(row, headers, rules[0])
  for (const rule of rules.slice(1)) {
    const current = rowMatchesRule(row, headers, rule)
    result = (rule.join ?? 'and') === 'or' ? (result || current) : (result && current)
  }
  return result
}

export function rowMatchesRule(row: string[], headers: string[], rule: TransformFilterRule): boolean {
  const idx = headers.indexOf(rule.column)
  if (idx < 0) return true
  const raw = String(row[idx] ?? '')
  const value = String(rule.value ?? '')
  switch (rule.op) {
    case 'contains':
      return raw.toLowerCase().includes(value.toLowerCase())
    case 'regex':
      try {
        return new RegExp(value, 'i').test(raw)
      } catch {
        return false
      }
    case 'equals':
      return raw === value
    case 'notEquals':
      return raw !== value
    case 'notEmpty':
      return raw.trim() !== ''
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = Number(raw)
      const b = Number(value)
      if (Number.isNaN(a) || Number.isNaN(b)) return false
      if (rule.op === 'gt') return a > b
      if (rule.op === 'gte') return a >= b
      if (rule.op === 'lt') return a < b
      return a <= b
    }
    default:
      return true
  }
}

function inferDefaultFilterOp(column: string, headers: string[], rows: string[][]): TransformFilterOp {
  const idx = headers.indexOf(column)
  if (idx < 0) return 'contains'
  const sample = rows
    .map((row) => row[idx])
    .filter((value) => value !== undefined && value !== '' && value !== 'NA' && value !== '.')
    .slice(0, 40)
  if (sample.length === 0) return 'contains'
  const numeric = sample.filter((value) => !Number.isNaN(Number(value)))
  return numeric.length / sample.length >= 0.8 ? 'equals' : 'contains'
}

function parseFilterExpression(expression: string, headers: string[]): TransformFilterRule[] | null {
  const source = expression.trim()
  if (!source) return null
  const tokens = source.split(/(\&\&|\|\||\&|\|)/).map((item) => item.trim()).filter(Boolean)
  const rules: TransformFilterRule[] = []
  let join: 'and' | 'or' = 'and'
  for (const token of tokens) {
    if (token === '&' || token === '&&') {
      join = 'and'
      continue
    }
    if (token === '|' || token === '||') {
      join = 'or'
      continue
    }
    const match = token.match(/^([A-Za-z0-9_.-]+)\s*(==|!=|>=|<=|>|<|~=)\s*(.+)$/)
    if (!match) continue
    const [, columnRaw, operator, rhsRaw] = match
    const column = headers.find((header) => header === columnRaw) ?? headers.find((header) => header.toLowerCase() === columnRaw.toLowerCase())
    if (!column) continue
    const value = rhsRaw.trim().replace(/^['"]|['"]$/g, '')
    const op: TransformFilterOp =
      operator === '==' ? 'equals'
        : operator === '!=' ? 'notEquals'
          : operator === '>' ? 'gt'
            : operator === '>=' ? 'gte'
              : operator === '<' ? 'lt'
                : operator === '<=' ? 'lte'
                  : 'contains'
    rules.push({
      id: `expr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      column,
      join: rules.length === 0 ? 'and' : join,
      op,
      value,
    })
  }
  return rules.length > 0 ? rules : null
}
