# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project

**BioFlow Studio** — Electron + React GUI for building and running bioinformatics pipelines (GWAS with PLINK2/REGENIE, bcftools workflows, etc.) on HPC clusters over SSH. Target cluster is Rorqual (Alliance Canada / McGill). Jobs are submitted as Slurm `sbatch` scripts; state is polled back via `squeue`/`sacct`.

Phase 3 (current) added the execution runtime with SLURM array support, validation, a Jobs panel, and file-picker integration. See `PHASE3_PLAN.md` for the full design doc — it is authoritative for data-model decisions and is referenced from code comments.

## Commands

```bash
npm run dev       # electron-vite dev with HMR (renderer) + main/preload rebuilds
npm run build     # electron-vite build → out/{main,preload,renderer}
npm run preview   # run the built app
```

No test runner is configured. `scripts/test-ssh.mjs` is a standalone SSH diagnostic (`node scripts/test-ssh.mjs <host> <user> <keypath>`) useful for isolating ssh2-library issues from Electron integration.

## Architecture

### Three-process Electron layout

- **`electron/main/`** — main process entry. Creates the BrowserWindow, calls `registerAllHandlers()`.
- **`electron/preload/index.ts`** — single contextBridge surface exposed as `window.api`. **All IPC goes through this**; renderer never sees `ipcRenderer`. Namespaces: `api.ssh`, `api.sftp`, `api.store`, `api.pipeline`, `api.terminal`, `api.dialog`, `api.localFile`.
- **`src/`** (renderer) — React 19 + Tailwind 4 + `@xyflow/react`. Path alias `@/*` → `src/*` (see `electron.vite.config.ts`).

TypeScript uses project references: `tsconfig.node.json` covers `electron/**`, `tsconfig.web.json` covers `src/**`. Don't import across the boundary directly — share types by importing from `src/types/` into main (one-way only; preload and main already do this).

IPC handler registration is centralized in `electron/ipc/registerAll.ts`. Any new IPC channel needs: (1) handler in `electron/ipc/*Handlers.ts`, (2) registration in `registerAll.ts`, (3) exposure in `electron/preload/index.ts`, (4) type in `electron/preload/index.d.ts`.

### Renderer state (Zustand)

Stores in `src/stores/`. The important ones and their roles:

- **`pipelineStore`** — React Flow nodes/edges, selection, undo/redo history (last 50). `exportSnapshot()` is the source of truth for what gets submitted. `setNodeStatus(nodeId, status, jobId?, error?)` updates canvas badges — must handle both `'tool'` and `'merge'` node types.
- **`runStore`** — mirror of main-process `PipelineRunner`. On `pipeline:node-status` IPC events it forwards to `pipelineStore.setNodeStatus` so badges update live. `startRun` auto-switches the bottom panel to the Jobs tab via `uiStore.setBottomPanelMode('jobs')`. `subscribeToEvents()` is called once in `App.tsx` on mount.
- **`uiStore`** — layout sizing, bottom-panel mode (`terminal | data | jobs`), and the **file-picker handoff** (`filePickMode`, `startFilePick`, `resolveFilePick`, `cancelFilePick`). `resolveFilePick` uses a dynamic `import('@/stores/pipelineStore')` to avoid a circular dep with runStore.
- **`connectionStore`** — active SSH connection id. `LOCAL_CONNECTION_ID` is a sentinel for the "no remote" mode; Run rejects on this id.

### Pipeline execution (main process, `electron/pipeline/`)

Execution is a pipeline of pure functions + one stateful singleton:

1. **`topoSort.ts`** — Kahn's algorithm, returns layered `string[][]` for parallel-within-layer submission. Throws `CycleError`.
2. **`axisPlanner.ts`** — pure. Walks nodes in topo order, returns per-node `AxisPlan { mode: 'single' | 'array' | 'fanIn', axis?, keys?, arrayPortId?, dependsOnArrayNodeIds? }`. This is how per-chromosome fan-out and merge fan-in are resolved.
3. **`ScriptGenerator.ts`** — pure. `generateToolScript` / `generateMergeScript` return `{ script, outputPaths }`. Output path convention: `<outputDir>/<nodeSlug>.<portId>[.<key>].<ext>`. Merge strategies: `tsv-concat-header`, `bcftools-concat`, `plink-pmerge-list`, `cat` (auto-picked from upstream fileType).
4. **`PipelineRunner.ts`** — singleton. `start()` creates a run, writes scripts via SFTP, submits `sbatch`, watches jobs via `JobTracker`, emits `pipeline:node-status` / `pipeline:run-status` IPC events. Runs are **in-memory only** (persistence is a later Phase 3 substep).
5. **`JobTracker.ts`** — batches `squeue -h -j <ids> -o "%i %T %M"` every 10s; falls back to `sacct` on absent jobs. Array jobs are one logical job; all-or-nothing success.

### Axis / loop model (critical — read before changing pipeline code)

The data model has three axis states on a data flow:

- **No axis** — single path, single job (default).
- **Axed** — a `FileNode` with `data.split = { axis, items: [{key, path}] }`, or a tool output inheriting axis from its axed input. Downstream tool auto-runs as a SLURM `--array=0-N-1` job.
- **Collapsed (fan-in)** — an axed edge feeding a `multi: true` port, or any input on a `merge` node. The job is submitted with `sbatch --dependency=afterok:<arrayId>` and receives all per-task paths.

`ToolNodeData.arrayOver` is an explicit escape hatch for the ambiguous "multiple axed inputs" case. `ToolPort.arrayable: false` opts a port out of auto-fan-out. The validator enforces `MULTIPLE_AXES_NO_CHOICE`, `EMPTY_SPLIT`, and related rules.

### SSH/SFTP gotchas

- **SFTP does NOT expand `~`.** SSH `exec` does (login shell). Anywhere an SFTP path crosses the API boundary, resolve home first. `PipelineRunner.resolveHome()` does this via `printf %s "$HOME"`.
- `SshManager` holds persistent ssh2 `Client` connections keyed by connection id; `SftpPool` caches SFTP sessions on top.
- `activeConnectionId` is latched at `startRun` time — a run survives the user switching connections.
- Slurm account is read from electron-store key `connection:<id>:slurmAccount` via `getSettingsStore()`. **Always use `getSettingsStore()`** — the named-stores API is not interchangeable with the default electron-store.

### SSH authentication & MFA

Alliance Canada / Compute Canada clusters (Rorqual) require **publickey + keyboard-interactive TOTP** (partial-success auth). The flow:

1. `SshManager.buildConnectOptions` sets `tryKeyboard: true` alongside whatever primary method (key/password/agent) is configured. `~` in key paths is expanded via `expandPath()` — ssh2 does not do this itself.
2. On the `keyboard-interactive` event: if the prompt text contains `"password"` and `config.password` is set, auto-respond with it. Otherwise call `promptUser()`, which emits a `ssh:prompt` IPC event (with a generated `promptId`) to the renderer and awaits a matching `ssh:prompt-response` (60s timeout).
3. **Compute Canada's TOTP prompt is labelled `"Password:"`** — this is misleading but authentic. `MfaPrompt.tsx` (a global dialog that listens for `ssh:prompt`) surfaces a hint clarifying that the "Password" prompt actually wants the 6-digit TOTP code.
4. Server banners (MFA enrollment notices, MOTD) are forwarded via `ssh:banner` events so they can appear in the connection UI.

Algorithm allowlist (`ALGORITHMS` constant in `SshManager.ts`) is **explicit**, not defaulted — HPC servers often run older/stricter crypto configs. Note: `chacha20-poly1305@openssh.com` was removed from the cipher list because it caused handshake failures on Rorqual. Don't re-add it without testing.

**`scripts/test-ssh.mjs`** mirrors the same algorithm allowlist and MFA prompt loop outside Electron — use it to isolate ssh2-library issues from Electron integration when auth breaks.

**Native modules:** `ssh2` pulls in `cpu-features` / native crypto bindings. If you bump Electron, run `npx electron-rebuild` or connections will fail at load time with an ABI mismatch.

### Tool registry & validation

- **`src/lib/toolRegistry.ts`** — static `TOOLS: ToolDef[]`. To add a tool, append an entry; the palette and ScriptGenerator pick it up automatically. `areTypesCompatible` treats `'any'` as permissive on either side.
- **`src/lib/pipelineValidator.ts`** — single source of truth for all validation. Both the `ValidationBadge` and `PipelineToolbar.handleRun` call `validatePipeline(snapshot)`; Run is blocked on any error-severity issue. Error codes are grep-able (e.g. `MISSING_INPUT`, `CYCLE`, `SPLIT_NO_AXIS`, `ORPHAN_OUTPUT`).
- **`src/lib/fileTypeInference.ts`** — `inferFileType(path)`. Handles compound extensions (`.vcf.gz`, `.fastq.gz`) first; returns `'any'` as the safe fallback. Used by the file picker so clicking a file populates the FileNode's `fileType` automatically.

### File-picker handoff

The sidebar `FileExplorer` doubles as a picker for `FileNode.path` (and eventually tool-input quick-path). The coordination is a single store flag in `uiStore.filePickMode`:

1. Requester (e.g. `NodeInspector.FileInspector`) calls `useUIStore.getState().startFilePick({ nodeId, requesterLabel, accept })`.
2. `FileExplorer` renders a banner and intercepts the next file click: `resolveFilePick(path, inferFileType(name))` → writes `{ path, fileType }` via `pipelineStore.updateNodeData` and clears the flag.
3. Escape or the cancel button calls `cancelFilePick()`.

Don't call `pipelineStore.updateNodeData` from the explorer directly — always go through `resolveFilePick` so the single-flag discipline is preserved.

### Bottom panel tabs

`BottomPanel` switches between `terminal`, `data`, and `jobs` via `uiStore.bottomPanelMode`. A badge on the Jobs tab counts active runs. The Jobs panel owns its own run selector; it does not have to be the panel currently focused on `activeRunId`.

## Conventions worth knowing

- Keep `ScriptGenerator` and `axisPlanner` pure. No SSH, no filesystem, no imports from `electron/*`. They're the place that benefits most from being testable once tests exist.
- When threading new per-node metadata through execution, follow the existing `nodeSlug` pattern: compute once in `PipelineRunner`, pass via `PlannerContext` to `axisPlanner`, pass via script-gen opts to `ScriptGenerator`. Don't derive it ad-hoc in two places.
- Output paths are computed by `axisPlanner` from node metadata only — never by listing the remote filesystem. This keeps downstream resolution deterministic across reconnects.
- `custom.shell` tool param uses `flag: '-c'` so the generated command is `bash -c '<script>'`. Don't "simplify" this — without `-c`, bash treats the script as a filename.
- **React Flow 12 data typing:** every node-data interface (`ToolNodeData`, `FileNodeData`, `MergeNodeData`, `NoteNodeData`) must include `[key: string]: unknown` — React Flow's `Node<T>` constrains `T extends Record<string, unknown>`. Without the index signature, TypeScript rejects the node in `nodes: BioflowNode[]`.
- **`pipelineStore` history discipline:** only *structural* `NodeChange`/`EdgeChange` variants (`add`, `remove`) push to the undo stack. Position drags and selection changes do not — otherwise every pixel of a drag would fill the 50-entry history. Mutating actions (`updateNodeData`, `addToolNode`, etc.) push explicitly before applying the change.
- **`dirty` flag:** set on every mutation in `pipelineStore`; cleared only by `loadSnapshot` and `reset`. Save does *not* currently clear it — the toolbar just flashes a "Saved" toast. If you add true save-state tracking, thread it through `exportSnapshot` consumers too.
- **Renderer CSP:** `index.html` allows `font-src 'self' data:` (for `@fontsource` inlined fonts) and `connect-src 'self' ws://localhost:*` (for Vite HMR). Tightening CSP will break dev HMR unless the ws rule is preserved.
# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
