import type { PipelineSnapshot, RunState } from '@/types/pipeline'
import type { BioflowWorkspace, RunManifest } from '@/types/workspace'

export function buildRunManifest(
  run: RunState,
  snapshot?: PipelineSnapshot,
  workspace?: BioflowWorkspace | RunState['workspace'] | null,
): RunManifest {
  return {
    generatedAt: Date.now(),
    workspace: run.workspace ?? workspace ?? null,
    run,
    snapshot,
    outputs: Object.entries(run.nodes)
      .filter(([, node]) => (node.outputPaths?.length ?? 0) > 0)
      .map(([nodeId, node]) => ({
        nodeId,
        label: snapshot?.nodes.find((candidate) => candidate.id === nodeId)?.data?.label as string | undefined ?? nodeId,
        status: node.status ?? 'idle',
        paths: node.outputPaths ?? [],
      })),
  }
}
