import { useMemo, useRef } from 'react'
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

interface DataTableProps {
  filePath: string
  headers: string[]
  rows: string[][]
}

const columnHelper = createColumnHelper<string[]>()

export function DataTable({ filePath, headers, rows }: DataTableProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const visibleColumns = useDataPreviewStore((s) => s.visibleColumns[filePath])
  const setVisibleColumns = useDataPreviewStore((s) => s.setVisibleColumns)
  const filter = useDataPreviewStore((s) => s.filters[filePath] ?? '')
  const setFilter = useDataPreviewStore((s) => s.setFilter)
  const sort = useDataPreviewStore((s) => s.sort[filePath])
  const setSort = useDataPreviewStore((s) => s.setSort)

  const visible = visibleColumns ?? headers
  const visibleIndexes = useMemo(
    () => headers.map((header, index) => ({ header, index })).filter(({ header }) => visible.includes(header)),
    [headers, visible],
  )
  const filteredRows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    let next = q
      ? rows.filter((row) => visibleIndexes.some(({ index }) => String(row[index] ?? '').toLowerCase().includes(q)))
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
  }, [filter, headers, rows, sort, visibleIndexes])

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
        <input
          value={filter}
          onChange={(e) => setFilter(filePath, e.target.value)}
          placeholder="Filter visible rows..."
          className="h-7 rounded-md border border-border bg-bg-tertiary px-2 text-xs text-text-primary placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent"
        />
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
      <div ref={parentRef} className="flex-1 overflow-auto">
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
                  colSpan={headers.length}
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
                  colSpan={headers.length}
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
