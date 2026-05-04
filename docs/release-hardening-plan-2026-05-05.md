# BioFlow Studio Release Hardening Plan

Target a release-candidate build for May 5, 2026, covering the full voice-note walkthrough plus the QA checklist. Verification is local-only: no live Rorqual smoke test gate, but all behavior should be covered with fixtures, mocks, typecheck, tests, build, and manual local workflow QA.

## Public And Data Changes

- Add settings defaults:
  - `inspector.showInlineValidateSettings = false`
  - `toolPalette.workflowPacksCollapsed = true`
  - `modules.defaults = { plink, r, bcftools, regenie }`
  - `rPackages.installMode = "prompt-on-run"`
- Add one transfer progress event from main to renderer, for example `pipeline:transfer-progress`, and show it in the Jobs panel.
- Update plot tools to expose one visible `plot` output plus `outputFormats: "png" | "pdf" | "both"`. Add a pipeline-load migration that maps old `png`/`pdf` plot ports to the new logical plot artifact.
- Keep the inspector "Validate settings" action available through the toolbar Check flow and an advanced setting, but hide inline inspector buttons by default.

## Implementation Order

1. Split detection and remote file reliability.
2. Inspector and sidebar UI foundation.
3. PLINK/GWAS workflow fixes.
4. Module, R, and plot workflow fixes.
5. Execution safety and result handling.
6. Local regression tests, build, and release-candidate QA.

## Split Detection And Remote File Reliability

- Fix folder split detection to prefer primary genotype files such as `.pgen`, `.bed`, `.bgen`, `.vcf.gz` over sidecars like `.pvar`, `.psam`, `.bim`, `.fam`.
- Detect contiguous chromosome keys `1-23`, including common `chr1`, `.1.`, `_c1_`, and similar filename patterns; report missing chromosomes explicitly instead of silently returning sparse keys like `2-4,17-23`.
- Use one per-folder SFTP listing cache during drag/inspect flows, with explicit refresh, so the UI does not miss files or reload excessively.
- Normalize SFTP paths before validation/run so dragged folder-derived paths match the actual remote files.
- Verify with a fixture folder containing PGEN triplets for chromosomes `1-23`; detection must return all keys and Run preflight must resolve the first generated PGEN path.

## Inspector And Sidebar UI Foundation

- Create shared inspector primitives for fields, action rows, scrollable lists, code previews, chips, focus states, and validation messages.
- Replace broken split preview/accepted-item layouts with bounded scroll areas that never overlap text at the current inspector width.
- Standardize focus rings to a non-clipped inset/box-shadow style across all text inputs, selects, textareas, and token fields.
- Normalize sidebar/path typography so file rows, bookmarks, and current-path labels feel consistent.
- Move saved cluster presets above "New connection"; sort saved presets by last used, with Rorqual first when present.
- Make workflow packs collapsible and default them collapsed unless the user is searching.
- Verify File, Tool, Merge, Transfer, and R node inspectors at narrow panel width with no clipped buttons, overlapping rows, or corner-only focus rings.

## PLINK/GWAS Workflow Fixes

- Fix recommended-option logic so covariate recommendations disappear once a covariate file is connected or the covariate flag is enabled.
- Make multi-column chips removable, including defaults such as `age`, and persist removals in node data.
- Keep required vs optional input labels visually distinct on nodes and in inspectors.
- Replace raw flag names in user-facing PLINK options with human-readable descriptions while preserving exact generated command flags.
- Add colored command preview tokenization: flags, values, paths, variables, and shell punctuation get distinct styles; previews wrap cleanly.
- Replace overflowing "Use override" controls with a compact toggle/action row; only show command override where edits can round-trip safely.
- Rewrite the split-input behavior section with explicit choices: "Auto array over split input," "Force single job," and "Use this input as the array axis."
- Ensure custom file flags, especially `--read-freq`, accept upstream file inputs and reject invalid single/split mismatches.
- Verify a local GWAS fixture can connect phenotype, genotype split, covariates, and `--read-freq`; validation warnings must be understandable without PLINK expertise.

## Module, R, And Plot Workflow Fixes

- Add module defaults in Settings and apply them before static registry defaults. If connected module discovery shows the configured default is unavailable, show a pre-run warning with available alternatives.
- Move R package status next to module controls and make package checks happen during Run preflight; missing packages trigger an install prompt instead of relying on a manual inspector button.
- Compact Manhattan/plot inspector layout into "Required columns" and "Plot options."
- Replace separate PNG/PDF output ports with one logical Plot output and a format selector for PNG, PDF, or both.
- Hide generic command override for generated R tools; for custom R nodes, provide an actual R code editor with documented input/output variables.
- Verify the Manhattan plot node shows one plot output, selectable formats, compact required columns, module/package preflight, and no misleading command editor.

## Execution Safety And Result Handling

- Preserve final output filename previews before Run, including merged outputs and plot artifacts.
- Ensure auto-merge produces one logical result artifact for downstream UX; delete unmerged shards only after merge success.
- On merge failure, mark the node failed and preserve all intermediate files needed for diagnosis.
- Strengthen temp-file deletion: confirmation required, connected deleted files become visibly broken on canvas, and validation blocks Run.
- Improve file-browser drag/drop: multi-selected chromosome files drag as a group, wrong file types produce clear warnings, and PLINK sidecars are grouped predictably.
- Clarify transfer node local destination label as "Local destination folder on this Mac," block missing paths, and show download progress in Jobs.
- Confirm custom bash exposes `$INPUT_1`, `$INPUT_2`, `$OUTPUT`, shows those variable names in the UI, and validates basic bash issues before Run.
- Verify local mocked execution covers merge success, merge failure, cleanup, transfer progress, deleted connected files, and custom bash variables.

## Test Plan

- Keep these commands green:
  - `npm run typecheck`
  - `npm test -- --run`
  - `npm run build`
- Add regression tests for:
  - UKB-style PGEN split detection with chromosomes `1-23`.
  - Split range editing and accepted-item rendering data shape.
  - PLINK recommendations, removable covariate chips, `--read-freq` file inputs, and split mismatch validation.
  - Module default resolution and unavailable-module warnings.
  - Plot output migration from old PNG/PDF ports to one logical plot port.
  - Custom bash `$INPUT_1` generation and validation.
  - Auto-merge cleanup skipping deletion on merge failure.
  - Transfer missing-path validation and progress event propagation.
- Manual local QA walkthrough:
  - SSH dialog/key setup surfaces, saved preset ordering, new pipeline, file drag, split folder drag, PLINK association, Manhattan plot, custom bash, transfer node, temp deletion, Run preflight, Jobs panel progress.

## Electron Visual Sweep Notes

- 2026-05-04: Desktop sweep found the node inspector was present in the accessibility tree but pushed off-screen at the current Electron window width. Fixed the center flex layout so the canvas yields space and the inspector rail stays visible.
- 2026-05-04: Desktop sweep found selected tool nodes could leave their hover card over the inspector, obscuring PLINK execution/module controls. Disabled tool hover cards while that tool node is selected.
- 2026-05-04: Rechecked split file accepted-item rows, split preview empty/disconnected state, PLINK inspector, Manhattan plot inspector, R package check, and custom-node builder in Electron. Live Rorqual-dependent preview checks remain covered by code/tests unless a manual cluster smoke test is run.

## Post-Change Walkthrough Addendum

- Fix split accepted-items and split-preview rows with explicit inspector scroll regions and CSS opt-outs from global nowrap/clipping rules.
- Make split range Apply transactional: it must either produce a full key/path list or leave the existing split untouched with a clear error. Manual splits may infer UKB-style chromosome filenames from accepted rows, but they must never create empty paths.
- Expand remote `~` before sidebar/full-browser SFTP listings, and make retry/refresh use forced listings after an initial failure.
- Normalize top toolbar and sidebar path typography with compact path labels, middle ellipsis, and full paths in hover titles.
- Show token-colored command previews directly in the analysis preview panel.
- Give Manhattan Plot a dedicated inspector with Required columns, Output files, and Plot styling sections, and show physical PNG/PDF output paths before run.
- Report physical plot files to run/results surfaces instead of exposing only the logical `.txt` plot manifest.
- Remaining live release gate: connect to Rorqual with MFA and confirm initial listing, UKB PGEN split detection, chromosome range `1-22`, and Check/Run preflight against real paths.

## Assumptions

- "Production-ready tomorrow" means a locally verified release candidate by May 5, 2026, not a live-cluster-certified build.
- Inline "Validate settings" buttons are hidden by default, but validation remains available via the toolbar and advanced setting.
- Old pipelines must continue loading after the plot output-port change.
- If module discovery is unavailable, BioFlow may use the configured/default module but must warn clearly before Run rather than failing later with an opaque Slurm error.
