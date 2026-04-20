import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react'

interface AxedEdgeData {
  label?: string
}

export function AxedEdge(props: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath(props)
  const data = props.data as AxedEdgeData | undefined
  const label = typeof data?.label === 'string' ? data.label : ''

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
    </>
  )
}
