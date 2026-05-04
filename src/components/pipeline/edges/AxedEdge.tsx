import {
  BaseEdge,
  EdgeLabelRenderer,
  Position,
  type EdgeProps,
} from '@xyflow/react'

interface AxedEdgeData {
  label?: string
  fanOutIndex?: number
  fanOutTotal?: number
  flowing?: boolean
}

const HANDLE_RADIUS_PX = 6
const HORIZONTAL_HANDLE_Y_NUDGE_PX = -0.5

function calculateControlOffset(distance: number, curvature: number) {
  return distance >= 0 ? 0.5 * distance : 25 * curvature * Math.sqrt(-distance)
}

function getControlWithCurvature({
  position,
  x1,
  y1,
  x2,
  y2,
  curvature,
}: {
  position: Position
  x1: number
  y1: number
  x2: number
  y2: number
  curvature: number
}) {
  switch (position) {
    case Position.Left:
      return [x1 - calculateControlOffset(x1 - x2, curvature), y1] as const
    case Position.Right:
      return [x1 + calculateControlOffset(x2 - x1, curvature), y1] as const
    case Position.Top:
      return [x1, y1 - calculateControlOffset(y1 - y2, curvature)] as const
    case Position.Bottom:
      return [x1, y1 + calculateControlOffset(y2 - y1, curvature)] as const
    default:
      return [x1, y1] as const
  }
}

function getBezierLabelPoint({
  sourceX,
  sourceY,
  sourceControlX,
  sourceControlY,
  targetControlX,
  targetControlY,
  targetX,
  targetY,
}: {
  sourceX: number
  sourceY: number
  sourceControlX: number
  sourceControlY: number
  targetControlX: number
  targetControlY: number
  targetX: number
  targetY: number
}) {
  return {
    x: 0.125 * sourceX + 0.375 * sourceControlX + 0.375 * targetControlX + 0.125 * targetX,
    y: 0.125 * sourceY + 0.375 * sourceControlY + 0.375 * targetControlY + 0.125 * targetY,
  }
}

function centerHandleAnchor(x: number, y: number, position?: Position) {
  switch (position) {
    case Position.Left:
      return { x: x + HANDLE_RADIUS_PX, y: y + HORIZONTAL_HANDLE_Y_NUDGE_PX }
    case Position.Right:
      return { x: x - HANDLE_RADIUS_PX, y: y + HORIZONTAL_HANDLE_Y_NUDGE_PX }
    case Position.Top:
      return { x, y: y + HANDLE_RADIUS_PX }
    case Position.Bottom:
      return { x, y: y - HANDLE_RADIUS_PX }
    default:
      return { x, y }
  }
}

export function AxedEdge(props: EdgeProps) {
  const data = props.data as AxedEdgeData | undefined
  const label = typeof data?.label === 'string' ? data.label : ''
  const total = data?.fanOutTotal ?? 1
  const index = data?.fanOutIndex ?? 0
  const curvature = total > 1 ? 0.18 + Math.abs(index - (total - 1) / 2) * 0.04 : 0.25
  const source = centerHandleAnchor(props.sourceX, props.sourceY, props.sourcePosition)
  const target = centerHandleAnchor(props.targetX, props.targetY, props.targetPosition)
  const sourcePosition = props.sourcePosition ?? Position.Bottom
  const targetPosition = props.targetPosition ?? Position.Top
  const [sourceControlX, sourceControlY] = getControlWithCurvature({
    position: sourcePosition,
    x1: props.sourceX,
    y1: source.y,
    x2: props.targetX,
    y2: target.y,
    curvature,
  })
  const [targetControlX, targetControlY] = getControlWithCurvature({
    position: targetPosition,
    x1: props.targetX,
    y1: target.y,
    x2: props.sourceX,
    y2: source.y,
    curvature,
  })
  const edgePath = `M${source.x},${source.y} C${sourceControlX},${sourceControlY} ${targetControlX},${targetControlY} ${target.x},${target.y}`
  const { x: labelX, y: labelY } = getBezierLabelPoint({
    sourceX: source.x,
    sourceY: source.y,
    sourceControlX,
    sourceControlY,
    targetControlX,
    targetControlY,
    targetX: target.x,
    targetY: target.y,
  })
  const fanOutLabel = total > 1 ? `${total} outputs` : ''

  return (
    <>
      <BaseEdge
        id={props.id}
        path={edgePath}
        className={data?.flowing ? 'bioflow-running-edge' : undefined}
        style={props.style}
        markerEnd={props.markerEnd}
        interactionWidth={24}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan rounded bg-bg-secondary/95 px-1.5 py-0.5 text-xs font-mono text-accent shadow"
            style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
      {!label && fanOutLabel && index === 0 && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan rounded bg-bg-secondary/95 px-1.5 py-0.5 text-xs text-warning shadow"
            style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {fanOutLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
