# BioFlow Studio Redesign Changes

Date: 2026-05-02

## Summary

This pass rebuilds the app around the design system documented in `design-research.md`: neutral surfaces, one interaction accent, status colors only for feedback, lighter chrome, contextual panels, compact typography, and purposeful motion.

## Design System

- Added dark, light, and simple-theme tokens for app, canvas, panel, raised, hover, text, accent, success, warning, and error colors.
- Added shared elevation utilities: `surface-panel`, `surface-card`, `surface-popover`, and `bioflow-field`.
- Added motion utilities for panel entry, node placement, success pulse, shimmer skeletons, empty-state motion, and running-edge flow.
- Reduced decorative borders globally by making neutral border utilities transparent while keeping status and accent borders available for real feedback.
- Preserved focus visibility with accent focus rings and reduced-motion behavior.

## Shell and Layout

- Reworked `TopBar`, `Sidebar`, `CenterPanel`, `BottomPanel`, and `AppLayout` to use elevated surfaces instead of boxed borders.
- Made resize handles quieter until hover.
- Updated shared tabs to use rounded active states, shadow, and accent only for the active tab.
- Kept bottom panels dense but made them feel like drawers instead of fixed boxed regions.

## Canvas and Blocks

- Converted canvas background to the new canvas token.
- Replaced static empty canvas copy with a subtle animated prompt.
- Updated drop feedback to an elevated notification style.
- Animated edges connected to running nodes with a dashed flow treatment.
- Rebuilt tool, file, merge, transfer, transform, and note nodes around neutral surfaces and selected-node lift.
- Added success pulse treatment for completed nodes.
- Kept missing connected files visually blocking on file nodes.
- Removed decorative category border colors from tool nodes.

## Tool Palette and Toolbar

- Lightened the tool palette with elevated contextual styling.
- Reduced toolbar popover and workflow/check chrome.
- Retained primary actions while making secondary command surfaces quieter.

## Inspector and Configuration

- Made the node inspector contextual: it disappears when nothing is selected.
- Reworked the bash editor into a code surface with compact variable references for `$INPUT`, `$INPUT_1`, `$INPUT_2`, `${INPUTS[@]}`, and `$OUTPUT`.
- Updated PLINK/analysis configuration surfaces so readable labels remain primary and raw flags are muted mono metadata.
- Kept "Validate settings" visible and styled validation results as actual success/error feedback.
- Kept custom file-valued flags and canvas/path source choices visible and less cluttered.
- Softened UKB field, flag builder, analysis options, command preview, and command override controls.

## File Workflows

- Reworked the sidebar file explorer and remote file browser around elevated toolbars, softer selection, and skeleton loading rows.
- Updated file drag affordance with scale/lift styling.
- Kept multi-select, type filters, file grouping, delete confirmation, and missing-file canvas flagging behavior intact.
- Updated path inputs and autocomplete popovers to the new field/popover style.
- Softened split-transfer, saved preview views, raw text preview, and data table controls.

## Connection and Cluster Flow

- Simplified connection dialog surfaces and moved transport/alias details behind an advanced disclosure.
- Kept key generation, existing-key detection, public key display/copy, MFA hinting, and connection trace feedback.
- Lightened connection status, Slurm settings, queue views, and diagnostic feedback surfaces.

## Jobs, Results, and Data Preview

- Rebuilt Jobs, Queue, Results, Data Preview, and Terminal empty/loading states with animated prompts or shimmer skeletons where appropriate.
- Converted run history, node run rows, queue rows, result cards, output rows, and log controls to elevated, compact rows.
- Kept transfer progress bars in node run rows.
- Kept result reuse, copy, preview, folder, run folder, restore snapshot, and report actions available.

## Settings and Workspace

- Updated Settings and Workspace dialogs to use the shared field and elevated section styles.
- Kept light/dark/simple theme switching wired to the new tokens.
- Moved workspace tool paths behind an "Advanced tool paths" disclosure.
- Softened DNAnexus, ANNOVAR setup, and dataset guide surfaces.

## Verification

- `npm run typecheck` passed.
- `npm test` passed: 25 files, 117 tests.
- `npm run build` passed for main, preload, and renderer bundles.

## Pass 3 — Layout system, dialog architecture, animation system

- Added `src/renderer/styles/layout.css` as the structural layout contract for the app: shared modal overlay/modal/body/footer classes, panel rail variables, inspector width transition, bottom-panel height transition, compact/wide container-query behavior, and panel text overflow rules.
- Moved the app shell, sidebar, tool palette, inspector, canvas region, and bottom drawer onto the shared layout classes so the canvas flex region absorbs panel changes without JS resize calculations.
- Added the canvas edge coordinate contract: node handles now expose `data-port-node`, `data-port-id`, `data-port-type`, `data-port-x`, and `data-port-y`, and custom edges read those handle-center coordinates instead of inferring parent-node bounds.
- Reworked the shared `Dialog` component so every dialog uses the single `.bioflow-modal-overlay` and `.bioflow-modal` system with internal scrolling and fixed footer behavior.
- Documented Dialog Architecture Rules in `design-research.md` and applied the pattern to connection, key setup, run review, settings, generic app dialogs, quick extract, and remote file browsing.
- Added `src/renderer/styles/motion.css` with the app-wide fade, shimmer, success-pulse, and edge-flow utilities, plus reduced-motion handling.
- Removed component-local keyframes and one-off animation classes; empty states and dialogs use `animate-fade-up`, loading skeletons use `animate-shimmer`, running edges use `bioflow-running-edge`, and completed nodes trigger `animate-success` only on a status transition to `done`.
- Added compact and wide responsive behavior through container queries: compact windows collapse the sidebar rail, overlay the inspector, reduce bottom-panel height, and truncate canvas node labels; wide windows expand the sidebar and inspector rails.
- Audited renderer CSS tokens: color definitions now live as design tokens, CSS files no longer contain hardcoded hex colors, and spacing/radius/shadow values were moved to tokens or relative units except the allowed `1px` border/shadow hairlines.

## Pass 4 — Bug fixes and visual quality

- Fixed React Flow handle alignment by making every canvas handle a true 10px rendered dot with no transform or padding on the `Handle` element; hover expansion now uses shadow instead of scale.
- Repositioned all input, output, optional, array/fan-out, merge, transfer, and transform handles with `calc(... - 5px)` so React Flow’s bounding rect center matches the visible dot center.
- Restored scroll behavior in transitioned rails with a two-element pattern: clipped outer rails plus fixed-width inner scroll surfaces for the inspector, tool palette, and sidebar file explorer.
- Moved shared dialogs into a `document.body` React portal and raised the modal overlay/modal z-index band to `1000/1001`, with a fixed blur backdrop that escapes app-shell stacking contexts.
- Added Pass 4 research notes from Linear’s 2026 refresh and Vercel/Geist design guidance to `design-research.md`.
- Added calmer surface layering: lifted cards/popovers/dialogs/inspector surfaces get a subtle top-edge highlight, while inputs, textareas, selects, code blocks, and path fields get recessed inset shadows.
- Added shared typography and interaction utilities: `interactive-row`, `interactive-button`, status/badge text treatment, mono tabular-number features, and canvas node title weight/spacing.
- Removed the remaining inline SVG close icon in tabs so the app icon set stays Lucide-only.
- Redesigned the connection dialog around the final three-field default: Host or IP, Username, Private key path, with Passphrase, Remote directory, key generation, MFA tip, local/saved connection helpers, and advanced SSH controls behind one More options disclosure.
- Updated the Connect button to keep a stable footprint while connecting, show a green success state briefly, and surface connection failures inline under the Host field.

## Pass 5 — Handle positions, scroll contract, terminal, file explorer, text overflow

- Rebuilt canvas port positioning for tool, file, merge, transfer, and transform nodes: node bodies are relative, port rows reserve left/right label padding, and every React Flow handle is an absolute 12px dot placed on the outer node edge with no transforms.
- Added the shared `.scroll-region` contract for shrinkable scrolling flex children and applied it to the inspector body, tool palette list, and sidebar file list; the inspector rail now explicitly owns the width transition while the inner content owns scrolling.
- Hardened xterm rendering with a scoped `.xterm` reset for whitespace, word break, word spacing, letter spacing, and ligatures, and expanded the terminal font stack to JetBrains Mono, Menlo, Monaco, Courier New, monospace at 13px/1.2 line height.
- Fixed sidebar file filtering so dotfiles are hidden by default, normal files sort before hidden paths when dotfiles are shown, and the show-dotfiles control is explicit.
- Rebuilt the sidebar file explorer toolbar into a stable default toolbar with New folder, Upload, Refresh, and More actions, plus a contextual selection toolbar with selected count, Download, Delete, and additional actions in a compact popover.
- Rebuilt the popup file explorer as a fixed large dialog using the shared portal modal with an 860px/640px responsive grid, a 200px source/favorites column, a non-squishing breadcrumb header with three icon actions, a scrollable file list, and a persistent filter/action footer.
- Added the app-wide text overflow contract: scoped shrinkability under the BioFlow shell, `.text-nowrap` for row labels/badges/breadcrumbs/tabs, `.text-wrap` for note/body text, and targeted nowrap coverage for PLINK option labels and flag metadata.

## Post-Pass 5 verification sweep

- Fixed remaining Local-mode leaks where renderer code could call SSH/SFTP with the `__local__` sentinel: schema previews, path autocomplete, remote file browser panes, split transfer panes, onboarding cluster tests, ANNOVAR setup, VEP install buttons, and the terminal New Terminal action now require a real SSH connection before touching SSH/SFTP APIs.
- Added connection-aware file helpers so schema/stat/head preview calls can intentionally route to local files or SSH files instead of duplicating direct SFTP calls in inspectors.
- Normalized local file-node origin/source inference for macOS local paths so existing `/Users/...` inputs open with the Local path mode selected, local Browse enabled, and local artifact metadata instead of being treated as remote files.
- Moved the script preview and run report views onto the shared portal-backed modal system with centralized wide-dialog sizing, so they inherit the same backdrop, z-index, animation, and internal scroll behavior as other dialogs.
- Tightened the modal text overflow contract so explicit wrapping utilities such as `.text-wrap`, `break-words`, `break-all`, and `whitespace-pre-wrap` are not overridden by the default nowrap rule.
- Runtime checked the Electron app in Local mode: opened the full file explorer, confirmed dotfiles are off by default and the list scrolls, selected a local file node, confirmed the inspector shows Local mode with local Browse enabled, and confirmed no `__local__` SSH/SFTP errors appeared in the dev server output.
- Verification after the sweep: `npm run typecheck` passed, `npm test` passed with 117 tests, and `npm run build` passed with the existing non-fatal Vite dynamic/static import warning for `pipelineStore.ts`.

## Edge and inspector stability fix

- Removed the stale DOM-measured edge coordinate override from `AxedEdge`; custom edges now use React Flow's live `sourceX/sourceY/targetX/targetY` values directly so lines update with node drag, zoom, pan, and canvas resizing without a second coordinate system.
- Removed the `bioflow:ports-updated` measurement loop and the `onMove` port-coordinate refresh from `PipelineCanvas`, eliminating the resize/drag-time twitch caused by delayed handle measurements.
- Hardened the inspector scroll contract with a zero-basis flex scroll body, contained overscroll, stable scrollbar gutter, and React Flow `nowheel`/`nopan`/`nodrag` escape classes so PLINK Association and other tall inspectors can scroll independently of the canvas.
- Verification: `npm run typecheck`, `npm test` (117 tests), and `npm run build` passed after these fixes.

## Connection hierarchy and file explorer split polish

- Lifted saved cluster presets and the authentication selector to the top of the connection dialog, so Rorqual-style saved profiles and SSH key/password/agent switching are part of the primary path instead of hidden in Advanced SSH.
- Made the visible credential field respond to the selected auth method: key path for SSH key, password plus remember-password for password auth, and a compact agent state for SSH agent auth.
- Kept passphrase, remote directory, key generation, MFA hinting, local browsing, connection name, and port in progressive disclosures.
- Reworked the popup file explorer controls so the view toggle uses list/grid icons, while the Split button opens the two-pane local/cluster transfer dialog for dragging files across locations.
- Removed the mistaken split-input selection mode from the popup browser; multi-file split inputs remain handled by the existing inspector/canvas workflows.
- Added a shared `FileGlyph` visual for sidebar rows, popup grid/list rows, DNAnexus rows, and split transfer panes, with calmer Lucide icon tones and a recessed file tile treatment.
- Widened and cleaned the split transfer dialog into an explicit local/cluster two-pane surface with consistent icons, scrollable panes, and clearer copy/move affordances.
- Restored Settings to a true wide side-tab dialog with a fixed navigation rail and independently scrollable page content, preserving the redesigned controls without cramping every page into the default modal width.
- Promoted the previous General-page subsections into first-class Settings pages: Interface, Appearance, Privacy, Setup, Run Checks, and Execution now live in the left rail instead of being buried in disclosures.
- Fixed the Settings left rail to stay a vertical, left-aligned menu at all app widths; removed the compact horizontal scrolling strip and gave every nav row the same explicit button geometry.
- Verification: `npm run typecheck`, `npm test` (117 tests), and `npm run build` passed; build still reports the existing non-fatal `pipelineStore.ts` dynamic/static import warning.

## Pass 6 — Sidebar explorer, popup explorer + preview, data previewer rebuild

- Rebuilt the sidebar file explorer as a fast navigator: compact path header, hidden slide-down filter, contextual More menu, collapsible Bookmarks/Recents/Data cart sections, sticky selection toolbar, shimmer loading rows, empty-state action, footer item count, and icon-only hidden-files toggle.
- Kept sidebar file-picker handoff, multi-select, preview opening, canvas staging, data cart staging, protected delete checks, missing canvas-node flagging, local/SSH routing, and DNAnexus panel access wired through the existing stores and handlers.
- Rebuilt the popup file explorer into a three-column modal: source rail for Local/SSH/DNAnexus/Favorites/Recents, central list/grid browser with breadcrumb/search/sort/filter footer, and a right preview panel.
- Added popup file previews for text and tabular files using first-200-line reads through the existing local/SFTP preview helpers; binary/unknown files now get a clear no-preview state.
- Added popup mini-editor mode for text/table previews under 1MB with Save/Discard, existing local/SFTP write APIs, and a warning when the selected file is already used as a pipeline input.
- Preserved split transfer by moving it into the popup source rail as an explicit two-pane transfer action rather than overloading the list/grid view toggle.
- Rebuilt the data preview table into an exploration surface with row search, match counts, sortable headers, column type badges, resizable/autofit columns, selected row styling, null rendering, tooltip full values, column visibility/reorder popover, pagination, rows-per-page control, bottom-panel expansion, and current-view CSV export.
- Updated data preview empty/loading states to use the shared empty-state and shimmer patterns instead of spinner/text-only feedback.
- Verification: runtime-smoked the sidebar, popup explorer, popup preview, and data preview empty state in Electron; `npm run typecheck`, `npm test` (117 tests), `npm run build`, and `git diff --check` passed. The build still reports the existing non-fatal `pipelineStore.ts` dynamic/static import warning.

## Post-Pass 6 regression sweep

- Restored an explicit `Browse` command in the sidebar file explorer header so the popup explorer is discoverable without knowing the path chip opens it.
- Restored visible data-preview rule filtering with a Filters popover, add/clear/remove filter actions, column/operator/value controls, and live application through the existing preview filter store.
- Collapsed Settings back to a smaller left navigation: General, Run, Paths, Tools, DNAnexus, and Advanced. Interface, appearance, privacy, setup, notifications, checks, and execution are now visible groups inside those pages instead of separate cramped tabs.
- Replaced the SSH saved-preset dropdown with selectable preset cards, including a clear New connection card.
- Added a shared `MenuSelect` popover control and used it for the visible file/data/settings selectors touched in this sweep; remaining native selects are globally flattened so they no longer carry the old chunky bordered dropdown treatment.
- Added compact modal/file-browser/settings responsive rules and wrapping data-preview toolbars so controls shrink or wrap instead of spilling when the window changes size.
- Verification: `npm run typecheck`, `npm test` (117 tests), `npm run build`, and `git diff --check` passed. The build still reports the existing non-fatal `pipelineStore.ts` dynamic/static import warning.

## SSH prompt after local preview fix

- Fixed a connection-routing bug where data preview tabs stored only a path, so reopening or reloading a local `/Users/...` preview while Rorqual was active sent that local path through remote SFTP/OpenSSH.
- Data preview tabs now retain their owning connection id, and preview `stat`, `head`, image/PDF reads, text/table reloads, raw/table mode switches, filtered CSV export, Jobs previews, sidebar previews, and popup previews route through that stored connection.
- Added a local-path fallback for older tabs without connection metadata so macOS absolute paths are treated as local even if SSH is active.
- Updated sidebar file explorer actions to use the current folder's connection id instead of the global active connection, preventing local-tab selections from being added, picked, copied, or previewed as remote files.

## Pass 7 — Full visual QA sweep

- Added `VISUAL_BUGS.md` and completed the requested visual QA log with critical, degraded, and polish groups.
- Fixed the modal scroll/overflow contract so expanded connection dialog sections scroll inside the modal body instead of clipping behind the footer.
- Bounded popup file preview tables with a shared mini-table layout so wide tabular previews truncate within their cells and remain scrollable.
- Cleaned the narrow file inspector split row by giving the text column shrinkable wrap behavior and keeping the Enable control fixed to the right.
- Raised sub-11px visual text in the audited palette, canvas nodes, edge labels, data-preview toolbar, jobs panel, connection preset cards, and popup preview controls to token-based `text-xs` sizing.
- Added a scoped global typography guard that maps legacy 8–10px utility classes inside the app shell, modals, and popovers to the `--text-xs` token.
- Fixed the Jobs run-selector header so the `Run:` label remains visible instead of collapsing next to the selector.
- Tightened popup grid file labels with a shared two-line clamp class so long names wrap consistently without spilling or jagged breaks.
- Continued the sweep on the missed light-theme cases: settings navigation, popup file explorer source rail, and preview rail now use light surface tokens instead of staying dark.
- Fixed the PLINK inspector parameter control row so Search, Custom, and Validate wrap cleanly instead of being clipped in the narrow inspector.
- Normalized dense file/tool text sizing, softened the canvas minimap, made bottom-panel badges token-sized, and changed workspace advanced tool paths to a single-column layout so long placeholders remain readable.

## OpenSSH background MFA prompt fix

- Restricted OpenSSH askpass/MFA prompting to explicit ControlPersist master startup during Connect.
- Switched ordinary OpenSSH app operations, including `exec`, streaming exec, file listing, stat/head/read/write, upload, and download, to non-interactive batch mode with `SSH_ASKPASS` stripped from the child environment.
- Added a unit test for the batch-mode SSH argument contract so background previews/readiness probes cannot silently regress into interactive authentication prompts.
