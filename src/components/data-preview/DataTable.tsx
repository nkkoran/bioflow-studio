import { useEffect, useMemo, useRef } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
  type ColumnDef,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { getColumnSummary } from './DelimiterDetector'
import { ColumnSummary } from './ColumnSummary'
import { Tooltip } from '@/components/ui/Tooltip'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import type { TransformFilterOp, TransformFilterRule } from '@/types/pipeline'

interface DataTableProps {
  filePath: string
  headers: string[]
  rows: string[][]
}

const columnHelper = createColumnHelper<string[]>()
const EMPTY_FILTERS: TransformFilterRule[] = []

export function DataTable({ filePath, headers, rows }: DataTableProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const visibleColumns = useDataPreviewStore((s) => s.visibleColumns[filePath])
  const setVisibleColumns = useDataPreviewStore((s) => s.setVisibleColumns)
  const filters = useDataPreviewStore((s) => s.filters[filePath] ?? EMPTY_FILTERS)
  const setFilters = useDataPreviewStore((s) => s.setFilters)
  const sort = useDataPreviewStore((s) => s.sort[filePath])
  const setSort = useDataPreviewStore((s) => s.setSort)
  const scrollOffset = useDataPreviewStore((s) => s.scrollOffset[filePath] ?? 0)
  const setScrollOffset = useDataPreviewStore((s) => s.setScrollOffset)

  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    el.scrollTop = scrollOffset
  // Restore when switching files; live scroll updates should not yank the view.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, rows.length])

  const visible = visibleColumns ?? headers
  const visibleIndexes = useMemo(
    () => headers.map((header, index) => ({ header, index })).filter(({ header }) => visible.includes(header)),
    [headers, visible],
  )
  const filteredRows = useMemo(() => {
    let next = filters.length > 0
      ? rows.filter((row) => filters.every((rule) => rowMatchesRule(row, headers, rule)))
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

  const columns = useMemo<ColumnDef<string[], string>[]>(
    () =>
      visibleIndexes.map(({ header, index }) =>
        columnHelper.accessor((row) => row[index], {
          id: header,
          header: () => {
            const summary = getColumnSummary(filteredRows, index)
            const activeSort = sort?.column === header ? sort.dir : null
            return (
              <Tooltip
                content={<ColumnSummary summary={summary} columnName={header} />}
                side="bottom"
                delay={200}
              >
                <button
                  className="cursor-pointer select-none truncate block text-left hover:text-accent"
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
    [filePath, filteredRows, setSort, sort, visibleIndexes],
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
    overscan: 20,
  })

  return (
    <div className="flex flex-col h-full w-full">
      <div className="shrink-0 border-b border-border bg-bg-secondary px-3 py-2 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-text-muted">Rows</div>
            <div className="text-xs text-text-secondary">Filter by a specific column instead of searching every visible cell.</div>
          </div>
          <button
            onClick={() => setFilters(filePath, [...filters, newFilter(headers[0] ?? '', headers, rows)])}
            className="h-7 px-2 rounded-md border border-accent/40 bg-accent/10 text-[11px] text-accent hover:bg-accent/15"
          >
            Add filter
          </button>
        </div>

        {filters.length > 0 ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-text-muted">
                {filters.length} active filter{filters.length === 1 ? '' : 's'}
              </span>
              <button
                onClick={() => setFilters(filePath, [])}
                className="text-[10px] text-text-muted hover:text-error"
              >
                Clear all filters
              </button>
            </div>
            {filters.map((rule) => (
              <FilterRuleRow
                key={rule.id}
                headers={headers}
                rows={rows}
                rule={rule}
                onChange={(next) => setFilters(filePath, filters.map((r) => r.id === rule.id ? next : r))}
                onRemove={() => setFilters(filePath, filters.filter((r) => r.id !== rule.id))}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-border bg-bg-primary/60 px-2 py-1.5 text-[11px] text-text-muted">
            No filters active. Add one like <span className="font-mono text-text-secondary">age &gt; 50</span> or <span className="font-mono text-text-secondary">phenotype contains case</span>.
          </div>
        )}

        <div className="border-t border-border-light pt-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="text-[10px] uppercase tracking-wide text-text-muted">Columns shown</div>
            <div className="flex items-center gap-2 text-[10px]">
              <button className="text-accent hover:underline" onClick={() => setVisibleColumns(filePath, headers)}>All</button>
              <button
                className="text-text-muted hover:text-text-primary"
                onClick={() => setVisibleColumns(filePath, headers.slice(0, 8))}
              >
                First 8
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto">
            {headers.map((header) => {
              const checked = visible.includes(header)
              return (
                <button
                  key={header}
                  onClick={() => {
                    const next = checked
                      ? visible.filter((column) => column !== header)
                      : [...visible, header]
                    setVisibleColumns(filePath, next.length > 0 ? next : [header])
                  }}
                  className={`px-1.5 py-0.5 rounded border text-[10px] ${
                    checked
                      ? 'border-accent/40 bg-accent/10 text-text-primary'
                      : 'border-border bg-bg-primary text-text-muted'
                  }`}
                >
                  {checked ? '✓ ' : ''}{header}
                </button>
              )
            })}
          </div>
        </div>
      </div>
      <div
        ref={parentRef}
        className="flex-1 overflow-auto"
        onScroll={(e) => setScrollOffset(filePath, e.currentTarget.scrollTop)}
      >
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-bg-tertiary">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="px-3 py-1.5 font-mono text-xs font-medium text-text-secondary border-b border-border"
                    style={{ maxWidth: header.column.columnDef.maxSize }}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
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
                  className={`hover:bg-bg-hover border-b border-border/50 ${
                    isEven ? 'bg-bg-primary' : 'bg-bg-secondary'
                  }`}
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
                    height:
                      virtualizer.getTotalSize() -
                      (virtualizer.getVirtualItems().at(-1)?.end ?? 0),
                    padding: 0,
                  }}
                />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="shrink-0 px-3 py-1.5 border-t border-border bg-bg-secondary">
        <span className="text-text-muted text-xs">
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
    op: inferDefaultFilterOp(column, headers, rows),
    value: '',
  }
}

function FilterRuleRow({
  headers,
  rows,
  rule,
  onChange,
  onRemove,
}: {
  headers: string[]
  rows: string[][]
  rule: TransformFilterRule
  onChange: (rule: TransformFilterRule) => void
  onRemove: () => void
}) {
  const op = FILTER_OPS.find((candidate) => candidate.value === rule.op) ?? FILTER_OPS[0]
  const active = rule.column && (op.needsValue === false || String(rule.value ?? '').trim() !== '')
  return (
    <div className={`flex items-center gap-1 rounded-md border px-1 py-1 ${
      active ? 'border-accent/40 bg-accent/10' : 'border-border bg-bg-primary/40'
    }`}>
      <select
        value={rule.column}
        onChange={(e) => {
          const column = e.target.value
          const opShouldFollowColumn = rule.op === 'contains' || rule.op === 'equals'
          onChange({
            ...rule,
            column,
            op: opShouldFollowColumn ? inferDefaultFilterOp(column, headers, rows) : rule.op,
          })
        }}
        className="h-7 min-w-0 flex-[1.2] rounded-md border border-border bg-bg-tertiary px-2 text-xs text-text-primary outline-none focus:ring-1 focus:ring-accent"
      >
        {headers.map((header) => <option key={header} value={header}>{header}</option>)}
      </select>
      <select
        value={rule.op}
        onChange={(e) => {
          const nextOp = e.target.value as TransformFilterOp
          const nextMeta = FILTER_OPS.find((candidate) => candidate.value === nextOp)
          onChange({ ...rule, op: nextOp, value: nextMeta?.needsValue === false ? undefined : (rule.value ?? '') })
        }}
        className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg-tertiary px-2 text-xs text-text-primary outline-none focus:ring-1 focus:ring-accent"
      >
        {FILTER_OPS.map((candidate) => <option key={candidate.value} value={candidate.value}>{candidate.label}</option>)}
      </select>
      {op.needsValue && (
        <input
          value={rule.value ?? ''}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
          placeholder="value"
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg-tertiary px-2 text-xs text-text-primary placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent"
        />
      )}
      <button
        onClick={onRemove}
        className="h-7 px-2 rounded-md text-[11px] text-text-muted hover:bg-error/10 hover:text-error"
      >
        Remove
      </button>
    </div>
  )
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
