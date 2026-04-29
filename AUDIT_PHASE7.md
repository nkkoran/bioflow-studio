# Phase 7 Audit

Date: 2026-04-21

Scope: Track E consistency / efficiency audit from `PHASE7_PLAN.md`.

## Landed in Phase 7

- Data preview filtering now distinguishes applied filters from the draft preview more clearly, and the displayed row counts/rows stay aligned with the current draft preview.
- Data preview filter evaluation now matches the transform runtime when a referenced column is missing instead of incorrectly treating the rule as "match everything."
- Renderer-side axis decoration now respects per-output auto-merge, so edge axis chips no longer disagree with the runtime planner.
- Output path previews now respect per-node output directory overrides and use the shared remote-path helper in renderer code instead of ad hoc string joins.
- Snapshot loading now migrates more than tool nodes: file split patterns, merge `convergeMode`, and transform filter `join` defaults are normalized on load.
- Added a connection-scoped `Refresh cached cluster info` action that clears renderer cache slices plus main-process SSH/SFTP/learned-resource runtime caches before refetching.
- Removed dead duplicate `* 2.ts` / `* 2.tsx` files that were not referenced anywhere.
- Merge and note nodes were brought closer to the same width/truncation discipline used by the other custom node types.

## Checklist

### 1. Path handling

Status: partially fixed in Phase 7.

- Renderer-side preview/export code was still doing manual remote path joining in a few places. Those paths were moved onto `src/lib/remotePath.ts` where touched.
- Remaining follow-up for Phase 8: main-process path helpers are still duplicated between `axisPlanner.ts` and `PipelineRunner.ts`, and renderer preview code still has a few local helper copies outside the audited hot paths.

### 2. Axis propagation

Status: checked, small fix landed.

- Runtime planning remains metadata-driven; the audited `axisPlanner` path does not fall back to remote filesystem listing when propagating array outputs.
- A renderer inconsistency existed in `src/lib/axisPlannerPure.ts`: edge axis chips ignored output auto-merge and could mark merged outputs as still axed. This is now fixed.

### 3. Tool param rendering

Status: checked, no blocker found.

- Legacy inspector rendering still works for non-PLINK tools after the block-builder work.
- File-typed legacy params now use the shared browser-backed path field instead of plain text input.
- Phase 8 follow-up: decide whether VEP or selected bcftools/REGENIE tools should migrate to the block-builder model.

### 4. Slurm script emission

Status: audited, deferred follow-up documented.

- Header content is consistent across tool / transform / merge scripts: account, partition, time, memory, CPUs, logs, and module preamble remain aligned.
- Remaining inefficiency for Phase 8: the header/preamble logic is duplicated across `generateToolScript`, `generateTransformScript`, and `generateMergeScript` and should be extracted to one helper.

### 5. File caching

Status: partially fixed in Phase 7.

- Cache TTLs are still not globally centralized, but they are now easier to invalidate in one place for a live connection.
- Added a single debug action to refresh cached cluster info and clear related runtime caches.
- Phase 8 follow-up: unify TTL constants / invalidation policy more systematically across SFTP listings, schema cache, module cache, account cache, learned-resource cache, and run-time capability probes.

### 6. Error surfaces

Status: audited, mostly deferred.

- Validator issue codes are already machine-readable and grep-able.
- Remaining inconsistency: runner and SSH failure strings are still partly free-form. Phase 8 should standardize code-prefixed operational errors across runner failures, submit failures, and SSH diagnostics.

### 7. Node data migrations

Status: fixed in Phase 7.

- Load-time migration now covers more than `flagBlocks`.
- File-node split metadata now normalizes `pattern`.
- Merge-node load now normalizes `convergeMode`.
- Transform-node load now normalizes filter `join` defaults.

### 8. React Flow node widths

Status: partially fixed in Phase 7.

- Merge and note nodes were aligned closer to the width cap used by file/tool nodes.
- Remaining Phase 8 follow-up: if the canvas gets another visual pass, extract the shared width/truncation tokens into one small node-layout helper instead of repeating utility classes.

### 9. IPC naming

Status: fixed for the issues found.

- Registered IPC namespaces still line up with their handler files.
- Dead duplicate IPC handler files were removed from `electron/ipc/`.
- No live namespace mismatch was found in `registerAll.ts`.

### 10. Store ownership duplication

Status: audited, deferred.

- The main remaining duplication is intentional mirroring between `runStore` and `pipelineStore` for node execution badges.
- That coupling is still acceptable for Phase 7, but Phase 8 should decide whether execution status should be fully projected from `runStore` instead of being copied into pipeline node data.

## Phase 8 Follow-ups

- Extract one shared Slurm header/module helper in `electron/pipeline/ScriptGenerator.ts`.
- Centralize cache TTL/invalidation policy across renderer and main-process caches.
- Standardize code-prefixed operational error strings across runner/SSH layers.
- Consolidate remaining duplicated path helper logic in main-process planning/runtime code.
- Consider a small shared node-layout helper for width/truncation conventions.
- Revisit long-term ownership of execution status mirrored between `runStore` and `pipelineStore`.
