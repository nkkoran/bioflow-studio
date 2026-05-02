import type { ValidationResult } from '@/lib/pipelineValidator'
import type { RunReadinessReport } from '@/types/workspace'
import type { DryRunScript, PipelineSnapshot, RunReview, TransferPlan } from '@/types/pipeline'
import { buildAxisAlignmentReport, buildCleanupPlan } from '@/lib/dataArtifacts'

export function buildRunReview(args: {
  snapshot: PipelineSnapshot
  validation: ValidationResult
  readiness?: RunReadinessReport | null
  transferPlans?: TransferPlan[]
  scripts?: DryRunScript[]
}): RunReview {
  const scripts = args.scripts ?? []
  const splitConsumerIds = new Set<string>()
  for (const edge of args.snapshot.edges) {
    const source = args.snapshot.nodes.find((node) => node.id === edge.source)
    if (source?.type === 'file' && Array.isArray((source.data as { split?: { items?: unknown[] } }).split?.items)) {
      splitConsumerIds.add(edge.target)
    }
  }
  const axisReports = [...splitConsumerIds]
    .map((nodeId) => buildAxisAlignmentReport(args.snapshot, nodeId))
    .filter((report) => report.rows.length > 0)
  return {
    snapshotId: args.snapshot.id,
    pipelineName: args.snapshot.name,
    generatedAt: Date.now(),
    validation: {
      errorCount: args.validation.errorCount,
      warningCount: args.validation.warningCount,
      infoCount: args.validation.issues.filter((issue) => issue.severity === 'info').length,
    },
    readiness: args.readiness ?? null,
    nodeCount: args.snapshot.nodes.length,
    edgeCount: args.snapshot.edges.length,
    arrayNodeCount: scripts.filter((script) => script.mode === 'array' || script.arraySize).length,
    transferPlans: args.transferPlans ?? [],
    cleanupPlan: buildCleanupPlan(args.snapshot, scripts),
    axisReports,
    scriptSummaries: scripts.map((script) => ({
      nodeId: script.nodeId,
      label: script.label,
      mode: script.mode,
      arraySize: script.arraySize,
      commandCount: script.commands?.length ?? 0,
      outputPaths: script.outputPaths,
    })),
  }
}
