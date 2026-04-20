# Phase 6 — Polish, Real-World Ergonomics, and Parallel Branches

**Status:** in progress. Track A is implemented; several Phase 6 ergonomics fixes
landed during interactive testing and are recorded below. Remaining planned work
is still listed in Tracks B-D.

## Project context

Phases 1–5 delivered: SSH/SFTP runtime, canvas graph editor, Slurm submission with array/fan-in, validator, Jobs panel, log streaming, run persistence, rerun, dry-run, templates, per-pipeline undo, grouped-sbatch mode, login-node execution, resource estimator, data preview with text/tabular/raw modes, pipeline switcher, global settings dialog, cross-folder split patterns with preview table, PLINK2 clump/score tools and the GRS bundle, ANNOVAR/VEP nodes with dataset guide. The Phase 5 polish pass closed the ANNOVAR/VEP runnable-on-a-fresh-cluster gap, added the first-run wizard, fixed grouped-sbatch log demux via step markers, added brace-expansion cartesian products, `.vcf.gz` preview via `zcat | head`, and persistence of `createSubfolders` + a centralized slug helper.

Phase 6 picks up what Phase 5 left on the floor (item 10 subitems) and adds the ergonomic items a GWAS researcher hits during a weeklong session: Slurm-account discovery, MFA/TOTP diagnostic logging, connection reuse, advanced-param hiding, richer node/param documentation surfaces, column-matching that survives file edits, parallel-branch fan-in, a smarter delimiter detector with manual override, a decluttered Jobs tab, saved preview views, drag-and-drop upload, learned resource estimates, module discovery, and canvas group decluttering. Item B-6 (parallel branches) is the riskiest — it touches `axisPlanner`, `ScriptGenerator`, the validator, and the merge node — and is sequenced late.

During implementation, user testing exposed a separate but urgent thread: axis
split setup and PLINK2 dry-run scripts were too opaque for real GWAS inputs.
Those fixes are now part of Phase 6 and are tracked as completed items in this
plan.

## Status summary

| # | Area | Status |
|---|---|---|
| A-10b | Axis chips on edges | implemented |
| A-10c | Column mapping in inspector | partially implemented (delimiter-aware schema loading; full mtime cache/refresh remains B-5) |
| A-10f | Login-node warning banner | implemented |
| A-10g | Centralized tool icons | implemented |
| A-11 | Axis splitter UX and auto-detection | implemented |
| A-12 | PLINK2 fileset/script generation cleanup | implemented |
| A-13 | Script preview copy/select usability | implemented |
| A-14 | SSH channel-open resilience | implemented |
| B-1 | Slurm account dropdown | planned |
| B-2a | SSH MFA diagnostic log | planned |
| B-2b | SSH session reuse | planned (channel retry/home cache/SFTP conservation implemented separately in A-14) |
| B-3 | Advanced params collapsible | planned |
| B-4a | Node hover card | planned |
| B-4b | Param tooltip + docUrl | planned |
| B-5 | Column matching + cache + refresh | partially implemented (shared delimiter/schema parser; cache invalidation refresh remains planned) |
| B-6 | Parallel-branch merge | planned |
| B-7 | Pipeline templates gallery | planned |
| B-8 | Failed-job diagnostic helper | planned |
| B-9 | Local→remote upload helper | planned |
| C-7 | Delimiter detection + filter UI | partially implemented (shared detector + schema use; manual override/filter operators remain planned) |
| C-8 | Jobs tab declutter | planned |
| C-9 | Data preview tab hygiene | planned |
| D-1 | Saved preview views | planned |
| D-2 | Drag-and-drop local file upload | planned |
| D-3 | Learned resource estimation | planned |
| D-4 | Full module spider autocomplete | planned |
| D-5 | Canvas node group auto-collapse | planned |

---

## Track A — Carry-forward from Phase 5 item 10

### A-10g. Centralized tool icons

**Diagnosis:** each of `ToolNode.tsx`, `ToolPalette.tsx`, `NodeInspector.tsx`, and `JobsPanel.tsx` picks a Lucide icon inline. Adding a tool requires edits in four places and icons drift.

**Status:** implemented.

**Plan:**
- New `src/lib/toolIcons.ts` exporting `iconForTool(toolId: string): LucideIcon` and `iconForCategory(cat: ToolCategory): LucideIcon`. Single mapping table: `gwas → Dna`, `annotation → Tags`, `qc → ShieldCheck`, `format → FileCog`, `merge → GitMerge`, `shell → Terminal`, `flow → Workflow`.
- Replace inline imports in the four callers with the helper. No visual styling changes — only the icon source.

**Verification:** grep for `lucide-react` in `src/components/pipeline` shows imports only in `toolIcons.ts` (plus unrelated chrome icons).

**Implemented notes:**
- Added `src/lib/toolIcons.ts`.
- Updated `ToolPalette`, `ToolNode`, `NodeInspector`, and Jobs-related node rows to consume the helper.

### A-10b. Axis chips on edges

**Diagnosis:** array-job structure is invisible on the canvas — users open the inspector to find out which edges carry `chr×22`.

**Status:** implemented.

**Plan:**
- New `src/components/pipeline/edges/AxedEdge.tsx` extending React Flow's `BaseEdge`. Renders a small rounded chip at edge midpoint: `{axis}×{N}`.
- Register via `edgeTypes = { axed: AxedEdge }` in `PipelineCanvas.tsx`.
- Derived selector in `pipelineStore`: `edgesWithAxis(snapshot)` runs the shared planner and tags each edge with its axis. Memoized on `nodes/edges` changes.
- Re-export the pure subset of the axis planner via a new barrel `src/lib/axisPlannerPure.ts` so the renderer does not import from `electron/*`.

**Verification:** per-chrom GWAS pipeline shows `chr×22` on every edge downstream of the axed PGEN; edges downstream of a merge show nothing.

**Implemented notes:**
- Added `src/components/pipeline/edges/AxedEdge.tsx`.
- Added renderer-safe planner helpers in `src/lib/axisPlannerPure.ts`.
- Updated `PipelineCanvas` to tag and render axed edges.

### A-10f. Login-node policy warning banner

**Diagnosis:** users don't know if login-mode will be killed by admins until the job dies.

**Status:** implemented.

**Plan:**
- New IPC channel `cluster:loginPolicy(connectionId)` → `{ hostname, cpuTimeLimitSeconds: number|null, memLimitMB: number|null, source: 'ulimit' | 'unknown' }`. Handler in `electron/ipc/clusterHandlers.ts` runs `hostname && ulimit -t && ulimit -v` over the existing SSH client, parses, returns.
- Auto-probe once per connection after successful connect (main process, cached in `SshManager` per id).
- Renderer: `src/components/connection/LoginPolicyToast.tsx` subscribes to a new `connectionStore.loginPolicy[connectionId]` field and surfaces a one-time sticky toast when `cpuTimeLimitSeconds && cpuTimeLimitSeconds < threshold`.
- Threshold configurable via `settings:cluster:loginPolicyWarnSeconds` (default 600).

**Verification:** connect to Rorqual, confirm hostname and limits are read; simulate `ulimit -t 60` on a test host, confirm toast fires.

**Implemented notes:**
- Added `electron/ipc/clusterHandlers.ts`, registered in `registerAll.ts`, and exposed via preload.
- Added `LoginPolicyToast` and connection/settings store fields for warning thresholds.

### A-11. Axis splitter UX and auto-detection

**Status:** implemented.

**Motivation:** early splitter UI required users to understand implementation
details: which folder to pick, whether files or subfolders were expected, and
which row paths were actually used. Real PLINK2 folders also include `.log`
files and companion files, so naive detection selected the wrong files.

**Implemented scope:**
- `NodeInspector.FileInspector` now has a clearer "Split into per-item files"
section with explicit key/path explanation.
- Added "Detect from folder" flow with Auto / Files here / Folders here modes.
  The user selects the folder containing split files or split subfolders; the
  app infers the likely split structure.
- Added direct-file detection, cross-folder detection, and nested-file fallback.
- Detection now prioritizes data files over logs and ranks PLINK/genetic files
  sensibly (`.pgen`, `.bed`, `.bgen`, VCF/BCF, then tabular files; `.log`,
  `.out`, `.err`, `stdout`, `stderr` are strongly de-prioritized).
- Added visible accepted key range/list, e.g. `1-22`, with an Apply action so a
  user can add/remove chromosomes by changing the range instead of editing every
  row.
- Manual brace formulas now split folder/path, filename-or-folder prefix,
  variable range, and suffix into separate fields.
- The PLINK2 hint now correctly explains that selected `.pgen` files are
  existence markers and BioFlow passes the prefix to PLINK2; `.pvar` and `.psam`
  remain implicit and are not modeled as explicit extra inputs.
- File type inference now treats common genetics tabular files as tabular:
  `.pheno`, `.phen`, `.covar`, `.sample`, `.psam`, `.eigenvec`, `.profile`.

**Verification:**
- Selecting a folder with `chr1/ukb_imp_chr1_v3.pgen` through
  `chr22/ukb_imp_chr22_v3.pgen` detects `chrom 1-22`.
- Detection chooses `.pgen` instead of `output.log` when both exist.
- Changing the range from `1-22` to `1-23` updates accepted rows from the
  existing pattern.

### A-12. PLINK2 fileset and generated-script cleanup

**Status:** implemented.

**Motivation:** dry-run scripts were functionally plausible but hard to read:
arrays used zero-based internal indices, split inputs expanded into long lookup
tables, PLINK2 received `.pgen` filenames instead of fileset prefixes, covariate
lists were comma-quoted, and `${KEY}` output expressions could be incorrectly
single-quoted.

**Implemented scope:**
- Numeric split keys are used directly as Slurm task IDs:
  `#SBATCH --array=1-22` with `KEY="$SLURM_ARRAY_TASK_ID"`.
- When split paths follow a pattern, generated scripts use a path template such
  as:

  ```bash
  i_input="/path/to/chr${KEY}/ukb_imp_chr${KEY}_v3.pgen"
  plink2 \
    --pfile "${i_input%.*}"
  ```

- Template inference handles keys that appear multiple times in each path, such
  as `chr1/ukb_imp_chr1_v3.pgen`.
- Split pattern metadata is threaded through `axisPlanner` as `pathTemplate` so
  detected glob/cross-folder splits can bypass lookup arrays.
- Irregular or non-numeric splits still fall back to safe lookup arrays.
- PLINK2 genotype inputs now render as `--pfile <prefix>` for `.pgen` files and
  `--bfile <prefix>` for `.bed` files.
- `pgen` FileNodes are compatible with PLINK input ports.
- PLINK list parameters such as `--covar-name` render as space-separated values
  (`age sexM PC1 PC2`) instead of a single comma-separated string.
- PLINK2 association `--glm` now defaults to `hide-covar`; legacy `linear` or
  `logistic` values normalize to `hide-covar` at generation time.
- Dynamic output paths use shell expansion correctly:
  `--out ".../output.${KEY}"`.
- Command formatting keeps flags and values together, making preview scripts
  much easier to read.

**Verification:**
- Per-chrom PLINK2 association dry-run emits `#SBATCH --array=1-22`, a single
  `i_input` template, `--pfile "${i_input%.*}"`, and `--covar-name age sexM PC1
  PC2`.

### A-13. Script preview copy/select usability

**Status:** implemented.

**Motivation:** app-wide `user-select: none` made generated scripts impossible
to highlight, and `navigator.clipboard.writeText` could fail silently in some
Electron contexts.

**Implemented scope:**
- `ScriptPreviewModal` script text is explicitly `select-text` and uses a
  text cursor.
- Copy button now has a fallback hidden-textarea copy path when
  `navigator.clipboard` is unavailable or denied.
- Copy button briefly changes to "Copied" after success.

**Verification:** text selection works inside the preview `<pre>` and the Copy
button copies the entire script.

### A-14. SSH channel-open resilience for dry-run and preview work

**Status:** implemented.

**Motivation:** Rorqual/HPC login nodes can reject new SSH channels when too
many exec/SFTP channels are open. Script preview only needs a small `$HOME`
lookup, but could fail with `Channel open failure: open failed`.

**Implemented scope:**
- `SshManager.exec` retries transient channel-open failures with short backoff.
- `PipelineRunner.resolveHome` caches resolved `$HOME` per connection so dry-run
  preview does not open a fresh exec channel repeatedly.
- `SftpPool` now keeps SFTP use conservative: one channel per connection and at
  most one idle SFTP channel retained, leaving room for ordinary exec channels.

**Verification:** script preview no longer fails immediately when the SSH
connection has recently used SFTP/file-preview channels.

---

## Track B — New features

### B-1. Slurm account dropdown

**Motivation:** today users paste their Slurm account as free text on first connect; mistyped accounts silently reject `sbatch`. A dropdown populated from the cluster eliminates the class.

**Data model & IPC:**
- New IPC `cluster:listAccounts(connectionId)` → `{ accounts: string[], source: 'sacctmgr' | 'sshare' | 'groups', cachedAt: number }`. Handler uses three-step fallback:
  1. `sacctmgr -n -P show assoc user=$USER format=Account`
  2. `sshare -U -P -n -o Account`
  3. `id -Gn` filtered to Alliance account prefixes (`def-*`, `rrg-*`, `ctb-*`).
- Channel file: `electron/ipc/clusterHandlers.ts`; register in `registerAll.ts`; expose under `api.cluster.listAccounts`; add to `electron/preload/index.d.ts`.
- Renderer store: new `src/stores/clusterInfoStore.ts` — `{ accountsByConnection: Record<connId, { accounts, source, cachedAt }> }`. 10-minute TTL. Exposes `loadAccounts(connId, { force })`.

**UI:**
- `ConnectionDialog` / `ConnectionManager` — replace the "Slurm account" text input with a combobox backed by the store. Still allow free-text entry when the list is empty. Show a small "Source: sacctmgr / sshare / groups" hint below.
- Reuse `getSettingsStore()` key `connection:<id>:slurmAccount` for persistence.

**Verification:** connect to Rorqual, see the user's `def-*` account pre-populated; on a stub connection with `sacctmgr` disabled, confirm fallback to `sshare` and display source.

### B-2a. SSH MFA diagnostic log

**Motivation:** Compute Canada TOTP auth is fragile — misleading "Password:" prompt, banner ordering, partial-success subtleties. When a connection fails, users see a generic error with no trace.

**Plan:**
- Extend `SshManager` to emit structured events on a single `ssh:debug` channel: `{ connectionId, stage: 'connect' | 'auth' | 'prompt' | 'banner' | 'error', detail: string, at: number }`.
- Renderer: `src/components/connection/ConnectionLogDrawer.tsx` — Radix Sheet opened from a small bug icon in `ConnectionManager`. Subscribes to `ssh:debug`; renders a scrollable log. In-memory ring buffer of the last 500 events.
- Audit: in `SshManager.buildConnectOptions` and the `keyboard-interactive` handler, tag every prompt auto-respond path with `stage: 'prompt', detail: 'auto-responded to "password" prompt'` so the "why did it use the stored password here" mystery is logged.

**Verification:** connect to Rorqual, open the drawer, confirm banner, TOTP prompt, and auto-response events are visible in order.

### B-2b. SSH session reuse

**Motivation:** clicking "Reconnect" or double-connecting wastefully tears down a live client and runs TOTP again.

**Plan:**
- `SshManager.connect(opts)` computes dedupe key `${host}:${port}:${username}:${authMethodId}`. If an existing live client matches and its `ready` state is true, return `{ connectionId, reused: true }` using the existing id.
- `authMethodId` is deterministic: key path hash for publickey, `'password'` for password, `'agent'` for agent.
- No settings toggle (per approved plan). `reused: true` surfaces in `ConnectionManager` as a small "Reused existing session" inline hint.

**Verification:** connect, then hit Connect again with the same creds — no new TOTP prompt, UI shows reused indicator.

### B-3. Advanced params collapsible

**Motivation:** PLINK2 and REGENIE inspectors are dense with rarely-touched flags (`--memory`, `--threads` overrides, `--output-missing-phenotype`) that drown the common ones (`--glm`, `--pheno`, `--covar`).

**Data model:**
- `ToolParam.advanced?: boolean` in `src/types/toolRegistry.ts`.
- Tag audit in `src/lib/toolRegistry.ts` across PLINK2 (memory/threads/output-missing-*), REGENIE (bsize, lowmem flags), ANNOVAR (nastring, remove, otherinfo), VEP (fork, buffer_size, everything variants).

**UI:**
- `NodeInspector.tsx` groups params by `advanced`. Render common first, then `<Collapsible>` "Advanced" with a chevron. Empty-collapsed state when no advanced params exist.
- Expansion state persisted per-tool-id in `uiStore.advancedExpanded: Record<toolId, boolean>`. Persist via existing `uiStore` electron-store mirror; new key `ui:advancedExpanded`. Per approved plan: persists across app restarts.

**Verification:** open a PLINK2 GWAS node — common flags visible, advanced hidden; expand, reopen inspector, state persists; restart app, state still persists.

### B-4a. Node hover card

**Motivation:** hovering a palette item or a canvas node gives no information today.

**Plan:**
- Wrap `ToolNode` (canvas) and each palette item in a Radix `HoverCard` (delay-open 400ms, close 100ms). Card content: tool name, one-line description, category icon, default resources (cpu/mem/time), count of connected vs total ports. Pure read from toolRegistry + snapshot.
- New component `src/components/pipeline/ToolHoverCard.tsx` shared by both callsites.

**Verification:** hover an unplaced palette item for ~0.5s, see card; hover a canvas node with some connected ports, card shows `3/5 ports connected`.

### B-4b. Param tooltips + doc links

**Plan:**
- Extend `ToolParam` with `description?: string`, `docUrl?: string`.
- Inspector: a small `ⓘ` icon next to each param label. Radix Tooltip on hover shows the description; if `docUrl`, the tooltip includes a "View docs →" link that `window.api.shell.openExternal` opens.
- Audit: write descriptions for the top ~50 most-used params; link upstream docs for PLINK2, REGENIE, bcftools, ANNOVAR, VEP canonical pages.

**Verification:** hover `ⓘ` on `--glm`, see description and a PLINK2 docs link; click it, browser opens.

### B-5. Column matching + cache + refresh (absorbs A-10c)

**Motivation:** today the Tool Inspector's `columnRef` selector re-fetches column lists every time the inspector re-opens and doesn't survive a file edit correctly — users see stale column names from a previous version.

**Status:** partially implemented. The shared delimiter/header parser and
delimiter-aware inspector schema loading are done. Mtime-keyed cache, explicit
refresh UI, and full transform schema propagation remain planned.

**Data model:**
- Existing `src/stores/fileSchemaStore.ts` caches schemas; extend the cache key to `${connectionId}:${path}:${mtimeMs}`. Fetch `mtime` via `sftp:stat` alongside the header read.
- Transform nodes propagate the mapped schema downstream. Add helper `src/lib/resolveUpstreamSchema.ts`: given a target port on a node, walk upstream nodes; for each transform, apply its projection; return the effective schema.

**UI:**
- `NodeInspector.tsx` column selector uses `resolveUpstreamSchema`. A small refresh button (circle-arrow icon) next to the dropdown forces re-fetch, bypassing cache.
- Effect deps: schema effect keyed on `[nodeId, portId, edgeListSignature]` where `edgeListSignature` hashes `edges.filter(e => e.target === nodeId).map(e => e.source+e.sourceHandle)`. Upstream structural changes invalidate.

**Verification:** connect a PLINK2 node to a sumstats file; select column `BETA`; edit the remote file (add a column); click refresh; new column appears. Downstream transform node's selector shows the projected schema without a manual refresh.

**Implemented notes:**
- Added `src/lib/delimitedText.ts` and wired `schemaResolver` to use it.
- `NodeInspector` now reads up to 30 header/sample lines for columnRef inputs
  and lets delimiter detection infer tabs, commas, pipes, semicolons, and
  whitespace-delimited phenotype/covariate files.
- PLINK phenotype/covariate column selectors now see separate columns instead
  of one collapsed header for space-delimited files.

### B-6. Parallel-branch merge

**Motivation:** users want two independent PLINK2 branches (e.g., male-only + female-only) to flow into one merge and continue downstream as one. Today this triggers axis-collision errors.

**Data model:**
```ts
interface MergeNodeData {
  // existing...
  convergeMode: 'axed-fan-in' | 'parallel-branches'   // NEW, default 'axed-fan-in'
  strategy: MergeStrategy                             // existing, auto-picked per mode
}
```

**axisPlanner** (`electron/pipeline/axisPlanner.ts`, pure):
- Add plan mode `'branchFanIn'`.
- A `merge` node with `convergeMode === 'parallel-branches'` plans as `branchFanIn` regardless of upstream axes. All non-merge nodes downstream inherit no axis from the merge.
- `convergeMode === 'axed-fan-in'` keeps current logic.

**Validator** (`src/lib/pipelineValidator.ts`):
- Replace the blanket "multi-input into same downstream" error with three specific codes:
  - `MULTI_INPUT_NO_CONVERGE` — two upstream nodes feed a non-merge target.
  - `AXIS_COLLISION` — two upstream nodes carry different axes into an `axed-fan-in` merge.
  - `PARALLEL_STRATEGY_INCOMPATIBLE` — `parallel-branches` merge's chosen strategy isn't valid for the incoming file types.
- New warning `BRANCH_MERGE_SCHEMA_MISMATCH` — `parallel-branches` inputs have incompatible `fileType`.

**Runner** (`electron/pipeline/PipelineRunner.ts`):
- For `branchFanIn` merges, submit with `--dependency=afterok:<jobA>:<jobB>[:<jobC>...]`, one dep per upstream node's final job id. Reuse the existing multi-dep path used for array fan-in but driven by node-ids not axis keys.

**ScriptGenerator** (`electron/pipeline/ScriptGenerator.ts`, pure):
- Extend `generateMergeScript` to accept `convergeMode`. For `parallel-branches`:
  - Default strategy: `tsv-concat-header` for `.tsv`/`.glm`; `bcftools-concat` for VCFs; `cat` fallback.
  - Input paths taken from each upstream node's single output, not per-axis items.

**UI:**
- `NodeInspector.tsx` merge panel: segmented control at top — "Axed fan-in" / "Parallel branches". Switching `convergeMode` pushes history.
- Per approved plan: small badge on the merge node header reflects current mode. **No edge styling changes.** No new node type.

**Verification:** build M/F-split GWAS → two plink2.glm nodes → one merge in `parallel-branches` mode → bcftools annotate downstream. Run. Confirm two independent slurm jobs submit in parallel, merge runs with `afterok:A:B`, downstream annotate has no axis, outputs are concatenated correctly.

### B-7. Pipeline templates gallery

**Motivation:** first-time users stare at an empty canvas. Phase 4 shipped internal templates but only reachable via the Open dialog.

**Plan:**
- New entry "Start from template…" in the `PipelineSwitcher` dropdown (below "+ New").
- New dialog `src/components/pipeline/TemplateGallery.tsx` — grid of cards: "PLINK2 per-chromosome GWAS", "REGENIE step-1 + step-2", "GRS with clumping", "Per-chromosome VCF QC", "Sex-stratified GWAS (parallel branches)" (showcases B-6).
- Templates stored in `src/lib/pipelineTemplates.ts` as `PipelineSnapshot` factories with TODO placeholders for user-provided paths.
- Selecting a template: if current pipeline is dirty, prompt. Otherwise, create a new pipeline with `name: template.name + ' (copy)'`.

**Verification:** create three templates from scratch in one session; each loads runnable except for placeholder input paths.

### B-8. Failed-job diagnostic helper

**Motivation:** when a run fails, users scroll the `.err` tail manually and guess at the cause.

**Plan:**
- On `pipeline:node-status` with status `failed`, `runStore` fetches the last 50 lines of the node's `.err` (reuse existing log-tail infra) and runs heuristics:
  - `Out of memory` / `oom-kill` / `MemoryError` → suggest bump mem 2×.
  - `TIMEOUT` / `slurmstepd: .* CANCELLED .*time limit` → suggest bump time 1.5×.
  - `command not found` / `No such file or directory: .../plinkX` → suggest missing module check.
  - `Invalid chromosome` / `No variants remaining` → suggest input filter.
- UI: new `src/components/jobs/FailureDiagnostic.tsx` rendered under the failed node's log view. Shows the tail + "Likely cause" + "Apply fix and rerun" button that mutates the node's slurm override (for mem/time) or opens the inspector (for modules/input).
- No changes to ScriptGenerator. Heuristic is renderer-only.

**Verification:** intentionally OOM a plink2 job; diagnostic shows "Likely OOM"; applying the fix bumps mem and reruns the pipeline from that node.

### B-9. Local→remote upload helper

**Motivation:** users have a phenotype file on their laptop. Today they must scp it manually to `/scratch` before wiring it into a FileNode.

**Plan:**
- `FileNodeData` gains `source: 'local' | 'remote'` (`remote` is today's default). Must be `[key: string]: unknown` compatible per existing React Flow discipline.
- When `source === 'local'`, the inspector shows the local path and an "Upload to cluster…" button. Clicking uploads via existing SFTP put to `settings:paths:uploadDir` (default `~/scratch/bioflow-uploads/`) with a progress bar, then flips `source` to `remote` and rewrites `path`.
- Settings: new key `settings:paths:uploadDir`, editable in Settings dialog.
- Validator rule `LOCAL_FILE_NOT_UPLOADED` (error) blocks submission when a FileNode has `source === 'local'`, with a one-click "Upload all" action.

**Verification:** pick a local `.pheno` via new "Browse local…" button on FileInspector; wire it into a PLINK2 node; click "Upload to cluster"; progress bar renders; `path` flips to the remote path; Run unblocks.

### C-7. Delimiter detection + filter UI

**Motivation:** `.glm`, `.profile`, space-delimited `.eigenvec` files parse as single-column; filter UI has no operator affordance; no manual delimiter override.

**Status:** partially implemented. The shared detector and parser are done and
used by both data preview and analysis-block column selectors. Filter operators
and manual delimiter override remain planned.

**Plan:**
- **7a. Detector** (`src/components/data-preview/DelimiterDetector.ts`): change `detectDelimiter` to score by column-count consistency (mode + standard deviation) first; tie-break tab > comma > space > semicolon. Add invariants at the top of the file.
- **7b. Filter UI** (`src/components/data-preview/DataTable.tsx`): per-column filter row gains an operator `<select>` (contains / = / > / < / regex). Numeric columns default `=`; string columns default `contains`. Active rules tint subtly. Add "Clear all filters" button.
- **7c. Delimiter override** (`DataPreview.tsx`): header gains `<select>` (Auto / Tab / Comma / Space / Semicolon / Pipe). Changing re-parses immediately. Override stored in `dataPreviewStore` keyed by file path; survives tab switches.

**Verification:** open a `.eigenvec` — columns appear without override; force override to "Comma" on a TSV, see single-column fallback; filter a numeric column by `> 5e-8`, rows tint correctly; clear all, rows return.

**Implemented notes:**
- Added `src/lib/delimitedText.ts` with `detectDelimiter`,
  `splitDelimitedLine`, `parseHeaderLine`, and `parseTabularData`.
- `DelimiterDetector.ts` now re-exports the shared parser for preview use.
- Detector scores candidate delimiters by consistent multi-column parsing
  across sample lines and supports tab, comma, whitespace, semicolon, and pipe.
- Parser strips VCF/PLINK `##` metadata blocks and a single leading `#` on
  header lines.
- Data preview and schema inference now share delimiter behavior, so the table
  view and analysis column selectors agree.

### C-8. Jobs tab declutter

**Motivation:** NodeRunList rows are too dense; run selector shows slug ids; log viewer chrome wastes space; no empty state.

**Plan:**
- **RunSelector** (`src/components/jobs/RunSelector.tsx`): render `{pipelineName} · {relativeTime}` (e.g., `"GWAS Pipeline · 2h ago"`); full slug in tooltip only. Keep existing groups-by-status.
- **NodeRunList** (`src/components/jobs/NodeRunList.tsx`): each row = status icon + node label + right-aligned duration. Job id + submitted/started timestamps move to row tooltip. Selected row expands to show a summary card with the full metadata.
- **LogViewer** (`src/components/jobs/LogViewer.tsx`): stdout/stderr tabs inline with header row. Add `{N} lines` badge. Left-edge collapse button hides NodeRunList and dedicates full height to logs.
- **Empty state** (`JobsPanel.tsx`): when no run is selected, render a centered illustration + "No run selected — start a pipeline to see job details here".

**Verification:** eyeball pass — all above visible; collapse toggles NodeRunList; tooltips expose dropped info.

### C-9. Data preview tab hygiene

**Motivation:** same preview panel as C-7 but opened via file explorer double-click. Filter state leaks across tabs, close button too small, scroll resets on tab revisit.

**Plan:**
- `dataPreviewStore` keyed by `path`, stored fields include `filters`, `delimiterOverride`, `scrollOffset`. Always reset `filters` on fresh tab open unless an explicit `savedView` flag is set (scaffold flag only; saved-views is future work).
- Tab label renders a small `🔵` badge when `filters` is non-empty.
- Increase tab close button target to 20×20px (pad around `×`, don't scale the glyph).
- Persist `scrollOffset` per path; restore on tab switch.

**Verification:** open `.glm`, apply a filter, switch tabs, switch back — filter active, scroll at last position, badge visible on label.

---

## Track D — Added scope from deferred items

### D-1. Saved preview views

**Motivation:** researchers often return to the same filtered, sorted, scrolled view while comparing GWAS outputs. C-9 scaffolds `savedView`; Phase 6 now makes it user-facing instead of leaving it as future work.

**Plan:**
- Extend `dataPreviewStore` with saved views keyed by file path: `{ name, filters, delimiterOverride, scrollOffset, sortState?, createdAt, updatedAt }`.
- `DataPreview.tsx` adds a compact saved-view selector next to the delimiter override: "Save view", "Update current", "Rename", and "Delete".
- Opening a file defaults to a fresh unfiltered tab; choosing a saved view applies its filters, delimiter override, sort state, and scroll offset intentionally.
- Persist saved views through the same store persistence path used for preview tab state. Keep views local-only; do not write sidecar files near user data.

**Verification:** open a `.glm`, filter to significant rows, save as "hits", close/reopen the preview, choose "hits", and confirm filters, delimiter, sort, and scroll restore without leaking to another file.

### D-2. Drag-and-drop local file upload

**Motivation:** B-9 adds a button flow for laptop files, but users naturally drag phenotype/covariate files from Finder into the app.

**Plan:**
- Add drag targets to the canvas and FileNode inspector. Dropping a local file creates or updates a FileNode with `source: 'local'`, path, and inferred file type.
- Reuse B-9 upload infrastructure, progress UI, settings key, and validator rule; do not create a second upload path.
- If a remote connection is active, offer "Upload now" after drop. If not, keep the node local and blocked by `LOCAL_FILE_NOT_UPLOADED`.
- Reject directories and multi-file drops with a clear inline message for this phase. Batch upload remains out of scope unless it falls out naturally from B-9.

**Verification:** drag a local `.pheno` onto the canvas, see a local FileNode appear, upload it to the configured remote directory, and confirm Run unblocks after the path flips to remote.

### D-3. Learned resource estimation from `sacct` history

**Motivation:** static resource estimates are useful for first runs but weak after users have real cluster history. Recent successful jobs can teach better memory/time defaults.

**Plan:**
- Add a main-process helper that queries `sacct` for completed BioFlow jobs by job name prefix and parses elapsed time, requested memory, max RSS, state, node count, and tool id encoded in job metadata.
- Store learned summaries per connection and tool id in settings: sample count, p50/p90 runtime, p90 memory, last updated, and source job ids.
- Resource estimator prefers learned p90 values when there are enough recent successful samples, with conservative fallback to the static registry defaults.
- UI surfaces the source of an estimate: "Registry default" vs "Learned from N jobs", with a reset action per tool/connection.
- Do not feed failed, cancelled, timeout, or OOM jobs into successful baselines except as warning evidence for B-8.

**Verification:** run a tool twice, query `sacct`, confirm the estimator displays learned values after the sample threshold, and confirm clearing learned estimates reverts to registry defaults.

### D-4. Full `module spider` autocomplete

**Motivation:** users still need to know exact module names for PLINK2, REGENIE, bcftools, VEP, ANNOVAR dependencies, and custom shell nodes.

**Plan:**
- New IPC `cluster:listModules(connectionId, query?)` backed by `module spider` or `module avail`, cached per connection with a manual refresh.
- Add module suggestions to settings/tool inspector fields that accept module names. Support fuzzy search by package name and version string.
- Show module metadata when available: full module name, versions, short description, and any load prerequisites printed by the cluster.
- Keep manual free-text entry; clusters vary, and autocomplete must not block unusual module naming.
- Reuse SSH debug logging from B-2a for module discovery failures.

**Verification:** connect to Rorqual, type `plink`, see PLINK2-related module suggestions, select one, and confirm the generated script loads the selected module unchanged.

### D-5. Automatic collapse/expand of canvas node groups

**Motivation:** large GWAS pipelines become hard to scan after templates, parallel branches, and per-chromosome flows land. Users need a way to compress completed or logically related groups without losing graph meaning.

**Plan:**
- Add group metadata to pipeline state for collapsed bounds and member node ids. Keep the existing node types; groups are layout metadata, not execution nodes.
- Provide automatic grouping heuristics for template-created branches and repeated per-chromosome sections, plus manual collapse/expand controls on group headers.
- Collapsed groups show a compact header with label, node count, aggregate status, and relevant axis summary. Expanding restores member node positions.
- Execution, validation, and export continue to operate on the underlying nodes and edges. Group collapse is purely visual.
- Persist group state in pipeline snapshots and undo/redo history.

**Verification:** load a per-chromosome template, auto-collapse the repeated branch group, run the pipeline, confirm aggregate status updates while collapsed, then expand and see original node positions restored.

---

## Implementation order

Batches — each mergeable and verifiable on its own.

**Current branch completed:** A-10g, A-10b, A-10f, A-11, A-12, A-13,
A-14, plus the implemented portions of B-5/C-7.

1. **Batch 1 — low-risk carry-forward + plumbing.** A-10g (icons), A-10b (edge chips), A-10f (login banner), B-1 (account dropdown), B-2a (debug log), B-2b (session reuse). All additive; no model changes.
2. **Batch 2 — inspector ergonomics.** B-3 (advanced collapsible), B-4a (hover card), B-4b (param tooltip + docUrl), B-5 (column matching + refresh). Shared file: `NodeInspector.tsx` — land as one PR or coordinate carefully.
3. **Batch 3 — preview + jobs polish.** C-7 + C-9 + D-1 share `DelimiterDetector.ts`, `DataTable.tsx`, `DataPreview.tsx`, `dataPreviewStore.ts` — land together. C-8 (Jobs tab) independent.
4. **Batch 4 — features needing new IPC / runner hooks.** B-7 (templates), B-8 (failure diagnostic), B-9 (upload helper), D-2 (drag-and-drop upload), D-3 (learned resource estimates), D-4 (module autocomplete).
5. **Batch 5 — canvas scale and highest-risk execution model.** D-5 (canvas group auto-collapse), then B-6 (parallel-branch merge). Pair with the B-6-specific template in B-7 for E2E verification.

## Critical files

**Implemented/current branch additions:** `src/lib/toolIcons.ts`,
`src/components/pipeline/edges/AxedEdge.tsx`, `src/lib/axisPlannerPure.ts`,
`src/components/connection/LoginPolicyToast.tsx`,
`electron/ipc/clusterHandlers.ts`, `src/lib/delimitedText.ts`.

**Remaining planned new files:** `src/components/connection/ConnectionLogDrawer.tsx`,
`src/stores/clusterInfoStore.ts`, `src/components/pipeline/ToolHoverCard.tsx`,
`src/lib/resolveUpstreamSchema.ts`, `src/components/jobs/FailureDiagnostic.tsx`,
`src/components/pipeline/TemplateGallery.tsx`,
`src/components/data-preview/SavedViewsMenu.tsx`, `src/lib/resourceLearning.ts`,
`src/components/pipeline/CanvasGroup.tsx`

**Heavily modified / current branch:**
- `src/components/pipeline/NodeInspector.tsx` — implemented axis split
  auto-detection, range/list editing, PLINK split guidance, delimiter-aware
  column schema loading; planned advanced section, hover card, tooltip, column
  refresh, merge mode toggle remain.
- `electron/pipeline/ScriptGenerator.ts` — implemented cleaner numeric arrays,
  path-template fan-out, PLINK `--pfile`/`--bfile` prefix handling, PLINK list
  params, `--glm hide-covar`, and dynamic shell expression quoting; planned
  `convergeMode` branch remains.
- `electron/pipeline/axisPlanner.ts` — implemented split `pathTemplate`
  propagation; planned `branchFanIn` plan mode remains.
- `electron/ssh/SshManager.ts` — implemented channel-open retry; planned reuse
  + debug events remain.
- `electron/ssh/SftpPool.ts` — implemented conservative SFTP channel limits.
- `electron/pipeline/PipelineRunner.ts` — implemented `$HOME` cache; planned
  multi-dep afterok for branch merge remains.
- `src/components/pipeline/ScriptPreviewModal.tsx` — implemented selectable
  script text and robust copy fallback.
- `src/lib/schemaResolver.ts`, `src/components/data-preview/DelimiterDetector.ts`,
  `src/components/data-preview/DataPreview.tsx`, `src/lib/fileTypeInference.ts`
  — implemented shared delimiter parsing and genetics file inference.

**Remaining planned heavy modifications:**
- `src/types/pipeline.ts` — `MergeNodeData.convergeMode`, `FileNodeData.source`
- `src/types/toolRegistry.ts` — `ToolParam.advanced`, `description`, `docUrl`
- `src/lib/toolRegistry.ts` — advanced tags, descriptions, docUrls
- `electron/pipeline/axisPlanner.ts` — `branchFanIn` plan mode
- `electron/pipeline/ScriptGenerator.ts` — `convergeMode` branch
- `electron/pipeline/PipelineRunner.ts` — multi-dep afterok for branch merge
- `src/lib/pipelineValidator.ts` — new codes
- `src/components/pipeline/NodeInspector.tsx` — advanced section, hover card, tooltip, column refresh, merge mode toggle
- `src/components/data-preview/{DataPreview,DataTable,DelimiterDetector}.tsx`
- `src/stores/dataPreviewStore.ts`
- `src/components/jobs/{JobsPanel,NodeRunList,LogViewer,RunSelector}.tsx`
- `src/components/pipeline/PipelineCanvas.tsx` — drag-drop upload target, axed edge types, visual groups
- `src/components/pipeline/FileNode.tsx` — local file source/drop state
- `electron/ssh/SshManager.ts` — reuse + debug events
- `src/stores/connectionStore.ts` — `loginPolicy` field
- `src/stores/fileSchemaStore.ts` — mtime key
- `src/stores/uiStore.ts` — `advancedExpanded`, saved preview view controls, group collapse state as needed
- `src/stores/resourceEstimateStore.ts` — learned `sacct` summaries
- `electron/preload/index.ts` + `.d.ts` + `electron/ipc/registerAll.ts` — new channels

## Verification plan (end-to-end)

1. **Edge chips** — per-chrom GWAS canvas shows `chr×22` on every axed edge.
2. **Splitter auto-detection** — selecting the parent genotype folder detects
   `chrom 1-22`; `.pgen` wins over `.log`; changing the range updates accepted
   rows.
3. **PLINK script generation** — per-chrom GWAS dry-run emits
   `#SBATCH --array=1-22`, a single `i_input="/.../chr${KEY}/...chr${KEY}...pgen"`
   template, `--pfile "${i_input%.*}"`, space-separated `--covar-name`, and a
   shell-expanded `--out "...${KEY}"`.
4. **Script preview UX** — generated script text is selectable and Copy copies
   the full script.
5. **Delimiter/schema parsing** — a space-delimited phenotype file connected to
   PLINK2 exposes real column names in `--pheno-name` / `--covar-name` pickers;
   `.eigenvec` parses multi-column in preview.
6. **SSH channel resilience** — repeated file previews and script dry-runs do
   not fail with `Channel open failure: open failed`.
7. **Account dropdown** — connecting to Rorqual auto-fills the list; stub connection falls through sacctmgr → sshare → groups.
8. **Session reuse** — reconnecting skips TOTP; UI shows "Reused session".
9. **Advanced params** — PLINK2 inspector common-first; expand persists across restarts.
10. **Hover card + tooltip** — palette and canvas nodes hover correctly; param `ⓘ` doc link opens in browser.
11. **Column matching** — edit remote file, refresh button picks up new columns; downstream transform propagates projected schema.
12. **Parallel branches** — sex-stratified GWAS template runs with two parallel sbatches + one merge via `afterok:A:B`; downstream is non-axed.
13. **Templates** — all five templates load; sex-stratified runs (item 12).
14. **Failure diagnostic** — intentionally OOM a node; diagnostic appears; "Apply fix" reruns with bumped mem.
15. **Upload helper** — local `.pheno` → "Upload to cluster" → path flips; validator unblocks Run.
16. **Delimiter + filters remaining scope** — force override to "Comma" on a TSV, see single-column fallback; numeric filter `>5e-8` filters rows; clear-all works.
17. **Jobs declutter** — RunSelector shows friendly names; NodeRunList dense→sparse; collapse toggles; empty state renders.
18. **Preview hygiene** — filter on one tab doesn't leak to another; blue badge visible; scroll position restored on tab revisit.
19. **Saved preview views** — save a filtered `.glm` view, close/reopen the tab, explicitly apply the saved view, and confirm filters/sort/scroll restore.
20. **Drag-and-drop upload** — drag a local `.pheno` into the canvas, upload it through the B-9 flow, and confirm the FileNode becomes remote.
21. **Learned resource estimation** — after enough successful runs, `sacct` history changes the displayed estimate source to "Learned from N jobs"; reset returns to registry defaults.
22. **Module autocomplete** — `module spider` suggestions appear for `plink`, selection preserves the exact module name in generated scripts.
23. **Canvas group auto-collapse** — repeated template branches collapse visually, aggregate status updates while collapsed, and expand restores node positions.

## Deferred / out of scope

- None from the previous Phase 6 deferred list. Those items are now planned as Track D.
