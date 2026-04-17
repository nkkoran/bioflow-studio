/**
 * Pipeline data model types.
 *
 * A pipeline is a directed acyclic graph of tool invocations.
 * Each node is either a tool (bcftools, plink2, etc.) or a file reference.
 * Edges represent data flow (output file → input file).
 */

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
  type: 'string' | 'number' | 'boolean' | 'file' | 'select' | 'multi-select'
  default?: string | number | boolean
  required?: boolean
  options?: string[]        // for select types
  placeholder?: string
  min?: number
  max?: number
  step?: number
}

/** Input/output port on a tool. */
export interface ToolPort {
  id: string                // unique within node (e.g., "input", "output")
  label: string
  fileType: FileType
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
  command: string           // binary name (e.g., "plink2")
  module?: string           // HPC module to load (e.g., "plink/2.00a3")
  inputs: ToolPort[]
  outputs: ToolPort[]
  params: ToolParam[]
  /** Slurm defaults — can be overridden per-node */
  slurm?: {
    cpus?: number
    memoryGB?: number
    timeHours?: number
    partition?: string
  }
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
  /** Execution status — populated by runtime, not user-editable */
  status?: 'idle' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  /** Slurm job id when running */
  jobId?: string
  /** Last error message if failed */
  error?: string
  [key: string]: unknown
}

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
}

/** A file node — represents an input/output file in the graph. */
export interface FileNodeData {
  label: string
  path: string                  // remote path; used when split is absent
  fileType: FileType
  isInput: boolean              // true = source, false = sink
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

/**
 * Data for a merge node — a dedicated fan-in that collapses an axed edge
 * back into a single file. The runner submits the merge as a single Slurm
 * job with `--dependency=afterok:<arrayJobId>`.
 */
export interface MergeNodeData {
  label: string
  strategy: MergeStrategy
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

export type BioflowNodeType = 'tool' | 'file' | 'note' | 'merge'

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
  createdAt: number
  updatedAt: number
  nodes: Array<{
    id: string
    type: BioflowNodeType
    position: { x: number; y: number }
    data: ToolNodeData | FileNodeData | NoteNodeData | MergeNodeData
  }>
  edges: Array<{
    id: string
    source: string
    sourceHandle?: string
    target: string
    targetHandle?: string
  }>
}

// ===================== Execution runtime types =====================

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface NodeRunState {
  nodeId: string
  status: ToolNodeData['status']
  jobId?: string                // Slurm job id (array jobs use the parent id)
  scriptPath?: string           // remote path to the submitted sbatch script
  stdoutPath?: string           // pattern; for arrays contains %A_%a
  stderrPath?: string
  /** Absolute remote dir where this node's outputs land. */
  outputDir?: string
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
  connectionId: string
  workDir: string
  /** Resolved `$HOME` on the remote — used to expand `~` in user-supplied path overrides. */
  homeDir?: string
  createdAt: number
  updatedAt: number
  status: RunStatus
  /** Serialized as a plain record so it survives IPC. */
  nodes: Record<string, NodeRunState>
}
