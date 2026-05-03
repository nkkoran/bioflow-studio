import { Handle, Position } from '@xyflow/react'
import type { CSSProperties } from 'react'

type PortTone = 'input' | 'output' | 'file'

interface PortHandleProps {
  nodeId: string
  id: string
  type: 'source' | 'target'
  position: Position.Left | Position.Right
  tone?: PortTone
  connected?: boolean
  top?: string
}

export function PortHandle({
  nodeId,
  id,
  type,
  position,
  tone = type === 'source' ? 'output' : 'input',
  connected = true,
  top,
}: PortHandleProps) {
  const style = top
    ? ({ '--bioflow-port-top': top } as CSSProperties)
    : undefined

  return (
    <Handle
      type={type}
      position={position}
      id={id}
      className="bioflow-port-handle"
      data-port-node={nodeId}
      data-port-id={id}
      data-port-type={type}
      data-port-side={position === Position.Left ? 'left' : 'right'}
      data-port-tone={tone}
      data-port-connected={connected ? 'true' : 'false'}
      style={style}
    />
  )
}
