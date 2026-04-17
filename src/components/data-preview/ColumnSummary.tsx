import type { getColumnSummary } from './DelimiterDetector'

interface ColumnSummaryProps {
  summary: ReturnType<typeof getColumnSummary>
  columnName: string
}

export function ColumnSummary({ summary, columnName }: ColumnSummaryProps) {
  return (
    <div className="space-y-1 p-1 min-w-[160px]">
      <div className="font-mono text-xs font-medium text-text-primary">{columnName}</div>
      <div className="border-t border-border my-1" />
      <Row label="Type" value={summary.type} />
      <Row label="Non-null" value={`${summary.nonNull} / ${summary.total}`} />
      <Row label="Unique" value={String(summary.unique)} />
      {summary.type === 'numeric' && (
        <>
          <Row label="Min" value={summary.min?.toFixed(4) ?? '-'} />
          <Row label="Max" value={summary.max?.toFixed(4) ?? '-'} />
          <Row label="Mean" value={summary.mean?.toFixed(4) ?? '-'} />
        </>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <span className="text-text-muted">{label}</span>
      <span className="text-text-primary font-mono">{value}</span>
    </div>
  )
}
