import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react'

interface AxedEdgeData {
  label?: string
  fanOutIndex?: number
  fanOutTotal?: number
}

export function AxedEdge(props: EdgeProps) {
  const data = props.data as AxedEdgeData | undefined
  const label = typeof data?.label === 'string' ? data.label : ''
  const total = data?.fanOutTotal ?? 1
  const index = data?.fanOutIndex ?? 0
  const curvature = total > 1 ? 0.18 + Math.abs(index - (total - 1) / 2) * 0.04 : 0.25
  const [edgePath, labelX, labelY] = getBezierPath({ ...props, curvature })
  const fanOutLabel = total > 1 ? `${total} outputs` : ''

  return (
    <>
      <BaseEdge id={props.id} path={edgePath} style={props.style} markerEnd={props.markerEnd} />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan rounded border border-accent/40 bg-bg-secondary px-1.5 py-0.5 text-[9px] font-mono text-accent shadow"
            style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
      {!label && fanOutLabel && index === 0 && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan rounded border border-amber-500/30 bg-bg-secondary px-1.5 py-0.5 text-[9px] text-amber-200 shadow"
            style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {fanOutLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
