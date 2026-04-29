/**
 * Pipeline data model types.
 *
 * A pipeline is a directed acyclic graph of tool invocations.
 * Each node is either a tool (bcftools, plink2, etc.) or a file reference.
 * Edges represent data flow (output file → input file).
 */

import type {
  ArtifactRecipe,
  OutputSchemaDef,
  ParameterRule,
  PortContract,
  RoleMapping,
} from './readiness'
import type { FileOrigin } from '@/constants/connections'

/** File-type categories used to validate connections between nodes. */
export type FileType =
  | 'vcf' | 'bcf'            // variant calling
  | 'fastq' | 'fasta'        // sequences
  | 'bam' | 'sam' | 'cram'   // alignments
  | 'bed' | 'gff' | 'gtf'    // annotations
  | 'plink' | 'bgen' | 'pgen' // genotype matrices
  | 'tsv' | 'csv' | 'txt'    // generic tabular
  | 'json' | 'yaml'          // config
  | 'any'                    // anything

/** A single parameter on a tool. */
export interface ToolParam {
  name: string              // canonical param name (e.g., "maf")
  flag?: string             // CLI flag (e.g., "--maf")
  label: string             // display label
  description?: string
  docUrl?: string
  section?: 'Inputs' | 'Analysis' | 'Filters' | 'Output' | 'Runtime'
  core?: boolean
  advanced?: boolean
  type: 'string' | 'number' | 'boolean' | 'file' | 'select' | 'multi-select'
  default?: string | number | boolean
  required?: boolean
  options?: string[]        // for select types
  placeholder?: string
  min?: number
  max?: number
  step?: number
  /** Render this param as a schema-aware column picker when possible. */
  columnRef?: boolean
  /** Prefer columns from this connected input port (e.g. "pheno", "covar"). */
  columnSourcePortId?: string
  /** When true, render the column picker as add/remove chips instead of a single text field. */
  columnMulti?: boolean
  /** When true, this param is managed by a dedicated UI section and should be hidden from the generic options panel. */
  internal?: boolean
}

export type ValueSourceKind =
  | 'literal'
  | 'upstream-column'
  | 'upstream-file'
  | 'path'
  | 'local-path'

export interface ValueSource {
  kind: ValueSourceKind
  value?: string
  portId?: string
}

export interface ToolFlagDef {
  id: string
  flag: string
  label: string
  group: 'Input' | 'Model' | 'Filters' | 'Output' | 'Resources' | 'Advanced'
  kind: 'toggle' | 'value' | 'columnRef' | 'fileInput' | 'list' | 'enum' | 'raw'
  description?: string
  docUrl?: string
  requires?: string[]
  conflicts?: string[]
  defaultEnabled?: boolean
  defaultValue?: unknown
  options?: string[]
  placeholder?: string
  sourcePortId?: string
  multiValue?: boolean
  requiredValue?: boolean
  paramName?: string
}

export interface ToolFlagBlock {
  id: string
  flagId: string
  value?: unknown
  enabled: boolean
  customFlag?: string
  customLabel?: string
  customInputKind?: 'text' | 'file'
}

export type AnalysisOptionKind =
  | 'switch'
  | 'text'
  | 'number'
  | 'enum'
  | 'list'
  | 'column'
  | 'file'
  | 'compound'
  | 'custom'

export type AnalysisOptionGroup = 'Input' | 'Model' | 'Filters' | 'Output' | 'Resources' | 'Advanced'

export interface AnalysisSubOptionState {
  enabled?: boolean
  value?: unknown
}

export interface AnalysisOptionState {
  optionId: string
  enabled: boolean
  value?: unknown
  source?: ValueSource
  subOptions?: Record<string, AnalysisSubOptionState>
  customFlag?: string
  customLabel?: string
  customInputKind?: 'text' | 'file'
}

/** Input/output port on a tool. */
export interface ToolPort {
  id: string                // unique within node (e.g., "input", "output")
  label: string
  description?: string      // plain-language explanation shown in the inspector
  fileType: FileType
  contract?: PortContract
  outputSchema?: OutputSchemaDef
  autoMergeDefault?: MergeStrategy
  intermediate?: boolean
  required?: boolean
  multi?: boolean           // accepts multiple files
  /**
   * If false, the runtime must NOT auto-fan-out this input into a Slurm array
   * even when an axed (per-chrom, etc.) source is connected. Defaults to true.
   */
  arrayable?: boolean
  /**
   * How multiple values are rendered to the command line when `multi: true`
   * (or when a fan-in consumes an axed edge). Default: 'repeat'.
   * Examples (flag = "-i"):
   *   repeat  → -i a -i b -i c
   *   comma   → -i a,b,c
   *   space   → -i a b c
   */
  multiFormat?: 'repeat' | 'comma' | 'space'
}

/** Definition of a tool (static — defined in tool registry). */
export interface ToolDef {
  id: string                // unique id (e.g., "plink2.assoc")
  name: string              // display name (e.g., "PLINK2 Association")
  category: ToolCategory
  description: string
  docUrl?: string
  command: string           // binary name (e.g., "plink2")
  module?: string           // HPC module to load (e.g., "plink/2.00a3")
  inputs: ToolPort[]
  outputs: ToolPort[]
  params: ToolParam[]
  artifactRecipes?: ArtifactRecipe[]
  parameterRules?: ParameterRule[]
  /** Slurm defaults — can be overridden per-node */
  slurm?: {
    cpus?: number
    memoryGB?: number
    timeHours?: number
    partition?: string
  }
  /** Advisory metadata for tools that need local/reference databases. */
  requiresDatabase?: { name: string; guideKey: string }
  backends?: Array<'ssh' | 'dnx'>
  dnxApplet?: { id?: string; name?: string }
}

export type ToolCategory =
  | 'variant-calling'
  | 'alignment'
  | 'qc'
  | 'gwas'
  | 'annotation'
  | 'format'
  | 'utility'
  | 'custom'

/**
 * An instantiated tool in the pipeline (= a node in the graph).
 *
 * The `[key: string]: unknown` index signature is required because React Flow's
 * `Node.data` type extends `Record<string, unknown>` in v12.
 */
export interface ToolNodeData {
  toolId: string                               // references ToolDef.id
  label: string                                // user-editable display label
  paramValues: Record<string, unknown>         // name -> value
  flagBlocks?: ToolFlagBlock[]
  analysisOptions?: AnalysisOptionState[]
  commandOverride?: string
  backend?: 'ssh' | 'dnx'
  dnxInstanceType?: string
  roleMappings?: Record<string, RoleMapping>
  outputMerge?: Record<string, { mode: 'fan-out' | 'auto-merge'; strategy?: MergeStrategy }>
  outputIntermediate?: Record<string, boolean>
  /** Optional module name to load instead of the registry default. */
  moduleOverride?: string
  slurmOverride?: {
    cpus?: number
    memoryGB?: number
    timeHours?: number
    partition?: string
  }
  /**
   * Port id to fan out over when multiple axed inputs are present.
   * Undefined → auto-pick the single axed non-multi input.
   * Null      → force a single job even if an axed input is connected.
   */
  arrayOver?: string | null
  /**
   * Optional absolute output directory override. When set, this node's outputs
   * land under `<outputDirOverride>/<slug>/...` instead of the run's default
   * `<workDir>/outputs/<slug>`. Downstream references to this node's outputs
   * are resolved from the same path by axisPlanner.
   */
  outputDirOverride?: string
  /** Run through Slurm by default; login is for small, interactive-safe jobs. */
  executionMode?: 'sbatch' | 'login'
  /** Execution status — populated by runtime, not user-editable */
  status?: 'idle' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  /** Slurm job id when running */
  jobId?: string
  /** Last error message if failed */
  error?: string
  [key: string]: unknown
}

export type SlurmOverride = NonNullable<ToolNodeData['slurmOverride']>

/**
 * Axis metadata for a file node that represents a split input (e.g., one
 * pgen per chromosome). When present, the node emits one path per `items`
 * entry on its outgoing edges, and downstream tools fan out into a SLURM
 * array over the same axis.
 */
export interface FileNodeSplit {
  axis: string                  // e.g., "chrom"
  items: Array<{ key: string; path: string }>
  glob?: string                 // optional — original pattern, display only
  pattern?: SplitPattern        // source pattern used to materialize items
}

export type SplitPattern =
  | { kind: 'manual' }
  | { kind: 'brace'; template: string }
  | { kind: 'glob'; template: string; capture: string }
  | { kind: 'crossFolder'; parentDir: string; childGlob: string; file: string }

export interface NodeGroup {
  id: string
  label: string
  nodeIds: string[]
  kind?: 'execution' | 'visual'
  sharedResources?: SlurmOverride
  collapsed?: boolean
  axisSummary?: string
}

/** A file node — represents an input/output file in the graph. */
export interface FileNodeData {
  label: string
  path: string                  // remote path; used when split is absent
  source?: 'local' | 'remote'
  origin?: FileOrigin
  fileType: FileType
  isInput: boolean              // true = source, false = sink
  outputFilename?: string
  outputDir?: string
  /** When set, this node is an axed source (per-chrom, per-sample, etc.). */
  split?: FileNodeSplit
  [key: string]: unknown
}

export type MergeStrategy =
  | 'auto'
  | 'tsv-concat-header'
  | 'bcftools-concat'
  | 'plink-pmerge-list'
  | 'cat'
  | 'tabular-inner'
  | 'tabular-outer'
  | 'tabular-left'

/**
 * Data for a merge node — a dedicated fan-in that collapses an axed edge
 * back into a single file. The runner submits the merge as a single Slurm
 * job with `--dependency=afterok:<arrayJobId>`.
 */
export interface MergeNodeData {
  label: string
  strategy: MergeStrategy
  convergeMode?: 'axed-fan-in' | 'parallel-branches'
  inputHandles?: Array<{ id: string; label: string }>
  columnPreview?: MergeColumnPreview
  outputIntermediate?: Record<string, boolean>
  /** See ToolNodeData.outputDirOverride. */
  outputDirOverride?: string
  slurmOverride?: {
    cpus?: number
    memoryGB?: number
    timeHours?: number
    partition?: string
  }
  status?: ToolNodeData['status']
  jobId?: string
  error?: string
  [key: string]: unknown
}

export interface MergeColumnPreview {
  files: Array<{ path: string; label: string; columns: string[] }>
  sharedColumns: string[]
  divergentColumns: Array<{ name: string; files: string[] }>
}

export interface TransferNodeData {
  label: string
  from: 'local' | 'ssh' | 'dnx'
  to: 'local' | 'ssh' | 'dnx'
  dnxProjectId?: string
  dnxFolder?: string
  sshFolder?: string
  outputName?: string
  status?: ToolNodeData['status']
  jobId?: string
  error?: string
  [key: string]: unknown
}

export type TransformFilterOp =
  | 'contains'
  | 'regex'
  | 'equals'
  | 'notEquals'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'notEmpty'

export interface TransformFilterRule {
  id: string
  column: string
  join?: 'and' | 'or'
  op: TransformFilterOp
  value?: string
}

export interface TransformRenameRule {
  from: string
  to: string
}

export interface TransformNodeData {
  label: string
  fileType: Extract<FileType, 'tsv' | 'csv' | 'txt' | 'any'>
  preset?: ArtifactRecipe['preset']
  roleMappings?: Record<string, RoleMapping>
  presetConfig?: Record<string, unknown>
  selectedColumns?: string[]
  filters?: TransformFilterRule[]
  renames?: TransformRenameRule[]
  outputMerge?: Record<string, { mode: 'fan-out' | 'auto-merge'; strategy?: MergeStrategy }>
  outputIntermediate?: Record<string, boolean>
  /** See ToolNodeData.outputDirOverride. */
  outputDirOverride?: string
  slurmOverride?: {
    cpus?: number
    memoryGB?: number
    timeHours?: number
    partition?: string
  }
  status?: ToolNodeData['status']
  jobId?: string
  error?: string
  [key: string]: unknown
}

export type BioflowNodeType = 'tool' | 'file' | 'note' | 'merge' | 'transform' | 'transfer'

/** Data payload for a note/comment node. */
export interface NoteNodeData {
  text: string
  color?: string
  [key: string]: unknown
}

/** Serializable pipeline snapshot. */
export interface PipelineSnapshot {
  version: 1
  id: string
  name: string
  description?: string
  execution?: {
    arrayChainMode?: 'task-level' | 'job-level'
    fileLifecyclePolicy?: 'keep-all' | 'keep-outputs-only' | 'delete-intermediates-on-success'
  }
  createdAt: number
  updatedAt: number
  nodes: Array<{
    id: string
    type: BioflowNodeType
    position: { x: number; y: number }
    data: ToolNodeData | FileNodeData | NoteNodeData | MergeNodeData | TransformNodeData | TransferNodeData
  }>
  edges: Array<{
    id: string
    source: string
    sourceHandle?: string
    target: string
    targetHandle?: string
  }>
  groups?: NodeGroup[]
}

// ===================== Execution runtime types =====================

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface NodeRunState {
  nodeId: string
  toolId?: string
  status: ToolNodeData['status']
  jobId?: string                // Slurm job id (array jobs use the parent id)
  scriptPath?: string           // remote path to the submitted sbatch script
  stdoutPath?: string           // pattern; for arrays contains %A_%a
  stderrPath?: string
  /** Absolute remote dir where this node's outputs land. */
  outputDir?: string
  /** Absolute remote output files resolved for this node's output ports. */
  outputPaths?: string[]
  submittedAt?: number
  startedAt?: number
  finishedAt?: number
  exitCode?: number
  error?: string
  /** True if this job was submitted as a SLURM array. */
  isArray?: boolean
  /** For array jobs: number of tasks. */
  arraySize?: number
}

export interface RunState {
  runId: string
  pipelineId: string
  /** Human-readable pipeline name captured at submit time; survives rename. */
  pipelineName?: string
  /** Snapshot captured at submit time for reproducibility/results views. */
  snapshot?: PipelineSnapshot
  /** Workspace context captured at submit time. */
  workspace?: {
    id?: string
    name?: string
    connectionName?: string
    analysisRoot?: string
    slurmAccount?: string
    slurmPartition?: string
    toolsRoot?: string
    annovarScriptsPath?: string
    annovarDbPath?: string
    vepPath?: string
    vepCachePath?: string
    recommendedTemplateId?: string
    notes?: string
  } | null
  connectionId: string
  arrayChainMode?: 'task-level' | 'job-level'
  fileLifecyclePolicy?: 'keep-all' | 'keep-outputs-only' | 'delete-intermediates-on-success'
  workDir: string
  scriptsDir?: string
  logsDir?: string
  outputRoot?: string
  /** Resolved `$HOME` on the remote — used to expand `~` in user-supplied path overrides. */
  homeDir?: string
  createdAt: number
  updatedAt: number
  status: RunStatus
  /** Serialized as a plain record so it survives IPC. */
  nodes: Record<string, NodeRunState>
}

export interface DryRunScript {
  nodeId: string
  label: string
  mode: 'single' | 'array' | 'fanIn' | 'branchFanIn' | 'skip'
  script: string
  summary?: string
  commands?: string[]
  outputPaths: string[]
  arraySize?: number
}
