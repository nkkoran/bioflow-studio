/**
 * PipelineToolbar — small top bar above the canvas with pipeline-level actions.
 *
 * Actions: undo, redo, save, open, new, run.
 * Also shows the editable pipeline name and a dirty-indicator dot.
 *
 * On Run: validates the pipeline. If there are errors a blocking modal is
 * shown (fix required). Otherwise a run-review modal summarizes files,
 * scripts, transfers, split alignment, and cleanup before submission.
 */
import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Save, FolderOpen, FilePlus2, Undo2, Redo2, Play, Download, Square, AlertTriangle, XCircle, FileCode2, LayoutTemplate, CheckSquare, CheckCircle2, Info, Loader2, ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useConnectionStore, LOCAL_CONNECTION_ID } from '@/stores/connectionStore'
import { useRunStore } from '@/stores/runStore'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import { useDnxStore } from '@/stores/dnxStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { classNames } from '@/lib/utils'
import { validatePipeline, type ValidationIssue, type ValidationResult } from '@/lib/pipelineValidator'
import { mergeReadinessIntoValidation } from '@/lib/workflowReadiness'
import { buildRunReadinessReport } from '@/lib/runReadiness'
import { getTool } from '@/lib/toolRegistry'
import {
  nodeDataWithAnalysisOptionEnabled,
  snapshotWithAnalysisOptionEnabled,
} from '@/lib/plinkQuickFix'
import type { MergeNodeData, PipelineSnapshot, RunReview, ToolNodeData, TransferPlan } from '@/types/pipeline'
import { ScriptPreviewModal } from './ScriptPreviewModal'
import { instantiateTemplate, PIPELINE_TEMPLATES } from '@/lib/pipelineTemplates'
import { Dialog } from '@/components/ui/Dialog'
import { savePipelineSnapshot, savePipelineSnapshotAs } from '@/lib/pipelinePersistence'
import { useDialogStore } from '@/stores/dialogStore'
import { useClusterDoctorStore } from '@/stores/clusterDoctorStore'
import { ClusterDoctorDialog } from '@/components/connection/ClusterDoctorDialog'
import type { ClusterDoctorReport, RunReadinessReport } from '@/types/workspace'
import type { ClusterModuleSuggestion } from '@/types/ssh'
import { useWorkflowReadinessStore } from '@/stores/readinessStore'
import type { DryRunScript } from '@/types/pipeline'
import { buildWorkflowGuide, type WorkflowGuideStep } from '@/lib/workflowGuide'
import { buildRunReview } from '@/lib/runReview'

// ── Run-confirmation modal ──────────────────────────────────────────────────

interface ConfirmDialogProps {
  result: ValidationResult
  review?: RunReview | null
  snapshot: PipelineSnapshot
  /** Called when the user confirms they want to run despite warnings. */
  onRunAnyway: (snapshot: PipelineSnapshot) => void
  onQuickFix?: (issue: ValidationIssue) => void
  onCreateRemoteFolder?: (issue: ValidationIssue) => void
  onApplyModule?: (issue: ValidationIssue, moduleName: string) => void
  onSelectNode?: (issue: ValidationIssue) => void
  onClose: () => void
}

function RunConfirmDialog({ result, review, snapshot, onRunAnyway, onQuickFix, onCreateRemoteFolder, onApplyModule, onSelectNode, onClose }: ConfirmDialogProps) {
  const hasErrors = result.errorCount > 0
  const hasWarnings = result.warningCount > 0
  const isClean = !hasErrors && !hasWarnings
  const [deleteIntermediates, setDeleteIntermediates] = useState(false)
  const submitSnapshot = useMemo(() => ({
    ...snapshot,
    execution: {
      ...(snapshot.execution ?? {}),
      fileLifecyclePolicy: deleteIntermediates ? 'delete-intermediates-on-success' as const : 'keep-all' as const,
    },
  }), [deleteIntermediates, snapshot])

  const headerBg = hasErrors ? 'bg-error/10 border-error/30' : hasWarnings ? 'bg-warning/10 border-warning/30' : 'bg-success/10 border-success/30'
  const headerText = hasErrors ? 'text-error' : hasWarnings ? 'text-warning' : 'text-success'
  const HeaderIcon = hasErrors ? XCircle : hasWarnings ? AlertTriangle : CheckCircle2
  const title = hasErrors
    ? `${result.errorCount} error${result.errorCount === 1 ? '' : 's'} must be fixed before running`
    : hasWarnings
      ? `${result.warningCount} warning${result.warningCount === 1 ? '' : 's'} — review before running`
      : 'Ready to run'

  // Group by severity for display.
  const errors = result.issues.filter((i) => i.severity === 'error')
  const warnings = result.issues.filter((i) => i.severity === 'warning')
  const infos = result.issues.filter((i) => i.severity === 'info')

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-[680px] max-h-[86vh] flex flex-col bg-bg-primary border border-border rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className={`flex items-center gap-2.5 px-4 py-3 border-b ${headerBg}`}>
          <HeaderIcon size={16} className={headerText} />
          <span className={`text-sm font-medium ${headerText}`}>{title}</span>
        </div>

        {review && (
          <div className="grid grid-cols-4 gap-2 border-b border-border bg-bg-secondary px-4 py-3">
            <RunReviewStat label="Nodes" value={String(review.nodeCount)} />
            <RunReviewStat label="Arrays" value={String(review.arrayNodeCount)} />
            <RunReviewStat label="Transfers" value={String(review.transferPlans.length)} />
            <RunReviewStat label="Cleanup" value={deleteIntermediates ? 'Explicit delete' : 'Keep all'} tone={deleteIntermediates ? 'warning' : 'muted'} />
          </div>
        )}

        {/* Issue list */}
        <div className="flex-1 overflow-y-auto py-1 min-h-0">
          {[
            { label: 'Errors', items: errors, color: 'text-error' },
            { label: 'Warnings', items: warnings, color: 'text-warning' },
            { label: 'Notes', items: infos, color: 'text-accent' },
          ].map(({ label, items, color }) =>
            items.length === 0 ? null : (
              <div key={label}>
                <div className="px-4 py-1 text-[9px] uppercase tracking-wider text-text-muted border-b border-border-light">
                  {label} ({items.length})
                </div>
                {items.map((issue, i) => (
                  <ModalIssueRow key={i} issue={issue} color={color} onQuickFix={onQuickFix} onCreateRemoteFolder={onCreateRemoteFolder} onApplyModule={onApplyModule} onSelectNode={onSelectNode} />
                ))}
              </div>
            ),
          )}
          {result.issues.length === 0 && (
            <div className="px-4 py-6 text-sm text-text-secondary">All blocking checks are clear.</div>
          )}
          {review && (
            <RunReviewDetails
              review={review}
              deleteIntermediates={deleteIntermediates}
              setDeleteIntermediates={setDeleteIntermediates}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border bg-bg-secondary">
          {hasErrors ? (
            <>
              <span className="text-xs text-text-muted mr-auto">Fix the errors above, then try again.</span>
              <Button variant="secondary" size="sm" onClick={onClose}>
                Close
              </Button>
            </>
          ) : (
            <>
              <span className="text-xs text-text-muted mr-auto">{isClean ? 'Ready to submit.' : "Warnings won't stop the run."}</span>
              <Button variant="secondary" size="sm" onClick={onClose}>
                Go back
              </Button>
              <Button variant="primary" size="sm" onClick={() => onRunAnyway(submitSnapshot)}>
                <Play size={11} className="mr-1" />
                {isClean ? 'Run' : 'Run anyway'}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ModalIssueRow({
  issue,
  color,
  onQuickFix,
  onCreateRemoteFolder,
  onApplyModule,
  onSelectNode,
}: {
  issue: ValidationIssue
  color: string
  onQuickFix?: (issue: ValidationIssue) => void
  onCreateRemoteFolder?: (issue: ValidationIssue) => void
  onApplyModule?: (issue: ValidationIssue, moduleName: string) => void
  onSelectNode?: (issue: ValidationIssue) => void
}) {
  return (
    <div className="px-4 py-2 border-b border-border-light/50 last:border-0 flex items-start gap-2">
      <span className={`text-[10px] font-mono shrink-0 mt-px ${color}`}>{issue.code}</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-text-primary leading-snug">{issue.message}</div>
        {issue.suggestion && (
          <div className="text-[10px] text-text-muted mt-0.5 leading-snug">{issue.suggestion}</div>
        )}
      </div>
      {onSelectNode && issue.nodeId && (
        <button
          type="button"
          onClick={() => onSelectNode(issue)}
          className="shrink-0 rounded border border-border bg-bg-tertiary px-2 py-1 text-[10px] text-text-secondary hover:text-text-primary"
        >
          Select
        </button>
      )}
      {onQuickFix && canApplyValidationQuickFix(issue) && (
        <button
          type="button"
          onClick={() => onQuickFix(issue)}
          className="shrink-0 rounded bg-accent px-2 py-1 text-[10px] text-white hover:brightness-110"
        >
          {validationQuickFixLabel(issue)}
        </button>
      )}
      {onCreateRemoteFolder && canCreateRemoteFolderQuickFix(issue) && (
        <button
          type="button"
          onClick={() => onCreateRemoteFolder(issue)}
          className="shrink-0 rounded bg-accent px-2 py-1 text-[10px] text-white hover:brightness-110"
        >
          Create folder
        </button>
      )}
      {onApplyModule && moduleCandidatesFromIssue(issue).length > 0 && (
        <ModuleSuggestionPicker issue={issue} onApply={onApplyModule} />
      )}
    </div>
  )
}

function RunReviewStat({ label, value, tone = 'muted' }: { label: string; value: string; tone?: 'muted' | 'warning' }) {
  return (
    <div className="rounded-md border border-border bg-bg-primary px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className={classNames('mt-0.5 truncate text-xs font-medium', tone === 'warning' ? 'text-warning' : 'text-text-primary')}>{value}</div>
    </div>
  )
}

function RunReviewDetails({
  review,
  deleteIntermediates,
  setDeleteIntermediates,
}: {
  review: RunReview
  deleteIntermediates: boolean
  setDeleteIntermediates: (value: boolean) => void
}) {
  const mismatches = review.axisReports.filter((report) => report.status === 'mismatch')
  return (
    <div className="border-t border-border-light px-4 py-3">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-text-muted">Run review</div>
      {review.transferPlans.length > 0 && (
        <div className="mb-2 rounded-md border border-border bg-bg-tertiary/50 p-2">
          <div className="text-xs font-medium text-text-primary">Planned transfers</div>
          <div className="mt-1 flex flex-col gap-1">
            {review.transferPlans.slice(0, 5).map((plan) => (
              <div key={plan.id} className="truncate text-[10px] text-text-muted">
                {plan.route}: {plan.source.path} {'->'} {plan.target.path}
              </div>
            ))}
            {review.transferPlans.length > 5 && <div className="text-[10px] text-text-muted">+{review.transferPlans.length - 5} more</div>}
          </div>
        </div>
      )}
      {review.axisReports.length > 0 && (
        <div className={classNames(
          'mb-2 rounded-md border p-2',
          mismatches.length > 0 ? 'border-warning/30 bg-warning/10' : 'border-success/30 bg-success/10',
        )}>
          <div className={classNames('text-xs font-medium', mismatches.length > 0 ? 'text-warning' : 'text-success')}>
            Split alignment
          </div>
          <div className="mt-1 flex flex-col gap-1">
            {review.axisReports.map((report) => (
              <div key={report.nodeId} className="text-[10px] text-text-secondary">
                {report.nodeId}: {report.message}
              </div>
            ))}
          </div>
        </div>
      )}
      {review.scriptSummaries.length > 0 && (
        <div className="mb-2 rounded-md border border-border bg-bg-tertiary/50 p-2">
          <div className="text-xs font-medium text-text-primary">Generated commands</div>
          <div className="mt-1 grid grid-cols-2 gap-1">
            {review.scriptSummaries.slice(0, 8).map((script) => (
              <div key={script.nodeId} className="truncate rounded bg-bg-primary px-2 py-1 text-[10px] text-text-muted">
                {script.label}: {script.mode}{script.arraySize ? ` (${script.arraySize} tasks)` : ''}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="rounded-md border border-border bg-bg-tertiary/50 p-2">
        <label className="flex items-start gap-2 text-xs text-text-primary">
          <input
            type="checkbox"
            checked={deleteIntermediates}
            onChange={(event) => setDeleteIntermediates(event.target.checked)}
            className="mt-0.5 accent-accent"
          />
          <span>
            Delete generated intermediate outputs after the run succeeds
            <span className="mt-0.5 block text-[10px] leading-snug text-text-muted">
              Off by default. BioFlow protects all file-node inputs and PLINK sidecars; generated outputs marked as intermediate and auto-merge shard files are eligible.
              {review.cleanupPlan.generatedIntermediatePaths.length > 0
                ? ` ${review.cleanupPlan.generatedIntermediatePaths.length} generated path${review.cleanupPlan.generatedIntermediatePaths.length === 1 ? '' : 's'} would be removed when this is enabled.`
                : ''}
            </span>
          </span>
        </label>
        {review.cleanupPlan.warnings.map((warning) => (
          <div key={warning} className="mt-1 text-[10px] text-warning">{warning}</div>
        ))}
      </div>
    </div>
  )
}

function canInsertTransferQuickFix(issue: ValidationIssue): boolean {
  return Boolean(issue.edgeId) && (
    issue.code === 'BACKEND_MISMATCH_NEEDS_TRANSFER'
    || issue.code === 'LOCAL_OUTPUT_NEEDS_TRANSFER'
    || issue.code === 'DNX_UPLOAD_ADVISORY'
    || issue.code === 'IMPLICIT_TRANSFER_PLANNED'
  )
}

function canInsertLiftoverQuickFix(issue: ValidationIssue): boolean {
  return Boolean(issue.edgeId) && issue.code === 'GENOME_BUILD_MISMATCH'
}

function canApplyValidationQuickFix(issue: ValidationIssue): boolean {
  return canInsertTransferQuickFix(issue)
    || canInsertLiftoverQuickFix(issue)
    || Boolean(resourceQuickFix(issue))
    || Boolean(analysisOptionQuickFix(issue))
}

function validationQuickFixLabel(issue: ValidationIssue): string {
  const resourceFix = resourceQuickFix(issue)
  if (resourceFix) return resourceFix.label
  const optionFix = analysisOptionQuickFix(issue)
  if (optionFix) return optionFix.label
  if (canInsertLiftoverQuickFix(issue)) return 'Insert liftover'
  return 'Insert transfer'
}

function resourceQuickFix(issue: ValidationIssue): { cpus: number; memoryGB: number; timeHours: number; label: string } | null {
  const cpus = Number(issue.details?.quickFixResourceCpus)
  const memoryGB = Number(issue.details?.quickFixResourceMemoryGB)
  const timeHours = Number(issue.details?.quickFixResourceTimeHours)
  if (!Number.isFinite(cpus) || !Number.isFinite(memoryGB) || !Number.isFinite(timeHours)) return null
  if (cpus <= 0 || memoryGB <= 0 || timeHours <= 0) return null
  return {
    cpus: Math.ceil(cpus),
    memoryGB: Math.ceil(memoryGB),
    timeHours,
    label: typeof issue.details?.quickFixLabel === 'string' ? issue.details.quickFixLabel : 'Apply resources',
  }
}

function analysisOptionQuickFix(issue: ValidationIssue): { optionId: string; value: string | number | boolean; label: string } | null {
  const rawFlag = issue.details?.quickFixFlagId
  if (typeof rawFlag === 'string' && rawFlag.trim()) {
    const value = issue.details?.quickFixValue
    return {
      optionId: rawFlag.trim(),
      value: typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : true,
      label: typeof issue.details?.quickFixLabel === 'string' ? issue.details.quickFixLabel : `Enable ${rawFlag.trim()}`,
    }
  }
  if (issue.code === 'PLINK_BINARY_PHENO_01_NEEDS_ONE' && issue.nodeId) {
    return { optionId: 'one', value: true, label: 'Enable --1' }
  }
  if (issue.code === 'INACTIVE_INPUT_CONNECTED' && issue.nodeId && issue.portId) {
    return { optionId: issue.portId, value: true, label: `Enable ${issue.portId}` }
  }
  return null
}

function canCreateRemoteFolderQuickFix(issue: ValidationIssue): boolean {
  return issue.code === 'CLUSTER_TOOLS_ROOT' || issue.code === 'CLUSTER_ANALYSIS_ROOT_WRITE'
}

function remoteFolderFromClusterIssue(issue: ValidationIssue): string | null {
  const detailPath = issue.details?.path
  if (typeof detailPath === 'string' && detailPath.trim()) return detailPath.trim()

  const text = `${issue.message}\n${issue.suggestion ?? ''}`
  const notFound = text.match(/not found:\s*([^\n]+)/i)
  if (notFound?.[1]) return notFound[1].trim().replace(/\.$/, '')
  const cannotWrite = text.match(/cannot write to\s+([^\n]+)/i)
  if (cannotWrite?.[1]) return cannotWrite[1].trim().replace(/\.$/, '')
  return null
}

function shellQuoteClient(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function moduleCandidatesFromIssue(issue: ValidationIssue): string[] {
  if (issue.code !== 'MODULE_UNAVAILABLE') return []
  const raw = issue.details?.moduleCandidates
  return typeof raw === 'string'
    ? raw.split('|').map((value) => value.trim()).filter(Boolean)
    : []
}

function ModuleSuggestionPicker({
  issue,
  onApply,
}: {
  issue: ValidationIssue
  onApply: (issue: ValidationIssue, moduleName: string) => void
}) {
  const candidates = moduleCandidatesFromIssue(issue)
  const [selected, setSelected] = useState(candidates[0] ?? '')
  if (candidates.length === 0) return null
  return (
    <div className="flex shrink-0 items-center gap-1">
      <select
        value={selected}
        onChange={(event) => setSelected(event.target.value)}
        className="h-6 max-w-[150px] rounded border border-border bg-bg-tertiary px-1 text-[10px] text-text-primary"
        title="Available modules found on this cluster"
      >
        {candidates.map((candidate) => (
          <option key={candidate} value={candidate}>{candidate}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => selected && onApply(issue, selected)}
        className="rounded bg-accent px-2 py-1 text-[10px] text-white hover:brightness-110"
      >
        Use
      </button>
    </div>
  )
}

function workflowStatusDot(status: WorkflowGuideStep['status']): string {
  if (status === 'done') return 'bg-success'
  if (status === 'blocked') return 'bg-error'
  if (status === 'active') return 'bg-accent'
  return 'bg-text-muted/40'
}

const READINESS_GROUPS = ['Structure', 'Files', 'Columns', 'IDs', 'Backends', 'Cluster', 'Resources', 'Results'] as const
type ReadinessCategory = typeof READINESS_GROUPS[number]

interface RunCheckResult {
  validation: ValidationResult
  readiness: RunReadinessReport
  transferPlans: TransferPlan[]
}

function groupIssues(issues: ValidationIssue[]): Record<ReadinessCategory, ValidationIssue[]> {
  const groups = {} as Record<ReadinessCategory, ValidationIssue[]>
  for (const group of READINESS_GROUPS) groups[group] = []
  for (const issue of issues) {
    groups[issueReadinessCategory(issue)].push(issue)
  }
  return groups
}

function issueReadinessCategory(issue: ValidationIssue): ReadinessCategory {
  const category = issue.details?.category
  if (typeof category === 'string' && READINESS_GROUPS.includes(category as ReadinessCategory)) return category as ReadinessCategory
  if (issue.code.includes('DNX') || issue.code.includes('BACKEND') || issue.code.includes('TRANSFER')) return 'Backends'
  if (issue.code.startsWith('CLUSTER_')) return 'Cluster'
  if (issue.code.includes('MODULE')) return 'Cluster'
  if (issue.code.includes('COLUMN') || issue.code.includes('SCHEMA')) return 'Columns'
  if (issue.code.includes('ID') || issue.code.includes('SAMPLE')) return 'IDs'
  if (issue.code.includes('FILE') || issue.code.includes('PATH') || issue.code.includes('READINESS') || issue.code.includes('OPTION_FILE')) return 'Files'
  if (issue.code.includes('SLURM') || issue.code.includes('RESOURCE')) return 'Resources'
  if (issue.code.includes('OUTPUT') || issue.code.includes('EXPORT') || issue.code.includes('ORPHAN')) return 'Results'
  return 'Structure'
}

function validationFromRunReadiness(report: RunReadinessReport): ValidationResult {
  const issues: ValidationIssue[] = report.issues.map((issue) => ({
    code: issue.code,
    severity: issue.severity,
    message: issue.message,
    suggestion: issue.suggestion,
    nodeId: issue.nodeId,
    edgeId: issue.edgeId,
    details: {
      ...(issue.details ?? {}),
      category: issue.category,
      action: issue.action ?? null,
    },
  }))
  return {
    ok: report.ok,
    issues,
    errorCount: report.errorCount,
    warningCount: report.warningCount,
    infoCount: report.infoCount,
  }
}

function appendValidationIssues(result: ValidationResult, issues: ValidationIssue[]): ValidationResult {
  const nextIssues = [...result.issues, ...issues]
  return validationResultFromIssues(nextIssues)
}

function validationResultFromIssues(issues: ValidationIssue[]): ValidationResult {
  const errorCount = issues.filter((issue) => issue.severity === 'error').length
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length
  const infoCount = issues.filter((issue) => issue.severity === 'info').length
  return {
    ok: errorCount === 0,
    issues,
    errorCount,
    warningCount,
    infoCount,
  }
}

function removeValidationIssues(result: ValidationResult, shouldRemove: (issue: ValidationIssue) => boolean): ValidationResult {
  return validationResultFromIssues(result.issues.filter((issue) => !shouldRemove(issue)))
}

function removeReadinessIssues(report: RunReadinessReport | null | undefined, shouldRemove: (issue: RunReadinessReport['issues'][number]) => boolean): RunReadinessReport | null | undefined {
  if (!report) return report
  const issues = report.issues.filter((issue) => !shouldRemove(issue))
  return {
    ...report,
    issues,
    ok: issues.every((issue) => issue.severity !== 'error'),
    errorCount: issues.filter((issue) => issue.severity === 'error').length,
    warningCount: issues.filter((issue) => issue.severity === 'warning').length,
    infoCount: issues.filter((issue) => issue.severity === 'info').length,
  }
}

async function moduleIssuesForSnapshot(connectionId: string, snapshot: PipelineSnapshot): Promise<ValidationIssue[]> {
  const moduleToNodes = requiredModulesForSnapshot(snapshot)
  const modules = [...moduleToNodes.keys()]
  if (modules.length === 0) return []
  try {
    const result = await window.api.cluster.checkModules(connectionId, modules)
    return result.checks.flatMap((check): ValidationIssue[] => {
      if (check.ok) return []
      const nodes = moduleToNodes.get(check.requested) ?? []
      const candidates = moduleCandidateNames(check.suggestions)
      const primary = nodes[0]
      return [{
        severity: 'error',
        code: 'MODULE_UNAVAILABLE',
        nodeId: primary?.nodeId,
        message: `Cluster module "${check.requested}" is not loadable${primary ? ` for ${primary.label}` : ''}.`,
        suggestion: candidates.length > 0
          ? `Choose an available replacement module, or open the node inspector and set a module override. ${check.message ?? ''}`.trim()
          : `Open the node inspector and set a module override that exists on this cluster. ${check.message ?? ''}`.trim(),
        details: {
          category: 'Cluster',
          requestedModule: check.requested,
          moduleCandidate: candidates[0] ?? '',
          moduleCandidates: candidates.join('|'),
        },
      }]
    })
  } catch (err: any) {
    return [{
      severity: 'warning',
      code: 'MODULE_CHECK_FAILED',
      message: `Could not check cluster modules: ${err?.message ?? String(err)}`,
      suggestion: 'The run can continue, but module names will only be validated by Slurm when the job starts.',
      details: { category: 'Cluster' },
    }]
  }
}

function requiredModulesForSnapshot(snapshot: PipelineSnapshot): Map<string, Array<{ nodeId: string; label: string }>> {
  const out = new Map<string, Array<{ nodeId: string; label: string }>>()
  const add = (moduleName: string | undefined, nodeId: string, label: string) => {
    const value = moduleName?.trim()
    if (!value) return
    out.set(value, [...(out.get(value) ?? []), { nodeId, label }])
  }
  for (const node of snapshot.nodes) {
    if (node.type === 'tool') {
      const data = node.data as ToolNodeData
      const tool = getTool(data.toolId)
      add(data.moduleOverride || tool?.module, node.id, data.label || tool?.name || data.toolId)
      continue
    }
    if (node.type === 'merge') {
      const data = node.data as MergeNodeData
      add(data.moduleOverride || defaultMergeModule(data), node.id, data.label || 'Merge')
    }
  }
  return out
}

function defaultMergeModule(data: MergeNodeData): string | undefined {
  if (data.strategy === 'bcftools-concat') return 'bcftools/1.19'
  if (data.strategy === 'plink-pmerge-list') return 'plink/2.00a3'
  return undefined
}

function moduleCandidateNames(suggestions: ClusterModuleSuggestion[]): string[] {
  const names = suggestions.flatMap((entry) => (
    entry.versions.length > 0 ? entry.versions.map((version) => `${entry.name}/${version}`) : [entry.name]
  ))
  return [...new Set(names)].slice(0, 8)
}

function isMatchingModuleIssue(candidate: ValidationIssue | RunReadinessReport['issues'][number], issue: ValidationIssue): boolean {
  if (candidate.code !== 'MODULE_UNAVAILABLE') return false
  if (candidate.nodeId !== issue.nodeId) return false
  const requested = issue.details?.requestedModule
  if (typeof requested !== 'string' || requested.length === 0) return true
  return candidate.details?.requestedModule === requested
}

function snapshotWithModuleOverride(snapshot: PipelineSnapshot, nodeId: string, moduleName: string): PipelineSnapshot {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => (
      node.id === nodeId && (node.type === 'tool' || node.type === 'merge')
        ? { ...node, data: { ...node.data, moduleOverride: moduleName } }
        : node
    )),
    updatedAt: Date.now(),
  }
}

function snapshotWithSlurmOverride(snapshot: PipelineSnapshot, nodeId: string, patch: NonNullable<ToolNodeData['slurmOverride']>): PipelineSnapshot {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => (
      node.id === nodeId && node.type === 'tool'
        ? { ...node, data: { ...node.data, slurmOverride: { ...(node.data as ToolNodeData).slurmOverride, ...patch } } }
        : node
    )),
    updatedAt: Date.now(),
  }
}

function snapshotNeedsSsh(snapshot: PipelineSnapshot): boolean {
  return snapshot.nodes.some((node) => {
    if (node.type === 'merge' || node.type === 'transform') return true
    if (node.type === 'transfer') {
      const data = node.data as { from?: string; to?: string }
      return data.from === 'ssh' || data.to === 'ssh'
    }
    if (node.type === 'tool') {
      return (node.data as ToolNodeData).backend !== 'dnx'
    }
    return false
  })
}

// ── Toolbar ─────────────────────────────────────────────────────────────────

export function PipelineToolbar() {
  const pipelineName = usePipelineStore((s) => s.pipelineName)
  const setPipelineName = usePipelineStore((s) => s.setPipelineName)
  const dirty = usePipelineStore((s) => s.dirty)
  const past = usePipelineStore((s) => s.past)
  const future = usePipelineStore((s) => s.future)
  const undo = usePipelineStore((s) => s.undo)
  const redo = usePipelineStore((s) => s.redo)
  const reset = usePipelineStore((s) => s.reset)
  const exportSnapshot = usePipelineStore((s) => s.exportSnapshot)
  const loadSnapshot = usePipelineStore((s) => s.loadSnapshot)
  const markSaved = usePipelineStore((s) => s.markSaved)
  const insertTransferNodeForEdge = usePipelineStore((s) => s.insertTransferNodeForEdge)
  const insertLiftoverNodeForEdge = usePipelineStore((s) => s.insertLiftoverNodeForEdge)
  const setSelectedNode = usePipelineStore((s) => s.setSelectedNode)
  const updateNodeData = usePipelineStore((s) => s.updateNodeData)
  const nodes = usePipelineStore((s) => s.nodes)
  const edges = usePipelineStore((s) => s.edges)
  const schemas = useDataPreviewStore((s) => s.schemas)
  const setBottomPanelMode = useUIStore((s) => s.setBottomPanelMode)
  const openConnectionDialog = useUIStore((s) => s.openConnectionDialog)

  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const activeRunId = useRunStore((s) => s.activeRunId)
  const activeRun = useRunStore((s) => s.activeRunId ? s.runs[s.activeRunId] : null)
  const startRun = useRunStore((s) => s.startRun)
  const settings = useSettingsStore((s) => s.settings)
  const dnxDefaultProjectId = useDnxStore((s) => s.defaultProjectId)
  const dnxAuthenticated = useDnxStore((s) => s.authStatus === 'authenticated')
  const confirmOnLoginNodeRun = useSettingsStore((s) => s.settings.confirmOnLoginNodeRun)
  const skipPreRunFileCheck = useSettingsStore((s) => s.settings.skipPreRunFileCheck)
  const skipPreRunDoctorCheck = useSettingsStore((s) => s.settings.skipPreRunDoctorCheck)
  const cancelRun = useRunStore((s) => s.cancelRun)
  const promptDialog = useDialogStore((s) => s.prompt)
  const confirmAction = useDialogStore((s) => s.confirm)
  const runDoctorReport = useClusterDoctorStore((s) => s.runReport)
  const evaluateReadiness = useWorkflowReadinessStore((s) => s.evaluateSnapshot)

  const [editingName, setEditingName] = useState(false)
  const [savedMessage, setSavedMessage] = useState<{ text: string; isError: boolean } | null>(null)
  const [running, setRunning] = useState(false)
  const [runStatus, setRunStatus] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [scriptPreview, setScriptPreview] = useState<DryRunScript[] | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<{ result: ValidationResult; snapshot: PipelineSnapshot; readiness?: RunReadinessReport | null; review?: RunReview | null } | null>(null)
  const [doctorDialog, setDoctorDialog] = useState<ClusterDoctorReport | null>(null)
  const [checkReport, setCheckReport] = useState<ValidationResult | null>(null)
  const [checkReadinessReport, setCheckReadinessReport] = useState<RunReadinessReport | null>(null)
  const [checkOpen, setCheckOpen] = useState(false)
  const [checkRunning, setCheckRunning] = useState(false)
  const [checkStatus, setCheckStatus] = useState<string | null>(null)
  const [workflowOpen, setWorkflowOpen] = useState(false)
  const [openPicker, setOpenPicker] = useState<Array<{ id: string; name: string }> | null>(null)
  const [templatePicker, setTemplatePicker] = useState(false)
  const activeRunIsCancellable = activeRun?.status === 'queued' || activeRun?.status === 'running'
  const checkRef = useRef<HTMLDivElement | null>(null)
  const workflowRef = useRef<HTMLDivElement | null>(null)

  const flashMessage = useCallback((msg: string, isError = false) => {
    setSavedMessage({ text: msg, isError })
    setTimeout(() => setSavedMessage(null), isError ? 7000 : 2000)
  }, [])

  useEffect(() => {
    if (!checkOpen) return
    const onDown = (event: PointerEvent) => {
      if (checkRef.current && !checkRef.current.contains(event.target as Node)) setCheckOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [checkOpen])

  useEffect(() => {
    if (!workflowOpen) return
    const onDown = (event: PointerEvent) => {
      if (workflowRef.current && !workflowRef.current.contains(event.target as Node)) setWorkflowOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [workflowOpen])

  useEffect(() => {
    if (!settings.workflowGuideEnabled) setWorkflowOpen(false)
  }, [settings.workflowGuideEnabled])

  const guideSnapshot = useMemo(() => exportSnapshot(), [edges, exportSnapshot, nodes])
  const guideValidation = useMemo(() => validatePipeline(guideSnapshot, {
    schemas,
    annotationDefaults: {
      annovarDbPath: settings.annovarDbPath,
      annovarScriptsPath: settings.annovarScriptsPath,
      vepCachePath: settings.vepCachePath,
      vepPath: settings.vepPath,
    },
    dnx: {
      defaultProjectId: dnxDefaultProjectId,
      authenticated: dnxAuthenticated,
    },
  }), [dnxAuthenticated, dnxDefaultProjectId, guideSnapshot, schemas, settings.annovarDbPath, settings.annovarScriptsPath, settings.vepCachePath, settings.vepPath])
  const activeRunOutputCount = useMemo(() => (
    activeRun ? Object.values(activeRun.nodes).reduce((sum, node) => sum + (node.outputPaths?.length ?? 0), 0) : 0
  ), [activeRun])
  const workflowGuide = useMemo(() => buildWorkflowGuide(guideSnapshot, {
    validation: guideValidation,
    activeConnectionId,
    localConnectionId: LOCAL_CONNECTION_ID,
    activeRunStatus: activeRun?.status ?? null,
    activeRunOutputCount,
  }), [activeConnectionId, activeRun?.status, activeRunOutputCount, guideSnapshot, guideValidation])

  const runChecks = useCallback(async (
    snapshot: PipelineSnapshot,
    opts: {
      includeDoctor?: boolean
      includeFileReadiness?: boolean
      includeModuleChecks?: boolean
      includeTransfers?: boolean
      onProgress?: (msg: string) => void
    } = {},
  ): Promise<RunCheckResult> => {
    opts.onProgress?.('Validating pipeline...')
    let result = validatePipeline(snapshot, {
      schemas,
      annotationDefaults: {
        annovarDbPath: settings.annovarDbPath,
        annovarScriptsPath: settings.annovarScriptsPath,
        vepCachePath: settings.vepCachePath,
        vepPath: settings.vepPath,
      },
      dnx: {
        defaultProjectId: dnxDefaultProjectId,
        authenticated: dnxAuthenticated,
      },
    })

    if (activeConnectionId && activeConnectionId !== LOCAL_CONNECTION_ID) {
      if (opts.includeFileReadiness) {
        opts.onProgress?.('Checking input files...')
        const readiness = await evaluateReadiness(activeConnectionId, snapshot)
        result = mergeReadinessIntoValidation(result, readiness)
      }
      if (opts.includeModuleChecks) {
        opts.onProgress?.('Checking cluster modules...')
        const moduleIssues = await moduleIssuesForSnapshot(activeConnectionId, snapshot)
        if (moduleIssues.length > 0) result = appendValidationIssues(result, moduleIssues)
      }
      if (opts.includeDoctor && !skipPreRunDoctorCheck) {
        opts.onProgress?.('Checking cluster...')
        const doctor = await runDoctorReport(activeConnectionId, { force: true })
        if (doctor.checks.length > 0) {
          const doctorIssues: ValidationIssue[] = doctor.checks.map((check) => ({
            code: `CLUSTER_${check.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
            severity: check.status === 'error' ? 'error' : check.status === 'warning' ? 'warning' : 'info',
            message: check.detail,
            suggestion: check.suggestion,
          }))
          result = appendValidationIssues(result, doctorIssues)
        }
      }
    }

    let transferPlans: TransferPlan[] = []
    if (opts.includeTransfers) {
      opts.onProgress?.('Planning transfers...')
      transferPlans = await window.api.pipeline.planTransfersDry(snapshot)
    }
    const readiness = buildRunReadinessReport({
      validation: result,
      transferPlans,
    })

    return {
      validation: validationFromRunReadiness(readiness),
      readiness,
      transferPlans,
    }
  }, [activeConnectionId, dnxAuthenticated, dnxDefaultProjectId, evaluateReadiness, runDoctorReport, schemas, settings.annovarDbPath, settings.annovarScriptsPath, settings.vepCachePath, settings.vepPath, skipPreRunDoctorCheck])

  const handleNew = useCallback(async () => {
    if (dirty) {
      const confirmed = await confirmAction({
        title: 'New pipeline',
        message: 'Discard unsaved changes and start a new pipeline?',
        confirmLabel: 'Start new pipeline',
        cancelLabel: 'Keep current',
      })
      if (!confirmed) return
    }
    reset()
  }, [confirmAction, dirty, reset])

  const handleSave = useCallback(async () => {
    const snapshot = exportSnapshot()
    try {
      await savePipelineSnapshot(snapshot)
      markSaved()
      flashMessage('Saved')
    } catch (err) {
      console.error('Save failed:', err)
      flashMessage('Save failed')
    }
  }, [exportSnapshot, flashMessage, markSaved])

  const handleSaveAs = useCallback(async () => {
    const snapshot = exportSnapshot()
    const nextName = await promptDialog({
      title: 'Save pipeline as',
      message: 'Choose a name for the copied pipeline.',
      defaultValue: `${snapshot.name} copy`,
      placeholder: 'Pipeline name',
      confirmLabel: 'Save copy',
    })
    if (!nextName?.trim()) return
    try {
      const next = {
        ...snapshot,
        createdAt: snapshot.createdAt,
      }
      const created = await savePipelineSnapshotAs(next, nextName.trim())
      loadSnapshot(created)
      markSaved()
      flashMessage('Saved as new pipeline')
    } catch (err) {
      console.error('Save as failed:', err)
      flashMessage('Save as failed', true)
    }
  }, [exportSnapshot, flashMessage, loadSnapshot, markSaved, promptDialog])

  const handleOpen = useCallback(async () => {
    if (dirty) {
      const confirmed = await confirmAction({
        title: 'Open pipeline',
        message: 'Discard unsaved changes and open a saved pipeline?',
        confirmLabel: 'Open pipeline',
        cancelLabel: 'Keep current',
      })
      if (!confirmed) return
    }
    const ids = (await window.api.store.get<string[]>('pipelines:ids')) ?? []
    if (ids.length === 0) { flashMessage('No saved pipelines'); return }
    const entries = await Promise.all(
      ids.map(async (id) => {
        const snap = await window.api.store.get<{ name: string; id: string }>(`pipeline:${id}`)
        return snap ? { id: snap.id, name: snap.name } : null
      }),
    )
    setOpenPicker(entries.filter((e): e is { id: string; name: string } => e !== null))
  }, [confirmAction, dirty, flashMessage])

  const confirmOpen = useCallback(async (id: string) => {
    setOpenPicker(null)
    const snap = await window.api.store.get<any>(`pipeline:${id}`)
    if (snap) loadSnapshot(snap)
    else flashMessage('Pipeline not found', true)
  }, [loadSnapshot, flashMessage])

  const handleImport = useCallback(async () => {
    if (dirty) {
      const confirmed = await confirmAction({
        title: 'Import pipeline',
        message: 'Discard unsaved changes and import a pipeline file?',
        confirmLabel: 'Import pipeline',
        cancelLabel: 'Keep current',
      })
      if (!confirmed) return
    }
    const path = await window.api.dialog.openFile({
      filters: [{ name: 'BioFlow pipeline JSON', extensions: ['json', 'bioflow'] }],
    })
    if (!path) return
    try {
      const text = await window.api.local.read(path)
      const snapshot = JSON.parse(text) as PipelineSnapshot
      if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) {
        throw new Error('File is not a BioFlow pipeline snapshot.')
      }
      loadSnapshot(snapshot)
      flashMessage('Imported')
    } catch (err: any) {
      console.error('Import failed:', err)
      flashMessage(`Import failed: ${err?.message ?? err}`, true)
    }
  }, [confirmAction, dirty, loadSnapshot, flashMessage])

  const handleTemplate = useCallback(async () => {
    if (dirty) {
      const confirmed = await confirmAction({
        title: 'Load template',
        message: 'Discard unsaved changes and load a template?',
        confirmLabel: 'Load template',
        cancelLabel: 'Keep current',
      })
      if (!confirmed) return
    }
    setTemplatePicker(true)
  }, [confirmAction, dirty])

  const confirmTemplate = useCallback((idx: number) => {
    setTemplatePicker(false)
    const template = PIPELINE_TEMPLATES[idx]
    if (!template) { flashMessage('Template not found', true); return }
    loadSnapshot(instantiateTemplate(template))
    flashMessage(`Loaded ${template.name}`)
  }, [loadSnapshot, flashMessage])

  const handleExport = useCallback(() => {
    const snapshot = exportSnapshot()
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${snapshot.name.replace(/[^a-z0-9]+/gi, '_')}.bioflow.json`
    a.click()
    URL.revokeObjectURL(url)
    flashMessage('Exported')
  }, [exportSnapshot, flashMessage])

  /** Actually submit the run (called directly if no issues, or via modal "Run anyway"). */
  const submitRun = useCallback(async (snapshot: PipelineSnapshot, readiness?: RunReadinessReport | null) => {
    if (!activeConnectionId) { flashMessage('No active connection', true); return }
    if (snapshotNeedsSsh(snapshot) && activeConnectionId === LOCAL_CONNECTION_ID) { flashMessage('Run requires an SSH connection', true); return }
    const loginNodes = snapshot.nodes.filter((node) => node.type === 'tool' && (node.data as any).executionMode === 'login')
    if (confirmOnLoginNodeRun && loginNodes.length > 0) {
      const ok = await confirmAction({
        title: 'Login-node execution',
        message: `This run includes ${loginNodes.length} login-node tool${loginNodes.length === 1 ? '' : 's'}. Continue?`,
        detail: 'Login-node tools are best kept to setup, light inspection, or tiny commands. Heavy work should go through Slurm.',
        confirmLabel: 'Run anyway',
        cancelLabel: 'Go back',
      })
      if (!ok) return
    }
    setRunning(true)
    try {
      const runnable = snapshot.nodes.filter((n) => n.type === 'tool' || n.type === 'merge' || n.type === 'transform' || n.type === 'transfer')
      await startRun(activeConnectionId, snapshot, readiness ?? null)
      flashMessage(`Submitting ${runnable.length} node${runnable.length === 1 ? '' : 's'}...`)
    } catch (err: any) {
      console.error('Run failed:', err)
      flashMessage(err?.message ?? String(err), true)
    } finally {
      setRunning(false)
    }
  }, [activeConnectionId, confirmAction, startRun, flashMessage, confirmOnLoginNodeRun])

  const handleRun = useCallback(async () => {
    try {
      const snapshot = exportSnapshot()
      const runnable = snapshot.nodes.filter((n) => n.type === 'tool' || n.type === 'merge' || n.type === 'transform' || n.type === 'transfer')
      if (runnable.length === 0) { flashMessage('No tools to run'); return }
      if (!activeConnectionId) { flashMessage('No active connection'); return }
      if (snapshotNeedsSsh(snapshot) && activeConnectionId === LOCAL_CONNECTION_ID) { flashMessage('Run requires an SSH connection'); return }

      setRunning(true)
      let result
      try {
        result = await runChecks(snapshot, {
          includeDoctor: true,
          includeFileReadiness: !skipPreRunFileCheck,
          includeModuleChecks: true,
          includeTransfers: true,
          onProgress: setRunStatus,
        })
      } catch (err: any) {
        console.error('[PipelineToolbar] validatePipeline threw:', err)
        flashMessage(`Validation error: ${err?.message ?? String(err)}`, true)
        setRunning(false)
        return
      } finally {
        setRunStatus(null)
      }

      let scripts: DryRunScript[] = []
      if (result.validation.errorCount === 0) {
        try {
          setRunStatus('Preparing run review...')
          scripts = await window.api.pipeline.generateScriptsDry(activeConnectionId, snapshot)
        } catch (err: any) {
          result = {
            ...result,
            validation: appendValidationIssues(result.validation, [{
              severity: 'warning',
              code: 'SCRIPT_PREVIEW_UNAVAILABLE',
              message: 'BioFlow could not generate the script preview for this run review.',
              suggestion: err?.message ?? String(err),
            }]),
          }
        } finally {
          setRunStatus(null)
        }
      }

      const reviewSnapshot: PipelineSnapshot = {
        ...snapshot,
        execution: { ...(snapshot.execution ?? {}), fileLifecyclePolicy: 'keep-all' },
      }
      const review = buildRunReview({
        snapshot: reviewSnapshot,
        validation: result.validation,
        readiness: result.readiness,
        transferPlans: result.transferPlans,
        scripts,
      })
      setRunning(false)
      setConfirmDialog({ result: result.validation, snapshot: reviewSnapshot, readiness: result.readiness, review })
    } catch (err: any) {
      console.error('[PipelineToolbar] handleRun threw:', err)
      flashMessage(err?.message ?? String(err), true)
      setRunning(false)
    }
  }, [activeConnectionId, exportSnapshot, flashMessage, runChecks, skipPreRunFileCheck])

  const handlePreviewScripts = useCallback(async () => {
    const snapshot = exportSnapshot()
    const runnable = snapshot.nodes.filter((n) => n.type === 'tool' || n.type === 'merge' || n.type === 'transform' || n.type === 'transfer')
    if (runnable.length === 0) { flashMessage('No tools to preview'); return }
    if (!activeConnectionId) { flashMessage('No active connection', true); return }
    if (snapshotNeedsSsh(snapshot) && activeConnectionId === LOCAL_CONNECTION_ID) { flashMessage('Script preview requires an SSH connection', true); return }

    let result
    try {
      result = validatePipeline(snapshot, {
        schemas,
        annotationDefaults: {
          annovarDbPath: settings.annovarDbPath,
          annovarScriptsPath: settings.annovarScriptsPath,
          vepCachePath: settings.vepCachePath,
          vepPath: settings.vepPath,
        },
        dnx: {
          defaultProjectId: dnxDefaultProjectId,
          authenticated: dnxAuthenticated,
        },
      })
    } catch (err: any) {
      flashMessage(`Validation error: ${err?.message ?? String(err)}`, true)
      return
    }
    if (result.errorCount > 0) {
      setConfirmDialog({ result, snapshot, readiness: null })
      return
    }

    setPreviewLoading(true)
    try {
      const scripts = await window.api.pipeline.generateScriptsDry(activeConnectionId, snapshot)
      setScriptPreview(scripts)
    } catch (err: any) {
      console.error('Script preview failed:', err)
      flashMessage(err?.message ?? String(err), true)
    } finally {
      setPreviewLoading(false)
    }
  }, [activeConnectionId, dnxAuthenticated, dnxDefaultProjectId, exportSnapshot, flashMessage, schemas, settings.annovarDbPath, settings.vepCachePath])

  const handleCheck = useCallback(async () => {
    const snapshot = exportSnapshot()
    setCheckRunning(true)
    setCheckOpen(true)
    setCheckStatus('Fast-checking pipeline...')
    try {
      const result = await runChecks(snapshot, {
        includeDoctor: false,
        includeFileReadiness: false,
        includeModuleChecks: false,
        includeTransfers: false,
        onProgress: setCheckStatus,
      })
      setCheckReport(result.validation)
      setCheckReadinessReport(result.readiness)
    } catch (err: any) {
      setCheckReport({
        ok: false,
        issues: [{
          severity: 'error',
          code: 'CHECK_FAILED',
          message: err?.message ?? String(err),
        }],
        errorCount: 1,
        warningCount: 0,
        infoCount: 0,
      })
      setCheckReadinessReport(null)
    } finally {
      setCheckRunning(false)
      setCheckStatus(null)
    }
  }, [exportSnapshot, runChecks])

  const handleWorkflowAction = useCallback((step: WorkflowGuideStep) => {
    setWorkflowOpen(false)
    if (step.action === 'connect') {
      openConnectionDialog()
      return
    }
    if (step.action === 'templates') {
      setTemplatePicker(true)
      return
    }
    if (step.action === 'select-node' && step.nodeId) {
      setSelectedNode(step.nodeId)
      return
    }
    if (step.action === 'check') {
      void handleCheck()
      return
    }
    if (step.action === 'run') {
      void handleRun()
      return
    }
    if (step.action === 'jobs') {
      setBottomPanelMode('jobs')
      return
    }
    if (step.action === 'results') {
      setBottomPanelMode('results')
    }
  }, [handleCheck, handleRun, openConnectionDialog, setBottomPanelMode, setSelectedNode])

  const applyValidationQuickFix = useCallback((issue: ValidationIssue) => {
    if (!canApplyValidationQuickFix(issue)) return
    const resourceFix = resourceQuickFix(issue)
    if (resourceFix && issue.nodeId) {
      const node = nodes.find((candidate) => candidate.id === issue.nodeId)
      if (!node || node.type !== 'tool') return
      const patch = {
        cpus: resourceFix.cpus,
        memoryGB: resourceFix.memoryGB,
        timeHours: resourceFix.timeHours,
      }
      updateNodeData(issue.nodeId, {
        slurmOverride: { ...((node.data as ToolNodeData).slurmOverride ?? {}), ...patch },
      })
      setSelectedNode(issue.nodeId)
      const shouldRemove = (candidate: ValidationIssue) => candidate.code === issue.code && candidate.nodeId === issue.nodeId && candidate.message === issue.message
      setCheckReport((current) => current ? removeValidationIssues(current, shouldRemove) : current)
      setConfirmDialog((current) => current ? {
        ...current,
        snapshot: snapshotWithSlurmOverride(current.snapshot, issue.nodeId!, patch),
        result: removeValidationIssues(current.result, shouldRemove),
        readiness: removeReadinessIssues(current.readiness, (candidate) => candidate.code === issue.code && candidate.nodeId === issue.nodeId && candidate.message === issue.message),
      } : current)
      flashMessage(resourceFix.label)
      return
    }
    const optionFix = analysisOptionQuickFix(issue)
    if (optionFix && issue.nodeId) {
      const node = nodes.find((candidate) => candidate.id === issue.nodeId)
      if (!node || node.type !== 'tool') return
      updateNodeData(issue.nodeId, nodeDataWithAnalysisOptionEnabled(node.data as ToolNodeData, optionFix.optionId, optionFix.value))
      setSelectedNode(issue.nodeId)
      const shouldRemove = (candidate: ValidationIssue) => candidate.code === issue.code && candidate.nodeId === issue.nodeId && candidate.message === issue.message
      setCheckReport((current) => current ? removeValidationIssues(current, shouldRemove) : current)
      setConfirmDialog((current) => current ? {
        ...current,
        snapshot: snapshotWithAnalysisOptionEnabled(current.snapshot, issue.nodeId!, optionFix.optionId, optionFix.value),
        result: removeValidationIssues(current.result, shouldRemove),
        readiness: removeReadinessIssues(current.readiness, (candidate) => candidate.code === issue.code && candidate.nodeId === issue.nodeId && candidate.message === issue.message),
      } : current)
      flashMessage(optionFix.label)
      return
    }
    if (!issue.edgeId) return
    const inserted = canInsertLiftoverQuickFix(issue)
      ? insertLiftoverNodeForEdge(
          issue.edgeId,
          String(issue.details?.sourceBuild ?? ''),
          String(issue.details?.targetBuild ?? ''),
        )
      : insertTransferNodeForEdge(issue.edgeId)
    if (inserted) {
      setCheckOpen(false)
      setCheckReport(null)
      setCheckReadinessReport(null)
      setConfirmDialog(null)
      flashMessage(canInsertLiftoverQuickFix(issue) ? 'Inserted CrossMap Liftover node' : 'Inserted Transfer node')
    }
  }, [flashMessage, insertLiftoverNodeForEdge, insertTransferNodeForEdge, nodes, setSelectedNode, updateNodeData])

  const createRemoteFolderQuickFix = useCallback(async (issue: ValidationIssue) => {
    if (!activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID) {
      flashMessage('Connect to SSH before creating a remote folder', true)
      return
    }
    if (!canCreateRemoteFolderQuickFix(issue)) return
    const folder = remoteFolderFromClusterIssue(issue)
    if (!folder) {
      flashMessage('Could not determine which remote folder to create', true)
      return
    }
    try {
      const quoted = shellQuoteClient(folder)
      const result = await window.api.ssh.exec(activeConnectionId, `mkdir -p ${quoted} && test -d ${quoted} && test -w ${quoted}`)
      if (result.exitCode !== 0) {
        throw new Error((result.stderr || result.stdout || `Could not create ${folder}`).trim())
      }
      const shouldRemove = (candidate: ValidationIssue) => candidate.code === issue.code && candidate.message === issue.message
      setCheckReport((current) => current ? removeValidationIssues(current, shouldRemove) : current)
      setConfirmDialog((current) => current ? {
        ...current,
        result: removeValidationIssues(current.result, shouldRemove),
        readiness: removeReadinessIssues(current.readiness, (candidate) => candidate.code === issue.code && candidate.message === issue.message),
      } : current)
      flashMessage(`Created ${folder}`)
    } catch (err: any) {
      flashMessage(err?.message ?? String(err), true)
    }
  }, [activeConnectionId, flashMessage])

  const applyModuleSuggestion = useCallback((issue: ValidationIssue, moduleName: string) => {
    const trimmed = moduleName.trim()
    if (!issue.nodeId || !trimmed) return
    updateNodeData(issue.nodeId, { moduleOverride: trimmed } as Partial<ToolNodeData>)
    setSelectedNode(issue.nodeId)
    setCheckReport((current) => current ? removeValidationIssues(current, (candidate) => isMatchingModuleIssue(candidate, issue)) : current)
    setConfirmDialog((current) => current ? {
      ...current,
      snapshot: snapshotWithModuleOverride(current.snapshot, issue.nodeId!, trimmed),
      result: removeValidationIssues(current.result, (candidate) => isMatchingModuleIssue(candidate, issue)),
      readiness: removeReadinessIssues(current.readiness, (candidate) => isMatchingModuleIssue(candidate, issue)),
    } : current)
    flashMessage(`Using module ${trimmed}`)
  }, [flashMessage, setSelectedNode, updateNodeData])

  const selectValidationIssueNode = useCallback((issue: ValidationIssue) => {
    if (!issue.nodeId) return
    setSelectedNode(issue.nodeId)
    setCheckOpen(false)
    setConfirmDialog(null)
  }, [setSelectedNode])

  const handleCancelRun = useCallback(async () => {
    if (!activeRunId || !activeRunIsCancellable) return
    const confirmed = await confirmAction({
      title: 'Cancel run',
      message: 'Cancel this run? Submitted Slurm jobs will be cancelled.',
      confirmLabel: 'Cancel run',
      cancelLabel: 'Keep running',
      danger: true,
    })
    if (!confirmed) return
    try {
      await cancelRun(activeRunId)
      flashMessage('Run cancelled')
    } catch (err: any) {
      console.error('Cancel failed:', err)
      flashMessage(`Cancel failed: ${err?.message ?? err}`)
    }
  }, [activeRunId, activeRunIsCancellable, cancelRun, confirmAction, flashMessage])

  useEffect(() => {
    const onMenuCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ command: 'new' | 'open' | 'save' | 'saveAs' }>).detail
      if (!detail) return
      if (detail.command === 'new') void handleNew()
      if (detail.command === 'open') void handleOpen()
      if (detail.command === 'save') void handleSave()
      if (detail.command === 'saveAs') void handleSaveAs()
    }
    window.addEventListener('bioflow:menu-command', onMenuCommand as EventListener)
    return () => window.removeEventListener('bioflow:menu-command', onMenuCommand as EventListener)
  }, [handleNew, handleOpen, handleSave, handleSaveAs])

  return (
    <>
      <div data-tour="run-toolbar" className="h-10 px-3 bg-bg-secondary border-b border-border flex items-center gap-2 shrink-0">
        {/* Pipeline name */}
        <div className="flex items-center gap-2 min-w-0">
          {editingName ? (
            <Input
              autoFocus
              value={pipelineName}
              onChange={(e) => setPipelineName(e.target.value)}
              onBlur={() => setEditingName(false)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditingName(false) }}
              className="h-6 w-48 text-xs"
            />
          ) : (
            <button
              onClick={() => setEditingName(true)}
              className="text-sm font-medium text-text-primary hover:text-accent transition-colors truncate max-w-[240px]"
              title="Click to rename"
            >
              {pipelineName}
            </button>
          )}
          {dirty && <span className="w-1.5 h-1.5 rounded-full bg-accent" title="Unsaved changes" />}
          <span className="text-[10px] text-text-muted">{nodes.length} node{nodes.length === 1 ? '' : 's'}</span>
          {settings.workflowGuideEnabled && (
            <div className="relative" ref={workflowRef}>
              <button
                type="button"
                onClick={() => setWorkflowOpen((open) => !open)}
                className={classNames(
                  'inline-flex h-6 max-w-[230px] items-center gap-1.5 rounded px-2 text-[10px] font-medium transition-colors',
                  workflowGuide.current.status === 'blocked'
                    ? 'bg-error/15 text-error'
                    : workflowGuide.current.status === 'active'
                      ? 'bg-accent/10 text-accent'
                      : 'text-text-muted hover:bg-bg-tertiary hover:text-text-primary',
                )}
                title={workflowGuide.current.detail}
              >
                <ListChecks size={12} />
                <span className="truncate">Next: {workflowGuide.current.title}</span>
              </button>
              {workflowOpen && (
                <div className="absolute left-0 top-full z-50 mt-1 w-[390px] rounded-lg border border-border bg-bg-secondary p-2 shadow-lg">
                  <div className="mb-1 px-1 text-[10px] uppercase tracking-wider text-text-muted">Workflow guide</div>
                  <div className="flex flex-col gap-1">
                    {workflowGuide.steps.map((step) => (
                      <div key={step.id} className="rounded-md border border-border-light bg-bg-primary px-2 py-2">
                        <div className="flex items-start gap-2">
                          <span className={classNames('mt-0.5 h-2 w-2 shrink-0 rounded-full', workflowStatusDot(step.status))} />
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-medium text-text-primary">{step.title}</div>
                            <div className="mt-0.5 text-[10px] leading-snug text-text-muted">{step.detail}</div>
                          </div>
                          {step.action && (
                            <button
                              type="button"
                              onClick={() => handleWorkflowAction(step)}
                              className="shrink-0 rounded border border-border bg-bg-tertiary px-2 py-1 text-[10px] text-text-secondary hover:text-text-primary"
                            >
                              {step.actionLabel ?? 'Open'}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="relative" ref={checkRef}>
            <button
              onClick={() => void handleCheck()}
              disabled={checkRunning}
              className={classNames(
                'inline-flex items-center gap-1.5 rounded px-2 h-6 text-[10px] font-medium transition-colors',
                checkRunning
                  ? 'bg-accent/10 text-accent'
                  : '',
                !checkReport
                  ? 'text-text-muted hover:text-text-primary hover:bg-bg-tertiary'
                  : checkReport.errorCount > 0
                    ? 'bg-error/15 text-error'
                    : checkReport.warningCount > 0
                      ? 'bg-warning/15 text-warning'
                      : checkReport.infoCount > 0
                        ? 'bg-accent/10 text-accent'
                        : 'bg-success/10 text-success',
              )}
              title={checkStatus ?? 'Check pipeline structure and file readiness'}
            >
              {checkRunning ? (
                <Loader2 size={12} className="animate-spin" />
              ) : checkReport ? (
                checkReport.errorCount > 0 ? <XCircle size={12} /> : checkReport.warningCount > 0 ? <AlertTriangle size={12} /> : checkReport.infoCount > 0 ? <Info size={12} /> : <CheckCircle2 size={12} />
              ) : <CheckSquare size={11} />}
              {checkRunning
                ? 'Checking...'
                : checkReport
                ? checkReport.errorCount > 0
                  ? `${checkReport.errorCount} errors`
                  : checkReport.warningCount > 0
                    ? `${checkReport.warningCount} warnings`
                    : checkReport.infoCount > 0
                      ? `${checkReport.infoCount} notes`
                      : 'Checked'
                : 'Check'}
            </button>
            {checkOpen && (checkReport || checkRunning) && (
              <div className="absolute left-0 top-full z-50 mt-1 max-h-[420px] w-[420px] overflow-auto rounded-lg border border-border bg-bg-secondary py-1 shadow-lg">
                {checkRunning && (
                  <div className="flex items-center gap-2 border-b border-border-light px-3 py-2 text-xs text-text-secondary">
                    <Loader2 size={13} className="animate-spin text-accent" />
                    <span>{checkStatus ?? 'Checking...'}</span>
                  </div>
                )}
                {checkReport && (
                  <>
                {checkReadinessReport && (
                  <div className="border-b border-border-light px-3 py-2 text-[10px] text-text-muted">
                    Fast check: {checkReadinessReport.errorCount} errors, {checkReadinessReport.warningCount} warnings, {checkReadinessReport.infoCount} notes. File probes, module checks, transfer planning, and cluster doctor run when you press Run.
                  </div>
                )}
                {READINESS_GROUPS.map((group) => {
                  const issues = groupIssues(checkReport.issues)[group]
                  if (issues.length === 0) return null
                  return (
                    <div key={group}>
                      <div className="border-b border-border-light px-3 py-1 text-[9px] uppercase tracking-wider text-text-muted">
                        {group} ({issues.length})
                      </div>
                      {issues.map((issue, index) => (
                        <div key={`${group}-${index}`} className="px-4 py-2 border-b border-border-light/50 last:border-0 flex items-start gap-2">
                          <span className={`text-[10px] font-mono shrink-0 mt-px ${issue.severity === 'error' ? 'text-error' : issue.severity === 'warning' ? 'text-warning' : 'text-accent'}`}>
                            {issue.code}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="text-xs text-text-primary leading-snug">{issue.message}</div>
                            {issue.suggestion && (
                              <div className="text-[10px] text-text-muted mt-0.5 leading-snug">{issue.suggestion}</div>
                            )}
                          </div>
                          {issue.nodeId && (
                            <button
                              type="button"
                              onClick={() => selectValidationIssueNode(issue)}
                              className="shrink-0 rounded border border-border bg-bg-tertiary px-2 py-1 text-[10px] text-text-secondary hover:text-text-primary"
                            >
                              Select
                            </button>
                          )}
                          {canApplyValidationQuickFix(issue) && (
                            <button
                              type="button"
                              onClick={() => applyValidationQuickFix(issue)}
                              className="shrink-0 rounded bg-accent px-2 py-1 text-[10px] text-white hover:brightness-110"
                            >
                              {validationQuickFixLabel(issue)}
                            </button>
                          )}
                          {canCreateRemoteFolderQuickFix(issue) && (
                            <button
                              type="button"
                              onClick={() => void createRemoteFolderQuickFix(issue)}
                              className="shrink-0 rounded bg-accent px-2 py-1 text-[10px] text-white hover:brightness-110"
                            >
                              Create folder
                            </button>
                          )}
                          {moduleCandidatesFromIssue(issue).length > 0 && (
                            <ModuleSuggestionPicker issue={issue} onApply={applyModuleSuggestion} />
                          )}
                        </div>
                      ))}
                    </div>
                  )
                })}
                {checkReport.issues.length === 0 && (
                  <div className="px-3 py-2 text-xs text-text-secondary">Fast check passed. Full file, module, transfer, and cluster checks run when you press Run.</div>
                )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Feedback message — errors shown in red for 7s, info in accent for 2s */}
        {savedMessage && (
          <span
            className={`ml-2 px-2 py-0.5 text-[10px] rounded max-w-[420px] truncate ${
              savedMessage.isError
                ? 'bg-error/10 text-error'
                : 'bg-accent/10 text-accent animate-pulse'
            }`}
            title={savedMessage.isError ? savedMessage.text : undefined}
          >
            {savedMessage.text}
          </span>
        )}

        <div className="flex-1" />

        {/* Actions */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={undo}
            disabled={past.length === 0}
            className={classNames(
              'p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors',
              'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
            )}
            title="Undo (Cmd/Ctrl+Z)"
          >
            <Undo2 size={14} />
          </button>
          <button
            onClick={redo}
            disabled={future.length === 0}
            className={classNames(
              'p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors',
              'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
            )}
            title="Redo (Shift+Cmd/Ctrl+Z)"
          >
            <Redo2 size={14} />
          </button>

          <div className="w-px h-5 bg-border mx-1" />

          <button
            onClick={handleNew}
            className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            title="New pipeline"
          >
            <FilePlus2 size={14} />
          </button>
          <button
            onClick={handleOpen}
            className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            title="Open pipeline"
          >
            <FolderOpen size={14} />
          </button>
          <button
            onClick={handleImport}
            className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            title="Import pipeline JSON"
          >
            <Download size={14} className="rotate-180" />
          </button>
          <button
            onClick={handleSave}
            className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            title="Save pipeline"
          >
            <Save size={14} />
          </button>
          <button
            onClick={handleTemplate}
            className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            title="Load template"
          >
            <LayoutTemplate size={14} />
          </button>
          <button
            onClick={handleExport}
            className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            title="Export as JSON"
          >
            <Download size={14} />
          </button>

          <div className="w-px h-5 bg-border mx-1" />

          <Button
            variant="secondary"
            size="sm"
            onClick={handlePreviewScripts}
            disabled={previewLoading}
            className="h-7 px-2.5 text-xs"
          >
            <FileCode2 size={12} className="mr-1" />
            {previewLoading ? 'Previewing...' : 'Preview'}
          </Button>

          <Button
            variant="primary"
            size="sm"
            onClick={handleRun}
            disabled={running}
            className="h-7 px-2.5 text-xs min-w-[72px] justify-center"
            title={runStatus ?? undefined}
          >
            <Play size={12} className="mr-1 shrink-0" />
            {runStatus
              ? <span className="truncate max-w-[140px]">{runStatus}</span>
              : running ? 'Running...' : 'Run'}
          </Button>
          {activeRunId && activeRunIsCancellable && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCancelRun}
              className="h-7 px-2.5 text-xs ml-1 text-red-400 hover:bg-red-500/10"
              title="Cancel active run"
            >
              <Square size={12} className="mr-1" />
              Cancel
            </Button>
          )}
        </div>
      </div>

      {/* Run confirmation modal — rendered outside the toolbar so it covers the full viewport */}
      {confirmDialog && (
        <RunConfirmDialog
          result={confirmDialog.result}
          review={confirmDialog.review}
          snapshot={confirmDialog.snapshot}
          onQuickFix={applyValidationQuickFix}
          onCreateRemoteFolder={(issue) => void createRemoteFolderQuickFix(issue)}
          onApplyModule={applyModuleSuggestion}
          onSelectNode={selectValidationIssueNode}
          onClose={() => setConfirmDialog(null)}
          onRunAnyway={async (snapshotToRun) => {
            const readiness = confirmDialog.readiness
            setConfirmDialog(null)
            await submitRun(snapshotToRun, readiness)
          }}
        />
      )}
      {scriptPreview && (
        <ScriptPreviewModal scripts={scriptPreview} onClose={() => setScriptPreview(null)} />
      )}
      <ClusterDoctorDialog open={Boolean(doctorDialog)} onClose={() => setDoctorDialog(null)} connectionId={activeConnectionId} report={doctorDialog} />

      <Dialog
        open={openPicker !== null}
        onClose={() => setOpenPicker(null)}
        title="Open pipeline"
      >
        {openPicker && openPicker.length === 0 ? (
          <div className="text-sm text-text-muted">No saved pipelines.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {openPicker?.map((entry) => (
              <button
                key={entry.id}
                onClick={() => void confirmOpen(entry.id)}
                className="flex items-center justify-between gap-2 px-3 py-2 rounded border border-border-light hover:bg-bg-hover text-left"
              >
                <span className="text-sm text-text-primary truncate">{entry.name}</span>
                <span className="text-[10px] font-mono text-text-muted shrink-0">{entry.id}</span>
              </button>
            ))}
          </div>
        )}
      </Dialog>

      <Dialog
        open={templatePicker}
        onClose={() => setTemplatePicker(false)}
        title="Load template"
      >
        <div className="flex flex-col gap-1">
          {PIPELINE_TEMPLATES.map((template, idx) => (
            <button
              key={template.id}
              onClick={() => confirmTemplate(idx)}
              className="flex flex-col gap-0.5 px-3 py-2 rounded border border-border-light hover:bg-bg-hover text-left"
            >
              <span className="text-sm text-text-primary">{template.name}</span>
              <span className="text-[11px] text-text-muted">{template.description}</span>
            </button>
          ))}
        </div>
      </Dialog>
    </>
  )
}
