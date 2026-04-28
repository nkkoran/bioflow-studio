# DNAnexus RAP Integration — Implementation Plan

## Context

BioFlow Studio currently submits bioinformatics jobs (PLINK2, REGENIE, bcftools, …) to the Rorqual HPC cluster over SSH/Slurm. The user wants to add **first-class DNAnexus RAP support** so the same canvas-and-inspector workflow can target either backend, plus a dedicated **UKB Spark/dxdata extraction tool** for pulling UKB phenotype fields off the RAP-dispensed dataset.

The integration must feel like one app, not two. Files from Rorqual and from a DNX project should be browsable side-by-side and droppable into the same pipeline; mixed-backend pipelines (e.g., extract on RAP → analyze on Rorqual, or vice-versa) need to "just work" via implicit transfer steps.

User decisions driving this design (resolved up front):
- **Backend selection**: per-node, via a new `dnxStore`. New "Transfer" node type to bridge backends. File browser gains a tab per connection.
- **Tool coverage**: mirror **all** existing tools onto RAP (Swiss Army Knife applet) plus a new UKB extraction tool.
- **Auth**: app-managed token via `safeStorage` (preferred), fallback to `~/.dnanexus_config`.
- **Outputs**: stay on DNX, downloaded lazily when consumed by a non-DNX downstream node or on user click.
- **Python env**: first-run bootstrap (detect `python3.9+`, create venv in `userData`, pip-install `dxpy` only — `dxdata` is needed *inside the cluster*, not locally; `pyspark` is **not** installed locally because all PySpark execution happens on the RAP cluster, and a local/cluster Python-version mismatch would silently break jobs).
- **Spark extraction mechanism**: a **bundled custom Spark applet** (`bioflow-ukb-extract`) shipped under `resources/dx-applets/ukb-extract/` and uploaded to the user's selected project on first use. The applet declares `runSpec.interpreter: python3` and `runSpec.systemRequirements.cluster.type: spark`, takes the field list / rename map / coding-values choice as JSON inputs, and runs a fixed PySpark script that uses `dxdata` from inside the cluster. The applet is rebuilt and re-uploaded automatically when its bundled hash changes.
  - **Why not `dxjupyterlab_spark_cluster`**: that app is fundamentally interactive (spins up a JupyterLab server). Its non-interactive side-channel requires `.py → .ipynb` conversion via `nbformat`, uploading a notebook input, and toggling an undocumented flag — brittle and not the production-appropriate path for a headless batch extraction.
- **UKB extract UX**: canvas node **and** sidebar quick-launcher.

---

## Architecture Overview

```
                                  ┌────────────────────────────────────┐
                                  │ Renderer (React)                   │
                                  │  dnxStore, connectionStore, …      │
                                  │  FileBrowser (tabs: Local/SSH/DNX) │
                                  └──────────────┬─────────────────────┘
                                                 │ window.api.dnx.*
                                  ┌──────────────▼─────────────────────┐
                                  │ Main: dnanexusHandlers.ts          │
                                  │  ──> DnxBridgeManager (singleton)  │
                                  └──────────────┬─────────────────────┘
                                                 │ NDJSON over stdio
                                  ┌──────────────▼─────────────────────┐
                                  │ Python subprocess                  │
                                  │  resources/python-bridge/bridge.py │
                                  │  (uses dxpy only — dxdata runs     │
                                  │   inside the RAP cluster)          │
                                  └────────────────────────────────────┘
```

The Python bridge is the **only** path to the RAP API — no `dx` CLI shelling. Mirrors the role `SshManager` plays for SSH.

---

## 1. Python Bridge

### 1.1 Bridge script — `resources/python-bridge/bridge.py` (new)

- Reads NDJSON commands from stdin: `{ "id": "...", "op": "auth"|"upload"|"run"|"status"|"download"|"list_files"|"list_projects"|"ensure_applet"|"spark_extract"|"cancel"|"ping", "args": {...} }`
- Writes one NDJSON line per response: `{ "id": "...", "ok": true, "result": {...} }` or `{ "id": "...", "ok": false, "error": {"type": "...", "message": "..."} }`
- Long-running ops (uploads/downloads) emit progress events: `{ "id": "...", "event": "progress", "data": {"bytes": ..., "total": ...} }`
- On `auth`: calls `dxpy.set_security_context({"auth_token_type": "Bearer", "auth_token": token})` and `dxpy.set_workspace_id(project_id)`.
- On `ensure_applet`: builds (if needed) and uploads the bundled `bioflow-ukb-extract` applet to the active project; idempotent on hash match (see §7.0 / §7.4).
- On `spark_extract`: writes the user's field list and rename map to two temp JSON files, uploads them, then calls `dxpy.DXApplet(id=<installed-applet-id>).run({fields_json, rename_json, coding_values, output_name}, instance_type=<user choice>)` and returns the job ID. Assumes `ensure_applet` has already been invoked by the renderer — no implicit applet upload here.

### 1.2 Manager — `electron/dnx/DnxBridgeManager.ts` (new)

Mirrors `SshManager` patterns:

- Singleton, lazy-spawned on first DNX op.
- Keeps an in-flight request map keyed by request ID; resolves promises on response.
- Pipes stderr to `console.error` and surfaces fatal errors via a `dnx:bridge-status` IPC event (matches the `ssh:status-change` pattern).
- Auto-respawn on unexpected exit (max 3 retries within 60s, then surface error).
- `ping` health-check on startup; if it fails, emit `dnx:bridge-error` so the renderer can prompt the user to repair the env.

### 1.3 Bootstrap — `electron/dnx/PythonEnvBootstrap.ts` (new)

- Resolves Python: `python3.11` → `python3.10` → `python3.9` → `python3` (reject < 3.9 with structured error).
- Creates venv at `app.getPath('userData')/python-bridge/venv`.
- `pip install --upgrade pip dxpy` only. **No `dxdata` or `pyspark` locally** — both are used only inside the RAP cluster, where the platform supplies the matching versions. Installing them locally creates a Python/Spark version-mismatch hazard (driver vs. worker serialization failures) and serves no purpose for a headless submission model.
- Streams progress as `dnx:bootstrap-progress` IPC events. Renderer shows a modal on first connect.
- Caches success marker (`venv/.bioflow-ready` with `dxpy` version pin) to skip bootstrap on subsequent launches.
- A "Repair environment" button in Settings re-runs bootstrap.
- A short `requirements.txt` comment documents *why* `pyspark`/`dxdata` are absent so future contributors don't re-add them.

---

## 2. IPC & Preload

### 2.1 New handler — `electron/ipc/dnanexusHandlers.ts` (new)

Channels (`dnx:*` namespace, matching existing `ssh:*` / `pipeline:*` convention):

| Channel | Purpose |
|---|---|
| `dnx:bootstrap` | Run/repair Python env. |
| `dnx:auth` | Set token + project on the bridge. |
| `dnx:list-projects` | Browse projects the token has access to. |
| `dnx:list-files` | List a folder (mirrors `sftp:ls` shape). |
| `dnx:stat` | File metadata (mirrors `sftp:stat`). |
| `dnx:upload` | Local → DNX. Streams `dnx:transfer-progress`. |
| `dnx:download` | DNX → local. Streams `dnx:transfer-progress`. |
| `dnx:run` | Submit a job (SAK or named app). Returns job ID. |
| `dnx:job-status` | One-shot status query. |
| `dnx:cancel` | Cancel a job. |
| `dnx:ensure-applet` | Build/upload the bundled `bioflow-ukb-extract` applet to the active project if missing or hash-changed. Surfaces its own progress; renderer calls this explicitly before `dnx:spark-extract`. |
| `dnx:spark-extract` | Submit a UKB extraction (assumes applet already installed). Returns job ID. |

Events (`webContents.send`):
- `dnx:job-status` (continuous; same shape as `pipeline:node-status` so it can flow through `runStore`)
- `dnx:transfer-progress`
- `dnx:bridge-status`
- `dnx:bootstrap-progress`
- `dnx:applet-install-progress` (stages: `building` → `uploading` → `verifying` → `done`; payload `{ stage, percent?, message? }`). Surfaced by the modal that the renderer opens around a `dnx:ensure-applet` call so a multi-minute first-time install doesn't read as a frozen spinner.

### 2.2 Preload — `electron/preload/index.ts`, `index.d.ts`

Add `api.dnx.*` namespace with the channels above. Follow the existing pattern (see `api.ssh`, `api.sftp`).

### 2.3 Secrets

DNX auth token uses the **existing** `store:set-secret` / `secure:` key pattern. Key: `secure:dnx:authToken`. Project ID is non-secret → plain `store:set` under `dnx:defaultProjectId`.

`DnxBridgeManager.ensureAuth()` resolves the token in priority order:
1. `safeStorage`-decrypted `secure:dnx:authToken`
2. `~/.dnanexus_config` (read by the Python bridge if no token in `auth` op)

---

## 3. Renderer State

### 3.1 New store — `src/stores/dnxStore.ts` (new)

```ts
{
  bootstrapStatus: 'unknown' | 'bootstrapping' | 'ready' | 'error',
  authStatus: 'unauthenticated' | 'authenticated' | 'error',
  defaultProjectId: string | null,
  availableProjects: { id: string; name: string }[],
  authToken: string | null,           // never persisted in store; mirror of safeStorage
  fieldPresets: FieldPreset[],        // saved UKB field sets
  installedAppletHash: string | null, // SHA-256 of bundled bioflow-ukb-extract applet dir; null until first install
  instanceCatalog: { lastRefreshed: number; specs: InstanceSpec[] } | null,
  setToken, setDefaultProject, refreshProjects, runBootstrap, …
}
```

Stays orthogonal to `connectionStore`. The active execution target is no longer a single connection ID — see §4.

### 3.2 `connectionStore` extension

`connectionStore` is unchanged for SSH semantics. The file browser and execution layer treat DNX as a virtual additional "connection" identified by a `DNX_CONNECTION_ID` constant exported from a new `src/constants/connections.ts` (alongside the existing `LOCAL_CONNECTION_ID`, which is moved to the same file). All code references the named constant, never the underlying string literal. The pipeline run path picks up the SSH connection from `connectionStore.activeConnectionId` and the DNX context from `dnxStore` independently — nodes opt in to one or the other (see §5).

### 3.3 `runStore` & `pipelineStore`

No structural change. `dnx:job-status` events are translated into `pipeline:node-status` shapes by `dnanexusHandlers.ts` so existing `runStore` subscribers and node badges keep working.

---

## 4. File Browser — Multi-Tab

**File**: `src/components/file-browser/RemoteFileBrowser.tsx` (modify) and a new shared shell.

- Add a tab strip at the top: **Local** | **Rorqual (SSH)** | **DNX: \<project name\>** (one tab per active backend; SSH tab disabled if no connection; DNX tab disabled until auth).
- Each tab uses its existing data source: `api.local.*`, `api.sftp.*`, `api.dnx.list-files`.
- Drag/drop: dragging a file from any tab onto a `FileNode` (or onto the canvas) populates the node with `{ path, origin: 'local'|'ssh'|'dnx', fileType }`. The new `origin` field on `FileNodeData` is the discriminator the validator uses to know whether a transfer is needed.
- The existing `uiStore.filePickMode` handoff is preserved: `resolveFilePick(path, fileType, origin)` takes an extra origin arg, default `'ssh'` for backward compat.

**File**: `src/types/pipeline.ts` — add `origin?: 'local' | 'ssh' | 'dnx'` to `FileNodeData`. Default `'ssh'`.

---

## 5. Tool Registry & Per-Node Backend

### 5.1 `ToolDef` extension — `src/lib/toolRegistry.ts`

Add an optional `backends: Array<'ssh' | 'dnx'>` field (default `['ssh']` — **opt-in, not opt-out**). Tools are added to `['ssh', 'dnx']` only after their generated SAK script has been verified to run correctly on RAP, because:
- `module load …` is Slurm-specific; SAK relies on pre-installed binaries or Docker images.
- Scratch-path env vars (`$TMPDIR`, `$SLURM_TMPDIR`) differ.
- Memory/cpu flags tuned for Rorqual nodes may not match SAK instance types.

Initial verified set (Phase 2): PLINK2, bcftools, basic tabix/bgzip utilities. REGENIE and others are added in subsequent phases as their SAK paths are validated. The UKB extraction tool is `backends: ['dnx']` only.

Add an optional `dnxApplet?: { id?: string; name?: string }` for tools that map to a named DNX app instead of SAK (e.g., the UKB extractor → bundled `bioflow-ukb-extract` applet).

### 5.2 `ToolNodeData` extension — `src/types/pipeline.ts`

Add `backend: 'ssh' | 'dnx'` (default `'ssh'`) and `dnxInstanceType?: string`. The inspector shows a backend toggle on every node whose tool supports both; nodes with a single supported backend lock to it.

### 5.3 New node type: **Transfer** node

**File**: `src/components/pipeline/nodes/TransferNode.tsx` (new) plus type entry in `src/types/pipeline.ts`.

Fields:
- `from: 'local' | 'ssh' | 'dnx'`
- `to:   'local' | 'ssh' | 'dnx'`
- `targetFolder: string` (path in the destination's namespace)
- `inherits fileType from upstream`

The compiler dispatches on `(from, to)`:
- `local → dnx` / `ssh → dnx` → `dnx:upload` (the SSH variant first does an SFTP fetch into a tempdir, then uploads).
- `dnx → local` / `dnx → ssh` → `dnx:download` (and SFTP put for the SSH variant).
- `local ↔ ssh` → existing SFTP pathways.

When auto-inserted from a `BACKEND_MISMATCH_NEEDS_TRANSFER` quick-fix, `from`/`to` are pre-filled from the upstream node's `origin`/backend and the downstream node's backend. The inspector renders a friendly label (e.g. "Rorqual → DNAnexus") rather than exposing the raw enum.

The Transfer node compiles to a `dnx:upload`, `dnx:download`, or chained ssh→local→dnx step in the runner. It is the **explicit** way for a user to bridge backends. The validator can also auto-insert a Transfer when an edge crosses backends without one (with a yellow warning telling the user we did so).

### 5.4 Validator updates — `src/lib/pipelineValidator.ts`

New rules:
- `BACKEND_MISMATCH_NEEDS_TRANSFER` (warning): edge connects nodes on different backends with no Transfer node. The validation badge exposes a **"Insert Transfer node"** quick-fix button that visually inserts the Transfer node on the canvas before run, so the user can see and edit it. Run-time auto-insertion is a fallback only and emits a clear toast (`"Inserted implicit Transfer between <upstream> and <downstream>"`) so silent pipeline mutation never happens unannounced.
- `DNX_NO_PROJECT` (error): a DNX-backed node exists but `dnxStore.defaultProjectId` is unset.
- `DNX_NOT_AUTHENTICATED` (error): DNX node present but not authenticated.

---

## 6. Execution Layer

### 6.1 Refactor — `electron/pipeline/PipelineRunner.ts`

Introduce a thin `BackendAdapter` interface:

```ts
type OutputPath =
  | { kind: 'local'; path: string }
  | { kind: 'ssh';   path: string; connectionId: string }
  | { kind: 'dnx';   fileId: string; projectId: string; downloadedTo?: string }

type RunPlan = Map<string /* nodeId */, OutputPath[]>

interface BackendAdapter {
  submit(node: ToolNode, scriptOrSpec: ScriptOrSpec, deps: OutputPath[]): Promise<{ jobId: string }>
  cancel(jobId: string): Promise<void>
  watch(jobId: string, callbacks: WatchCallbacks): Unsubscribe
  resolveOutputPaths(node: ToolNode, plan: RunPlan): OutputPath[]
}
```

The discriminated union makes the lazy-download model explicit: `kind: 'dnx'` outputs carry a file ID until a Transfer step (or a downstream local consumer) populates `downloadedTo`. Transfer-node compilation switches on `kind` to decide whether to emit a `dnx:download`, `dnx:upload`, or SFTP transfer.

Two implementations:
- `SshBackendAdapter` — wraps the existing SFTP-write + `sbatch` + `JobTracker.watch` flow. **No behavior change** for current pipelines.
- `DnxBackendAdapter` (new, `electron/pipeline/DnxBackendAdapter.ts`) — uploads any local script/inputs via `dnx:upload`, calls `dnx:run` (SAK applet for normal tools, named applet for UKB extract), polls via `DnxJobPoller`.

`PipelineRunner.start()` walks layers as today; for each node it picks the adapter from `node.data.backend`. Cross-backend dependencies are resolved by inserting an implicit Transfer step (or honoring the user's explicit Transfer node) before the dependent layer is dispatched.

### 6.2 `DnxJobPoller` — `electron/pipeline/DnxJobPoller.ts` (new)

Mirrors `JobTracker`. Every 10s, the bridge dispatches `dxpy.DXJob(job_id).describe()` calls for **all in-flight job IDs concurrently** via `concurrent.futures.ThreadPoolExecutor` (capped at, say, 8 workers), then collects the results into a single NDJSON response back to the main process. (`dxpy.find_jobs()` is not a batch describe — it takes a single `id` and returns a generator — so a parallelized describe is the right primitive.) On `DXAPIError` with HTTP 429, applies exponential backoff (start 15s, cap 5min) before the next tick and surfaces a single `dnx:bridge-status` warning event (debounced) so the user knows the poller is throttled. Same `JobOutcome` shape as `JobTracker`; emits the same status-mapped events through `runStore`.

### 6.3 SAK script generation — `electron/pipeline/ScriptGenerator.ts`

`generateToolScript()` stays pure; for DNX-backend nodes it emits the same bash command, but `DnxBackendAdapter` wraps it as the `cmd` input to a Swiss Army Knife applet invocation rather than an `sbatch` script. Output paths follow the same `<nodeSlug>.<portId>[.<key>].<ext>` convention but live under the DNX project's run output folder.

### 6.4 Lazy download

DNX-produced files appear as `origin: 'dnx'` in the run manifest. They are downloaded only when:
1. A downstream non-DNX node consumes them (auto-insert a Transfer), or
2. The user clicks "Download" in the run output viewer.

---

## 7. UKB Spark Extraction Tool

### 7.0 Bundled applet — `resources/dx-applets/ukb-extract/` (new)

A `dx-app-wizard`-shaped applet directory with:
- `dxapp.json`: `runSpec.interpreter = python3`. Cluster spec follows the actual DNAnexus schema (the key is `clusterSpec`, nested inside the per-instance-type entry under `systemRequirements`):

  ```json
  "systemRequirements": {
    "*": {
      "instanceType": "mem1_ssd1_v2_x8",
      "clusterSpec": {
        "type": "spark",
        "version": "<pin to current RAP cluster Spark>",
        "initialInstanceCount": 2
      }
    }
  }
  ```

  Implementation step: validate this shape against the live `dxapp.json` JSON Schema (or a `dx build --dry-run`) before merging — using the wrong key (`cluster` vs `clusterSpec`) makes `dx build` either reject the applet or silently skip the Spark cluster, in which case `dxdata` fails at runtime. Inputs: `fields_json` (file), `rename_json` (file), `coding_values` (string), `output_name` (string). Outputs: `tsv` (file).
- `src/extract.py`: a **fixed** PySpark script. It reads `fields_json` and `rename_json` as JSON files at runtime — **no string interpolation of user input into source code**. Field IDs and rename labels are passed as data, not code, eliminating the script-injection risk.
- `Readme.md`, `LICENSE`, and a `version.json` pin file: `{ "appletVersion": "0.1.0", "sparkVersion": "<current RAP cluster Spark>", "dxdataVersion": "<pin>" }`. The Spark version must match the RAP cluster's; check via DNAnexus release notes or `dxpy.api.system_describe_executable_constraints()` (the same project's Spark catalog). To update, bump `version.json` — the directory hash changes, so the next `dnx:ensure-applet` call automatically rebuilds and re-uploads.

The applet is built and uploaded to the user's project on first use of the extraction tool (or on "Reinstall applet" in Settings). A SHA-256 of the applet directory is recorded in `dnxStore.installedAppletHash`; if the bundled hash differs, the bridge re-uploads.

### 7.1 Tool definition — `src/lib/toolRegistry.ts`

```ts
{
  id: 'ukb.spark-extract',
  name: 'UKB Data Extraction (Spark)',
  category: 'extraction',
  backends: ['dnx'],
  dnxApplet: { name: 'bioflow-ukb-extract' },
  inputs: [],
  outputs: [{ id: 'tsv', label: 'Extracted phenotypes', fileType: 'tsv' }],
  params: [
    { name: 'fields',         type: 'fieldList' /* custom UI */ },
    { name: 'codingValues',   type: 'select', options: ['replace', 'raw'], default: 'replace' },
    { name: 'outputName',     type: 'string',  default: 'ukb_extracted_traits.tsv' },
    { name: 'outputFolder',   type: 'dnxPath', default: '/' },
    { name: 'instanceType',   type: 'select', options: SPARK_INSTANCE_TYPES /* exported from src/lib/dnxInstanceCatalog.ts as the static fallback list, used until the live system_describe_instance_types fetch populates dnxStore */, default: 'mem1_ssd1_v2_x8' },
    { name: 'preset',         type: 'preset' /* custom UI */ },
  ],
  slurm: { /* ignored on dnx */ },
}
```

### 7.2 Field builder — `src/components/pipeline/inspector/UkbFieldBuilder.tsx` (new)

Custom param widget rendered when the inspector encounters `type: 'fieldList'` — keeps the rest of `AnalysisOptionsPanel` generic.

Features:
- Add row: `field_id` (e.g. `p21001_i0`) + optional rename label.
- Import from CSV/TSV (one field per line, optional second column for label).
- Save as preset (writes to `dnxStore.fieldPresets`, persisted via `store:set` under `dnx:fieldPresets`).
- Built-in presets: **MRI Cardiac Traits** (the cardiac MRI list), **Anthropometrics**, **Demographics + EID**.

### 7.3 Standalone launcher

**File**: `src/components/sidebar/QuickExtractButton.tsx` (new) added to the existing sidebar.

Opens a modal that wraps the same `UkbFieldBuilder` + run controls. On submit, it constructs an ephemeral one-node pipeline and dispatches it through the normal `PipelineRunner` path so logs, status, and outputs flow into the same Jobs panel — no parallel codepath. The synthetic run is stamped with a human-readable display name: `"Quick Extract — <preset name or 'Custom fields'> (<YYYY-MM-DD HH:mm>)"` so it surfaces cleanly in the Jobs panel rather than as a UUID.

### 7.4 Bridge `spark_extract` op

1. Serializes the field list and rename map to two temp JSON files.
2. Uploads both as inputs to the `bioflow-ukb-extract` applet. *(Applet installation is **not** done here — the renderer is required to call `dnx:ensure-applet` first so its progress can be surfaced via `dnx:applet-install-progress`. The bridge fails fast with `APPLET_NOT_INSTALLED` if the applet ID is missing.)*
3. Runs the applet via `dxpy.DXApplet(id=...).run({fields_json, rename_json, coding_values, output_name}, instance_type=<user choice>)`.
4. Returns the job ID for `DnxJobPoller` to track.

The fixed applet script means **no dynamic code generation from user input** — eliminating the rename-label script-injection risk.

### 7.5 Instance metadata

`src/lib/dnxInstanceCatalog.ts` (new) holds a static spec table (CPU/RAM/local SSD per instance type) populated lazily from `dxpy.api.system_describe_instance_types()` via the bridge, cached in `dnxStore`. **No hardcoded pricing** — pricing changes too often and would silently go stale. Instead, the inspector shows specs (e.g., "8 cores · 64 GB RAM · 200 GB SSD") plus a "View current pricing" link to the DNAnexus pricing page. A "Last refreshed" timestamp is shown for the spec table; users can click "Refresh" to re-fetch.

---

## 8. Settings UI

**File**: `src/components/settings/SettingsDialog.tsx` (modify) — add **DNAnexus** tab:

- Auth token field (masked), saves via `store:set-secret('secure:dnx:authToken', ...)`.
- Default project dropdown (populated from `dnx:list-projects` after auth).
- "Test connection" button (calls `dnx:auth` + `ping`).
- "Repair Python environment" button (re-runs bootstrap).
- Field presets manager (list/edit/delete entries from `dnxStore.fieldPresets`).

**File**: `src/stores/settingsStore.ts` — extend `AppSettings` with `dnxAuthTokenStored: boolean` and `dnxDefaultProjectId: string | null` (the token itself stays in safeStorage, this just tracks presence).

---

## 9. Critical Files

**Create**:
- `resources/python-bridge/bridge.py`
- `resources/python-bridge/requirements.txt` (dxpy only)
- `resources/dx-applets/ukb-extract/dxapp.json`
- `resources/dx-applets/ukb-extract/src/extract.py` (fixed PySpark script; reads JSON inputs)
- `src/constants/connections.ts` (LOCAL_CONNECTION_ID, DNX_CONNECTION_ID)
- `electron/dnx/DnxBridgeManager.ts`
- `electron/dnx/PythonEnvBootstrap.ts`
- `electron/ipc/dnanexusHandlers.ts`
- `electron/pipeline/DnxBackendAdapter.ts`
- `electron/pipeline/DnxJobPoller.ts`
- `src/stores/dnxStore.ts`
- `src/components/pipeline/nodes/TransferNode.tsx`
- `src/components/pipeline/inspector/UkbFieldBuilder.tsx`
- `src/components/sidebar/QuickExtractButton.tsx`
- `src/lib/dnxInstanceCatalog.ts`
- `test/unit/dnxBridge.test.ts`, `test/unit/dnxBackendAdapter.test.ts`, `test/unit/ukbFieldBuilder.test.ts`

**Modify**:
- `electron/main/index.ts` (call `registerDnanexusHandlers`)
- `electron/ipc/registerAll.ts`
- `electron/preload/index.ts`, `electron/preload/index.d.ts`
- `electron/pipeline/PipelineRunner.ts` (introduce `BackendAdapter`, refactor to dispatch)
- `electron/pipeline/ScriptGenerator.ts` (no-op for SSH path; add DNX wrapping)
- `src/types/pipeline.ts` (add `origin` to `FileNodeData`, `backend` to `ToolNodeData`, `TransferNodeData`)
- `src/lib/toolRegistry.ts` (add `backends` field, default `['ssh']`; opt PLINK2 + bcftools + tabix/bgzip into `['ssh', 'dnx']` for Phase 2 after each is verified end-to-end on SAK; add `dnxApplet`; add UKB extraction tool entry)
- `src/lib/pipelineValidator.ts` (new rules)
- `src/components/file-browser/RemoteFileBrowser.tsx` (tabs)
- `src/components/pipeline/PipelineCanvas.tsx` (Transfer node registration)
- `src/components/pipeline/NodeInspector.tsx` (per-node backend toggle, `fieldList`/`preset`/`dnxPath` widgets)
- `src/components/pipeline/inspector/AnalysisOptionsPanel.tsx` (custom param widget dispatch)
- `src/components/settings/SettingsDialog.tsx` (DNAnexus tab)
- `src/stores/settingsStore.ts`, `src/stores/uiStore.ts` (origin-aware filePick), `src/stores/runStore.ts` (subscribe to `dnx:job-status`)
- `package.json` (no new JS deps; document `python3.9+` prereq in README)

**Reused (no change)**: `runStore`, `JobsPanel`, `LogViewer`, `safeStorage` plumbing in `storeHandlers.ts`, `JobTracker` (left alone for SSH).

---

## 9b. Phasing

To keep risk bounded, implementation lands in three phases:
1. **Phase 1 — Foundations**: Python bridge + bootstrap, auth, file browser tabs, DNX file ops, no execution yet. Verifiable by browsing/uploading/downloading files between Local/SSH/DNX.
2. **Phase 2 — Execution**: BackendAdapter refactor, DnxBackendAdapter for SAK, DnxJobPoller, Transfer node, validator rules. Initial verified tools: PLINK2, bcftools.
3. **Phase 3 — UKB extraction**: bundled applet build/upload, field builder, presets, sidebar quick-launcher. Add REGENIE / further tools to `backends: ['ssh','dnx']` after each is validated end-to-end.

## 10. Verification

1. **Bridge unit tests** (`test/unit/dnxBridge.test.ts`): spawn `bridge.py` against a mocked dxpy (monkey-patched in a fixture); send each op; assert response shapes and progress events.
2. **Backend adapter test** (`test/unit/dnxBackendAdapter.test.ts`): submit / cancel / watch with a stub `DnxBridgeManager`; assert it emits the same `JobOutcome` shapes as `JobTracker` so `runStore` is interchangeable.
3. **Validator tests** (`test/unit/pipelineValidator.test.ts`): add cases for `BACKEND_MISMATCH_NEEDS_TRANSFER`, `DNX_NO_PROJECT`, `DNX_NOT_AUTHENTICATED`.
4. **End-to-end manual** against a real DNX test project:
   - First-run bootstrap completes.
   - Set token in Settings → "Test connection" succeeds → projects list populates.
   - Drag a `.bgen` from the **DNX** tab onto the canvas; drop a PLINK2 GWAS node, set `backend = dnx`; Run; watch live status in Jobs panel; outputs appear in the DNX tab.
   - Click an output → "Download" → confirm it lands locally.
   - Build a mixed pipeline: UKB extract → Transfer → REGENIE on Rorqual; verify auto-transfer runs and REGENIE consumes the TSV.
   - Sidebar quick-extract launcher: produce the cardiac MRI traits TSV with the built-in preset; verify resulting file id appears in DNX tab.
5. **Cancel path**: cancel a running RAP job from Jobs panel; bridge `dnx:cancel` is invoked; node status flips to `cancelled`.
6. **Failure surface**: kill the bridge subprocess mid-run; verify auto-respawn and that the user sees a clear error if respawn fails.
7. **Applet integrity**: modify a byte in `resources/dx-applets/ukb-extract/src/extract.py`; relaunch; verify the bridge detects the hash change and re-uploads the applet before the next extraction job.
8. **Script-injection regression test**: submit an extraction with a rename label of `"); import os; os.system('id'); ("` — assert it runs to completion and the literal string lands as the column header (proving it was treated as data, not code).
9. **Rate-limit handling**: simulate `429` from the bridge in `DnxJobPoller`; assert poller backs off exponentially and recovers.
10. **Auto-Transfer UX**: build a cross-backend pipeline without an explicit Transfer; verify the validator surfaces `BACKEND_MISMATCH_NEEDS_TRANSFER` with a working "Insert Transfer node" quick-fix; then verify the run-time fallback path emits the toast when fired.
