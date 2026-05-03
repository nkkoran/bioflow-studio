import { useEffect, useMemo, useRef, useState } from 'react'
import { Columns3, Download, Filter, Maximize2, Plus, Search, Trash2, X } from 'lucide-react'

import { Tooltip } from '@/components/ui/Tooltip'
import { MenuSelect, type MenuSelectOption } from '@/components/ui/MenuSelect'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import type { TransformFilterOp, TransformFilterRule } from '@/types/pipeline'
import { classNames } from '@/lib/utils'

interface DataTableProps {
  filePath: string
  headers: string[]
  rows: string[][]
  onAddFilteredToPipeline?: () => void
  onExportFilteredFile?: (filteredRows: string[][]) => void
  onExpandPanel?: () => void
}

type SortState = { column: string; dir: 'asc' | 'desc' } | undefined
type ColumnKind = 'str' | 'int' | 'float' | 'bool'

const DEFAULT_VISIBLE_COLUMNS = 24
const DEFAULT_COLUMN_WIDTH = 150
const PAGE_SIZE_OPTIONS = [50, 100, 500]
const EMPTY_FILTERS: TransformFilterRule[] = []
const JOIN_OPTIONS: Array<MenuSelectOption<'and' | 'or'>> = [
  { value: 'and', label: 'AND' },
  { value: 'or', label: 'OR' },
]
const FILTER_OPS: Array<MenuSelectOption<TransformFilterOp> & { needsValue: boolean }> = [
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

export function DataTable({ filePath, headers, rows, onAddFilteredToPipeline, onExportFilteredFile, onExpandPanel }: DataTableProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const resizeRef = useRef<{ column: string; startX: number; startWidth: number } | null>(null)
  const visibleColumns = useDataPreviewStore((s) => s.visibleColumns[filePath])
  const setVisibleColumns = useDataPreviewStore((s) => s.setVisibleColumns)
  const filters = useDataPreviewStore((s) => s.filters[filePath] ?? EMPTY_FILTERS)
  const draftFilters = useDataPreviewStore((s) => s.draftFilters[filePath] ?? filters)
  const setFilters = useDataPreviewStore((s) => s.setFilters)
  const setDraftFilters = useDataPreviewStore((s) => s.setDraftFilters)
  const resetDraftFilters = useDataPreviewStore((s) => s.resetDraftFilters)
  const sort = useDataPreviewStore((s) => s.sort[filePath])
  const setSort = useDataPreviewStore((s) => s.setSort)
  const setScrollOffset = useDataPreviewStore((s) => s.setScrollOffset)
  const [query, setQuery] = useState('')
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [selectedRow, setSelectedRow] = useState<number | null>(null)
  const [rowsPerPage, setRowsPerPage] = useState(100)
  const [page, setPage] = useState(0)
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({})
  const [dragColumn, setDragColumn] = useState<string | null>(null)

  const defaultVisible = useMemo(
    () => headers.length > DEFAULT_VISIBLE_COLUMNS ? headers.slice(0, DEFAULT_VISIBLE_COLUMNS) : headers,
    [headers],
  )
  const visible = visibleColumns && visibleColumns.length > 0 ? visibleColumns : defaultVisible
  const visibleIndexes = useMemo(
    () => visible
      .map((header) => ({ header, index: headers.indexOf(header) }))
      .filter((entry) => entry.index >= 0),
    [headers, visible],
  )

  const columnKinds = useMemo(() => {
    const sample = rows.slice(0, 200)
    return new Map(headers.map((header, index) => [header, inferColumnKind(sample.map((row) => row[index] ?? ''))]))
  }, [headers, rows])

  const activeFilters = useMemo(() => getUsableFilterRules(filters, headers), [filters, headers])
  const usableDraftFilters = useMemo(() => getUsableFilterRules(draftFilters, headers), [draftFilters, headers])
  const sortedRows = useMemo(() => filterAndSortRows(rows, headers, filters, sort), [filters, headers, rows, sort])
  const searchedRows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return sortedRows
    return sortedRows.filter((row) => row.some((value) => String(value ?? '').toLowerCase().includes(needle)))
  }, [query, sortedRows])

  const pageCount = Math.max(1, Math.ceil(searchedRows.length / rowsPerPage))
  const currentPage = Math.min(page, pageCount - 1)
  const pageRows = useMemo(() => {
    const start = currentPage * rowsPerPage
    return searchedRows.slice(start, start + rowsPerPage)
  }, [currentPage, rowsPerPage, searchedRows])
  const rangeStart = searchedRows.length === 0 ? 0 : currentPage * rowsPerPage + 1
  const rangeEnd = currentPage * rowsPerPage + pageRows.length

  const filterSignature = useMemo(() => JSON.stringify(activeFilters), [activeFilters])

  useEffect(() => {
    setPage(0)
    setSelectedRow(null)
  }, [filterSignature, query, rowsPerPage, sort?.column, sort?.dir])

  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    el.scrollTop = useDataPreviewStore.getState().scrollOffset[filePath] ?? 0
  }, [filePath, rows.length])

  useEffect(() => {
    function onMove(event: PointerEvent) {
      const resize = resizeRef.current
      if (!resize) return
      const nextWidth = Math.max(72, resize.startWidth + event.clientX - resize.startX)
      setColumnWidths((current) => ({ ...current, [resize.column]: nextWidth }))
    }
    function onUp() {
      resizeRef.current = null
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
  }, [])

  const cycleSort = (header: string) => {
    const next: SortState = sort?.column !== header
      ? { column: header, dir: 'asc' }
      : sort.dir === 'asc'
        ? { column: header, dir: 'desc' }
        : undefined
    setSort(filePath, next)
  }

  const toggleColumn = (header: string) => {
    const next = visible.includes(header)
      ? visible.filter((column) => column !== header)
      : [...visible, header]
    setVisibleColumns(filePath, next.length > 0 ? next : [header])
  }

  const autoFitColumn = (header: string) => {
    const index = headers.indexOf(header)
    const sample = rows.slice(0, 120).map((row) => row[index] ?? '')
    const maxLength = Math.max(header.length, ...sample.map((value) => String(value).length))
    setColumnWidths((current) => ({ ...current, [header]: Math.min(320, Math.max(96, maxLength * 8 + 28)) }))
  }

  const moveVisibleColumn = (source: string, target: string) => {
    if (source === target) return
    const next = [...visible]
    const from = next.indexOf(source)
    const to = next.indexOf(target)
    if (from < 0 || to < 0) return
    next.splice(from, 1)
    next.splice(to, 0, source)
    setVisibleColumns(filePath, next)
  }

  const updateDraftFilter = (ruleId: string, patch: Partial<TransformFilterRule>) => {
    setDraftFilters(filePath, draftFilters.map((rule) => rule.id === ruleId ? { ...rule, ...patch } : rule))
  }

  const addFilter = () => {
    setDraftFilters(filePath, [
      ...draftFilters,
      {
        id: `filter-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        column: headers[0] ?? '',
        join: 'and',
        op: 'contains',
        value: '',
      },
    ])
    setFiltersOpen(true)
  }

  const cancelFilterEdits = () => {
    resetDraftFilters(filePath)
    setFiltersOpen(false)
  }

  const applyFilterEdits = () => {
    if (draftFilters.some((rule) => getFilterRuleIssue(rule, headers))) return
    setFilters(filePath, usableDraftFilters)
    setFiltersOpen(false)
  }

  const toggleFiltersOpen = () => {
    if (filtersOpen) {
      cancelFilterEdits()
      return
    }
    resetDraftFilters(filePath)
    setFiltersOpen(true)
  }

  const clearDraftFilters = () => {
    setDraftFilters(filePath, [])
  }

  const removeDraftFilter = (ruleId: string) => {
    setDraftFilters(filePath, draftFilters.filter((candidate) => candidate.id !== ruleId))
  }

  const filterIssues = useMemo(
    () => draftFilters
      .map((rule) => getFilterRuleIssue(rule, headers))
      .filter((issue): issue is string => Boolean(issue)),
    [draftFilters, headers],
  )
  const hasInvalidDraftFilters = filterIssues.length > 0

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-bg-primary">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 bg-bg-secondary/80 px-3 py-1">
        <div className="min-w-0 flex flex-1 items-center gap-2">
          <span className="text-nowrap text-xs text-text-muted">{basename(filePath)}</span>
          <span className="bioflow-badge text-nowrap rounded bg-bg-tertiary px-1.5 py-0.5 text-xs text-text-muted">
            {rows.length} x {headers.length}
          </span>
          {activeFilters.length > 0 && (
            <button type="button" onClick={onAddFilteredToPipeline} className="interactive-row h-7 px-2 text-xs text-accent">
              Add filtered to canvas
            </button>
          )}
        </div>
        <div className="bioflow-field flex h-7 min-w-[8rem] flex-[1_1_13rem] max-w-[18rem] items-center gap-1.5 rounded-md px-2">
          <Search size={13} className="shrink-0 text-text-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search rows"
            className="min-w-0 flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-muted outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="interactive-button flex h-5 w-5 shrink-0 items-center justify-center text-text-muted hover:text-text-primary"
              aria-label="Clear row search"
              title="Clear row search"
            >
              <X size={12} />
            </button>
          )}
        </div>
        {query && <span className="bioflow-badge rounded bg-accent/10 px-1.5 py-0.5 text-xs text-accent">{searchedRows.length} of {rows.length}</span>}
        <div className="relative">
          <button
            type="button"
            onClick={toggleFiltersOpen}
            className={classNames(
              'interactive-row flex h-7 items-center gap-1.5 px-2 text-xs',
              activeFilters.length > 0 ? 'bg-accent/10 text-accent' : 'text-text-muted hover:text-text-primary',
            )}
            title="Filter rows"
          >
            <Filter size={13} />
            <span className="text-nowrap">Filters</span>
            {activeFilters.length > 0 && <span className="bioflow-badge rounded bg-accent/15 px-1 text-xs">{activeFilters.length}</span>}
          </button>
          {filtersOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={cancelFilterEdits} />
              <div className="surface-popover absolute right-0 top-full z-50 mt-1 flex w-[min(36rem,calc(100vw-var(--space-8)))] max-w-[36rem] flex-col gap-2 rounded-lg p-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-text-muted">Row filters</div>
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={addFilter} className="interactive-row flex h-7 items-center gap-1 px-2 text-xs text-accent">
                      <Plus size={12} />
                      Add
                    </button>
                    {draftFilters.length > 0 && (
                      <button type="button" onClick={clearDraftFilters} className="interactive-row h-7 px-2 text-xs text-text-muted">
                        Clear
                      </button>
                    )}
                  </div>
                </div>
                {draftFilters.length === 0 ? (
                  <div className="rounded-md bg-bg-tertiary/60 px-3 py-3 text-xs text-text-muted">
                    No row filters. Add a rule to keep only matching rows in this preview.
                  </div>
                ) : (
                  <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
                    {draftFilters.map((rule, index) => {
                      const op = FILTER_OPS.find((candidate) => candidate.value === rule.op) ?? FILTER_OPS[0]
                      const issue = getFilterRuleIssue(rule, headers)
                      return (
                        <div
                          key={rule.id}
                          className={classNames(
                            'grid grid-cols-[4.25rem_minmax(0,1fr)_minmax(7rem,0.8fr)_minmax(0,1fr)_1.75rem] items-center gap-1.5 rounded-md p-1',
                            issue ? 'bg-warning/10' : 'bg-bg-primary/30',
                          )}
                        >
                          {index === 0 ? (
                            <div className="px-1 text-[11px] font-medium uppercase tracking-wide text-text-muted">Where</div>
                          ) : (
                            <MenuSelect<'and' | 'or'>
                              value={rule.join ?? 'and'}
                              options={JOIN_OPTIONS}
                              onChange={(value) => updateDraftFilter(rule.id, { join: value === 'or' ? 'or' : 'and' })}
                              placeholder="AND"
                              menuClassName="w-20"
                            />
                          )}
                          <MenuSelect
                            value={rule.column}
                            options={headers.map((header) => ({ value: header, label: header }))}
                            onChange={(value) => updateDraftFilter(rule.id, { column: value })}
                            placeholder="Column"
                            menuClassName="w-56"
                          />
                          <MenuSelect<TransformFilterOp>
                            value={rule.op}
                            options={FILTER_OPS}
                            onChange={(value) => {
                              const nextOp = (value || 'contains') as TransformFilterOp
                              const nextMeta = FILTER_OPS.find((candidate) => candidate.value === nextOp)
                              updateDraftFilter(rule.id, { op: nextOp, value: nextMeta?.needsValue === false ? undefined : (rule.value ?? '') })
                            }}
                            placeholder="Operator"
                            menuClassName="w-44"
                          />
                          {op.needsValue ? (
                            <input
                              value={rule.value ?? ''}
                              placeholder="value"
                              onChange={(event) => updateDraftFilter(rule.id, { value: event.target.value })}
                              className="bioflow-field h-7 min-w-0 rounded-md px-2 text-xs text-text-primary outline-none"
                            />
                          ) : (
                            <div className="text-nowrap px-2 text-xs text-text-muted">no value</div>
                          )}
                          <button
                            type="button"
                            onClick={() => removeDraftFilter(rule.id)}
                            className="interactive-button flex h-7 w-7 items-center justify-center text-text-muted hover:text-error"
                            aria-label="Remove filter"
                          >
                            <Trash2 size={12} />
                          </button>
                          {issue && <div className="col-span-full px-1 text-[11px] text-warning">{issue}</div>}
                        </div>
                      )
                    })}
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 border-t border-border-subtle pt-2">
                  <div className="min-w-0 text-[11px] text-text-muted">
                    {hasInvalidDraftFilters ? filterIssues[0] : `${usableDraftFilters.length} rule${usableDraftFilters.length === 1 ? '' : 's'} ready`}
                  </div>
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={cancelFilterEdits} className="interactive-row h-7 px-2 text-xs text-text-muted">
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={applyFilterEdits}
                      disabled={hasInvalidDraftFilters}
                      className="interactive-row h-7 px-2 text-xs text-accent disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Apply
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="relative">
          <button type="button" onClick={() => setColumnsOpen((open) => !open)} className="interactive-button flex h-7 w-7 items-center justify-center text-text-muted hover:text-text-primary" title="Column visibility">
            <Columns3 size={14} />
          </button>
          {columnsOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setColumnsOpen(false)} />
              <div className="surface-popover absolute right-0 top-full z-50 mt-1 flex max-h-80 w-64 flex-col rounded-lg p-2">
                <div className="mb-2 flex items-center gap-2 text-xs">
                  <button type="button" className="interactive-row h-7 px-2 text-accent" onClick={() => setVisibleColumns(filePath, headers)}>Show all</button>
                  <button type="button" className="interactive-row h-7 px-2 text-text-muted" onClick={() => setVisibleColumns(filePath, defaultVisible)}>Default</button>
                  <button type="button" className="interactive-row h-7 px-2 text-text-muted" onClick={() => setVisibleColumns(filePath, [headers[0]].filter(Boolean))}>First</button>
                </div>
                <div className="scroll-region flex flex-col gap-1">
                  {headers.map((header) => (
                    <label
                      key={header}
                      draggable={visible.includes(header)}
                      onDragStart={() => setDragColumn(header)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={() => {
                        if (dragColumn) moveVisibleColumn(dragColumn, header)
                        setDragColumn(null)
                      }}
                      className="interactive-row flex h-7 items-center gap-2 px-2 text-xs text-text-secondary"
                    >
                      <input type="checkbox" checked={visible.includes(header)} onChange={() => toggleColumn(header)} className="h-3 w-3 accent-accent" />
                      <span className="text-nowrap min-w-0 flex-1">{header}</span>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={() => onExportFilteredFile?.(searchedRows)}
          disabled={searchedRows.length === 0}
          className="interactive-button flex h-7 w-7 items-center justify-center text-text-muted hover:text-text-primary disabled:opacity-40"
          title="Export filtered and searched rows as CSV"
        >
          <Download size={14} />
        </button>
        <button
          type="button"
          onClick={onExpandPanel}
          className="interactive-button flex h-7 w-7 items-center justify-center text-text-muted hover:text-text-primary"
          title="Expand to full panel"
        >
          <Maximize2 size={14} />
        </button>
      </div>

      <div
        ref={parentRef}
        className="scroll-region overflow-auto"
        onScroll={(event) => setScrollOffset(filePath, event.currentTarget.scrollTop)}
      >
        <table className="min-w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 bg-bg-tertiary shadow-sm">
            <tr>
              {visibleIndexes.map(({ header }) => {
                const activeSort = sort?.column === header ? sort.dir : null
                const width = columnWidths[header] ?? DEFAULT_COLUMN_WIDTH
                return (
                  <th key={header} className="group relative h-8 px-2 font-semibold text-text-primary" style={{ width, minWidth: width }}>
                    <button type="button" onClick={() => cycleSort(header)} className="flex w-full items-center gap-1 text-left">
                      <span className="text-nowrap min-w-0 flex-1">{header}</span>
                      <span className={classNames('text-text-muted opacity-0 group-hover:opacity-100', activeSort && 'opacity-100 text-accent')}>
                        {activeSort === 'asc' ? '↑' : activeSort === 'desc' ? '↓' : '↕'}
                      </span>
                      <span className="bioflow-badge rounded bg-bg-primary px-1 text-xs text-text-muted opacity-0 group-hover:opacity-100">
                        {columnKinds.get(header) ?? 'str'}
                      </span>
                    </button>
                    <span
                      role="separator"
                      aria-orientation="vertical"
                      className="absolute right-0 top-1 h-6 w-1 cursor-col-resize"
                      onPointerDown={(event) => {
                        resizeRef.current = { column: header, startX: event.clientX, startWidth: width }
                      }}
                      onDoubleClick={() => autoFitColumn(header)}
                    />
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, rowIndex) => {
              const absoluteIndex = currentPage * rowsPerPage + rowIndex
              const selected = selectedRow === absoluteIndex
              return (
                <tr
                  key={`${absoluteIndex}-${row.join('\u0001')}`}
                  onClick={() => setSelectedRow((current) => current === absoluteIndex ? null : absoluteIndex)}
                  className={classNames(
                    'h-7 cursor-pointer',
                    rowIndex % 2 === 0 ? 'bg-bg-primary' : 'bg-bg-secondary',
                    selected && 'border-l-2 border-accent bg-bg-tertiary',
                  )}
                >
                  {visibleIndexes.map(({ header, index }) => {
                    const value = row[index] ?? ''
                    const kind = columnKinds.get(header) ?? 'str'
                    const missing = value === '' || value.toLowerCase?.() === 'null' || value.toLowerCase?.() === 'na'
                    return (
                      <td
                        key={header}
                        className={classNames(
                          'text-nowrap px-2 py-1 text-text-primary',
                          kind === 'int' || kind === 'float' ? 'text-right font-mono tabular-nums' : 'text-left',
                          missing && 'italic text-text-muted',
                        )}
                        style={{ width: columnWidths[header] ?? DEFAULT_COLUMN_WIDTH, maxWidth: columnWidths[header] ?? DEFAULT_COLUMN_WIDTH }}
                      >
                        <Tooltip content={value || 'missing'} delay={500}>
                          <span className="block truncate">{missing ? '—' : <HighlightedValue value={value} query={query} />}</span>
                        </Tooltip>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <footer className="flex min-h-7 shrink-0 flex-wrap items-center gap-2 px-3 py-1 text-xs text-text-muted">
        <span className="text-nowrap min-w-0 flex-1">
          Showing {rangeStart}-{rangeEnd} of {searchedRows.length} rows{query ? ` (${rows.length} total)` : ''}
        </span>
        {searchedRows.length > rowsPerPage && (
          <div className="flex items-center gap-2">
            <button type="button" className="interactive-row h-6 px-2" disabled={currentPage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>← Prev</button>
            <span className="text-nowrap">Page {currentPage + 1} of {pageCount}</span>
            <button type="button" className="interactive-row h-6 px-2" disabled={currentPage >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>Next →</button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <span>Rows per page</span>
          <div className="flex rounded-md bg-bg-tertiary/70 p-0.5 shadow-sm">
            {PAGE_SIZE_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setRowsPerPage(option)}
                className={classNames(
                  'interactive-row h-5 px-1.5 text-xs',
                  rowsPerPage === option ? 'bg-accent/10 text-accent' : 'text-text-muted',
                )}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      </footer>
    </div>
  )
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function HighlightedValue({ value, query }: { value: string; query: string }) {
  const needle = query.trim()
  if (!needle) return <>{value}</>
  const lower = value.toLowerCase()
  const start = lower.indexOf(needle.toLowerCase())
  if (start < 0) return <>{value}</>
  return (
    <>
      {value.slice(0, start)}
      <mark className="rounded bg-accent/20 text-text-primary">{value.slice(start, start + needle.length)}</mark>
      {value.slice(start + needle.length)}
    </>
  )
}

function inferColumnKind(values: string[]): ColumnKind {
  const sample = values.map((value) => String(value ?? '').trim()).filter(Boolean).slice(0, 80)
  if (sample.length === 0) return 'str'
  if (sample.every((value) => /^(true|false|0|1)$/i.test(value))) return 'bool'
  if (sample.every((value) => /^-?\d+$/.test(value))) return 'int'
  if (sample.every((value) => /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value))) return 'float'
  return 'str'
}

export function filterAndSortRows(
  rows: string[][],
  headers: string[],
  filters: TransformFilterRule[],
  sort: SortState,
): string[][] {
  const usableFilters = getUsableFilterRules(filters, headers)
  let next = usableFilters.length > 0 ? rows.filter((row) => rowMatchesFilters(row, headers, usableFilters)) : rows
  if (!sort) return next
  const idx = headers.indexOf(sort.column)
  if (idx < 0) return next
  return [...next].sort((a, b) => {
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

export function rowMatchesFilters(row: string[], headers: string[], rules: TransformFilterRule[]): boolean {
  const usableRules = getUsableFilterRules(rules, headers)
  if (usableRules.length === 0) return true
  return usableRules.reduce<boolean | null>((acc, rule, index) => {
    const idx = headers.indexOf(rule.column)
    const value = idx >= 0 ? row[idx] ?? '' : ''
    const result = matchesRule(value, rule)
    if (index === 0 || acc === null) return result
    return (rule.join ?? 'and') === 'or' ? acc || result : acc && result
  }, null) ?? true
}

function matchesRule(value: string, rule: TransformFilterRule): boolean {
  const rawNeedle = String(rule.value ?? '')
  const numberValue = toFiniteNumber(value)
  const numberNeedle = toFiniteNumber(rawNeedle)
  switch (rule.op) {
    case 'contains':
      return value.toLowerCase().includes(rawNeedle.toLowerCase())
    case 'regex':
      try {
        return new RegExp(rawNeedle, 'i').test(value)
      } catch {
        return false
      }
    case 'equals':
      return value === rawNeedle
    case 'notEquals':
      return value !== rawNeedle
    case 'gt':
      if (numberValue === null || numberNeedle === null) return false
      return numberValue > numberNeedle
    case 'gte':
      if (numberValue === null || numberNeedle === null) return false
      return numberValue >= numberNeedle
    case 'lt':
      if (numberValue === null || numberNeedle === null) return false
      return numberValue < numberNeedle
    case 'lte':
      if (numberValue === null || numberNeedle === null) return false
      return numberValue <= numberNeedle
    case 'notEmpty':
      return value.trim().length > 0
    default:
      return true
  }
}

export function getUsableFilterRules(rules: TransformFilterRule[], headers: string[]): TransformFilterRule[] {
  return rules.filter((rule) => !getFilterRuleIssue(rule, headers))
}

export function getFilterRuleIssue(rule: TransformFilterRule, headers: string[]): string | null {
  if (!rule.column || !headers.includes(rule.column)) return 'Choose a valid column.'
  const op = FILTER_OPS.find((candidate) => candidate.value === rule.op)
  if (!op) return 'Choose a valid operator.'
  if (!op.needsValue) return null
  const rawValue = String(rule.value ?? '')
  if (rawValue.trim().length === 0) return 'Enter a filter value.'
  if (rule.op === 'regex') {
    try {
      new RegExp(rawValue)
    } catch {
      return 'Fix the regular expression before applying.'
    }
  }
  if (isNumericFilterOp(rule.op) && toFiniteNumber(rawValue) === null) return 'Enter a numeric value.'
  return null
}

function isNumericFilterOp(op: TransformFilterOp): boolean {
  return op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte'
}

function toFiniteNumber(value: string): number | null {
  if (String(value ?? '').trim().length === 0) return null
  const next = Number(value)
  return Number.isFinite(next) ? next : null
}
