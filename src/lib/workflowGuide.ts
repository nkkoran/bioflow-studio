import type { FileNodeData, PipelineSnapshot, RunStatus } from '@/types/pipeline'
import type { ValidationResult } from '@/lib/pipelineValidator'

export type WorkflowStepStatus = 'done' | 'active' | 'blocked' | 'pending'
export type WorkflowStepAction = 'connect' | 'templates' | 'select-node' | 'check' | 'run' | 'jobs' | 'results'

export interface WorkflowGuideStep {
  id: 'data' | 'configure' | 'connection' | 'check' | 'run' | 'results'
  title: string
  detail: string
  status: WorkflowStepStatus
  action?: WorkflowStepAction
  actionLabel?: string
  nodeId?: string
}

export interface WorkflowGuide {
  current: WorkflowGuideStep
  steps: WorkflowGuideStep[]
}

export function buildWorkflowGuide(
  snapshot: PipelineSnapshot,
  opts: {
    validation?: ValidationResult | null
    activeConnectionId?: string | null
    localConnectionId?: string
    activeRunStatus?: RunStatus | null
    activeRunOutputCount?: number
  } = {},
): WorkflowGuide {
  const runnableCount = snapshot.nodes.filter((node) =>
    node.type === 'tool' || node.type === 'merge' || node.type === 'transform' || node.type === 'transfer'
  ).length
  const inputFiles = snapshot.nodes.filter((node) => node.type === 'file' && (node.data as FileNodeData).isInput)
  const missingInput = inputFiles.find((node) => {
    const data = node.data as FileNodeData
    const splitItems = data.split?.items ?? []
    return !data.path?.trim() && splitItems.length === 0
  })
  const missingBuild = inputFiles.find((node) => {
    const data = node.data as FileNodeData
    if (!isGenomeCoordinateType(data.fileType)) return false
    return !String(data.genomeBuild ?? '').trim() && !buildFromText(`${data.label} ${data.path}`)
  })
  const validation = opts.validation ?? null
  const firstValidationNode = validation?.issues.find((issue) => issue.nodeId)?.nodeId
  const needsSsh = snapshotNeedsSsh(snapshot)
  const hasSshConnection = Boolean(opts.activeConnectionId && opts.activeConnectionId !== opts.localConnectionId)
  const connectionReady = !needsSsh || hasSshConnection
  const hasOutputs = (opts.activeRunOutputCount ?? 0) > 0
  const runStatus = opts.activeRunStatus ?? null

  const dataStep: WorkflowGuideStep = missingInput
    ? {
        id: 'data',
        title: 'Attach input files',
        detail: `${inputFiles.length} input file node${inputFiles.length === 1 ? '' : 's'}, with at least one missing a path.`,
        status: 'active',
        action: 'select-node',
        actionLabel: 'Select missing input',
        nodeId: missingInput.id,
      }
    : inputFiles.length > 0
      ? {
          id: 'data',
          title: 'Input files are attached',
          detail: `${inputFiles.length} input file node${inputFiles.length === 1 ? '' : 's'} ready on the canvas.`,
          status: 'done',
        }
      : {
          id: 'data',
          title: 'Add data',
          detail: 'Drag files or folders onto the canvas, or start from a template.',
          status: 'active',
          action: 'templates',
          actionLabel: 'Load template',
        }

  const configureStep: WorkflowGuideStep = runnableCount === 0
    ? {
        id: 'configure',
        title: 'Add analysis steps',
        detail: 'Choose a tool from the palette and connect it to your inputs.',
        status: 'pending',
        action: 'templates',
        actionLabel: 'Load template',
      }
    : validation?.errorCount
      ? {
          id: 'configure',
          title: 'Fix required settings',
          detail: `${validation.errorCount} error${validation.errorCount === 1 ? '' : 's'} need attention before this can run.`,
          status: 'active',
          action: firstValidationNode ? 'select-node' : 'check',
          actionLabel: firstValidationNode ? 'Select first issue' : 'Open check',
          nodeId: firstValidationNode,
        }
      : missingBuild
        ? {
            id: 'configure',
            title: 'Confirm genome builds',
            detail: 'Coordinate-bearing inputs are missing build metadata, so build-mismatch checks will be weaker.',
            status: 'active',
            action: 'select-node',
            actionLabel: 'Set build',
            nodeId: missingBuild.id,
          }
        : {
            id: 'configure',
            title: 'Analysis settings look configured',
            detail: `${runnableCount} runnable step${runnableCount === 1 ? '' : 's'} on the canvas.`,
            status: 'done',
          }

  const connectionStep: WorkflowGuideStep = connectionReady
    ? {
        id: 'connection',
        title: needsSsh ? 'Cluster connection is ready' : 'No cluster connection needed yet',
        detail: needsSsh ? 'The pipeline can submit SSH/Slurm-backed work.' : 'This pipeline is DNAnexus-only or still being drafted.',
        status: 'done',
      }
    : {
        id: 'connection',
        title: 'Connect to a cluster',
        detail: 'This pipeline has SSH/Slurm-backed steps and needs a live server connection before Run.',
        status: 'blocked',
        action: 'connect',
        actionLabel: 'Connect',
      }

  const checkStep: WorkflowGuideStep = validation?.warningCount
    ? {
        id: 'check',
        title: 'Review warnings',
        detail: `${validation.warningCount} warning${validation.warningCount === 1 ? '' : 's'} should be reviewed before running.`,
        status: 'active',
        action: 'check',
        actionLabel: 'Open check',
      }
    : validation && validation.errorCount === 0 && runnableCount > 0
      ? {
          id: 'check',
          title: 'Pre-run check is clean',
          detail: 'Run the async Check when you want file/schema/cluster readiness too.',
          status: 'done',
          action: 'check',
          actionLabel: 'Check again',
        }
      : {
          id: 'check',
          title: 'Run pre-flight check',
          detail: 'BioFlow will validate structure, files, columns, and cluster readiness.',
          status: runnableCount > 0 ? 'active' : 'pending',
          action: 'check',
          actionLabel: 'Check',
        }

  const canRun = runnableCount > 0 && connectionReady && (validation?.errorCount ?? 0) === 0
  const runStep: WorkflowGuideStep = runStatus === 'running' || runStatus === 'queued'
    ? {
        id: 'run',
        title: 'Run is in progress',
        detail: 'Watch logs and step status in the Jobs tab.',
        status: 'active',
        action: 'jobs',
        actionLabel: 'Open jobs',
      }
    : runStatus === 'done'
      ? {
          id: 'run',
          title: 'Latest run finished',
          detail: 'Review outputs in Results or restore the run snapshot if needed.',
          status: 'done',
          action: 'results',
          actionLabel: 'Open results',
        }
      : canRun
        ? {
            id: 'run',
            title: 'Ready to run',
            detail: validation?.warningCount ? 'Warnings will require confirmation.' : 'The pipeline can be submitted now.',
            status: 'active',
            action: 'run',
            actionLabel: 'Run',
          }
        : {
            id: 'run',
            title: 'Run after setup',
            detail: 'Complete the active steps above before submitting jobs.',
            status: 'pending',
          }

  const resultsStep: WorkflowGuideStep = hasOutputs
    ? {
        id: 'results',
        title: 'Outputs are available',
        detail: `${opts.activeRunOutputCount} output path${opts.activeRunOutputCount === 1 ? '' : 's'} recorded for the active run.`,
        status: 'active',
        action: 'results',
        actionLabel: 'Browse results',
      }
    : runStatus === 'done'
      ? {
          id: 'results',
          title: 'No outputs recorded yet',
          detail: 'Open the run folder if the tool wrote files outside declared outputs.',
          status: 'active',
          action: 'jobs',
          actionLabel: 'Open jobs',
        }
      : {
          id: 'results',
          title: 'Results come after a run',
          detail: 'Finished runs will appear in the Results tab with preview and reuse actions.',
          status: 'pending',
        }

  const steps = [dataStep, configureStep, connectionStep, checkStep, runStep, resultsStep]
  const current = runStatus === 'running' || runStatus === 'queued'
    ? runStep
    : hasOutputs || runStatus === 'done'
      ? resultsStep
      : steps.find((step) => step.status === 'blocked' || step.status === 'active') ?? steps[steps.length - 1]
  return {
    current,
    steps,
  }
}

function snapshotNeedsSsh(snapshot: PipelineSnapshot): boolean {
  return snapshot.nodes.some((node) => {
    if (node.type === 'merge' || node.type === 'transform') return true
    if (node.type === 'transfer') {
      const data = node.data as { from?: string; to?: string }
      return data.from === 'ssh' || data.to === 'ssh'
    }
    if (node.type === 'tool') return (node.data as { backend?: string }).backend !== 'dnx'
    return false
  })
}

function isGenomeCoordinateType(fileType: string): boolean {
  return ['vcf', 'bcf', 'bed', 'plink', 'pgen', 'bgen', 'bam', 'cram', 'sam', 'gff', 'gtf'].includes(fileType)
}

function buildFromText(text: string): string | null {
  const lower = text.toLowerCase()
  if (/\b(grch37|hg19|b37)\b/.test(lower)) return 'GRCh37'
  if (/\b(grch38|hg38|b38)\b/.test(lower)) return 'GRCh38'
  return null
}
