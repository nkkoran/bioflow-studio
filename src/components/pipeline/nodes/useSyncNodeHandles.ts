import { useLayoutEffect } from 'react'
import { useUpdateNodeInternals } from '@xyflow/react'

export function useSyncNodeHandles(nodeId: string, deps: readonly unknown[] = []) {
  const updateNodeInternals = useUpdateNodeInternals()

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      updateNodeInternals(nodeId)
    })

    return () => {
      cancelAnimationFrame(frame)
    }
  }, [nodeId, updateNodeInternals, ...deps])
}
