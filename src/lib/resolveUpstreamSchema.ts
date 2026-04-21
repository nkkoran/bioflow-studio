import type { PipelineSnapshot } from '@/types/pipeline'
import { connectedInputSchema, type ColumnSchema, type SchemaCache } from '@/lib/schemaResolver'

export function resolveUpstreamSchema(
  snapshot: PipelineSnapshot,
  nodeId: string,
  portId: string,
  schemas: SchemaCache,
): ColumnSchema | null {
  return connectedInputSchema(snapshot, nodeId, portId, schemas)
}
