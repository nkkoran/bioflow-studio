# BioFlow Studio — Phase 3 Implementation Plan

**Status:** draft, pre-implementation
**Depends on:** Phase 1 (SSH + file explorer + data preview + terminal), Phase 2 (pipeline canvas)
**Owner:** single-developer project

Phase 3 turns the visual pipelines built in Phase 2 into **real, running jobs on
the HPC cluster**, with validation, a file browser integration so users don't
have to hand-type remote paths, and a job monitor panel that tracks live state.

---

## Goals

1. **Execute** a pipeline: walk the DAG, generate Slurm sbatch scripts, submit
   via SSH, stream status back to node badges.
2. **Validate** a pipeline before running: catch missing inputs, type
   mismatches, cycles, unconfigured params, and dangling output files.
3. **Integrate the file browser** with file nodes so the sidebar doubles as a
   file picker.
4. **Monitor running jobs** with a dedicated panel mirroring `squeue` output and
   tailing stdout/stderr per job.

## Non-goals (deferred to Phase 4+)

- Multi-pipeline parallel execution / pipeline templates.
- Automatic job-dependency inference across *multiple* pipelines.
- Resource optimization / predictive scheduling.
- Container support (Singularity/Apptainer autoloading).

---

## 1. Execution Runtime

### 1.1 Architecture

The execution runtime is split across three layers:

```
┌──────────────────────────┐  renderer
│  Run button / Run store  │
└───────────┬──────────────┘
            │ IPC: pipeline:run / pipeline:cancel
┌───────────▼──────────────┐  main (electron/pipeline/)
│     PipelineRunner       │  ← Owns runtime state
│     ├─ Topo sorter       │
│     ├─ ScriptGenerator   │  ← Emits sbatch scripts
│     └─ JobTracker        │  ← Polls squeue
└───────────┬──────────────┘
            │ SshManager.exec / sftp.write
┌───────────▼──────────────┐  remote
│   Rorqual login node     │
│   sbatch / squeue / scancel
└──────────────────────────┘
```

The runner is in the main process because:

- It needs long-lived SSH access (survives renderer reloads).
- Slurm interaction is a side-effect that should not live in React.
- Tailing log files benefits from direct stream access via SFTP.

### 1.2 New files

#### `electron/pipeline/PipelineRunner.ts`
Singleton orchestrator. Exposes:

```ts
class PipelineRunner {
  static getInstance(): PipelineRunner

  /** Start a run. Returns a runId. Rejects if validation fails. */
  async start(connectionId: string, snapshot: PipelineSnapshot, workDir: string): Promise<string>

  /** Cancel all pending/running jobs for a run (scancel + mark cancelled). */
  async cancel(runId: string): Promise<void>

  /** Cancel one node's job specifically. */
  async cancelNode(runId: string, nodeId: string): Promise<void>

  /** Current state for UI rehydration on reload. */
  getRun(runId: string): RunState | null
  listRuns(): RunState[]
}
```

Internal state per run:

```ts
interface RunState {
  runId: string
  pipelineId: string
  connectionId: string
  workDir: string               // absolute remote path, e.g. /home/user/bioflow/runs/<runId>
  createdAt: number
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  nodes: Map<string, NodeRunState>
  topoOrder: string[][]         // layers of parallelizable nodes
}

interface NodeRunState {
  nodeId: string
  status: ToolNodeData['status']
  jobId?: string                // Slurm job id
  scriptPath?: string           // remote path to submitted sbatch
  stdoutPath?: string
  stderrPath?: string
  submittedAt?: number
  startedAt?: number
  finishedAt?: number
  exitCode?: number
  error?: string
}
```

Lifecycle (per node, in topo order):

1. Wait for all upstream nodes to complete successfully.
2. Resolve input paths from upstream `outputs` (see 1.4 for the path map).
3. Generate sbatch script → SFTP write to `<workDir>/scripts/<nodeId>.sbatch`.
4. `sbatch <script>` via `SshManager.exec` — capture returned job id.
5. Transition node to `queued`, then `running` when job starts.
6. On completion: read exit code, mark `done`/`failed`, unblock downstream.

Concurrency: nodes on the same topo layer submit in parallel. Layers are serial.

#### `electron/pipeline/ScriptGenerator.ts`
Pure functions that turn a `ToolNodeData` + resolved I/O paths into an sbatch
script string.

```ts
export function generateSbatchScript(opts: {
  nodeId: string
  tool: ToolDef
  nodeData: ToolNodeData
  resolvedInputs: Record<string, string[]>   // portId -> absolute path(s)
  outputDir: string                           // <workDir>/outputs/<nodeId>
  logDir: string                              // <workDir>/logs
  connectionDefaults?: { partition?: string; account?: string }
}): { script: string; outputPaths: Record<string, string> }
```

Script template:

```bash
#!/bin/bash
#SBATCH --job-name=bioflow-<nodeId>
#SBATCH --output=<logDir>/<nodeId>-%j.out
#SBATCH --error=<logDir>/<nodeId>-%j.err
#SBATCH --cpus-per-task=<cpus>
#SBATCH --mem=<memory>G
#SBATCH --time=<HH:MM:00>
#SBATCH --partition=<partition>
#SBATCH --account=<account>   # if set

set -euo pipefail

# Module loading (from tool.module)
module --force purge
module load StdEnv/2023
module load <tool.module>

mkdir -p <outputDir>
cd <outputDir>

<tool.command> \
  <flag1> <value1> \
  <flag2> <value2> \
  --out <outputDir>/out
```

Flag emission rules:

- `boolean true` → include flag alone (`--firth`).
- `boolean false` → omit.
- `string/number` with value → `--flag value` (quote strings with spaces).
- `undefined/null/empty string` → omit (unless `required` — caught by validator).
- Multi-input ports → flag repeated or comma-separated per tool convention
  (each ToolDef may specify `multiFormat: 'repeat' | 'comma' | 'space'`; default
  repeat).

Output path convention: `<outputDir>/<nodeId>.<portId>.<ext>` where `ext` is
derived from the port's `fileType` (vcf → `.vcf.gz`, bam → `.bam`, etc.). Tools
whose output is a directory (FastQC, MultiQC) emit to `<outputDir>` directly.

#### `electron/pipeline/JobTracker.ts`
Polls `squeue` and individual log files.

```ts
class JobTracker {
  /** Watch a job. Resolves when it reaches a terminal state. */
  watch(connectionId: string, jobId: string, callbacks: {
    onStart?: () => void
    onProgress?: (lastLogLine: string) => void
    onFinish: (result: { exitCode: number; duration: number }) => void
  }): void

  stopWatching(jobId: string): void
}
```

Implementation:

- Maintains an interval (default 10 s, tunable) per connection that runs
  `squeue -h -j <ids> -o "%i %T %M"` with all watched jobs batched.
- Parses states: `PD` (pending/queued), `R` (running), `CG` (completing),
  absent (finished — then fetch `sacct -j <id> -o State,ExitCode --noheader`).
- On transition to `running`, kicks off an stdout tail via
  `tail -F <logDir>/<nodeId>-<jobId>.out` through an exec channel, forwarded
  to the renderer as `pipeline:job-log` events.

#### `electron/pipeline/topoSort.ts`
Utility: given `PipelineSnapshot.nodes/edges`, return `string[][]` (layers) or
throw if a cycle is detected. Uses Kahn's algorithm.

#### `electron/ipc/pipelineHandlers.ts`
Wraps `PipelineRunner` in IPC:

| Channel | Direction | Payload | Returns |
|---|---|---|---|
| `pipeline:run` | renderer→main | `{ connectionId, snapshot, workDir? }` | `{ runId }` |
| `pipeline:cancel` | renderer→main | `{ runId }` | void |
| `pipeline:cancel-node` | renderer→main | `{ runId, nodeId }` | void |
| `pipeline:list-runs` | renderer→main | void | `RunState[]` |
| `pipeline:get-run` | renderer→main | `{ runId }` | `RunState \| null` |
| `pipeline:node-status` | main→renderer | `{ runId, nodeId, status, jobId?, error? }` | — |
| `pipeline:run-status` | main→renderer | `{ runId, status }` | — |
| `pipeline:job-log` | main→renderer | `{ runId, nodeId, chunk, stream: 'stdout'\|'stderr' }` | — |

Registered in `electron/ipc/registerAll.ts`.

### 1.3 Remote working directory layout

Default workDir: `~/bioflow/runs/<runId>/` (configurable per-connection).

```
<workDir>/
├── pipeline.json        # frozen snapshot used for this run
├── scripts/
│   └── <nodeId>.sbatch
├── outputs/
│   └── <nodeId>/
│       └── out.<ext>    # tool output(s)
└── logs/
    ├── <nodeId>-<jobId>.out
    └── <nodeId>-<jobId>.err
```

Created upfront via `mkdir -p` in a single SSH exec before any submission.

### 1.4 Input/output path resolution

For each tool node, the runner builds `resolvedInputs: Record<portId, string[]>`
by walking incoming edges:

- Edge from a `tool` source → use `outputPaths[sourcePortId]` from the upstream
  node's generator output.
- Edge from a `file` source → use that file node's `path` verbatim (after
  `~/` expansion).
- Multi-input ports collect all incoming edges into an array.

Missing required inputs → validator catches it in 1.5, not here.

### 1.5 Renderer-side run store

#### `src/stores/runStore.ts`

```ts
interface RunStoreState {
  activeRunId: string | null
  runs: Record<string, RunState>      // by runId
  logs: Record<string, string[]>      // by nodeId — ring buffer, last 500 lines

  startRun: (connectionId: string, snapshot: PipelineSnapshot) => Promise<string>
  cancelRun: (runId: string) => Promise<void>
  cancelNode: (runId: string, nodeId: string) => Promise<void>
  setActiveRun: (runId: string | null) => void

  // Subscribed on mount in AppLayout
  subscribeToEvents: () => () => void  // returns unsubscribe
}
```

The store listens to `pipeline:node-status`, `pipeline:run-status`, and
`pipeline:job-log`, and on `node-status` events also calls
`pipelineStore.setNodeStatus(...)` so the canvas badges update live.

### 1.6 UI changes

- `PipelineToolbar.handleRun` is no longer a stub: it calls
  `runStore.startRun(activeConnectionId, snapshot)`. If no active connection,
  prompt to connect first.
- Each tool node already has a status badge — it now reflects live runtime
  status automatically (pipelineStore already has `setNodeStatus`).
- A "Cancel run" button appears next to Run when `activeRunId` is non-null.

---

## 2. Pipeline Validation

### 2.1 Goals

Catch all fixable problems **before** submitting any jobs. Surface warnings and
errors inline in the UI rather than as raw exceptions.

### 2.2 New file: `src/lib/pipelineValidator.ts`

```ts
export type ValidationSeverity = 'error' | 'warning' | 'info'

export interface ValidationIssue {
  severity: ValidationSeverity
  nodeId?: string         // if absent, it's a pipeline-level issue
  edgeId?: string
  portId?: string
  code: string            // machine-readable: 'MISSING_INPUT', 'CYCLE', ...
  message: string         // human-readable
  suggestion?: string
}

export interface ValidationResult {
  ok: boolean             // true iff no `error` issues
  issues: ValidationIssue[]
}

export function validatePipeline(snapshot: PipelineSnapshot): ValidationResult
```

### 2.3 Checks

| Code | Severity | Trigger |
|---|---|---|
| `EMPTY_PIPELINE` | error | No tool nodes |
| `CYCLE` | error | DAG contains a cycle (topo sort fails) |
| `MISSING_INPUT` | error | Tool has a `required: true` input port with no incoming edge |
| `MISSING_REQUIRED_PARAM` | error | `param.required && paramValues[name] == null or ""` |
| `TYPE_MISMATCH` | error | Edge whose types fail `areTypesCompatible` (shouldn't happen post-canvas validation, but defensive) |
| `FILE_NODE_NO_PATH` | error | File node with empty `path` |
| `ORPHAN_OUTPUT` | warning | Tool output with no outgoing edge and no downstream file node — user may lose results |
| `NO_TERMINAL_OUTPUT` | warning | Pipeline produces no output-file node (results only exist inside run workdir) |
| `OVERPROVISIONED_SLURM` | info | CPU/memory much larger than tool defaults — flag for review |
| `UNKNOWN_TOOL` | error | `toolId` not in registry (after registry changes or pipeline import) |
| `DUPLICATE_NODE_LABEL` | info | Two tool nodes share the same label — harmless but confusing |

### 2.4 UI integration

#### `src/components/pipeline/ValidationBadge.tsx`
Small badge in `PipelineToolbar`, between node count and action buttons:

- Green check + "Valid" when `ok: true` and zero warnings.
- Yellow ! + warning count when only warnings.
- Red ! + error count otherwise.

Click opens a panel (reuse `Dialog` or a popover) listing issues grouped by
severity, with "Jump to node" buttons that call
`pipelineStore.setSelectedNode(nodeId)` and scroll the canvas.

Validation runs:

- On every pipeline change via a `useMemo` over `nodes`/`edges` (cheap — graph
  sizes will be <100 nodes).
- Automatically before `startRun` — blocks the run if `!result.ok`.

### 2.5 Node-level hints

Tool and file nodes gain a subtle red ring when they're the subject of an
error issue:

- `ToolNode.tsx` subscribes to validation via a selector
  `useValidation(nodeId) → ValidationIssue[]` and adds `ring-2 ring-error/60`
  when any error is present. Tooltip on hover shows the messages.
- Same treatment in `FileNode.tsx`.

---

## 3. File Browser Integration

### 3.1 Goal

When a user selects a file node and clicks "Pick file...", the sidebar file
explorer enters **pick mode**: clicking a file sets the node's `path` and
`fileType`, then exits pick mode.

### 3.2 UI store additions

#### `src/stores/uiStore.ts`

```ts
interface UIStore {
  // ... existing ...
  filePickMode: {
    active: boolean
    nodeId: string | null            // node requesting a path
    portId?: string                  // optional: a specific input port
    accept?: FileType[]              // filter for file explorer (dim non-matching)
  }
  startFilePick: (nodeId: string, accept?: FileType[], portId?: string) => void
  resolveFilePick: (path: string, fileType: FileType) => void  // called by FileExplorer
  cancelFilePick: () => void
}
```

### 3.3 FileExplorer changes

`src/components/file-explorer/FileExplorer.tsx`:

- When `filePickMode.active`, top of the explorer shows a banner:
  *"Selecting a file for `<node label>`"* with a Cancel button.
- Clicking a file entry (not a directory) calls `resolveFilePick(path, ft)`,
  where `ft` is inferred from the extension via a new
  `src/lib/fileTypeInference.ts` (`.vcf.gz → vcf`, `.bam → bam`, etc.).
- Non-matching files (when `accept` is set) are rendered at 50% opacity with
  clicks disabled.
- Pressing Escape cancels pick mode.

### 3.4 Inspector changes

`NodeInspector.FileInspector`:

- Adds a "Pick file..." button next to the path input. Clicking calls
  `uiStore.startFilePick(nodeId, [data.fileType])`.
- On `resolveFilePick`, updates both `path` and `fileType` (the inference may
  produce a more specific type than `any`).

`NodeInspector.ToolInspector`:

- For each input port with `fileType !== 'any'` and no incoming edge, shows an
  optional "Quick input" slot — a mini path display with a "Pick..." button
  that creates a file node under the hood and auto-connects it. (Nice-to-have,
  can ship without.)

### 3.5 Data flow

```
FileInspector "Pick..." click
        │
        ▼
uiStore.startFilePick(nodeId, [fileType])
        │
        ▼
FileExplorer renders banner + disables non-matching
        │
User clicks file
        │
        ▼
FileExplorer infers fileType from ext → uiStore.resolveFilePick(path, ft)
        │
        ▼
uiStore updates pipelineStore node data + clears pick mode
```

The `resolveFilePick` action does the `pipelineStore.updateNodeData` call so
the FileExplorer stays decoupled from the pipeline store.

---

## 4. Job Monitor Panel

### 4.1 Goal

A new tab in the bottom panel (alongside Terminal and Data Preview) showing
live status of the active run and historical runs.

### 4.2 UI hierarchy

```
BottomPanel
├── Tab: Terminal (existing)
├── Tab: Data Preview (existing)
└── Tab: Jobs (new)
     ├── Header: run selector dropdown + Cancel Run button
     ├── Left pane: node list with status + duration + jobId
     └── Right pane: log viewer for selected node (stdout / stderr tabs)
```

### 4.3 New components

#### `src/components/jobs/JobsPanel.tsx`
Top-level. Reads `runStore.runs` and `activeRunId`.

#### `src/components/jobs/RunSelector.tsx`
Dropdown of recent runs; clicking one sets `activeRunId`.

#### `src/components/jobs/NodeRunList.tsx`
Virtualized list (TanStack Virtual, same as DataPreview) of the active run's
nodes, showing per-row:

- Status icon (same palette as `ToolNode` badge)
- Node label + tool name
- Job id (monospace)
- Submitted / started timestamps
- Duration (live for running jobs via `useInterval`)
- Click row → selects node in log viewer

#### `src/components/jobs/LogViewer.tsx`
Two tabs (stdout / stderr) rendering the last N lines of log from
`runStore.logs[nodeId]`. Uses a monospace font, auto-scrolls to bottom unless
user has scrolled up. "Download full log" button calls
`window.api.sftp.read(connectionId, <stderrPath>)` and triggers a browser
download.

### 4.4 BottomPanel wiring

`src/components/layout/BottomPanel.tsx` currently renders two tabs from
`uiStore.bottomPanelTab`. Add `'jobs'` to the union and register the Jobs tab
in the tab bar. When a run starts (`activeRunId` transitions from null), auto-
switch to the Jobs tab.

### 4.5 Persistence

Runs persist across app reloads. On app start, `runStore.subscribeToEvents`
also calls `window.api.pipeline.listRuns()` to rehydrate. If a run was
in-flight when the app closed, the main-process tracker reattaches via
`squeue -j <jobIds>` on the next successful SSH connect.

### 4.6 Log streaming

Logs arrive via `pipeline:job-log` events (see 1.2). The run store keeps a
**500-line ring buffer per node** in memory. Beyond that, "Download full log"
fetches the file.

`runStore` subscribes to the event once at mount (in `AppLayout.useEffect`)
and never unsubscribes — the renderer process owns this subscription for the
whole session.

---

## 5. Settings additions

Per-connection runtime defaults are stored via the existing settings store:

```
connection:<id>:
  workDirRoot: string       // default: "~/bioflow/runs"
  slurmAccount?: string     // Alliance accounts like "def-pi123"
  slurmPartition?: string   // default: cluster-specific
  maxParallelJobs: number   // default: 8
  jobPollInterval: number   // default: 10s
```

New UI: a "Runtime" section in `ConnectionDialog` with these fields.
`PipelineRunner.start` reads these per connection before submitting.

---

## 6. Types & shared contracts

New additions to `src/types/pipeline.ts`:

```ts
export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface RunState {
  runId: string
  pipelineId: string
  connectionId: string
  workDir: string
  createdAt: number
  updatedAt: number
  status: RunStatus
  nodes: Record<string, NodeRunState>   // serialized (not Map) for IPC
}

export interface NodeRunState {
  nodeId: string
  status: ToolNodeData['status']
  jobId?: string
  scriptPath?: string
  stdoutPath?: string
  stderrPath?: string
  submittedAt?: number
  startedAt?: number
  finishedAt?: number
  exitCode?: number
  error?: string
}
```

Preload `window.api.pipeline`:

```ts
pipeline: {
  run: (connectionId: string, snapshot: PipelineSnapshot, workDir?: string) => Promise<{ runId: string }>
  cancel: (runId: string) => Promise<void>
  cancelNode: (runId: string, nodeId: string) => Promise<void>
  listRuns: () => Promise<RunState[]>
  getRun: (runId: string) => Promise<RunState | null>
  onNodeStatus: (cb: (data: { runId: string; nodeId: string; status: RunStatus; jobId?: string; error?: string }) => void) => () => void
  onRunStatus: (cb: (data: { runId: string; status: RunStatus }) => void) => () => void
  onJobLog: (cb: (data: { runId: string; nodeId: string; chunk: string; stream: 'stdout' | 'stderr' }) => void) => () => void
}
```

---

## 7. Implementation order

Phase 3 is large; tackle in this sequence so there's something testable at each
step:

1. **`topoSort.ts` + `pipelineValidator.ts` + `ValidationBadge`** — no backend
   required; gives immediate user value and catches bad pipelines before we
   even wire up execution.
2. **`ScriptGenerator.ts`** with a "Preview sbatch" button in the inspector —
   users see exactly what would run. Also serves as a unit test target.
3. **File browser integration** — decouples file-path editing from runtime;
   users can build fully-specified pipelines offline.
4. **`PipelineRunner` + `JobTracker` + IPC handlers** — minimal execution:
   one node at a time, no log streaming yet.
5. **`runStore` + Jobs panel (static)** — shows submitted jobs with polled
   status but no live logs.
6. **Parallel layer execution** in the runner.
7. **Log streaming** via `pipeline:job-log`.
8. **Run persistence + rehydration** on app reload.
9. **Per-connection runtime settings** in `ConnectionDialog`.

Each step should leave the app in a shippable state.

---

## 8. Testing notes

- Unit tests for `topoSort`, `pipelineValidator`, `ScriptGenerator` are pure
  functions — straightforward with Vitest.
- `PipelineRunner` integration test: stub `SshManager` + `SftpPool` with an
  in-memory fake that records exec calls and pretends `sbatch` returns
  `Submitted batch job 12345`.
- End-to-end: a throwaway test pipeline (`echo hello` via a Custom Shell tool)
  submitted to the real rorqual cluster — manual, gated behind a script the
  user runs.

---

## 9. Open questions (resolve during implementation)

- **Module system**: StdEnv/2023 on Rorqual vs. older clusters — should we make
  the module preamble part of connection settings rather than the tool def?
  Tentative: yes, move `module load StdEnv/<year>` to connection settings,
  leave per-tool modules in the registry.
- **Account propagation**: `--account` is mandatory on Alliance clusters. Plan
  is to require it in connection settings and fail the run early if missing.
- **File staging**: do we need to copy input files into `<workDir>/inputs/`
  before submitting, or just reference paths in place? Starting simple — in-
  place references. Revisit if we hit permission or quota issues.
- **Cancellation on app quit**: if the user quits while jobs are running, do
  we `scancel` or leave them? Default: leave them running; log the runId so
  the user can reattach on next launch. Offer a "Cancel all running jobs on
  quit" setting.

---

## 10. Definition of done

Phase 3 is done when:

- [ ] A user can build a valid pipeline, click Run, and see tool nodes transition
      idle → queued → running → done on the canvas in real time.
- [ ] Invalid pipelines are blocked at Run with a clear issue list.
- [ ] File nodes can be configured via the sidebar file browser (no manual path
      typing required).
- [ ] The Jobs panel shows live job state, duration, and tail logs for the
      active run.
- [ ] Runs persist across app reloads and reattach via `squeue` / `sacct`.
- [ ] Cancelling a run issues `scancel` for all its pending and running jobs.
