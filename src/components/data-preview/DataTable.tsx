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

interface DataTableProps {
  headers: string[]
  rows: string[][]
}

const columnHelper = createColumnHelper<string[]>()

export function DataTable({ headers, rows }: DataTableProps) {
  const parentRef = useRef<HTMLDivElement>(null)

  const columns = useMemo<ColumnDef<string[], string>[]>(
    () =>
      headers.map((header, index) =>
        columnHelper.accessor((row) => row[index], {
          id: header,
          header: () => {
            const summary = getColumnSummary(rows, index)
            return (
              <Tooltip
                content={<ColumnSummary summary={summary} columnName={header} />}
                side="bottom"
                delay={200}
              >
                <span className="cursor-pointer select-none truncate block">
                  {header}
                </span>
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
    [headers, rows],
  )

  const table = useReactTable({
    data: rows,
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
        <span className="text-text-muted text-xs">Showing {rows.length} rows</span>
      </div>
    </div>
  )
}
