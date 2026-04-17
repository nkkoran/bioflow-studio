# BioFlow Studio — Phase 4 Implementation Plan

**Status:** in progress (items 1, 2, 4, 5, 6, 7, 11, 15 shipped/mostly shipped; items 3, 13, 16, 17 partially shipped)
**Depends on:** Phase 1 (SSH + file explorer + data preview + terminal), Phase 2 (pipeline canvas), Phase 3 (execution runtime + validation + jobs panel + SSH persistence)
**Owner:** single-developer project

Phase 4 closes the remaining gaps in the pipeline-authoring and run-observation experiences now that the core SSH-plus-Slurm loop works end to end. It also carries forward the validator warnings and run persistence that PHASE3_PLAN.md explicitly deferred.

---

## Project context

BioFlow Studio is a desktop application (Electron + React) that lets bioinformatics researchers build and run GWAS/variant-calling pipelines on HPC clusters over SSH. The immediate target cluster is Rorqual (Alliance Canada / McGill), which submits jobs through Slurm (`sbatch`, `squeue`, `sacct`, `scancel`). Jobs are real — they consume cluster time — so authoring errors, observability gaps, and bad re-run UX each have a direct cost.

The app is a three-process Electron build:

- **main** (`electron/main/`) — runs the long-lived SSH/SFTP connections, the pipeline runner, job tracker, and IPC handlers.
- **preload** (`electron/preload/index.ts`) — the single `window.api` surface exposed to the renderer; all IPC crosses this boundary.
- **renderer** (`src/`) — React 19 + Zustand 5 + `@xyflow/react` for the canvas. Stores in `src/stores/` (`pipelineStore`, `runStore`, `uiStore`, `connectionStore`) form the app's state model.

Execution flow (phase-3 infrastructure Phase 4 builds on): the renderer calls `window.api.pipeline.run(snapshot)`; `PipelineRunner` walks the DAG via `topoSort.ts`, computes per-node axis plans (single / array / fan-in) in `axisPlanner.ts`, generates sbatch scripts via `ScriptGenerator.ts`, writes them over SFTP, submits with `sbatch`, and watches each job via `JobTracker.ts`. Per-node status transitions are emitted as `pipeline:node-status` IPC events; `runStore` forwards them to `pipelineStore.setNodeStatus` so canvas badges animate live.

Phase 3's authoritative design doc is [PHASE3_PLAN.md](PHASE3_PLAN.md); shipped architecture + conventions live in [CLAUDE.md](CLAUDE.md). Phase 4 references both.

---

## Goals

1. **Authoring** — a user should be able to drag a file from the explorer straight onto the canvas, rename outputs, route folders per stage, and have tool inspectors auto-populate with column names from connected data. Today each of those takes a detour through the inspector and a lot of typing.

2. **Observation** — when a job finishes the user should see what it produced. Today stdout/stderr tabs stay empty, Refresh does nothing, and there's no summary.

3. **Reuse** — failed runs should be recoverable without starting from scratch. Today a single failed node means re-running the whole pipeline; runs vanish on app restart.

4. **Polish** — fix the visual crowding, non-scrolling dialog, and misaligned handles that make the UI feel unfinished.

## Non-goals (deferred)

- Cost estimation (SU hours per run) once `sacct` parse lands — straightforward follow-up.
- LLM-assisted pipeline generation.
- Collaborative multi-user editing.
- Pipeline templates marketplace (local export/import only — item 13c does ship).
- Container support (Singularity/Apptainer autoloading).
- Windows installer polish and code signing.

---

## Status summary

| #   | Work item                                     | Status                |
| --- | --------------------------------------------- | --------------------- |
| 1a  | ToolNode / MergeNode handle alignment         | ✅ shipped             |
| 1b  | Dialog body scrollability                     | ✅ shipped             |
| 1c  | TopBar crowding (ResizeObserver + compact)    | ✅ shipped             |
| 2   | Default analysis folder (per-connection)      | ✅ shipped (Browse button deferred) |
| 3   | FileNode output rework (rename + folder)      | partial — output FileNode sink paths now drive runtime destinations; filename/folder split UI still pending |
| 4   | Per-node output folder override               | ✅ shipped             |
| 5   | FileExplorer → canvas drag-drop               | ✅ shipped (auto-connects to first compatible tool input; popover still future polish) |
| 6   | Jobs panel fixes + completed-job summary      | ✅ shipped — selectable run history, summaries, output/log actions |
| 7   | Data previewer filter / column select / sort  | ✅ shipped             |
| 8   | Column mapping in tool inspector              | pending               |
| 9   | Transform node (filter rows, select columns)  | pending               |
| 10  | Re-run single failed node                     | pending               |
| 11  | Script viewer / dry-run mode                  | ✅ shipped             |
| 12  | Run history persistence + squeue reattach    | pending               |
| 13  | Autosave + keyboard shortcuts + templates + notifications | partial — keyboard shortcuts + import/templates shipped; autosave + notifications pending |
| 14  | Validator warnings carry-over                 | pending               |
| 15  | Log streaming follow-up (stdout/stderr still empty) | ✅ shipped — NodeRunState now carries log paths; terminal refresh uses SFTP |
| 16  | Live Slurm queue view (squeue -u)             | partial — Jobs panel polls `squeue -u` while open; dedicated Queue tab still pending |
| 17  | Concurrent runs — start another without waiting | partial — Run button no longer blocked by terminal runs; full per-pipeline badge isolation pending |
| 18  | Multiple named pipelines (open/switch/new)    | pending               |

---

## 1. Visual polish  ✅ shipped

Three independent fixes, no cross-file dependencies.

### 1a. Handle alignment

**Problem.** Handles on ToolNode were positioned with `top: (idx + 0.5) * 20 + 4px`. Each port row had `position: relative`, which means the handle positioned **relative to its own row**, not the whole node — so only the first port's circle lined up with anything, and even that was off.

**Fix.** Each row is a fixed `h-6 flex items-center` container; the handle inside uses `top: 50%; transform: translateY(-50%)` to center on its row's midline. Same fix applied to MergeNode. Files: [src/components/pipeline/nodes/ToolNode.tsx](src/components/pipeline/nodes/ToolNode.tsx), [src/components/pipeline/nodes/MergeNode.tsx](src/components/pipeline/nodes/MergeNode.tsx).

### 1b. Dialog scrollability

**Problem.** The SSH Connect dialog (and any tall dialog) overflowed the viewport when the window wasn't full-screen; no scroll was available.

**Fix.** Dialog container now `max-h-[90vh] flex flex-col`, header/footer are `shrink-0`, body is `flex-1 min-h-0 overflow-y-auto`. Outer overlay got `p-4` so the dialog has breathing room on small viewports. File: [src/components/ui/Dialog.tsx](src/components/ui/Dialog.tsx).

### 1c. TopBar crowding

**Problem.** Title + connection status + settings packed into a flex row with no truncation; at narrow widths items overlapped.

**Fix.** ResizeObserver on the TopBar root sets a `compact` flag below 620 px. In compact mode the title hides and `ConnectionStatus` collapses to: dot + short name + chevron (plus hover tooltip with full info). Same threshold handles disconnect-state buttons (Connect label stays, Local collapses to an icon). Files: [src/components/layout/TopBar.tsx](src/components/layout/TopBar.tsx), [src/components/connection/ConnectionStatus.tsx](src/components/connection/ConnectionStatus.tsx).

---

## 2. Default analysis folder (per-connection setting)  ✅ shipped (partial)

Foundation for per-stage folder routing (items 3 and 4). One new field in the existing per-connection Slurm Settings panel.

### Shipped

- New "Default analysis folder" field in the Slurm Settings popover ([ConnectionStatus.tsx](src/components/connection/ConnectionStatus.tsx)) — stored under `connection:<id>:defaultAnalysisFolder` via the existing namespaced-key electron-store pattern.
- `PipelineRunner.start()` reads the key via a new `loadAnalysisFolder()` and uses it as `workRoot` instead of the hardcoded `~/bioflow`. `~` / `~/...` are expanded against the remote `$HOME` resolved at run start.
- Final layout now: `<workRoot>/runs/<slug>-<ts>/{scripts,outputs,logs}` — falls back to `~/bioflow/runs/...` when unset.

### Deferred

- **Browse button**: the field is currently a plain text input. The full plan called for a folder-picker handoff through `uiStore.filePickMode` with a new `mode: 'directory'` variant. That involves also teaching `FileExplorer` to render a "Select this folder" banner action. Punted until the directory picker is actually needed elsewhere (items 3 and 4's Browse buttons depend on the same extension — ship all three together).

### Data model

No type changes. Stored under the existing namespaced-key pattern in `electron-store`:

```
connection:<id>:defaultAnalysisFolder   // absolute remote path
```

### Changes

- **[src/components/connection/ConnectionStatus.tsx](src/components/connection/ConnectionStatus.tsx)** — `SlurmSettings`. Add an `Input` labeled "Default analysis folder" with a Browse button that opens the SFTP directory picker (reuse the existing `startFilePick` handoff via `uiStore`, extended to accept a "directory-only" variant — see below). Save/load via `window.api.store.get/set`.
- **[electron/pipeline/PipelineRunner.ts](electron/pipeline/PipelineRunner.ts)** — `loadConnectionDefaults()` reads the new key. When set, it replaces the current hardcoded `<home>/bioflow` base for `workDir`. Falls back to `<home>/bioflow` when unset, preserving current behavior.
- **[src/stores/uiStore.ts](src/stores/uiStore.ts)** — the existing `filePickMode` handoff is file-focused; add a `mode: 'file' | 'directory'` discriminator so the same mechanism can pick a folder. `FileExplorer`'s banner also needs a "Select this folder" button when `mode === 'directory'`.

### Runner behavior

```
workDirRoot = defaultAnalysisFolder || `${home}/bioflow`
workDir     = `${workDirRoot}/runs/${pipelineSlug}-${timestamp}`
outputDir   = `${workDir}/outputs/<nodeSlug>`     // unless overridden (item 4)
logDir      = `${workDir}/logs`
scriptDir   = `${workDir}/scripts`
```

### Verification

Set a folder in Slurm Settings. Run a trivial pipeline. Confirm `<folder>/runs/<run-slug>/{scripts,outputs,logs}` exists on the cluster and `sbatch` scripts reference the correct paths.

---

## 3. FileNode output rework (rename + folder)

### Motivation

An "output file" block currently expects the user to pick an existing file, which is semantically wrong — the file doesn't exist until the pipeline runs. Rework so output FileNodes are named destinations for a tool's output port.

### Data model ([src/types/pipeline.ts](src/types/pipeline.ts))

```ts
interface FileNodeData {
  label: string
  fileType: FileType
  isInput: boolean
  path?: string                      // used when isInput=true
  split?: FileNodeSplit              // unchanged
  // New, only meaningful when isInput=false:
  outputFilename?: string            // e.g. "assoc_results.tsv"
  outputDir?: string                 // absolute override; falls back to defaultOutputDir
  [key: string]: unknown
}
```

### Runner behavior

- **[electron/pipeline/axisPlanner.ts](electron/pipeline/axisPlanner.ts)** — when a tool output port is connected to an `isInput=false` FileNode, the resolved output path becomes `<outputDir || defaultOutputDir>/<outputFilename || generatedName>`. Add a pure helper `resolveSinkPath(edge, fileNodeData, defaults)`.
- **[electron/pipeline/ScriptGenerator.ts](electron/pipeline/ScriptGenerator.ts)** — consumes the resolved path as-is; no new templating logic.
- **Array jobs** keep the `.${KEY}` suffix convention: `outputFilename` is the stem, `.${KEY}` is inserted before the extension.

### Inspector ([src/components/pipeline/NodeInspector.tsx](src/components/pipeline/NodeInspector.tsx))

`FileInspector` for `isInput=false`:

- Replace the "Pick file..." button with two fields:
  - **Filename** (text input) — basename + extension.
  - **Folder** (text input + Browse button using the directory-picker handoff from item 2).
- Keep the `isInput` toggle; add a one-line hint explaining the new semantics.
- **Migration path**: if an existing `isInput=false` node has a `path` but no `outputFilename`/`outputDir`, split `path` into dir + basename on first save. Guard with a flag to avoid re-running.

### Visual ([src/components/pipeline/nodes/FileNode.tsx](src/components/pipeline/nodes/FileNode.tsx))

Show "→ `outputFilename`" on the node face when `isInput=false`, with the folder as a tooltip.

### Verification

Build `<input> → <tool> → <renamed output>`. Run. Confirm the file lands at the chosen folder with the chosen name, and the Jobs summary (item 6) reports it.

---

## 4. Per-node output folder override  ✅ shipped

### Motivation

Lets the user route `step1` intermediates to one folder and `step2` to another without adding output FileNodes everywhere. Paired with item 3, but cleanly separate.

### Shipped

- `outputDirOverride?: string` added to both `ToolNodeData` and `MergeNodeData` in [src/types/pipeline.ts](src/types/pipeline.ts).
- New pure helper `resolveNodeOutputDir(override, defaultOutputRoot, slug, homeDir?)` in [axisPlanner.ts](electron/pipeline/axisPlanner.ts). Handles `~`/`~/...` expansion against the resolved remote home.
- [PlannerContext](electron/pipeline/axisPlanner.ts) gains an optional `homeDir` so axed path resolution respects the override everywhere.
- [PipelineRunner.start()](electron/pipeline/PipelineRunner.ts) passes `homeDir`, uses the helper to seed the `mkdir -p` set for each node, stashes `home` on `RunState.homeDir` for later mkdir/script generation.
- [PipelineRunner.runNode()](electron/pipeline/PipelineRunner.ts) uses the same helper to compute `outputDir` so script-generated paths match the ones axisPlanner threaded into downstream inputs. `NodeRunState.outputDir` is populated at submission time — used by the Jobs summary card (item 6).
- Inspectors: new "Output folder" field in both `ToolInspector` and `MergeInspector` with an "absolute path or `~/…`" hint. Browse button deferred with item 2's directory picker.

### Transform node (item 9)

Same `outputDirOverride` field will apply — the helper and PlannerContext already handle it.

### Verification

Set overrides on two tool nodes. Run. Confirm each node's outputs land in its override path; nodes without an override use the default. Type `~/scratch/foo` — confirm it expands to `<home>/scratch/foo` both in the mkdir and in the downstream node's resolved input paths.

---

## 5. FileExplorer → canvas drag-drop

### Motivation

The FileExplorer rows already emit `application/x-bioflow-path` on drag ([src/components/file-explorer/FileTreeNode.tsx:48](src/components/file-explorer/FileTreeNode.tsx:48)). The receiving end on the canvas just isn't wired up.

### Canvas drop

[src/components/pipeline/PipelineCanvas.tsx](src/components/pipeline/PipelineCanvas.tsx) `onDrop`:

1. Read the `application/x-bioflow-path` MIME payload.
2. Convert drop coordinates to flow coordinates via React Flow's `screenToFlowPosition`.
3. Hit-test against existing nodes.
   - **On empty canvas**: create a new `FileNode` at the drop point with `path` set and `fileType = inferFileType(name)`.
   - **On a tool node**: open a popover menu anchored at the drop point listing the tool's input ports. Each port is labeled with its `portId` + `fileType`; entries are disabled if the file's type doesn't match. Clicking a port creates a new `FileNode` just to the left of the target and an edge to the chosen port. (Keeping the graph model consistent: edges always connect node ports.)

### New component

`src/components/pipeline/PortPickerPopover.tsx` — absolute-positioned floating menu. Dismisses on outside click or Escape. Small, hand-rolled; no Radix dependency needed.

### Drag visuals

Listen for `dragenter`/`dragleave` on the canvas root for `application/x-bioflow-path`; while a drag is in progress, tool nodes render with a "drop target" outline (simple CSS class toggled via state).

### Coexistence with the existing file picker

The `uiStore.filePickMode` handoff (used by FileInspector) stays. Drag-drop is an additional affordance, not a replacement. The inspector picker still fires when the user clicks Browse.

### Verification

Drag a `.vcf.gz` from the explorer onto empty canvas → new input FileNode with inferred type `vcf`. Drag onto a `bcftools view` node → popover shows only `vcf` / `any` ports as enabled. Pick one → FileNode + edge appear.

---

## 6. Jobs panel fixes + completed-job summary  — partial (summary shipped; see 6.1 follow-up for remaining bug)

### Shipped

- **Summary card** ([src/components/jobs/JobSummary.tsx](src/components/jobs/JobSummary.tsx)) — duration, exit code, slurm job id, error, and an SFTP-listed "Files created" table with size / relative mtime / inferred fileType. Rendered above the LogViewer in `JobsPanel` only for nodes in a terminal state.
- **`pipeline:list-outputs` IPC** — [pipelineHandlers.ts](electron/ipc/pipelineHandlers.ts) + preload + env.d.ts. Main-side `PipelineRunner.listNodeOutputs(runId, nodeId)` reads from `NodeRunState.outputDir` (populated at submission — see item 4) and SFTP-ls'es it via the existing pool.
- **Terminal-transition refresh** — `LogViewer`'s SFTP-refresh effect now depends on `ns?.status`, so a non-array `running → done` transition triggers one final SFTP read (catches bytes `tail -F` missed).
- **Refresh button explains itself** — when the user clicks Refresh before `resolvedPath` is known, the viewer shows a clear "Log path not known yet" message instead of silently doing nothing.

### 6.1 Bug fixes

**`stdoutPath`/`stderrPath` missing on fast jobs.** The runner populates these paths only after `squeue` reports a state. For jobs that complete before the first squeue tick, the fields stay `undefined` and `LogViewer` falls through. Fix: write the expected paths into `NodeRunState` at submission time in [electron/pipeline/PipelineRunner.ts](electron/pipeline/PipelineRunner.ts) — `ScriptGenerator` already knows them deterministically.

**Refresh does nothing after completion.** Root cause is usually the above (`resolvedPath === null` so the handler returns early). With paths set at submission time the button behaves. Add a visible error state when the user clicks Refresh but `resolvedPath` is still null so they see *why* nothing happened.

**Terminal transition doesn't trigger one-shot SFTP refresh.** `LogViewer` has an effect that triggers SFTP read only on array nodes or when a node is *already* terminal at selection time. For non-array jobs that go from `running` → `done` while the viewer is open, streaming stops but nothing reads the final file. Add a second effect that reacts to `ns.status` transitioning into a terminal state and fires `sftpRefresh()` once per transition.

**Empty-file rendering.** `text.split('\n')` yields `['']` for an empty file, rendered as a single empty line. Gate on `text.length === 0` before splitting.

All four changes in [src/components/jobs/LogViewer.tsx](src/components/jobs/LogViewer.tsx).

### 6.2 Completed-job summary card

New component `src/components/jobs/JobSummary.tsx`, rendered in [src/components/jobs/JobsPanel.tsx](src/components/jobs/JobsPanel.tsx) above the `LogViewer` when `ns.status ∈ {'done','failed','cancelled'}`.

Content:

- Duration (`finishedAt − startedAt`), exit code, slurm job id, error message (if any).
- **Files created**: SFTP-ls the node's resolved `outputDir` at summary-open time. Cache per-node in `runStore` keyed by `<runId>:<nodeId>` to avoid refetching. Table columns: filename, size, mtime, inferred fileType. Per-row actions: **Preview** (opens the data previewer for tabular types) and **Use as input** (calls the existing `uiStore.startFilePick` resolve flow for the waiting node elsewhere).
- **Array jobs**: roll-up of per-task exit codes ("18 succeeded, 4 failed") with expansion to see individual tasks.

### 6.3 IPC

- `pipeline:list-outputs` — handler in [electron/ipc/pipelineHandlers.ts](electron/ipc/pipelineHandlers.ts): takes `{ runId, nodeId }`, SFTP-lists the resolved outputDir, returns `RemoteFileEntry[]`. Keeps the renderer from guessing paths and lets the main process use its existing SftpPool.

### Verification

Run a `echo hi > out.txt` custom-shell pipeline. Click into the completed node. Summary card shows `out.txt` with size/mtime. Both stdout and stderr tabs populate. Click Refresh — logs re-read. Kill stdout with a `set -u $unset`; re-run, confirm stderr populates and summary shows exit code + file list even on failure.

---

## 7. Data previewer: filter + column select + sort

Preview-only enhancements. No pipeline side effect — materialization happens in the Transform node (item 9).

### UI ([src/components/data-preview/DataTable.tsx](src/components/data-preview/DataTable.tsx), [DataPreview.tsx](src/components/data-preview/DataPreview.tsx))

- **Column select**: multi-select chip row above the table — one chip per column with a checkbox toggle. Hidden columns stay in the underlying data; just not rendered. Persist selection in `dataPreviewStore` keyed by file path so re-opening the same file preserves the view.
- **Row filter**: a small filter bar with one rule per column. Supported ops by inferred type:
  - text → `contains` / `equals` / `regex`
  - numeric → `=` / `>` / `<` / `>=` / `<=` / range
  Rules combine with AND. Computed in-memory over the loaded rows — no SFTP re-read.
- **Sort**: click-to-sort per column header (asc/desc cycle). Cheap, same dataset.

### Store ([src/stores/dataPreviewStore.ts](src/stores/dataPreviewStore.ts))

Add `visibleColumns: Record<filePath, string[]>`, `filters: Record<filePath, FilterRule[]>`, `sort: Record<filePath, { column, dir }>`. All optional — absent means default (show all, no filter).

### Verification

Open a 500-row TSV. Hide 3 columns. Add a numeric filter (`age > 50`). Sort by `IID` ascending. Table updates instantly without re-fetching. Close and re-open — view state persists.

---

## 8. Column mapping in tool inspector

### Motivation

When a tabular file is connected to a tool that expects column names (PLINK2 `pheno-name`, REGENIE `covarColList`, etc.), those params are currently free-text. Users can — and do — typo column names, leading to `awk`/`plink2` errors at runtime.

### Tool registry ([src/lib/toolRegistry.ts](src/lib/toolRegistry.ts))

Add `columnRef?: true` to `ToolParam`. Annotate existing params where appropriate: PLINK2 `pheno-name`, `covar-name`, `covar`, REGENIE `covarColList`, `phenoCol`, etc.

### Inspector ([src/components/pipeline/NodeInspector.tsx](src/components/pipeline/NodeInspector.tsx) — `ToolInspector`)

- When rendering params, detect `columnRef: true`.
- Resolve connected input: walk upstream edges to find the source tabular file. If the upstream is a FileNode, read its `path`. If it's a Transform node (item 9), compute the output schema from the Transform's rules applied to its upstream. If it's another tool, read the declared output type from the registry.
- Fetch headers via `window.api.sftp.head(path, 1)`, split by inferred delimiter.
- Render a single-select dropdown (or multi-select for comma-list params) instead of a text input.
- **Heuristic pre-selection**: seed a default for common names (`IID` → `IID`, `FID` → `FID`, case-insensitive match for `pheno` / `phenotype` / `trait` → `phenoCol`, `sex` → sex cols). Mark pre-selected values with a subtle "Suggested" chip so the user sees it was a guess.

### Schema cache ([src/stores/fileSchemaStore.ts](src/stores/fileSchemaStore.ts)) — new

`headers: Record<filePath, { columns: string[]; delimiter: string; fetchedAt: number }>`. Cache hits skip the SFTP call. Invalidate on file mtime change (item 6.2 gives us mtime for free).

### Verification

Connect a TSV with headers `FID,IID,pheno,age,sex` to a PLINK2 assoc node. Open the inspector — `pheno-name` is a dropdown pre-filled with `pheno`, marked "Suggested". Alternatives shown. Change the upstream file to one with `response` instead of `pheno` — dropdown re-populates.

---

## 9. Transform node (filter rows, select/rename columns)

### Motivation

Preview-only filtering (item 7) is exploratory; it doesn't alter what the pipeline runs. A Transform node makes the same operations reproducible, part of the graph, and materialized as intermediates.

### Data model ([src/types/pipeline.ts](src/types/pipeline.ts))

```ts
type BioflowNodeType = 'tool' | 'file' | 'note' | 'merge' | 'transform'

interface TransformNodeData {
  label: string
  rules: TransformRule[]
  outputDirOverride?: string
  status?: RunStatus | 'idle'
  jobId?: string
  error?: string
  [key: string]: unknown
}

type TransformRule =
  | { kind: 'selectColumns'; columns: string[] }
  | { kind: 'renameColumns'; mapping: Record<string, string> }
  | {
      kind: 'filterRows'
      column: string
      op: 'eq' | 'ne' | 'gt' | 'lt' | 'ge' | 'le' | 'contains' | 'regex'
      value: string
    }
```

Rules apply in order. An empty `rules` array is a pass-through.

### Script generation ([electron/pipeline/ScriptGenerator.ts](electron/pipeline/ScriptGenerator.ts))

New `generateTransformScript` picks an implementation by upstream fileType:

- **tsv / csv** → `awk` (always available). Generate a single `awk` expression combining all rules. Preserve header on the first line.
- **vcf / bcf** → `bcftools view` with `-s` (sample filter) / `-r` (region filter) / `-i` (expression filter) where the rule maps cleanly; fall back to `awk` with a warning when it doesn't.
- **pgen / plink** → `plink2 --extract` / `--keep` / `--rename` variants.
- **other** → fall back to `awk`.

Emit output at `<outputDir>/<nodeSlug>.transformed.<ext>` per the existing output-path convention.

### Axis behavior ([electron/pipeline/axisPlanner.ts](electron/pipeline/axisPlanner.ts))

Transform nodes are **axis-transparent**: an axed input produces an axed output with the same axis/keys. The generated script runs as a SLURM array for axed inputs, same as tool nodes.

### Inspector — `TransformInspector` in [NodeInspector.tsx](src/components/pipeline/NodeInspector.tsx)

- List of rules with add/remove. Each rule's fields depend on its `kind`.
- **"Copy from preview"** button: if the user has set filters in the previewer on the upstream file, one click converts those into rules on the node.
- Column dropdowns (for select / rename / filter column refs) reuse the same schema cache from item 8.

### Palette + canvas

- Add a `utility` category entry in [ToolPalette.tsx](src/components/pipeline/ToolPalette.tsx). Drop creates a Transform node.
- New component `src/components/pipeline/nodes/TransformNode.tsx` — similar to MergeNode (single input, single output, uses `transform` category color).
- `pipelineStore.addTransformNode(position)` — mirrors `addMergeNode`.
- `setNodeStatus` in [pipelineStore.ts](src/stores/pipelineStore.ts) — widen the type whitelist to include `'transform'`.

### Validator

Add `TRANSFORM_UNKNOWN_COLUMN` error: if any rule references a column not present in the upstream schema (from the schema cache), surface an error. Depends on item 8's schema inference.

### Verification

Build `input.tsv → Transform(filterRows age>50, selectColumns [IID,pheno]) → PLINK2 assoc`. Run. Confirm the intermediate on the cluster has the right rows/columns. Confirm the assoc step consumes it and completes.

---

## 10. Re-run single failed node

### Motivation

A 10-step pipeline where step 7 fails shouldn't require re-running steps 1–6. Re-running only the failed node (and its downstream) saves cluster time and reduces friction.

### Runner API ([electron/pipeline/PipelineRunner.ts](electron/pipeline/PipelineRunner.ts))

New method:

```ts
rerunNode(runId: string, nodeId: string): Promise<void>
```

Lifecycle:

1. Verify the run exists and the node is in a terminal state (`done`/`failed`/`cancelled`).
2. Re-resolve inputs from existing run state — upstream outputs were already computed and persisted.
3. Regenerate the sbatch script (picks up inspector changes made since the original run).
4. SFTP-write (overwriting the existing script), submit via `sbatch`, watch via `JobTracker` — all under the original runId.
5. Emit `pipeline:node-status` IPC events as usual. Downstream nodes that were `cancelled`/`failed` because this node failed get flipped back to `queued` so they run when this one completes.

No upstream re-runs. Fresh sibling-node-of-array-job behavior: an array node re-run re-submits all tasks (no single-task retry in v1 — noted as future work).

### IPC

- `pipeline:rerun-node` channel in [electron/ipc/pipelineHandlers.ts](electron/ipc/pipelineHandlers.ts) and [electron/preload/index.ts](electron/preload/index.ts).

### UI

- Button in `JobSummary` (item 6) for terminal-failed nodes.
- Canvas context menu (right-click) on failed tool/merge/transform nodes — "Re-run this step" entry.

### Verification

Run a 3-node pipeline where the middle node fails on a bad flag. Fix the flag in the Inspector. Click Re-run this step. Confirm only that node (+ its downstream) executes and that the sbatch script on the cluster reflects the new flag.

---

## 11. Script viewer / Dry-run mode

### Motivation

Before burning cluster time, users (and reviewers) should be able to see exactly what sbatch scripts a given pipeline would generate.

### IPC

- `pipeline:generate-scripts-dry` — takes `{ connectionId, snapshot }`, returns `{ nodeId → { script: string; outputPaths: Record<portId, string | string[]> } }`. Runs topo + axis + scriptgen in the main process without any SFTP writes or sbatch calls. Uses the same connectionDefaults lookup so paths match what the real run would use.

### UI

- "Preview scripts" button in [PipelineToolbar.tsx](src/components/pipeline/PipelineToolbar.tsx).
- Modal ([src/components/pipeline/ScriptPreviewModal.tsx](src/components/pipeline/ScriptPreviewModal.tsx)) with:
  - Left: list of nodes in topo order (layered, with axis mode annotation).
  - Right: read-only `<pre>` of the selected node's script (no Monaco dependency — overkill).
  - Per-node "Copy" button (clipboard) and "Open in new window" for longer scripts.
- Validation integration: the modal runs `validatePipeline(snapshot)` at open time and shows errors/warnings above the list.

### Verification

Load a valid pipeline. Click Preview scripts. Confirm `#SBATCH` headers are correct (account, partition, array dimensions), module loads match the tool registry, and the command line includes the expected flags. Break the pipeline (unconnected required input) and confirm the modal shows the validation error.

---

## 12. Run history persistence + squeue reattach

Closes the last deferred item from PHASE3_PLAN.md §4.5.

### Storage

- JSON-lines file per run at `<userData>/runs/<runId>.jsonl` (using Electron's `app.getPath('userData')`).
- Each line is a `RunStateEvent`:
  - `{ kind: 'run-start', runId, connectionId, snapshot, workDir, startedAt }`
  - `{ kind: 'node-status', nodeId, status, jobId?, stdoutPath?, stderrPath?, ... }`
  - `{ kind: 'run-status', status }`
  - Optional sampled log chunks (write every Nth chunk to keep file size bounded).
- Writes are fire-and-forget from the main process; a write failure logs but doesn't break the run.

### Restore on boot

- On main-process startup, scan `<userData>/runs/`, load each file, replay events into `PipelineRunner`'s in-memory map.
- Expose via existing `pipeline:list-runs` / `pipeline:get-run` IPC — the Jobs panel already reads these.

### Squeue reattach

For each run that was `running` at the prior shutdown:

1. If its `connectionId` is still alive (hydrated from main-process SSH state — shipped this phase), re-subscribe the `JobTracker` to its Slurm job ids via `squeue -j <ids>`.
2. If the ids are gone from squeue, fall back to `sacct -j <ids>` for the terminal state.
3. If the connection isn't alive, mark the run `unknown` and prompt the user to reconnect; on reconnect, retry reattach once.

### Cleanup

Keep the last 50 runs; prune older on boot. Configurable later.

### Verification

Start a pipeline, close the app mid-run, reopen. Confirm the run appears in the Jobs panel with its completed/running state. Logs for completed nodes load via SFTP. A still-running job continues to tick from its current state.

---

## 13. Autosave + keyboard shortcuts + templates + notifications

Four small, independent UX items bundled because each is ~a day's work.

### 13a. Autosave

- [pipelineStore.ts](src/stores/pipelineStore.ts) already has a `dirty` flag. Add a debounced (1 s) subscriber that writes `exportSnapshot()` to `<userData>/pipelines/<pipelineId>.json`.
- On app boot, load the most recently modified pipeline JSON and call `pipelineStore.loadSnapshot`.
- Distinct from item 12 — this is the graph, not run state.

### 13b. Keyboard shortcuts

In [PipelineCanvas.tsx](src/components/pipeline/PipelineCanvas.tsx), mount a document-level keydown handler scoped to when canvas has focus (check `document.activeElement` is not an input / textarea). React Flow's built-in behavior handles some of these — verify before duplicating.

- **Backspace / Delete** — delete selected nodes + their incident edges (already works partially; audit).
- **⌘D** — duplicate selected with +40px offset, preserving data.
- **⌘C / ⌘V** — internal clipboard (stored in `pipelineStore`, not OS clipboard). Paste at cursor position offset from the original.
- **⌘Z / ⇧⌘Z** — undo / redo (history exists in pipelineStore — wire the bindings).
- **Enter / F2** on a selected node — focus the Inspector.

### 13c. Pipeline templates (export/import)

- "Export pipeline" and "Import pipeline" entries in the TopBar or [PipelineToolbar.tsx](src/components/pipeline/PipelineToolbar.tsx).
- Export: `dialog.showSaveDialog` → write `exportSnapshot()` JSON.
- Import: `dialog.showOpenDialog` → read → validate top-level shape → confirm dialog if current graph is dirty → `loadSnapshot`.
- Seed built-in templates at [src/lib/pipelineTemplates.ts](src/lib/pipelineTemplates.ts):
  - "Basic GWAS" — pgen input → PLINK2 assoc → TSV output.
  - "Per-chrom assoc + merge" — axed chr1–22 pgen → PLINK2 assoc (array) → Merge.
  - "VCF QC → GWAS" — VCF → bcftools view → PLINK2 make-pgen → assoc.

### 13d. Notifications

- Main process: when a run transitions into a terminal state, fire an Electron `Notification` ("Pipeline `name` finished: 5 succeeded, 1 failed"). Click opens the app and selects the run in the Jobs panel.
- Renderer: a toast via a simple toast system (add [src/components/ui/Toast.tsx](src/components/ui/Toast.tsx) + a small store — nothing exists yet).
- Settings: a checkbox under connection settings (same pattern) — `connection:<id>:notifyOnFinish` (default true).

### Verification

- Edit a pipeline, quit, relaunch → graph is restored.
- Select three nodes, ⌘D → three duplicates at +40px.
- Export a pipeline, clear canvas, import — same graph.
- Run a long job; when it finishes, a system notification fires and the in-app toast appears.

---

## 14. Validator warnings carry-over

Complete the validator rules listed in PHASE3_PLAN.md that weren't shipped in Phase 3.

Add to [src/lib/pipelineValidator.ts](src/lib/pipelineValidator.ts):

- `ORPHAN_OUTPUT` — **warning** — a tool output port has no outgoing edge. Hint: "This output will be generated but not used. Add an output FileNode or a downstream tool."
- `OVERPROVISIONED_SLURM` — **warning** — a node requests resources far above a heuristic baseline for its tool (a small map in the validator, easy to tune). E.g. `bcftools view` asking for 64 CPUs. Hint points to the specific parameter.
- `TRANSFORM_UNKNOWN_COLUMN` — **error** — already listed under item 9; called out here for completeness.
- `SCHEMA_COLUMN_MISMATCH` — **error** — a `columnRef: true` param references a column not present in the resolved upstream schema (depends on item 8). Distinct from `TRANSFORM_UNKNOWN_COLUMN` in that it fires against tool params, not transform rules.

### Verification

Construct pipelines that trigger each rule; confirm the badge lights up and the inspector surfaces the hint.

---

## 15. Log streaming follow-up — stdout/stderr still empty in the viewer

### Observed

Despite item 6.1's fixes, stdout and stderr tabs still don't populate for finished non-array jobs. Item 6's shipped changes (terminal-transition SFTP refresh, path-set-at-submission, explicit error on null path) were necessary but not sufficient — the tabs are still empty when the user opens a completed run.

### Suspected root causes (investigate, don't assume)

1. **Path templating mismatch.** `runNode` sets `ns.stdoutPath = ${logDir}/${slug}-${jobId}.out` / `...-${jobId}_%a.out`. The sbatch script uses `#SBATCH --output=${logDir}/${slug}-%j.out` (non-array) / `${slug}-%A_%a.out` (array). `%j` and `%A` both resolve to the parent job id at submission time, so the strings *should* match — but verify by listing the actual file on disk after a run and diffing against `ns.stdoutPath`. A missing `.` or different Slurm format could silently break the read.

2. **Ring-buffer vs. SFTP read conflict.** For non-array jobs, `LogViewer` reads `logLines` from the runStore ring buffer (populated by `pipeline:job-log` streaming) AND fires `sftpRefresh()` on terminal transition. The refresh calls `setLog(nodeId, stream, lines)` which *replaces* the buffer. If the buffer was empty (streaming never started — job completed before the watcher saw it run), the replace should populate it; if `setLog` semantics differ (append vs. replace), this could race.

3. **`ls` format surprise from SftpPool.** `listNodeOutputs` already shipped; works fine for output files. If the log file is in `<workDir>/logs/` rather than `<workDir>/outputs/<slug>/`, the summary card's "Files created" won't list it either (intentionally — it's listing `outputDir`, not `logDir`). This is correct, but it means the summary card isn't a substitute for the tabs working.

4. **Streaming-end race for non-array jobs.** `execStream` tails via `tail -F`. When the job ends, slurm's `.out` / `.err` are written synchronously to disk by the compute node. `tail -F` on the head node may or may not catch the flush before the job is marked terminal and we call `cancelTailOut/cancelTailErr`. For a fast job (seconds) the tail might not even start before we cancel it.

### Plan

1. **Reproduce with a minimal pipeline.** `echo hi > /tmp/hi && echo bye 1>&2` as a custom.shell tool. Run it. Note what the tabs show and the actual contents of the log files on the cluster. Log all relevant `NodeRunState` fields at each transition.
2. **Add a single structured log** in `runNode` just before the sbatch call: `{ nodeId, slug, jobId-template: '%j|%A_%a', stdoutPath-set-to: ns.stdoutPath, expectedLogDirContents-at-done }`. Enough to isolate whether the path or the reader is wrong.
3. **If path-mismatch**: align the `NodeRunState` fields with the sbatch directive — pick one naming convention and stick to it. Likely adding a `%A` pattern on non-array and dropping `${jobId}` substitution.
4. **If streaming-miss**: after terminal transition, unconditionally do one final SFTP read even if the ring buffer is non-empty, and merge (not replace) so streaming doesn't lose what it already had.
5. **Belt and suspenders**: in the summary card, link to the log files directly — "stdout" / "stderr" rows with a click-to-open-log behavior. Even if the tabs break again later, the user has a path out.

### Verification

Run a fast job (exits in <2s) and a slow job (sleeps 30s). In both cases stdout and stderr tabs populate within 1s of status `done`. The "Log path not known yet" message never appears for a submitted job.

### Files

- [src/components/jobs/LogViewer.tsx](src/components/jobs/LogViewer.tsx) — merge-on-refresh fix, diagnostic logging.
- [electron/pipeline/PipelineRunner.ts](electron/pipeline/PipelineRunner.ts) — path alignment, instrumentation.
- [electron/pipeline/ScriptGenerator.ts](electron/pipeline/ScriptGenerator.ts) — potentially switch `%j` → `%A` for consistency if root cause.

---

## 16. Live Slurm queue view (`squeue -u $USER`)

### Motivation

The Jobs panel only shows jobs this app submitted. Users often want to see everything queued under their username — other runs, scheduled jobs from `sbatch` outside the app, neighbors' jobs on shared partitions. Today they switch to a terminal tab and run `squeue -u`. Pulling that into the UI closes a loop.

### Design

- **Main process**: add a lightweight poller, opt-in (not running by default — users without Slurm access shouldn't pay the exec cost).
  - `SlurmQueueWatcher` (new, `electron/slurm/SlurmQueueWatcher.ts`): per-connection. On `start()` it runs `squeue -u $USER -h -o "%i|%j|%T|%M|%l|%P|%R"` every 10 s, diffs against the previous poll, emits `slurm:queue-update` on changes. Reuses `SshManager.exec` — no SFTP needed.
  - Mirror the `JobTracker` cadence; share the exec channel if practical to avoid double-polling.
  - Stop the watcher when no renderer is subscribed (renderer ref-count).

### Data

```ts
interface SlurmQueueEntry {
  jobId: string          // '%i' — numeric or array id (e.g. "12345_[0-5]")
  name: string           // '%j'
  state: string          // '%T' — PENDING | RUNNING | COMPLETING | ...
  elapsed: string        // '%M'
  timeLimit: string      // '%l'
  partition: string      // '%P'
  reason: string         // '%R' — e.g. "Priority", "Resources", "(None)"
  isOurs: boolean        // matched against PipelineRunner's known job ids
}
```

The `isOurs` flag lets the UI bold / colorize jobs originating from BioFlow — click-through opens them in the Jobs panel.

### IPC

- `slurm:queue-subscribe(connectionId)` — opens the stream, returns latest snapshot immediately.
- `slurm:queue-unsubscribe(connectionId)`.
- Event: `slurm:queue-update({ connectionId, entries })`.

### UI

- New bottom-panel tab **"Queue"** alongside Terminal / Data / Jobs. Active connection only (disabled for `LOCAL_CONNECTION_ID`).
- Table with sortable columns: job id, name, state, elapsed, limit, partition, reason.
- Top-row controls: refresh now, auto-refresh toggle, "show only my BioFlow jobs" filter.
- Right-click on an entry → **Cancel** (calls the existing `scancel` path via `ssh.exec`), **Copy job id**, **Open in terminal** (focuses terminal tab with `scontrol show job <id>` ready to run).
- Empty state: "No queued jobs for `<username>` on this cluster."

### Failure modes

- `squeue` not on PATH → show a one-time banner explaining what's missing; don't repeatedly retry.
- Connection drops → freeze the list with a stale-state indicator; resume on reconnect.

### Verification

Submit 3 `sleep 60` jobs via `sbatch` outside the app. Open the Queue tab on the connected cluster. Confirm all 3 appear within 15 s, transition through `PD → R → CG`, and disappear on completion. Submit a BioFlow pipeline — its jobs appear in the same list with the "ours" styling.

### Files

- `electron/slurm/SlurmQueueWatcher.ts` (new)
- `electron/ipc/slurmHandlers.ts` (new) + `registerAll.ts`
- `electron/preload/index.ts` + `src/env.d.ts`
- `src/stores/slurmQueueStore.ts` (new) — mirrors main's state, per-connection.
- `src/components/jobs/QueueTab.tsx` (new).
- `src/components/layout/BottomPanel.tsx` — new tab wiring.
- `src/stores/uiStore.ts` — `bottomPanelMode` gains `'queue'`.

---

## 17. Concurrent runs — start a new pipeline without waiting

### Motivation

Today when a run is in progress, the Run button logic and UI implicitly assume a single "active" run. Users want to start another run (same or different pipeline) without waiting. Most of the infrastructure already supports multiple runs — `PipelineRunner.runs` is a `Map`, `runStore.runs` is a record keyed by `runId` — but the toolbar + jobs panel treat the active run as singular.

### Current state (verify before changing)

- `PipelineRunner.start()` already returns a unique `runId` and runs fire-and-forget via `executeRun`. No mutex. So parallel runs *should* be possible at the main-process level.
- `runStore.startRun` sets `activeRunId` to the new run's id, auto-switching the Jobs panel. Starting a second run hides the first from the primary view (user can still select it from the run dropdown in `JobsPanel`).
- `pipelineStore.setNodeStatus` clobbers node badges with the latest `pipeline:node-status` event regardless of which run it came from. **This is the main bug**: node badges on the canvas reflect whichever run last ticked, not the currently-selected pipeline's run.

### Plan

1. **Canvas node badges** should follow the *currently-displayed pipeline* only. Track per-pipeline `{ runId → per-node statuses }` in pipelineStore. `setNodeStatus` writes into the map keyed by the event's runId; the canvas renders only the active pipeline's most-recent-completed-run-per-node (or the active run, see item 18).
2. **Run button**:
   - Default: enabled whenever the pipeline validates. Clicking while another run is in progress submits a new run without prompting.
   - Optional "Queue vs. run now" toggle in the toolbar for users who want strictly-serial behavior (rare on HPC — slurm already queues).
   - Show a small badge on the Jobs tab with the count of in-flight runs (infrastructure already counts this — just wire it in).
3. **Jobs panel**: the run dropdown already supports multiple runs. Add visual grouping: "Running (2)" / "Completed (5)" sections. Default-select the most recently-started run when a new run begins; keep user's selection sticky if they picked something else.
4. **Cancel semantics**: "Cancel run" already targets a specific runId. Confirm no global state makes cancelling one run bleed into another.
5. **Notifications (item 13d)**: include the pipeline name so "Pipeline X finished" is unambiguous when two pipelines are in flight.

### Verification

Start pipeline A. While A's first node is running, open pipeline B (item 18) and start it. Confirm:

- Both runs appear in the Jobs panel's run dropdown with their own live status.
- Pipeline A's canvas shows A's node badges; pipeline B's canvas shows B's.
- Switching the active run in the Jobs panel switches the displayed logs / summary, but not the canvas.
- Cancelling A does nothing to B.

### Files

- [src/stores/pipelineStore.ts](src/stores/pipelineStore.ts) — per-pipeline run-status map, key `setNodeStatus` by runId.
- [src/stores/runStore.ts](src/stores/runStore.ts) — route node-status events to the right pipeline's map; don't overwrite `activeRunId` on new run if user has explicitly selected another.
- [src/components/pipeline/PipelineToolbar.tsx](src/components/pipeline/PipelineToolbar.tsx) — Run button no longer disabled on in-flight run.
- [src/components/jobs/JobsPanel.tsx](src/components/jobs/JobsPanel.tsx) — group runs by status in the dropdown; stickiness rules.

---

## 18. Multiple named pipelines (open / switch / new)

### Motivation

Today the app holds exactly one pipeline graph in memory. Users want several at once — e.g. a "GWAS prototype" in one tab and a "VCF QC sanity check" in another — and to switch without losing state. Pairs naturally with item 13a (autosave) and item 13c (templates), but is distinct: autosave is about persistence, templates are about sharing; this is about having multiple live pipelines at the same time.

### Data model

```ts
// src/stores/pipelineStore.ts
interface PipelineStore {
  pipelines: Record<string, PipelineSnapshot>   // keyed by pipelineId
  activePipelineId: string | null
  // ...existing canvas state is now derived from pipelines[activePipelineId]
}
```

Each pipeline has its own `id`, `name`, `description`, `nodes`, `edges`, and undo history. Switching between pipelines is just a change of `activePipelineId`.

### Storage

- One autosave file per pipeline at `<userData>/pipelines/<pipelineId>.json` (already planned under item 13a — trivially extends).
- An index file `<userData>/pipelines/index.json` keyed by id: `{ id, name, lastOpened, updatedAt }`. Used to populate the "Open recent" list without reading every JSON.

### UI

- **Tabs row** below the TopBar (or in a pipeline-switcher dropdown to preserve vertical space): one tab per open pipeline. Plus button to create a new blank pipeline. `x` on each tab closes it (auto-saves first; confirm if dirty and unsaved).
- **"Open pipeline" dialog** — scrollable list pulled from the index file, with search + last-opened timestamp. Select → load into a new tab.
- **"New pipeline"** — opens a dialog: `name`, optional template (reuses item 13c's template system when it ships; otherwise just a blank graph). Creates a fresh id, sets it active.
- **"Duplicate pipeline"** — clones the active graph with a new id; handy for experiments.

### Undo / redo

`pipelineStore` currently holds a single `history` stack. Becomes `Record<pipelineId, history[]>`. Switching tabs doesn't reset history. Memory is bounded per-pipeline (existing 50-entry cap).

### Run coupling

- Runs are already per-pipelineId via `RunState.pipelineId` — good. Item 17's canvas badge fix reads from the active pipeline's status map.
- Jobs panel stays global (shows runs across all pipelines). Optional "only show runs for the active pipeline" filter.

### Migration

On first launch after this ships, if there's an existing autosaved graph, import it as a single pipeline with id `legacy` and name "Untitled pipeline" so nothing's lost.

### Verification

- Create two pipelines with distinct graphs. Switch between tabs. Edit one — the other's graph is untouched.
- Quit and relaunch. Both pipelines are listed in "Open recent"; the last active tab is selected by default.
- Start a run on pipeline A, switch to pipeline B. Pipeline B's canvas has no run indicators; A's keep ticking (requires item 17).
- Close a dirty tab — prompt to save first.

### Files

- [src/stores/pipelineStore.ts](src/stores/pipelineStore.ts) — biggest change: restructure around a map.
- `src/components/layout/PipelineTabs.tsx` (new) — tab row + new/open/close actions.
- `src/components/pipeline/NewPipelineDialog.tsx` (new)
- `src/components/pipeline/OpenPipelineDialog.tsx` (new)
- `src/components/layout/AppLayout.tsx` — mount the tab row.
- [electron/main](electron/main) + handlers — list/read/write `<userData>/pipelines/*.json` (shared with item 13a autosave).

### Interaction with other items

- Item 13a (autosave) becomes a per-pipeline fire-and-forget write, one file per pipeline.
- Item 13c (export/import) works per-active-pipeline.
- Item 12 (run persistence) is unchanged — runs already carry `pipelineId`.
- Item 17 (concurrent runs) is a prerequisite for this to feel right: without it, switching tabs while a run is in progress is visually broken.

---

## Critical files (most-touched across Phase 4)

| File                                                              | Items affected         |
| ----------------------------------------------------------------- | ---------------------- |
| `src/types/pipeline.ts`                                           | 3, 4, 9                |
| `src/components/pipeline/NodeInspector.tsx`                       | 3, 4, 8, 9             |
| `src/components/pipeline/PipelineCanvas.tsx`                      | 5, 13b                 |
| `src/components/pipeline/nodes/{Tool,File,Merge,Transform}Node.tsx` | 1a, 3, 9             |
| `src/components/jobs/{LogViewer,JobsPanel}.tsx` + new `JobSummary.tsx` | 6                  |
| `src/components/data-preview/{DataTable,DataPreview}.tsx`         | 7, 9                   |
| `src/components/ui/Dialog.tsx`                                    | 1b                     |
| `src/components/layout/TopBar.tsx`, `connection/ConnectionStatus.tsx` | 1c, 2, 13d         |
| `electron/pipeline/PipelineRunner.ts`                             | 2, 3, 4, 6, 10, 12     |
| `electron/pipeline/ScriptGenerator.ts`                            | 3, 9                   |
| `electron/pipeline/axisPlanner.ts`                                | 3, 9                   |
| `electron/ipc/pipelineHandlers.ts`, `electron/preload/index.ts`   | 6, 10, 11, 12          |
| `src/lib/toolRegistry.ts`                                         | 8                      |
| `src/lib/pipelineValidator.ts`                                    | 9, 14                  |
| `src/stores/{ui,pipeline,run,dataPreview}Store.ts`                | 2, 6, 7, 13            |
| `src/stores/fileSchemaStore.ts` (new)                             | 8, 9                   |

---

## Reused existing pieces

- `application/x-bioflow-path` MIME type is already set by [FileTreeNode.tsx:48](src/components/file-explorer/FileTreeNode.tsx:48). Item 5 wires the receiving end.
- `uiStore.startFilePick` / `resolveFilePick` handoff — unchanged for files, extended with `mode: 'directory'` for folder picks (item 2).
- Per-connection settings pattern (`connection:<id>:slurmAccount`) — extended for `defaultAnalysisFolder` (item 2) and `notifyOnFinish` (item 13d).
- `pipelineStore.setNodeStatus` — already polymorphic; needs `'transform'` added to the whitelist (item 9).
- `inferFileType` — seeds fileType on drag-dropped FileNodes (item 5).
- `exportSnapshot` / `loadSnapshot` — underpin autosave (item 13a) and templates (item 13c).
- `JobTracker.watch` — reused by `rerunNode` (item 10) and reattach (item 12).
- `SshManager.listConnections` — shipped earlier this phase; enables item 12 reattach.
- `CustomShell` tool template in the registry — a useful dev helper when smoke-testing items 6 and 10.

---

## Assumptions (verify during implementation)

- Existing `isInput=false` FileNodes in saved pipelines have a `path` that splits cleanly into dir + basename. The one-shot migration handles typical cases; malformed values stay as-is with a warning toast.
- The tool registry is the single source of `columnRef` annotations (item 8). User-defined tools are a separate effort.
- Slurm `sacct` is available on Rorqual for every job — required by item 12 reattach.
- Electron `Notification` works in the packaged build (default true on macOS; Windows needs `app.setAppUserModelId`, already set by `electron-vite`).
- Keyboard shortcuts are focus-aware — ⌘C must not steal focus from an inspector text field.
- The schema cache (item 8) can assume a header row on TSV/CSV. For files without a header, the inspector falls back to free-text.

---

## Verification plan (end-to-end)

### Unit / behavior tests (Vitest, once a test setup exists — otherwise targeted manual)

- `axisPlanner` — output resolution with renamed FileNode sink (item 3).
- `ScriptGenerator` — transform-node output per upstream fileType (item 9).
- Validator — `ORPHAN_OUTPUT`, `OVERPROVISIONED_SLURM`, `TRANSFORM_UNKNOWN_COLUMN`, `SCHEMA_COLUMN_MISMATCH` (items 9, 14).

### Smoke scenarios (manual, against Rorqual)

- **Drag-drop authoring**: drag 3 files from the explorer, wire them to two tool nodes, name outputs, run. Should require zero typing in the inspector.
- **Column-mapping roundtrip**: connect TSV → PLINK2 assoc; confirm dropdown pre-selects the right phenotype column.
- **Transform node**: `file.tsv → Transform(filter age>50, select [IID,pheno]) → PLINK2 assoc`. Run; verify intermediate on the cluster and downstream consumption.
- **Re-run failed node**: introduce a bad flag, run, see the failure, fix in inspector, click Re-run — only that node (+ downstream) runs.
- **Persistence**: quit mid-run, reopen, confirm run state reattaches and logs are available.

### UI checks (non-fullscreen, ~800×600)

- SSH add-connection dialog scrolls.
- TopBar items don't overlap; connection status collapses to the compact pill.
- Node handles align with their labels on ToolNode with many ports.

### Notification smoke

Run a short job; confirm the system notification appears on completion and clicking it focuses the app on the Jobs panel.

---

## Out of scope (future phases)

- Cost estimation (SU hours per run).
- LLM-assisted pipeline generation.
- Single-task retry inside an array job (item 10 re-runs the whole array).
- Cross-pipeline job dependencies.
- Collaborative multi-user editing.
- Container support (Singularity / Apptainer autoloading).
- Windows installer polish and code signing.
- Schema inference for headerless files (item 8 requires a header row).
