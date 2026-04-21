# Phase 7 — Analyst Ergonomics, Real-Cluster Fit, and Pipeline Scale

## Context

Phase 6 landed the ergonomic scaffolding (axis chips, login-policy toast,
account dropdown, MFA debug, advanced-param collapsible, column matching,
parallel-branch merge, templates, drag-drop uploads, learned resources, saved
preview views, canvas group collapse). During a real multi-day GWAS session on
Rorqual, a new batch of friction points surfaced that Phase 6 did not address
— PLINK2 parameter authoring is still a dense single-form affair, SSH key
setup is manual, ANNOVAR databases need a terminal, array outputs are
awkward to consume downstream, path fields have no autocomplete or truncation,
and long per-chromosome pipelines serialize at the wrong granularity. Phase 7
closes those gaps and ends with a cross-cutting consistency audit.

Target canonical pipeline used for verification throughout:

> Filtered genotype (e.g. single-ethnicity pgen) → per-chrom PLINK2 assoc
> (GWAS) → p-value filter → PLINK2 clump → PLINK2 --score (GRS) → export.
> Every chrom must flow independently through clump, with merge deferred to
> GRS.

---

## Status summary

| # | Area | Risk |
|---|---|---|
| A-1 | PLINK2 block-builder inspector | high (new param model) |
| A-2 | Column/file/parameter source picker unification | med |
| A-3 | PCA analysis tool (`plink2 --pca`) | low |
| A-4 | Input passthrough (multi-edge outputs, typed reuse) | med |
| B-1 | SSH key generator + ssh-copy-id install + agent | med |
| B-2 | Password auth audit + fix | low |
| B-3 | ANNOVAR one-click DB install driven by selected ops/build | med |
| C-1 | Opt-in auto-merge on array output ports | high |
| C-2 | Per-chrom clump / array-chain dependency plumbing | high |
| C-3 | Intermediate-file cleanup policy + per-node temp flag | med |
| C-4 | Filter-before-passthrough helper tool | low |
| D-1 | Remote file browser modal (Mac Finder-style) | med |
| D-2 | Path field autocomplete (sftp) | low |
| D-3 | Fix Finder→app drag-drop (window-level handler) | med |
| D-4 | Long-path truncation + hover reveal on nodes | low |
| D-5 | Cmd+S save shortcut + Cmd+Shift+S save-as | low |
| D-6 | Data preview filters: apply button, materialize-as-new-input | med |
| E | App-wide consistency/efficiency audit | med |

---

## Progress update

Status as of 2026-04-21:

- `A-1` PLINK2 block-builder inspector: begun implementation, currently bugged. The experimental block-builder, migration scaffolding, validator hooks, and script-emission path were added behind a settings toggle, but the UX/behavior still needs debugging before it should be treated as complete.
- `A-2` Column / file / parameter source picker unification: implemented as part of the block-builder path.
- `A-3` PCA analysis tool (`plink2 --pca`): implemented.
- `A-4` Input passthrough (multi-edge outputs, typed reuse): implemented.
- `B-1` SSH key generator + install + agent flow: implemented in-app in the connection dialog, including generated-key switching, optional agent/keychain add, and MFA caveat messaging.
- `B-2` Password auth audit + remember-password behavior: implemented. Password auth keeps working, remembered passwords now persist only when explicitly requested, and saved connections no longer infer password persistence implicitly.
- `B-3` ANNOVAR one-click DB install: implemented with selected-feature/build-driven database calculation, installed vs missing status checks, estimated download sizes, and in-app install progress events.
- `C-1` Opt-in auto-merge on array output ports: implemented with tool defaults, per-node overrides, implicit merge execution, and validator coverage for missing merge strategies.
- `C-2` Per-chrom array-chain dependency plumbing: implemented with task-level `aftercorr` when available and job-level fallback otherwise; canonical PLINK clump chaining is now supported.
- `C-3` Intermediate-file lifecycle policy + per-node temp flags: implemented with global lifecycle settings, per-output intermediate flags, manifest writing, and best-effort post-success cleanup.
- `C-4` Filter-before-passthrough helper tool: implemented via the new `flow.filterFile` entry that creates a reusable transform-backed filter/materialize step.
- `D-1` Remote file browser modal: implemented and wired into node path/folder picking.
- `D-2` Path field autocomplete: implemented for remote path inputs and the browser path bar.
- `D-3` Finder → app drag-drop: implemented with window-level drag/drop handling and a canvas-wide drop overlay.
- `D-4` Long-path truncation + hover reveal: implemented on primary node path/output rows with bounded node widths and middle-ellipsis rendering.
- `D-5` Cmd/Ctrl+S save + Cmd/Ctrl+Shift+S save-as: implemented.
- `D-6` Data preview draft/apply filters + export/materialize: implemented with draft filter buffers, explicit Apply/Revert, and one-click export into a reusable filtered-file pipeline chain.

Audit follow-up on 2026-04-21:

- `B-2` password/MFA auth handling tightened so keyboard-interactive prompts can carry Duo push/menu responses (for example entering `1` for push) instead of being framed as TOTP-only.
- `B-3` ANNOVAR database checks now distinguish `installed`, `missing`, and `stale` states, and the installer targets all non-installed required databases.
- `C-2` / `C-3` execution settings are now surfaced as per-pipeline controls in the toolbar, while new/legacy pipelines correctly inherit global defaults when no per-pipeline override is present.
- `D-1` / `D-2` remote browsing fixes landed for forced refresh and PLINK/BED picker compatibility.
- `D-3` window-level file drag/drop overlay handling was stabilized to avoid flicker from nested dragleave events.
- `D-5` File menu parity is now present alongside the keyboard shortcuts (`New`, `Open`, `Save`, `Save As`).
- Validator audit: transform-node validation was corrected to stop using merge-specific branch logic/messages.

Track E is intentionally deferred until the rest of Phase 7 is in place.

---

## Track A — Node authoring and analysis blocks

### A-1. PLINK2 block-builder inspector

**Motivation:** today every PLINK2 tool (assoc, clump, score, pca, qc)
renders as one long form. Adding the right mix of flags requires jumping
between the PLINK2 docs and the inspector, and there is no way to visually
see the command being built. Users asked for a block-by-block / drag-flags
formula builder.

**Data model (types/toolRegistry.ts, types/pipeline.ts):**

- New `ToolFlagDef` catalog per tool: `{ id, flag, label, group, kind:
  'toggle' | 'value' | 'columnRef' | 'fileInput' | 'list' | 'enum',
  valueSchema, description, docUrl, requires?: string[], conflicts?:
  string[], defaultEnabled?: boolean }`. Groups: `Input`, `Model`,
  `Filters`, `Output`, `Resources`, `Advanced`.
- New `ToolNodeData.flagBlocks: Array<{ id, flagId, value, enabled }>` —
  ordered list of selected flag blocks (order drives command order).
- Legacy `paramValues` is migrated once on load via a `migrations` helper;
  unrecognized keys surface as raw blocks so nothing is lost.

**UI — `src/components/pipeline/inspector/FlagBuilder.tsx`:**

- Left: grouped flag palette (collapsible groups, search box, docUrl on
  each chip). Right: ordered "active flags" list showing one block per
  flag with its control (toggle / input / column-picker / file-picker /
  enum). Drag to reorder; drag from palette to insert; click × to
  remove.
- Below the list: live command preview (read-only, syntax-highlighted,
  identical format to ScriptPreview) that updates on every block change.
  Conflicts/requires violations highlight red with a tooltip and block Run
  via a new validator rule `FLAG_CONFLICT`.
- Groups can be collapsed; "Advanced" starts collapsed (reuse
  `uiStore.advancedExpanded`).
- Presets dropdown: "Standard assoc", "QC filter set", "GRS scoring",
  "PCA". Each preset is just an initial `flagBlocks` array.

**ScriptGenerator (`electron/pipeline/ScriptGenerator.ts`):**

- Replace per-tool hardcoded flag emission with `emitFlagBlocks(blocks,
  ctx)` that walks `flagBlocks` in order. `columnRef` blocks resolve
  through the existing column projection helper; `fileInput` blocks
  resolve against upstream edges. Keep `resolvePlinkInputPrefix` /
  `--pfile`/`--bfile` handling exactly as-is — it lives in the resolver,
  not in a generic `kind: 'fileInput'` block.
- Applies to `plink2.assoc`, `plink2.clump`, `plink2.score`,
  `plink2.pca` (A-3), `plink2.qc`. REGENIE and bcftools stay on legacy
  rendering for now (noted in deferred).

**Verification:**

- Drag `--glm` into active, preview shows `plink2 --pfile ... --glm
  hide-covar`; add `--covar` block, pick file upstream, add `--covar-name`
  block, pick columns — preview updates in place.
- Required-flag validator blocks Run when `--clump` is present but
  `--clump-p1` threshold is missing.
- Existing pipelines load without data loss (migration smoke test on
  `examples/per-chrom-gwas.pipeline.json`).

### A-2. Column / file / parameter source picker unification

**Motivation:** column pickers, file pickers, and text path fields are
three different components today, each with its own refresh/cache story.

**Plan:**

- Single `ValueSource` type: `{ kind: 'literal' | 'upstream-column' |
  'upstream-file' | 'path' | 'local-path' }`. Flag blocks that accept a
  value delegate rendering to one `ValueSourceField` component.
- Reuses `resolveUpstreamSchema` (Phase 6) and the new browser modal (D-1)
  and autocomplete (D-2).
- No separate columnRef code path in NodeInspector — the flag builder is
  the only consumer.

**Verification:** switching a block from "literal value" to
"upstream-column" on `--pheno-name` offers a column chip picker; switching
a `--covar` path block to "upstream-file" lets the user pick an upstream
FileNode or tool output without opening an explorer.

### A-3. PCA analysis tool

**Plan:**

- Add `plink2.pca` to `src/lib/toolRegistry.ts`: input port `genotype`
  (pgen/bed), outputs `eigenvec` (tabular), `eigenval` (tabular). Flag
  catalog: `--pca <count>`, `--maf`, `--mind`, `--geno`, `--hwe`,
  `--chr`, `--keep`, `--remove`, `--out`.
- Default `--pca 10`. Uses the same block-builder (A-1).
- Include in the "GWAS PCA covariate" template (B-7-ish followup): pgen →
  plink2.pca → split eigenvec columns as upstream-column source for
  assoc's `--covar-name`.

**Verification:** pipeline pgen → plink2.pca → plink2.assoc with
`--covar` = pca.eigenvec and `--covar-name` = PC1 PC2 PC3 runs end-to-end
and produces a glm with covariate columns.

### A-4. Input passthrough (multi-edge outputs, typed reuse)

**Motivation:** users want one genotype FileNode to feed multiple
downstream analyses (assoc, pca, clump) without duplicating the node.
Today a second edge from the same output handle *is* allowed by the model
but the inspector / script generator treats each consumer independently,
and users report the UX is unclear (edges visually overlap).

**Plan:**

- `PipelineCanvas`: when an output already has ≥1 edge and the user drags
  a new connection from it, offer a "fan-out to N inputs" connection
  style (slight edge curvature offset + labelled handle count).
- New node affordance: right-click on a FileNode handle → "Wire to all
  compatible inputs on canvas" action. Idempotent; skips already-wired
  targets.
- Validator: warn `UNUSED_FILE_NODE` downgraded to info when a FileNode
  feeds ≥1 consumer. Error only if 0 consumers and node is required.
- No schema change — edges already support 1:N.

**Verification:** one pgen FileNode feeds assoc + pca + clump + qc in the
canonical pipeline; dry-run shows each tool receiving the same
`--pfile` prefix.

---

## Track B — Connection and environment setup

### B-1. SSH key generator + install + agent

**Motivation:** new users fumble through `ssh-keygen` / `ssh-copy-id`
manually (and often give up). "What is ssh-agent" came up — surfacing it
as part of a one-click flow is the right answer.

**Plan:**

- New IPC `ssh:setupKey({ host, port, username, password, comment })`:
  1. `ssh-keygen -t ed25519 -N '' -f
     ~/.ssh/bioflow_<hostSlug>_<username>` (fail if file exists unless
     `overwrite: true`).
  2. Password-auth SSH into the host once, append the new public key to
     `~/.ssh/authorized_keys` with correct modes (`chmod 700 ~/.ssh; chmod
     600 ~/.ssh/authorized_keys`).
  3. On Compute Canada TOTP clusters, MFA may still be required for
     key-based auth per org policy — surface a note, do not claim
     passwordless login if `keyboard-interactive` is still required.
- Agent handling: if `SSH_AUTH_SOCK` is set, offer `ssh-add <keypath>` via
  `spawn` so the passphrase is cached for the session. On macOS, add the
  key to the keychain if the user opts in (`ssh-add --apple-use-keychain`).
- Explain in a short helper paragraph in the dialog: "ssh-agent holds
  your key in memory so you don't retype the passphrase every time.
  BioFlow will ask it to remember this key for your session."
- UI: `ConnectionDialog` gains an "Auto-setup key" button in the auth
  section. Wizard: Step 1 confirm host/user, Step 2 password prompt
  (in-app, scoped to setup), Step 3 progress + result. On success,
  auth method auto-switches to `key` with the generated path.

**Verification:** on a fresh account, Auto-setup completes and a follow-up
Connect succeeds without a password prompt (TOTP still required if the
cluster enforces it, with a clear UI note).

### B-2. Password auth audit

**Plan:**

- `SshManager.buildConnectOptions`: confirm password is actually passed
  when `authMethod === 'password'`; confirm `tryKeyboard` fallback path
  does not consume the password destined for keyboard-interactive TOTP
  on password-only hosts.
- Add explicit test through `scripts/test-ssh.mjs --password` asserting
  successful auth on a password-only host and a clear failure mode on
  wrong-password (no hang).
- Fix `ConnectionDialog` so the password field is persisted to the
  secure store only when user checks "Remember password" (currently
  inferred — audit and fix as needed).

**Verification:** pass/fail paths produce discriminated errors in
`ConnectionLogDrawer`.

### B-3. ANNOVAR one-click database install

**Motivation:** today the wizard shows setup instructions but does not
run them. The set of required databases is a function of the selected
`--protocol`/`--operation` flags and `buildver`.

**Plan:**

- `src/lib/annovarCatalog.ts`: static map of protocol → database name
  (`refGene`, `gnomad41_genome`, `clinvar_20240917`, `dbnsfp47a`, …),
  keyed by buildver. Source: ANNOVAR humandb docs. Include estimated
  download size per DB so the user sees a total.
- Inspector: when ANNOVAR node flag blocks change, compute the required
  DB set, show a pill list with status per DB (`Installed` /
  `Missing` / `Stale`). One button: "Install missing (X GB)".
- IPC `annovar:installDatabases({ connectionId, humandbPath, buildver,
  databases[] })`: runs `annotate_variation.pl -downdb -buildver $BV
  -webfrom annovar <db> $HUMANDB` for each missing DB, streaming
  progress on `annovar:install-progress` events.
- Check-installed is a cached `sftp:stat` on each DB's canonical file
  (e.g., `hg38_refGene.txt`).

**Verification:** pick protocol `refGene,gnomad41_genome,clinvar`, buildver
`hg38`, click Install — three `-downdb` commands run in order, progress
renders, status flips to Installed; re-running is a no-op.

---

## Track C — Execution model: merge, chains, file lifecycle

### C-1. Opt-in auto-merge on array output ports

**Motivation:** today a fan-out (per-chrom) analysis emits N files, and
downstream must use a `merge` node or a `multi:true` port. For common
cases (GWAS assoc output used by a non-axed downstream) users want "just
give me one merged file" without explicit wiring.

**Plan (types, axisPlanner, ScriptGenerator, Runner):**

- `ToolPort.autoMergeDefault?: MergeStrategy` in the tool registry (e.g.,
  `plink2.assoc` output `glm` defaults to `tsv-concat-header`).
- Per-node override: `ToolNodeData.outputMerge: Record<portId, { mode:
  'fan-out' | 'auto-merge', strategy?: MergeStrategy }>`. Default
  inherits port's `autoMergeDefault`.
- Output port chip on the node shows `⋮22` (fan-out) or `⇢1` (merged)
  and is toggleable by click.
- `axisPlanner`: if an axed output has `auto-merge`, synthesize an
  implicit merge step in the plan — its outputs replace the axed value
  downstream. Runner submits the merge as an `afterok:<arrayJobId>` job
  using the same path as B-6's branch merge, no extra node in the graph.
- Validator rule `AUTO_MERGE_STRATEGY_MISSING` when the port has no
  default and no override.

**Verification:** canonical pipeline assoc → filter: with auto-merge on
the assoc glm, filter sees a single merged file; toggling back to fan-out
restores per-chrom inputs. No explicit merge node required.

### C-2. Per-chrom clump / array-chain dependency plumbing

**Motivation:** canonical pipeline should keep chrom axis alive through
clump (each chrom's clump starts as soon as its GWAS task finishes),
merge only at GRS.

**Plan:**

- `plink2.clump` input port marked `arrayable: true` (already is for
  `plink2.assoc`). Ensure `axisPlanner` inherits axis through clump when
  upstream is axed and downstream port is not `multi:true`.
- `PipelineRunner.runNode`: for axed→axed chains, submit the downstream
  array with `--dependency=aftercorr:<upstreamArrayJobId>` (task-level
  dependency, not job-level). Fall back to `afterok` when aftercorr is
  unsupported on the cluster (detect via a one-time `sbatch --help |
  grep aftercorr` cache).
- C-1 auto-merge moves into play at GRS: plink2.score input port's
  `--score-file` is set to auto-merge so GRS receives one clump output.
- Settings: per-pipeline flag `arrayChainMode: 'task-level' |
  'job-level'` (default task-level on Slurm ≥ 17.11 with aftercorr).

**Verification:** canonical pipeline runs with 22 parallel assoc tasks;
clump task K starts as soon as assoc task K finishes; total wallclock is
close to one chrom's runtime plus one merge, not 22×.

### C-3. Intermediate-file cleanup policy + per-node temp flag

**Plan:**

- Settings (global + per-pipeline override): `fileLifecycle.policy:
  'keep-all' | 'keep-outputs-only' | 'delete-intermediates-on-success'`.
  Default `keep-all`.
- `ToolOutputPort.intermediate?: boolean` and per-node override
  `ToolNodeData.outputIntermediate: Record<portId, boolean>`.
- After a successful run, `PipelineRunner` collects all outputs marked
  intermediate from the run manifest and removes them on policy
  `delete-intermediates-on-success`. Failures never delete. A manifest
  `intermediates.json` is always written so the user can clean up later
  even under `keep-all`.
- Also emits scripts alongside intermediates so the user can re-run a
  single step post-cleanup — scripts are always preserved.

**Verification:** run the canonical pipeline with
`delete-intermediates-on-success`; glm/clump per-chrom files disappear,
GRS final output and logs remain.

### C-4. Filter-before-passthrough helper tool

**Plan:**

- New `flow.filterFile` tool: tabular-in, tabular-out; params are the
  same column/operator model as DataPreview filters. Emits a new file
  that downstream consumers use as input.
- Rationale: users currently re-filter the same file in 3 downstream
  nodes; one helper generates the filtered artifact once.

**Verification:** swap manual `awk` filter in canonical pipeline with
`flow.filterFile`, downstream receives pre-filtered file.

---

## Track D — Canvas / field ergonomics

### D-1. Remote file browser modal (Mac Finder-style)

**Motivation:** sidebar handoff is awkward for node path fields; users
want a dialog they can focus on.

**Plan:**

- New `src/components/file-browser/RemoteFileBrowser.tsx` Radix Dialog:
  - Left pane: favorites (`$HOME`, `$SCRATCH`, `~/projects/def-*`,
    learned from Phase 6 account) and recent paths.
  - Main pane: column view (click-through) or list view toggle.
  - Top: path breadcrumb + manual path input with autocomplete (D-2).
  - Filter chips: file-type filter (reuses `inferFileType`), hide
    dotfiles toggle.
  - Select mode: single file | directory | multi-file (caller-specified).
- Replaces `FolderPickerField` / `FileInspector` Browse flow. Sidebar
  explorer keeps its independent role for ambient browsing.
- `uiStore.filePickMode` stays as the store contract; the modal is just
  a different UI that resolves the same flag.

**Verification:** clicking Browse on a FileNode opens the modal, favorites
are populated from the active connection, selecting a file closes the
modal and resolves the pick.

### D-2. Path field autocomplete

**Plan:**

- New IPC `sftp:readdir({ connectionId, path, limit })` (already exists
  under `SftpPool.ls` — expose in preload if not already).
- New `RemotePathInput` component: debounced lookup on the parent
  directory of the typed prefix, filter by the trailing segment,
  render a dropdown of up to 20 candidates. Tab completes the longest
  common prefix. Supports `~` expansion via a cached `$HOME` (same cache
  as Phase 6).
- Replaces raw `<Input>` for node path fields and modal path bar.

**Verification:** typing `~/scratch/gw` suggests `gwas/`, Tab completes,
arrow-keys pick a child.

### D-3. Fix Finder→app drag-drop

**Motivation:** reportedly broken. Likely cause: drop lands outside the
canvas dropzone (on the toolbar / header) or dragover is preventDefault-
missing on ancestors.

**Plan:**

- Add window-level `dragover`/`drop` handlers on the top-level app root
  that (a) call `preventDefault` unconditionally, (b) route drops to the
  canvas handler with the drop coordinates mapped, or to the inspector
  if a FileNode is selected.
- Verify Electron `webSecurity` and `webContents.session` allow reading
  `File.path`; if `file://` permissions are the blocker, use
  `webUtils.getPathForFile(file)` in preload and hand the resulting
  absolute path to the renderer.
- Show a subtle canvas-wide "Drop file here" overlay during dragover.

**Verification:** drag a `.pheno` from Finder anywhere onto the app → a
local FileNode appears; B-9 upload helper kicks in for remote use.

### D-4. Long-path truncation + hover reveal

**Plan:**

- `FileNode.tsx`, `ToolNode.tsx`, and node headers: wrap path text in a
  middle-ellipsis component (`src/components/ui/MiddleEllipsis.tsx`) with
  configurable max width. Full path on hover via existing `title`
  attribute *plus* a Radix HoverCard showing path + split axis summary.
- Bound node width in `React Flow`: max width 320px; internal text uses
  `min-w-0` + `flex-shrink` correctly so label/path wrap inside the
  node instead of stretching it.
- Fix overflow in `NodeInspector` path rows the same way.

**Verification:** extremely long split pattern path no longer extends a
FileNode past 320px; hovering reveals full path; canvas pan/zoom
unchanged.

### D-5. Cmd+S save shortcut

**Plan:**

- Global key handler in `App.tsx` (or `AppLayout`): `Cmd/Ctrl+S` calls
  `pipelineStore.savePipeline()`; `Cmd/Ctrl+Shift+S` opens Save As
  dialog. Ignore when focus is in an editable text field that needs
  Cmd+S (none currently; if ScriptPreviewModal is open, delegate).
- Also surface in the File menu for parity.

**Verification:** Cmd+S on a dirty pipeline clears dirty flag and flashes
the Saved toast.

### D-6. Data preview filter apply + materialize

**Motivation:** live filtering on large GLM files is laggy.

**Plan:**

- Filter UI (from Phase 6 C-7): add a "Draft" mode. Filter rule edits
  collect in a draft buffer and only apply on `Apply` (or Enter). Small
  "Unapplied changes" hint next to Apply.
- New "Export filtered as file…" action next to Apply: writes a new
  file on the remote via `flow.filterFile` (C-4) with the current
  filter set, then offers to wire it into a FileNode.
- Reuse `dataPreviewStore` for draft-vs-applied state.

**Verification:** filtering a 20M-row glm file stays responsive (only
parses on Apply); Export writes a new `.filtered.tsv` remotely.

---

## Track E — App-wide consistency / efficiency audit

Scope: a dedicated pass to find and fix inconsistencies in methodology
across parts of the app that do similar things.

**Audit checklist (produce one report + minimal fixes):**

1. **Path handling.** Every place that takes a user path: confirm `~`
   expansion is consistent (SFTP vs exec), no ad-hoc `path.join` on the
   renderer. Canonical helper: `src/lib/remotePath.ts`.
2. **Axis propagation.** Cross-check `axisPlanner` output assignment
   against `FileNode.split` items: detect any place that falls back to
   listing the filesystem instead of using metadata.
3. **Tool param rendering.** After A-1 lands, confirm legacy form-based
   tools (REGENIE, bcftools, VEP) still render; decide per-tool whether
   to migrate to the block builder in Phase 8.
4. **Slurm script emission.** Run dry-run across all templates; confirm
   identical header block style (account, time, mem, cpus, array,
   dependencies, module loads) and that module loading comes from one
   helper (not duplicated in merge/tool script paths).
5. **File caching.** Audit `SftpPool`, schema cache, learned resources
   cache, module spider cache, account cache — they should share the
   same TTL/invalidation discipline and expose a single "Refresh all
   cached cluster info" debug action.
6. **Error surfaces.** Audit validator error codes, runner failure
   messages, and `ssh:debug` events — unify severity levels and make
   each uniquely grep-able.
7. **Node data migrations.** After `flagBlocks` lands, inventory any
   other evolving fields (splitter pattern, merge convergeMode, output
   intermediate) to confirm each has a migration that runs on load.
8. **React Flow node widths.** Confirm every custom node (`ToolNode`,
   `FileNode`, `MergeNode`, `NoteNode`) uses the same max-width and
   truncation approach (D-4).
9. **IPC naming.** `cluster:*`, `ssh:*`, `sftp:*`, `pipeline:*` —
   audit that every handler lives in the right namespace and is
   registered in `registerAll.ts`; cull dead channels.
10. **State store duplication.** Look for any pipeline state that is
    maintained in both `pipelineStore` and `runStore` / `uiStore` and
    decide one owner.

**Output:** `AUDIT_PHASE7.md` checked into the repo with findings and
follow-up tickets. Fixes that are <30 min land in Phase 7; larger items
become Phase 8 entries.

---

## Critical files

**New:**

- `src/components/pipeline/inspector/FlagBuilder.tsx`
- `src/lib/flagRegistry.ts` (catalog of flag defs per tool)
- `src/components/file-browser/RemoteFileBrowser.tsx`
- `src/components/ui/MiddleEllipsis.tsx`
- `src/components/ui/RemotePathInput.tsx`
- `src/lib/annovarCatalog.ts`
- `src/lib/remotePath.ts`
- `electron/ipc/annovarHandlers.ts`
- `electron/ipc/sshSetupHandlers.ts`
- `AUDIT_PHASE7.md` (track E output)

**Heavily modified:**

- `src/lib/toolRegistry.ts` — PLINK2 flag catalogs, PCA tool, output
  `autoMergeDefault`, `intermediate` ports.
- `src/types/pipeline.ts`, `src/types/toolRegistry.ts` — `flagBlocks`,
  `outputMerge`, `outputIntermediate`, `FlagDef`.
- `src/components/pipeline/NodeInspector.tsx` — becomes a host for
  FlagBuilder for migrated tools.
- `electron/pipeline/ScriptGenerator.ts` — `emitFlagBlocks`, auto-merge
  emission.
- `electron/pipeline/axisPlanner.ts` — implicit auto-merge plan nodes,
  `aftercorr` dependency signalling.
- `electron/pipeline/PipelineRunner.ts` — `aftercorr` emission + fallback
  detection, intermediate cleanup.
- `electron/ssh/SshManager.ts` — `setupKey` handler, ssh-agent
  integration, password-auth audit fixes.
- `src/components/pipeline/PipelineCanvas.tsx` — window-level drag
  routing, multi-edge fan-out affordance.
- `src/stores/uiStore.ts` — file browser open state, filter-draft state.
- `src/stores/pipelineStore.ts` — migrations, Cmd+S save integration.
- `src/components/connection/ConnectionDialog.tsx` — Auto-setup key
  wizard, password audit UI.
- `src/components/pipeline/nodes/{ToolNode,FileNode,MergeNode}.tsx` —
  middle-ellipsis paths, auto-merge chip on output ports.
- `src/components/data-preview/DataTable.tsx` — draft filter mode +
  Export filtered.

---

## Implementation order

1. **Batch 1 — safe plumbing.** D-4 (truncation), D-5 (Cmd+S), D-3
   (window-level drag), B-2 (password audit). Independent, no model
   changes.
2. **Batch 2 — file browsing + paths.** D-1 (browser modal), D-2
   (autocomplete). Shared infra; land together.
3. **Batch 3 — SSH + ANNOVAR ops.** B-1 (key setup), B-3 (ANNOVAR
   install). Share the "run this command and stream progress" pattern.
4. **Batch 4 — flag builder.** A-1 + A-2 + A-3 together (PLINK2 flag
   model, PCA tool, source picker). Single big PR with migration
   coverage. Do before C-1 because C-1 depends on per-port flag on the
   migrated tools.
5. **Batch 5 — array chains and lifecycle.** C-1 (auto-merge), C-2
   (aftercorr), C-3 (cleanup policy), C-4 (filter helper), A-4 (multi-
   edge affordance), D-6 (apply-based preview filters).
6. **Batch 6 — audit.** Track E: run the 10-item checklist, file
   follow-ups, fix the small ones.

## Verification plan (end-to-end)

Canonical pipeline run as a single scripted E2E across Batches 1–5:

1. Drag pgen folder from Finder (D-3) → FileNode `pgen_eur`.
2. Open FlagBuilder on plink2.assoc (A-1) → build `--glm --pheno
   --pheno-name BMI --covar --covar-name PC1 PC2 --chr $KEY --pfile
   $PREFIX --out ...${KEY}`; preview matches Phase 6 canonical dry-run.
3. Connect assoc → p-value filter (`flow.filterFile`, C-4) → clump
   (A-1 block builder) → GRS (plink2.score) → export.
4. Auto-merge toggle (C-1) set on clump output going into GRS.
5. Cmd+S saves pipeline (D-5).
6. Run → 22 assoc tasks parallel → 22 filter tasks chained per-task
   (aftercorr, C-2) → 22 clump tasks chained per-task → merge → GRS →
   export. Total wallclock ≈ one chrom + merge + GRS, not 22×.
7. After successful run, `delete-intermediates-on-success` (C-3) cleans
   per-chrom glm/clump artifacts; GRS output and logs remain.
8. ANNOVAR side-test (B-3): new ANNOVAR node with
   `refGene,clinvar_20240917`, buildver hg38 → Install Missing runs
   `annotate_variation.pl -downdb` twice, both flip to Installed.
9. SSH side-test (B-1): from a fresh account, Auto-setup key runs, next
   connect is passwordless (TOTP still if enforced).
10. Audit (E): `AUDIT_PHASE7.md` present, any small fixes merged.

## Deferred / out of scope

- REGENIE / bcftools / VEP flag-builder migration (Phase 8).
- Batch multi-file drag-drop upload (handle single file per drop for now).
- Windows-specific key setup niceties.
- Non-Slurm schedulers for `aftercorr` fallbacks beyond `afterok`.
- Full Finder column-view polish (ship list view first, column view
  optional).
