# Phase 5 — Usability, Clarity, and Real-World Pipelines

## Context

Phases 1–4 built the full execution runtime: SSH auth, SFTP browsing, canvas graph editing, Slurm submission with array/fan-in, validator, Jobs panel, log streaming, run persistence, rerun, dry-run, templates, and the Phase-4 polish pass (port-picker popover, per-pipeline undo, grouped run dropdown, queue scancel, pipeline-name notifications).

With core flows stable, the remaining friction is about **what the user sees** and **what real GWAS work needs**:

1. **Data preview still crashes** on some inputs, and the double-click route is too narrow — `.log`/`.sh`/`.out` files aren't recognised as "text", yet those are exactly the files users double-click when debugging a failed run.
2. **Pipeline discoverability is weak** — pipelines live behind an "Open" dialog, there's no always-visible switcher, and the gear icon in the TopBar isn't wired to anything.
3. **Array inputs don't match how clusters are organised.** Users have per-chromosome PGENs split across *directories*, not within one directory. The pattern UI is a single glob input with no preview of which files will actually be used.
4. **GWAS workflows need clumping, GRS, and annotation** (ANNOVAR/VEP). ANNOVAR and VEP need reference databases the user must download — that download happens on the login node, which we don't currently expose.
5. **Login-node execution** is a general gap. Some steps (light post-processing, small annotation jobs, internet-requiring downloads) shouldn't queue through Slurm.
6. **Resource requests** are blind defaults today — no feedback from input sizes, filters, or tool type.
7. **Linear node chains** could often be a single sbatch script, but every node gets its own allocation, which wastes queue time and Slurm resources.

Authoritative prior docs: [CLAUDE.md](CLAUDE.md), [PHASE3_PLAN.md](PHASE3_PLAN.md), [PHASE4_PLAN.md](PHASE4_PLAN.md) (sections "Post-MVP bugfix pass" for recent log/queue fixes).

---

## Work items

Ordered roughly by dependency and risk. Each item is independently mergeable.

Implementation status as of 2026-04-18:
- Items 1-9 are implemented in the app.
- Item 10 is partially implemented: 10a, 10d, and 10e are done; 10b, 10c, 10f, and 10g remain planned.
- Pipeline autosave is implemented as an additional Phase 5 usability improvement.

### 1. Data preview: crash-proofing + text mode + double-click opens everything

**Crash fix** ([src/components/data-preview/DataPreview.tsx](src/components/data-preview/DataPreview.tsx)):
- Wrap `detectDelimiter` / `parseTabularData` in a second try/catch. If they throw (e.g. mismatched quotes, extreme column count, pathological regex input), fall back to **raw text mode** — render the fetched content in a `<pre>` with monospace font and line numbers. Never let a preview failure crash the panel.
- Guard `Math.min/max(...numericValues)` in `getColumnSummary` ([DelimiterDetector.ts:117](src/components/data-preview/DelimiterDetector.ts)) against V8's argument-count limit by using a `for` loop for arrays > 5000 elements. Unlikely in a 500-line head, but deterministic.
- Add a "Raw text" toggle in the preview header so the user can opt out of parsing entirely (useful when the detector picks the wrong delimiter on a noisy file).

**Double-click opens everything** ([src/components/file-explorer/FileExplorer.tsx:handlePreview](src/components/file-explorer/FileExplorer.tsx), [src/lib/utils.ts:isTabularFile](src/lib/utils.ts)):
- Expand the double-click route so *any file under a size/binary guard* opens a preview tab. Binary files still get the binary message we already show.
- Introduce a new helper `classifyPreview(path): 'tabular' | 'text' | 'binary' | 'image'` that returns the preview mode. Tabular = current `isTabularFile` set plus `.pvar/.pgen.pvar` etc. Text = `log, sh, out, err, md, json, yaml, yml, py, R, sbatch, conf, ini, toml, bed`. Binary = everything else until proven otherwise.
- The preview store already supports per-tab modes via its data shape; extend `PreviewTab` with `mode: 'tabular' | 'text'` and add a `RawTextView` sibling component to `DataTable`.

**Extension additions** in `isTabularFile`: add `.glm`, `.eigenvec`, `.eigenval`, `.clumped`, `.profile`, `.prsice`, `.ld` so PLINK2 and clumping outputs preview cleanly.

Verification: double-click a `.log` — opens in text mode. Double-click a `.tsv` — opens tabular. Double-click an empty file, a binary, a 1-column pheno file, and a file whose first line is all quotes — none crash the panel. Toggle Raw on a malformed CSV and see the source.

---

### 2. Pipeline switcher in the TopBar

The Open dialog we added in Phase 4 is fine for "load something old" but not for "switch between three pipelines I'm working on today". Add a dropdown next to the title.

**Files:**
- [src/components/layout/TopBar.tsx](src/components/layout/TopBar.tsx) — replace the static "BioFlow Studio" label with `<PipelineSwitcher />` when not compact.
- New `src/components/layout/PipelineSwitcher.tsx` — a `<select>`-style dropdown showing the current pipeline's name; clicking reveals the list of saved pipelines plus "+ New" and "Rename…" items.
- [src/stores/pipelineStore.ts](src/stores/pipelineStore.ts) — already persists `pipeline:<id>` and maintains `pipelines:ids`. Expose a `listPipelines()` helper that reads both and returns `{id, name, updatedAt}[]`.

**Behavior:**
- Switching a dirty pipeline prompts (existing dialog pattern used in `PipelineToolbar.handleOpen`).
- Rename writes `pipeline:<id>` with an updated name; the historyByPipeline cache is keyed by id so undo survives.
- Compact mode (TopBar < 620px): show just the pipeline name as a small button with a caret.

Verification: open three pipelines in a session, flip between them from the dropdown, confirm undo stacks, dirty prompts, and rename all behave.

---

### 3. Global Settings dialog (wire the gear icon)

The gear button in the TopBar has `title="Settings"` but no handler. Wire it to a modal.

**Files:**
- New `src/components/settings/SettingsDialog.tsx` — Radix-style Dialog with left-rail sections: **General**, **Paths**, **Notifications**, **Advanced**.
- [src/components/layout/TopBar.tsx](src/components/layout/TopBar.tsx) — onClick opens the dialog.
- New `src/stores/settingsStore.ts` (renderer) — thin wrapper around `window.api.store.get/set` for the `settings:*` namespace. Keys below.
- [electron/store/settingsStore.ts](electron/store/settingsStore.ts) — unchanged (already handles arbitrary keys via the namespaced-key pattern).

**Settings shipped in this phase:**

*Paths (apply per connection, override per-pipeline):*
- `settings:paths:scriptsSubfolder` — default `scripts`
- `settings:paths:outputsSubfolder` — default `outputs`
- `settings:paths:logsSubfolder` — default `logs`
- `settings:paths:createSubfolders` — boolean, default `true`. When false, all three flatten into the run folder.
- `settings:paths:runFolderTemplate` — default `runs/{pipelineSlug}-{timestamp}`. Tokens: `{pipelineSlug}`, `{pipelineName}`, `{timestamp}`, `{date}`, `{user}`.

*General:*
- `settings:defaultPartition` — string (falls back to connection's partition)
- `settings:autoOpenJobsTabOnRun` — boolean, default true (matches today's behavior)
- `settings:confirmOnLoginNodeRun` — boolean, default true (see item 8)

*Notifications:*
- `settings:notifyOnRunFinish` — boolean, default true
- `settings:notifyOnRunFail` — boolean, default true
- `settings:notifySoundEnabled` — boolean, default false

**Runner integration** ([electron/pipeline/PipelineRunner.ts:loadConnectionDefaults](electron/pipeline/PipelineRunner.ts)): read the new keys during run setup. Paths override the hardcoded `scripts/outputs/logs` triple. When `createSubfolders=false`, all writes go to `<runDir>/` directly.

**I/O visibility on the canvas** (pairs with settings, closes the "where does my output go?" gap):
- [src/components/pipeline/nodes/ToolNode.tsx](src/components/pipeline/nodes/ToolNode.tsx) — show the computed output path for the primary output port on the node face (monospace, truncated, tooltip = full path). Derived from a new helper `computeNodeOutputPreview(nodeId, snapshot, pathSettings)` in `src/lib/outputPathPreview.ts` that mirrors the main-process resolution logic but runs synchronously in the renderer.
- When a FileNode has `isInput=false` and the parent's `outputDir` resolves, the node face shows the full `<dir>/<name>` as a single muted line.

Verification: toggle `createSubfolders=false`, run a pipeline, confirm `scripts/`, `outputs/`, `logs/` are collapsed into the run directory. Rename the run folder template to include `{pipelineName}`, run, confirm directory naming. The node face now shows the resolved output path when the pipeline is valid.

---

### 4. Array inputs: cross-folder sources + pattern preview

Today the Glob helper in `FileInspector` handles `chr{1..22}.pgen` in one directory. Real clusters split per-chromosome files across directories (`/data/chr1/geno.pgen`, `/data/chr2/geno.pgen`).

**Pattern model** ([src/types/pipeline.ts:FileNodeSplit](src/types/pipeline.ts)):
```ts
interface FileNodeSplit {
  axis: string               // unchanged
  items: SplitItem[]         // unchanged, but now derived from pattern
  pattern?: SplitPattern     // NEW — the source of truth; items are materialized from it
}

type SplitPattern =
  | { kind: 'manual' }                                  // user added rows by hand
  | { kind: 'brace'; template: string }                 // e.g. '/path/chr{1..22}.pgen'
  | { kind: 'glob'; template: string; capture: string } // wildcard + capture-group name
  | { kind: 'crossFolder'; parentDir: string; childGlob: string; file: string }
  // e.g. parent=/scratch/chroms, childGlob=chr*, file=geno.pgen → /scratch/chroms/chr{N}/geno.pgen
```

**FileInspector UI** ([src/components/pipeline/NodeInspector.tsx:FileInspector](src/components/pipeline/NodeInspector.tsx)):
- Replace the single "Pattern" input with a segmented control: **Manual / Brace range / Glob / Cross-folder**. Each mode has its own tiny form.
- **Preview table** directly below the form: always visible, rebuilds as the user types (debounced 300ms). Columns: `key`, `path`, `exists?` (SFTP stat). Red-tinted rows for missing files.
- "Accept" button commits the preview into `items`. Editing after accept still shows the preview so the user can re-sync if files changed on disk.
- Empty state: "Enter a pattern above to see which files would be used."

**Multi-extension file-set helper**: PGEN/PVAR/PSAM come as a trio. Add a small button "PLINK2 file-set" that, given a `.pgen` split, auto-creates sibling FileNodes for `.pvar` and `.psam` with the same split, wired to the same downstream tool's corresponding ports. Uses existing `pipelineStore.addFileNode` + `addEdge`.

**Resolver** in main process — add [electron/ipc/fsHandlers.ts](electron/ipc/fsHandlers.ts) channel `split:resolve(connectionId, pattern)` → `{items, missing}`. Handles all four `SplitPattern.kind`s via SFTP `ls` and glob expansion. Renderer calls it for the preview.

Verification: build a split whose files live in `/scratch/chr{1..22}/geno.pgen`, see the preview populate with all 22 rows, all green; delete `chr5/geno.pgen` on disk, refresh, see row 5 red; run the pipeline and confirm the array job receives the right paths.

---

### 5. Merged script mode + visual node grouping

Today each tool node = one sbatch. For a linear "qc → merge-vcf → tabix → stats" chain this wastes queue time. Give the user the option to merge.

**Data model** ([src/types/pipeline.ts](src/types/pipeline.ts)):
```ts
interface PipelineSnapshot {
  // existing fields...
  groups?: NodeGroup[]
}

interface NodeGroup {
  id: string
  label: string
  nodeIds: string[]           // must be a connected linear chain, same axis
  sharedResources?: SlurmOverride  // override for the merged sbatch
}
```

**Runner change** ([electron/pipeline/PipelineRunner.ts](electron/pipeline/PipelineRunner.ts), [electron/pipeline/ScriptGenerator.ts](electron/pipeline/ScriptGenerator.ts)):
- Before per-node script generation, group nodes by `groups[]`. For each group, emit **one sbatch** that concatenates the bodies of each member's generated script (headers stripped for all but the first; module loads deduped). The group's resource request = `max` across member requests unless `sharedResources` is set.
- Validator rule `GROUP_NON_LINEAR` — error — a group whose nodes aren't a single path, or whose members have different axes.
- Validator rule `GROUP_DIFFERENT_AXIS` — error — mixing axed and non-axed nodes in one group.
- Status reporting: all grouped nodes transition together (they share a jobId). The canvas paints the group outline the same status color.

**Canvas UI** ([src/components/pipeline/PipelineCanvas.tsx](src/components/pipeline/PipelineCanvas.tsx), new `src/components/pipeline/GroupOverlay.tsx`):
- Multi-select 2+ nodes → right-click → "Group into single sbatch". Creates a `NodeGroup`.
- Visually: a dashed rounded rectangle behind the group's bounding box, label in top-left corner. React Flow doesn't need a real group node — we compute the rect from member positions each render.
- Context menu on the group: "Ungroup", "Edit group resources…".
- Unsupported groupings (fan-in, branching) show a red outline + tooltip explaining why.

Verification: take a 4-node linear chain, group them, run, confirm a single Slurm job id is emitted and all four nodes move through `queued → running → done` together. Break grouping with a branch and see the validator error.

---

### 6. Clumping + GRS nodes, with GRS-bundles-clump on drag — implemented 2026-04-18

**Tool registry** ([src/lib/toolRegistry.ts](src/lib/toolRegistry.ts)):

*New entry* `plink2.clump`:
```
id: 'plink2.clump', category: 'gwas', command: 'plink2', module: 'plink/2.00a3'
inputs: [bfile/pfile genotypes (arrayable), sumstats (tsv)]
outputs: [clumped (tsv), ranges (bed)]
params: clump-p1, clump-p2, clump-r2, clump-kb, clump-snp-field, clump-field
slurm defaults: cpus=4, mem=16G, time=2h
```

*New entry* `plink2.score` (GRS):
```
id: 'plink2.score', category: 'gwas', command: 'plink2'
inputs: [genotypes (arrayable), scorefile (tsv), sumstats optional (tsv)]
outputs: [profile (tsv)]
params: score-col-nums, header, center, variance-standardize, no-mean-imputation
slurm defaults: cpus=2, mem=8G, time=1h
```

**Bundles** — drag-from-palette that instantiates multiple nodes:
- New file `src/lib/toolBundles.ts` — a bundle is `{ id, label, description, build(position): { nodes, edges } }`. One entry `grs.withClumping` creates a `plink2.clump` node + `plink2.score` node + an edge from clump's `ranges` output into score's `--extract` param via a small helper FileNode. Positions are offset so the user sees the structure immediately.
- [src/components/pipeline/ToolPalette.tsx](src/components/pipeline/ToolPalette.tsx) — show bundles in their own "Bundles" section at the top of the palette. Drag MIME: `application/bioflow-bundle`.
- [src/components/pipeline/PipelineCanvas.tsx](src/components/pipeline/PipelineCanvas.tsx) `onDrop` — new branch handles the bundle MIME: instantiates nodes + edges in one `pipelineStore` history push.

Verification: drag "GRS (with clumping)" from the palette; see two tool nodes and their wiring appear together on the canvas; run and confirm the scorefile is `--extract`-filtered by the clumped output.

---

### 7. ANNOVAR + VEP annotation nodes, with dataset guidance — implemented 2026-04-18

**Registry entries:**
- `annovar.table_annovar` — category `annotation`, command `table_annovar.pl`. Params: `buildver`, `protocol`, `operation`, `remove`, `nastring`, `vcfinput`. Module: `annovar` (user's cluster).
- `vep` — category `annotation`, command `vep`. Params: `assembly`, `cache`, `offline`, `everything`, `plugin`, `fork`. Module: `vep/110`.

Both declare an advisory field `requiresDatabase: { name, guideKey }` pointing to a guide entry.

**Dataset-download guide** (new `src/components/settings/DatasetGuideDialog.tsx`):
- A small help dialog keyed by `guideKey` (e.g. `annovar-humandb`, `vep-cache`). Content is a markdown-ish string with: the commands to run **on the login node**, where to put the output, expected disk size, where to tell the tool about it.
- Triggered from the tool node's header (a small "?" icon appears when `requiresDatabase` is declared and the node hasn't been validated against an available database), and from the NodeInspector.
- Copy-to-clipboard button for each command block.
- Does not auto-run anything — user confirms in their terminal. When login-node execution lands (item 8), we can offer "Run for me" on these commands.

**Validator rule** `ANNOT_DATABASE_MISSING` — warning — tool declares `requiresDatabase` and the node has no `annotationDbPath` param set. Clicking the warning opens the guide.

Verification: drag an ANNOVAR node, click the `?`, see the humandb download commands; set the annotation DB path, confirm the warning clears.

---

### 8. Login-node execution — implemented 2026-04-18

Some things shouldn't queue: ANNOVAR/VEP dataset downloads, small transforms, anything that needs internet. Let the user mark a node as login-node.

**Data model** ([src/types/pipeline.ts:ToolNodeData](src/types/pipeline.ts)):
```ts
interface ToolNodeData {
  // existing...
  executionMode?: 'sbatch' | 'login'   // default 'sbatch'
}
```

**Runner** ([electron/pipeline/PipelineRunner.ts](electron/pipeline/PipelineRunner.ts)):
- In the submit loop, if `executionMode === 'login'`:
  - Skip sbatch entirely. Run the generated command via `ssh.execStream` directly.
  - Emit the same IPC status events (`queued → running → done|failed`).
  - `jobId` is synthetic (`login-<uuid-slice>`); the queue panel ignores it.
  - Stream stdout/stderr straight into `runStore.appendLog` (reuses the streaming path that already exists for sbatch logs).
- New validator rule `LOGIN_NODE_HEAVY` — warning — a node with `executionMode='login'` requests cpus>4, memGB>16, or is axed. Message: "Running an array or heavy job on the login node will likely be killed by cluster admins. Consider sbatch."

**UI** ([src/components/pipeline/NodeInspector.tsx:ToolInspector](src/components/pipeline/NodeInspector.tsx)):
- Segmented control at the top of the inspector: **Slurm job** / **Login node**. The second option shows a yellow hint box with the warning rule's text.
- On the node face, login-mode nodes get a small "login" badge next to the category.
- Confirm-on-first-submit when `settings:confirmOnLoginNodeRun=true`: a one-line dialog before kickoff.

**Group interaction**: login-mode nodes can't be part of a `NodeGroup` (item 5 validator rule `GROUP_MIXED_EXECUTION`).

Verification: set a small shell node to login-mode, run it, see logs stream without a slurm job id; try to array-split a login-mode node and see the warning; put a login-mode node into a group and see the error.

---

### 9. Smart resource suggester — implemented 2026-04-18

Replace blind defaults with a per-node estimator that learns from the inputs.

**New module** `src/lib/resourceEstimator.ts`:
```ts
interface EstimateInput {
  tool: ToolDef
  nodeData: ToolNodeData
  inputSizes: Record<string, number>   // port id → resolved input bytes (0 if unknown)
  isArray: boolean
  arraySize?: number
  hasFilter: boolean                   // --extract, --keep, --chr, --region present
}

interface EstimateOutput {
  cpus: number; memGB: number; timeHours: number
  rationale: string[]   // short bullets like "32GB/chrom at chr2 size → 24GB rounded up"
  confidence: 'low' | 'medium' | 'high'
}

function estimateResources(input: EstimateInput): EstimateOutput
```

Heuristics (tunable, stored in a single lookup table at the top of the file):
- **PLINK2 GWAS**: baseline 8 CPU / 16 GB / 2 h for ≤1 GB genotype; scale memGB linearly with input size up to 64 GB; `--extract`/`--keep` filter halves the estimate; arrays use per-chrom size, not the total.
- **REGENIE step 1**: 16 CPU / 64 GB / 12 h; memGB scales with sample count (`.psam` row count).
- **REGENIE step 2**: similar to PLINK2 GWAS.
- **bcftools**: 4 CPU / 8 GB / 1 h baseline; scales with VCF size.
- **Clumping**: 4 CPU / 16 GB / 1 h regardless of size.
- **GRS (plink2 --score)**: 2 CPU / 8 GB / 30 min; memGB scales with genotype size.
- **ANNOVAR/VEP**: 4 CPU / 16 GB / 2 h; VEP with `--fork N` gets `N` CPUs. Caps at 16 GB unless the user overrides.

**Size discovery**: [electron/pipeline/PipelineRunner.ts](electron/pipeline/PipelineRunner.ts) already resolves input paths at validation. Add a one-shot `sftp.stat` pass for each resolved input before emitting the recommendation. Cache per-path in a new `src/stores/fileSizeStore.ts` keyed by `${connectionId}:${path}` with a 30 s TTL.

**UI** ([src/components/pipeline/NodeInspector.tsx:SlurmOverridePanel](src/components/pipeline/NodeInspector.tsx)):
- Compute the estimate whenever the inspector is open and inputs are resolvable.
- Show a "Suggested: 8 CPU / 32 GB / 2 h" card with the rationale bullets and "Apply" / "Apply + show why" buttons.
- If the user's current override deviates ≥2× from the suggestion, paint the fields yellow.

Verification: build a PLINK2 GWAS with a tiny 10k-variant `.pvar` and see a small suggestion; swap the input for a 500k-variant file and watch the suggestion go up; add `--chr 22` and see it drop; switch to arrayed and see per-chrom sizing.

---

### 10. Misc cleanup and polish (bundled with the above)

**10a. Visual port state** — connected vs unconnected handles should look different. Change unconnected ports to an outlined style in [ToolNode.tsx](src/components/pipeline/nodes/ToolNode.tsx). Cheap; closes a real papercut flagged during Phase 4 review.

**10b. Axis labels on edges** — when an edge carries an axed flow, render a small "{axis}×{N}" chip on the React Flow edge via `edgeTypes` + a custom component. Surfaces array-job structure without opening the inspector.

**10c. Column mapping in Tool Inspector** — (Phase 4 listed this, but we didn't ship the annotation path). Re-confirm status during Phase 5, and complete if still open. See [PHASE4_PLAN.md](PHASE4_PLAN.md) item 8.

**10d. Recent pipelines indicator** — in the new pipeline switcher (item 2), show a small dot on pipelines modified in the last 24h.

**10e. Run folder open-in-explorer** — right-click the run header in JobsPanel → "Open in File Explorer" (switches the file explorer's cwd to the run dir). Zero backend work; closes the "where did my outputs go?" loop visually.

**10f. Login-node warning banner on startup** — when connected, probe the cluster's login-node policy via a trivial `hostname` + `ulimit -t` check. If CPU-time limits are tight, show a one-time warning so users know login-mode jobs will be killed quickly.

**10g. Node icon consistency** — different tool categories use different Lucide icons; standardize the mapping in one place (`src/lib/toolIcons.ts`).

---

## Critical files (most-touched)

- [src/components/data-preview/DataPreview.tsx](src/components/data-preview/DataPreview.tsx), [DelimiterDetector.ts](src/components/data-preview/DelimiterDetector.ts), new `RawTextView.tsx` — item 1
- [src/components/file-explorer/FileExplorer.tsx](src/components/file-explorer/FileExplorer.tsx), [src/lib/utils.ts](src/lib/utils.ts), new `src/lib/filePreviewClassifier.ts` — item 1
- [src/components/layout/TopBar.tsx](src/components/layout/TopBar.tsx), new `src/components/layout/PipelineSwitcher.tsx` — item 2
- New `src/components/settings/SettingsDialog.tsx`, new `src/stores/settingsStore.ts`, [electron/pipeline/PipelineRunner.ts](electron/pipeline/PipelineRunner.ts) — item 3
- [src/types/pipeline.ts](src/types/pipeline.ts) — items 3, 4, 5, 8 (new data fields)
- [src/components/pipeline/NodeInspector.tsx](src/components/pipeline/NodeInspector.tsx) — items 4, 7, 8, 9, 10c
- New `electron/ipc/fsHandlers.ts` `split:resolve` channel — item 4
- [electron/pipeline/ScriptGenerator.ts](electron/pipeline/ScriptGenerator.ts), [electron/pipeline/PipelineRunner.ts](electron/pipeline/PipelineRunner.ts) — items 3, 5, 8, 9
- [src/lib/toolRegistry.ts](src/lib/toolRegistry.ts), new `src/lib/toolBundles.ts` — items 6, 7
- [src/components/pipeline/ToolPalette.tsx](src/components/pipeline/ToolPalette.tsx), [PipelineCanvas.tsx](src/components/pipeline/PipelineCanvas.tsx), new `src/components/pipeline/GroupOverlay.tsx` — items 5, 6
- New `src/lib/resourceEstimator.ts`, new `src/stores/fileSizeStore.ts` — item 9
- [src/components/pipeline/nodes/ToolNode.tsx](src/components/pipeline/nodes/ToolNode.tsx), [FileNode.tsx](src/components/pipeline/nodes/FileNode.tsx) — items 3, 8, 10a
- [src/lib/pipelineValidator.ts](src/lib/pipelineValidator.ts) — new rules for items 5, 7, 8

---

## Reused existing pieces

- `window.api.store` + namespaced keys — the settings dialog plugs in without any main-process changes.
- `application/bioflow-tool` drag MIME pattern — new `application/bioflow-bundle` MIME follows the same template ([ToolPalette.tsx](src/components/pipeline/ToolPalette.tsx)).
- `pipelineStore.historyByPipeline` — already keyed by pipeline id, so the switcher in item 2 gets undo-per-pipeline for free.
- `sftp:stat` IPC — reused for both the split preview's `exists?` column and the resource estimator's size discovery.
- `runStore.appendLog` / log-stream path — login-mode (item 8) reuses the existing streaming plumbing.
- Validator pattern and `ValidationBadge` — new rules just get new error codes.
- Existing `FilePickDialog` + `uiStore.startFilePick` — the settings dialog's folder-browse buttons reuse this so we don't have two browsers.

---

## Assumptions (verify during implementation)

- Cluster admins tolerate brief login-node runs (minutes, not hours). We make this the user's responsibility with a warning rule and a confirm-on-first-run dialog, not a hard block.
- ANNOVAR/VEP modules are available on Rorqual under predictable names. If they aren't, `requiresDatabase` guides the user through `module spider` first.
- `sftp.stat` round-trip cost is acceptable in the inspector open-path. If it turns out to lag, add a debounce and hide the estimator until it's ready.
- Grouped-sbatch (item 5) memory accounting — we max across members, not sum. If a merged group's members each peak separately, that's fine; if they peak concurrently, the user bumps via `sharedResources`.
- Resource heuristics in item 9 will be wrong on edge cases. Low-confidence estimates are explicitly marked and the user can ignore them.

---

## Verification plan (end-to-end)

1. **Preview**: open a `.log`, `.sh`, `.tsv`, a binary `.pgen`, an empty file, a malformed CSV — each either renders correctly or shows a contextual message. No preview crashes the panel.
2. **Switcher**: create three pipelines, switch between them from the TopBar, rename one, confirm undo state persists and dirty-prompts fire.
3. **Settings**: change the output subfolder name and toggle `createSubfolders` off; run a pipeline; confirm the remote layout matches.
4. **Array**: build a cross-folder split (`/scratch/chr*/geno.pgen`), see the preview table, run it, confirm `KEYS` is 1..22 and outputs have `.chr{N}` suffixes.
5. **Groups**: group four linear nodes, run, confirm a single slurm jobId and all four nodes move in lockstep; introduce a branch, see the validator error.
6. **Bundles**: drag the GRS-with-clumping bundle, see two connected nodes appear in one history push; run it, confirm the scorefile uses the clumped output.
7. **Annotation**: add an ANNOVAR node, click the guide, copy the humandb download command, run it on the login node (item 8), confirm path; run the ANNOVAR node.
8. **Login**: set a shell node to login-mode, run, see logs stream without a slurm jobId; try to group it — validator stops you.
9. **Estimator**: open a PLINK2 node with a known-small input, see a small suggestion; swap the input for a large one, see the suggestion grow; apply it, confirm the `#SBATCH --mem` in the dry-run preview matches.

---

## Explicitly out of scope (future phases)

- Parallel execution of *login-mode* nodes across multiple login hosts.
- Learned resource estimation (training from observed `sacct` stats). Item 9 is heuristic only.
- A full module registry with `module spider`-based autocomplete.
- ANNOVAR/VEP database downloads kicked off from the app (requires item 8 plus a download-progress UI; next phase).
- Visual node grouping with collapse/expand (item 5's group is structural only; always rendered).
- Remote-workspace sync (e.g. checkout a project folder that includes both the pipeline JSON and the input manifest).

---

# Phase 5 — Polish & Finalization Pass (audit 2026-04-18)

## Context

Items 1–9 landed; item 10 is partly done. A thorough audit across the runtime, UI, validator, and tool registry surfaces two classes of problems: (a) real bugs that silently break advertised features, and (b) UX gaps where the implementation works but the user experience doesn't match what a GWAS researcher actually needs. This pass closes both. The target is a finalized app that a researcher can open cold and run a per-chromosome GWAS + clump + score + annotate pipeline without hitting surprises.

Citations use `file:line` against the tree as of 2026-04-18. Each bullet below is an independently mergeable change.

## A. Bugs to fix (ordered by severity)

### HIGH — runtime correctness

- **Grouped sbatch: no log streaming at all, and per-node attribution impossible.** `runGroup` in [electron/pipeline/PipelineRunner.ts](electron/pipeline/PipelineRunner.ts) has no `tail -F` hookup (compare with `runNode` at line 908), and `mergeScriptsForGroup` writes one shared `.out` for the whole group. **Fix:** emit `echo '::bioflow-step:<nodeId>:start'` / `:end` markers between member scripts in `mergeScriptsForGroup`; add a `tail -F` pair to `runGroup` that demuxes lines by the currently-open marker and forwards `emitJobLog(runId, activeNodeId, chunk, stream)`. When no marker is active, drop chunks to the first member to keep something visible.
- **Login-node concurrent runs — verify, then harden.** `ssh.execStream` already calls `client.exec(...)` which opens a new SSH channel (so ssh2 multiplexing should cover concurrency). **Fix:** add a smoke test that fires two login-mode shell nodes simultaneously on the same connection and confirms output stays separate. If ssh2 serializes under load (we have seen this on older hpc sshd configs), introduce a small per-connection semaphore in `SshManager` that opens an auxiliary channel above N=2 concurrent login jobs.
- **ANNOVAR tool is not runnable on a fresh cluster.** [src/lib/toolRegistry.ts](src/lib/toolRegistry.ts) `annovar.table_annovar` has no `module` field and the existing guide skips (1) mandatory user registration at annovar.openbioinformatics.org, (2) tarball extraction, (3) `ANNOVAR_HOME`/PATH export, (4) per-database download loop. **Fix:**
  - Add optional `annovarPath` param (absolute path to the `annovar/` directory).
  - Make `module` optional; if neither is set, add validator rule `ANNOVAR_PATH_MISSING` (error).
  - Rewrite `DatasetGuideDialog` `annovar-humandb` content into four numbered stages with copy-buttons: registration reminder → `tar -xf annovar.latest.tar.gz` → `export PATH="$HOME/annovar:$PATH"` → `cd $HOME/annovar && for db in refGene cytoBand exac03 avsnp150 dbnsfp42a clinvar_20221231 gnomad211_exome; do ./annotate_variation.pl -buildver hg38 -downdb -webfrom annovar $db humandb/; done`.
- **VEP tool similarly missing module.** [toolRegistry.ts](src/lib/toolRegistry.ts) `vep` entry needs `module: 'vep/110'` or a `vepPath` param; validator rule `VEP_PATH_MISSING`; guide's `vep_install -a cf --CACHE_VERSION 110 --ASSEMBLY GRCh38 --SPECIES homo_sapiens -d $HOME/vep_cache` called out as login-mode work.
- **ANNOVAR first-run wizard (resolved decision: wizard with manual fallback).** New `src/components/settings/AnnovarSetupWizard.tsx`: detects `humandb/` under `settings:annovarDbPath`; if missing, drives the four-stage script as a single login-mode job with progress. "I'll do it myself" opens the existing `DatasetGuideDialog`.

### MEDIUM — split resolver correctness

- **Brace expansion only parses the first `{N..M}`.** [electron/ipc/fsHandlers.ts](electron/ipc/fsHandlers.ts) regex handles one group per template; `chr{1..22}.{bed,bim,fam}` silently drops the second group. **Fix:** recursive expansion yielding cartesian product; cap at 10 000 results.
- **Glob capture field is unescaped.** Same file embeds the user's `capture` string directly into a `RegExp`. **Fix:** accept only a token name (`chr`, `sample`), escape the rest of the template, inject `([A-Za-z0-9._-]+?)` for the token slot.
- **`createSubfolders=false` — confirm applied correctly.** `buildRunDirs` at line 1154 does branch on the setting; re-verify end-to-end that the script/output/log paths all flatten when it's false and that `mkdir -p` doesn't still create stray subfolders.
- **Run-folder template tokens: inconsistent slugs.** `{pipelineName}` and node labels both go through slugify but in different files. **Fix:** extract one `slugify()` helper to `src/lib/slug.ts`, import from both main and renderer.
- **Resource estimator: no hard cap.** [src/lib/resourceEstimator.ts](src/lib/resourceEstimator.ts) linear scaling on a 100 GB input suggests 800 GB mem. **Fix:** cap `memGB` at `settings:partitionMaxMemGB` (default 192 for Rorqual) and mark the estimate `confidence: 'low'` when capped.
- **Estimator cache leaks across connections.** [src/stores/fileSizeStore.ts](src/stores/fileSizeStore.ts) never prunes. **Fix:** subscribe to `connectionStore` and drop entries whose `connectionId` is no longer live.
- **Preview size guard unused.** [DataPreview.tsx](src/components/data-preview/DataPreview.tsx) defines `MAX_PREVIEW_BYTES` but skips the `sftp.stat` gate. **Fix:** `sftp.stat` before `headFile`; when over the guard, render an "Open in raw text mode" prompt instead of auto-reading 500 lines.
- **`.gz` files misclassified.** [src/lib/filePreviewClassifier.ts](src/lib/filePreviewClassifier.ts) strips only the final extension. **Fix:** compound-ext peel (reuse `inferFileType`'s logic); add a "Preview gzipped" action that pipes through `zcat | head -n 500` via SSH.

### MEDIUM — persistence & UI drift

- **Pipeline switcher: stale ids accumulate.** [src/stores/pipelineStore.ts](src/stores/pipelineStore.ts) `pipelines:ids` is append-only. **Fix:** on `listPipelines`, verify each id has a live `pipeline:<id>` blob; drop dead ones. Add a delete-with-confirmation action in `PipelineSwitcher.tsx`.
- **Pipeline rename doesn't propagate to run history (resolved decision: rewrite).** Add `pipelineStore.renamePipeline(id, name)` that updates `pipeline:<id>`, `historyByPipeline[id]`, and walks `runStore.runs` rewriting `pipelineName` on every run whose `pipelineId === id`. Persist via `pipeline:runs:v1` key in the settings store.
- **Array split items become stale on reload.** No re-resolve. **Fix:** add a "Refresh" button next to the pattern controls; auto-refresh on inspector open when `pattern.kind !== 'manual'`.
- **`notifySoundEnabled` has no audio path.** Setting is read but nothing plays. **Fix:** bundle `src/assets/notify.wav`, play via `new Audio(url).play()` in `runStore` subscribers on `done`/`failed` when the setting is true.

### LOW — icons, polish, estimator coverage

- **Resource estimator missing common tools.** Add samtools, bwa, fastqc, multiqc, bcftools.merge entries to the heuristics table.
- **Node icon mapping scattered.** Centralize in `src/lib/toolIcons.ts` (item 10g).
- **Login-node warning banner** (item 10f): run `hostname && ulimit -t` once at connect time; toast when CPU-time limit < 30 min.
- **Axis chips on edges** (item 10b): render `{axis}×{N}` via custom `edgeTypes`.
- **Column mapping in inspector** (item 10c): surface the `columnRef` selector for tools that declare column-typed params.

## B. Additional features (prioritized)

1. **ANNOVAR/VEP first-run wizard** — see HIGH above. Depends on login-node hardening.
2. **Pipeline templates library** — "Start from template" entry on the switcher: plink2 GWAS, REGENIE two-step, GRS-with-clumping, per-chromosome VCF QC. Each template is a `PipelineSnapshot` with TODO placeholders where user inputs go. Files: new `src/lib/pipelineTemplates.ts`, surface in `PipelineSwitcher.tsx`.
3. **Failed-job diagnostic helper** — on node-fail, show the last 50 lines of `.err` plus a heuristic ("OOMKilled" → bump mem 2×; `TIMEOUT` → bump time 2×; `command not found` → module missing). One-click "Apply suggestion and rerun". Files: new `src/components/jobs/FailureDiagnostic.tsx`, heuristics in `src/lib/failureHeuristics.ts`.
4. **Local-to-remote upload helper** — when a FileNode `path` points to a local file, offer SFTP-upload to `settings:paths:uploadsSubfolder` on first run. New preload method `api.sftp.upload(id, localPath, remotePath)` backed by `SftpPool.write` streaming.
5. **Grouped-sbatch log navigator** — per-member log tabs in JobsPanel once step-markers land.
6. **Image/PDF preview** — PNG/JPG via `<img src="data:...">`, PDF via `<iframe>`. `classifyPreview` gets an `'image'` branch.
7. **File explorer search** — recursive `find | head -n 500` over SSH, bound to cwd. Ctrl-F opens a search input above the tree.
8. **Pipeline diff on reload** — when loading a pipeline with in-memory edits, modal shows node-add/remove/param-change summary before clobbering.
9. **Per-partition caps in estimator** — parse `scontrol show partition` on connect; clamp estimator output to the chosen partition's `MaxMemPerNode` / `MaxTime`.

## C. Resolved architectural decisions

1. **ANNOVAR install** — Wizard with manual fallback (default: wizard; "I'll do it myself" opens the static guide).
2. **Login-node concurrency** — Multiplex ssh2 channels per job on the shared connection. Verify on Rorqual; fall back to a semaphore only if output interleaves in testing.
3. **Grouped sbatch logs** — Step-marker demux; `ScriptGenerator` emits markers, log tailer routes chunks to the active member.
4. **Pipeline rename** — Rewrite captured `pipelineName` on rename across `pipelineStore` + `runStore`.

## D. Critical files (by section)

- [electron/pipeline/PipelineRunner.ts](electron/pipeline/PipelineRunner.ts) — `runGroup` log tail + demux, step-marker handling, slug helper extraction
- [electron/pipeline/ScriptGenerator.ts](electron/pipeline/ScriptGenerator.ts) — emit step-markers in grouped output
- [electron/ipc/fsHandlers.ts](electron/ipc/fsHandlers.ts) — brace expansion recursion, glob capture escape
- [src/lib/toolRegistry.ts](src/lib/toolRegistry.ts) — annovar/vep module + path fields, new validator-friendly shape
- [src/lib/pipelineValidator.ts](src/lib/pipelineValidator.ts) — `ANNOVAR_PATH_MISSING`, `VEP_PATH_MISSING`
- `src/components/settings/DatasetGuideDialog.tsx` — rewrite ANNOVAR/VEP guides into staged copy-blocks
- New `src/components/settings/AnnovarSetupWizard.tsx` — wizard flow
- [src/lib/resourceEstimator.ts](src/lib/resourceEstimator.ts) + [src/stores/fileSizeStore.ts](src/stores/fileSizeStore.ts) — partition cap, connection-scoped pruning, additional tools
- [src/stores/pipelineStore.ts](src/stores/pipelineStore.ts) + `src/components/layout/PipelineSwitcher.tsx` — prune stale ids, delete action, rename propagation
- [src/components/data-preview/DataPreview.tsx](src/components/data-preview/DataPreview.tsx) + `src/lib/filePreviewClassifier.ts` — size guard, gz handling
- [src/components/pipeline/NodeInspector.tsx](src/components/pipeline/NodeInspector.tsx) — split refresh, column mapping
- New `src/lib/slug.ts`, `src/assets/notify.wav`, `src/lib/toolIcons.ts`, `src/lib/pipelineTemplates.ts`, `src/lib/failureHeuristics.ts`
- New `src/components/jobs/FailureDiagnostic.tsx`

## E. Verification plan

1. **Grouped logs** — group 3 nodes, run, click each in JobsPanel, confirm only that member's lines appear; confirm the shared `.out` on disk matches the concatenation.
2. **Login concurrency** — fire two login-mode shell nodes simultaneously; stdout stays separate, both exit codes tracked.
3. **ANNOVAR cold-start** — fresh account: add ANNOVAR node, run wizard, confirm `humandb/` populates, pipeline produces an annotated TSV.
4. **Cross-folder brace** — `chr{1..22}.{bed,bim,fam}` resolves to 66 green rows.
5. **createSubfolders=false** — run pipeline; `ls runDir` shows flat layout.
6. **Preview `.vcf.gz`** — double-click → zcat-piped preview; large file triggers size-guard prompt.
7. **Estimator cap** — 120 GB input caps at partition max with low confidence.
8. **Pipeline rename** — rename; existing runs in JobsPanel update their labels immediately.
9. **Deleted pipeline** — delete from switcher; reload app; stale `pipeline:<id>` key is gone.
10. **Failed-job diagnostic** — force an OOM; failure card shows "Bump memory 2×" button; clicking reruns with the new override.

## F. Out of scope for this pass

- Learned resource estimation from `sacct` history (still future).
- Multi-host login-node parallelism.
- Full module registry with `module spider` autocomplete.
- Remote-workspace sync.
