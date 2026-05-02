import type { TransferPlan } from '../types/pipeline'
import type { WorkflowReadinessIssue, WorkflowReadinessReport } from '../types/readiness'
import type { ClusterDoctorReport, RunReadinessReport } from '../types/workspace'

type RunReadinessIssue = RunReadinessReport['issues'][number]
type ValidationIssueLike = {
  code: string
  severity: 'error' | 'warning' | 'info'
  message: string
  suggestion?: string
  nodeId?: string
  edgeId?: string
  details?: Record<string, string | number | boolean | null>
}
type ValidationResultLike = {
  issues: ValidationIssueLike[]
}

export function buildRunReadinessReport(args: {
  validation?: ValidationResultLike | null
  readiness?: WorkflowReadinessReport | null
  clusterDoctor?: ClusterDoctorReport | null
  transferPlans?: TransferPlan[]
}): RunReadinessReport {
  const issues: RunReadinessIssue[] = []

  for (const issue of args.validation?.issues ?? []) {
    issues.push(fromValidationIssue(issue))
  }
  for (const issue of args.readiness?.issues ?? []) {
    issues.push(fromWorkflowReadinessIssue(issue))
  }
  for (const check of args.clusterDoctor?.checks ?? []) {
    if (check.status === 'pass') continue
    issues.push({
      code: `CLUSTER_${check.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
      severity: check.status === 'error' ? 'error' : 'warning',
      category: 'Cluster',
      message: check.detail,
      suggestion: check.suggestion,
      action: 'run-cluster-doctor',
    })
  }
  for (const plan of args.transferPlans ?? []) {
    if (plan.mode !== 'implicit' && (plan.warnings?.length ?? 0) === 0) continue
    issues.push({
      code: plan.mode === 'implicit' ? 'IMPLICIT_TRANSFER_PLANNED' : 'TRANSFER_REVIEW',
      severity: plan.mode === 'implicit' ? 'warning' : 'info',
      category: 'Backends',
      message: `${plan.route} transfer planned for ${plan.source.path || 'upstream output'}.`,
      suggestion: plan.warnings?.join(' ') || 'Review the transfer route before running.',
      edgeId: plan.edgeId,
      nodeId: plan.nodeId,
      action: plan.mode === 'implicit' ? 'insert-transfer' : 'select-node',
    })
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length
  const infoCount = issues.filter((issue) => issue.severity === 'info').length
  return {
    ok: errorCount === 0,
    errorCount,
    warningCount,
    infoCount,
    issues,
  }
}

function fromValidationIssue(issue: ValidationIssueLike): RunReadinessIssue {
  return {
    code: issue.code,
    severity: issue.severity,
    category: validationCategory(issue),
    message: issue.message,
    suggestion: issue.suggestion,
    nodeId: issue.nodeId,
    edgeId: issue.edgeId,
    details: issue.details,
    action: validationAction(issue),
  }
}

function fromWorkflowReadinessIssue(issue: WorkflowReadinessIssue): RunReadinessIssue {
  return {
    code: issue.code,
    severity: issue.severity,
    category: workflowCategory(issue),
    message: issue.message,
    suggestion: issue.suggestion,
    nodeId: issue.nodeId,
    details: issue.details,
    action: issue.path ? 'preview-file' : issue.nodeId ? 'select-node' : undefined,
  }
}

function validationCategory(issue: ValidationIssueLike): RunReadinessIssue['category'] {
  if (issue.code.includes('DNX') || issue.code.includes('BACKEND') || issue.code.includes('TRANSFER')) return 'Backends'
  if (issue.code.includes('MODULE')) return 'Cluster'
  if (issue.code.includes('COLUMN') || issue.code.includes('SCHEMA')) return 'Columns'
  if (issue.code.includes('FILE') || issue.code.includes('PATH') || issue.code.includes('SIDECAR')) return 'Files'
  if (issue.code.includes('SLURM') || issue.code.includes('LOGIN') || issue.code.includes('RESOURCE')) return 'Resources'
  if (issue.code.includes('ORPHAN') || issue.code.includes('OUTPUT')) return 'Results'
  return 'Structure'
}

function workflowCategory(issue: WorkflowReadinessIssue): RunReadinessIssue['category'] {
  if (issue.category === 'Columns') return 'Columns'
  if (issue.category === 'IDs') return 'IDs'
  if (issue.category === 'Handoffs') return 'Backends'
  if (issue.category === 'Resources') return 'Resources'
  if (issue.category === 'Parameters') return 'Structure'
  if (issue.category === 'Outputs' || issue.category === 'Export') return 'Results'
  return 'Files'
}

function validationAction(issue: ValidationIssueLike): RunReadinessIssue['action'] {
  if (issue.code === 'BACKEND_MISMATCH_NEEDS_TRANSFER' || issue.code === 'LOCAL_OUTPUT_NEEDS_TRANSFER') return 'insert-transfer'
  if (issue.code === 'GENOME_BUILD_MISMATCH') return 'insert-liftover'
  if (issue.code === 'DNX_NO_PROJECT' || issue.code === 'DNX_NOT_AUTHENTICATED') return 'open-settings'
  if (issue.nodeId) return 'select-node'
  return undefined
}
