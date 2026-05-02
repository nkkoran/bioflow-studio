# BioFlow Studio Design Research

Date: 2026-05-02

## Sources Read

- Apple Human Interface Guidelines: https://developer.apple.com/design/human-interface-guidelines/
- Apple Layout guidance: https://developer.apple.com/design/human-interface-guidelines/layout
- Apple Typography guidance: https://developer.apple.com/design/human-interface-guidelines/typography
- Apple Color guidance: https://developer.apple.com/design/human-interface-guidelines/color
- OpenAI Codex app announcement, February 2, 2026: https://openai.com/index/introducing-the-codex-app/
- Linear Concepts and action model: https://linear.app/docs/conceptual-model
- Linear contextual menu design notes: https://linear.app/now/invisible-details

## Phase 1: Research Principles

### Apple HIG: Clarity, Deference, Depth

Clarity matters most for BioFlow because the target user is a bioinformatician who understands the experiment but may not know every PLINK or Slurm flag. Labels must describe outcomes in human language first, then reveal raw commands, file paths, job ids, and flags as supporting detail.

Deference means the pipeline canvas, file paths, and run state are the product. Chrome should recede. Panels can be present when useful, but secondary configuration should not visually compete with the graph.

Depth should be used to explain hierarchy and focus: selected nodes lift, drawers float above the canvas, dialogs and pickers separate from the work surface with elevation. Depth should not be decoration.

Platform fit for macOS means compact controls, keyboard access, predictable dialogs, clear focus rings, readable text, and avoiding critical-only controls at the bottom edge.

### OpenAI Codex App

The Codex app is a useful reference because it treats a technical workspace as a command center. The relevant lessons are minimal chrome, content-forward work areas, contextual panels that appear when needed, and a mostly monochrome palette with precise color moments for action, status, and permissions.

For BioFlow, this means the canvas should feel like the primary workspace, with the file explorer, tool palette, run checks, and node inspector acting as assistants around it. Actions should be discoverable through buttons and menus now, but the design should leave room for command-palette-first workflows.

### Linear

Linear's strongest lesson is consistency of action paths: button, shortcut, context menu, and command menu should all point to the same verbs. Dense does not mean cramped; lists can carry a lot of data when typography, spacing, hover states, and progressive disclosure are disciplined.

For BioFlow, repeated scientific workflows need fast scanning: file lists, node IO rows, validation issues, run steps, and results should be compact but breathable. Keyboard navigation should support common moves: select, delete, duplicate, check, run, focus search, close panels with Escape, and navigate lists.

## BioFlow Design System

### Color Palette

The interface uses neutral surfaces first and one accent for interactivity. Scientific/status colors appear only when conveying actual feedback.

Dark theme:
- App background: `#0B0D10`
- Canvas background: `#0E1116`
- Panel surface: `#15181E`
- Raised surface: `#1B2028`
- Hover surface: `#242A33`
- Text primary: `#F2F5F8`
- Text muted: `#A3ACB8`
- Text faint: `#6F7885`
- Accent: `#4F8CFF`
- Success: `#31C48D`
- Warning: `#F6B44B`
- Error: `#F05252`

Light theme:
- App background: `#F6F7F9`
- Canvas background: `#F9FAFC`
- Panel surface: `#FFFFFF`
- Raised surface: `#F0F3F7`
- Hover surface: `#E8EDF4`
- Text primary: `#14171C`
- Text muted: `#536071`
- Text faint: `#8290A1`
- Accent: `#2563EB`
- Success: `#16865A`
- Warning: `#B7791F`
- Error: `#D92D20`

Usage:
- Accent is for primary actions, active states, focus, selected tabs, and active handles.
- Status colors are for validation, run state, missing files, transfer progress, and success pulses.
- Avoid category-colored borders as decoration. If category color appears, it should be a small icon tint or label dot.

### Typography Scale

Use Inter for UI and JetBrains Mono only for paths, ids, flags, commands, and logs.

- Title: 15px / 20px, 600. Panel titles, dialog titles, selected node names.
- Body: 13px / 18px, 400 or 500. Primary UI text and file names.
- Meta: 11px / 16px, 400. Paths, hints, badges, secondary rows.
- Code: 11px / 16px, 400 mono. Commands, flags, paths, job ids.

Keep display hierarchy shallow. No large hero text inside the app.

### Spacing System

4px grid:
- 4px: icon/text micro gaps
- 8px: row gaps, compact padding, chips
- 12px: panel padding, list item padding
- 16px: section spacing
- 24px: dialog interior spacing and large empty states

Panels should feel dense but not packed. Prefer consistent row heights: 28px compact controls, 32px standard inputs, 40px toolbar regions.

### Motion Vocabulary

Motion should explain state change.

- Panels and popovers: 150ms slide plus fade, ease-out.
- Dialogs: 150ms fade and 2px upward settle, ease-out.
- Canvas nodes on selection: 120ms lift via shadow and translate.
- Canvas node placement: spring-drop feel through CSS entry animation.
- Connection made: short spring-snap/pulse on handle and edge.
- Data flowing: animated dashed edge while source/target is running.
- Dragging files: ghost scales to 0.95 with shadow lift.
- Loading: shimmer skeleton for panes/lists, spinner only for small inline waits.
- Success: 700ms green pulse on connected node or completed run badge.
- Respect reduced motion by disabling movement and leaving opacity changes.

### Component Conventions

- Cards are only for repeated content, node bodies, dialogs, and framed tools. Do not nest cards.
- Panels are elevated surfaces, not bordered boxes. Use soft shadows and a small surface shift.
- Inputs are quiet, full-width, left aligned, with accent focus rings.
- Buttons are icon-first when the icon is familiar. Text appears for primary commands or ambiguous actions.
- Badges are compact, animated on status transition, and never decorative.
- Required vs optional inputs must be visible without reading docs.
- PLINK flag UI shows readable label first, raw flag in smaller muted mono text beneath.
- Advanced controls are hidden behind a disclosure by default unless required for the current node.

## Phase 2: Current App Audit

### App Shell: TopBar, Sidebar, CenterPanel, BottomPanel

Current behavior:
- TopBar contains pipeline switcher, workspace switcher, connection status, and settings.
- Sidebar permanently hosts the file explorer.
- CenterPanel permanently shows tool palette, canvas, and node inspector.
- BottomPanel permanently reserves height for Terminal, Data Preview, Jobs, Results, and Queue.

Issues:
- Four panes compete with the canvas at all times.
- Borders outline every surface, making the app feel boxed in.
- The bottom panel is useful but visually heavy, especially before any run exists.
- The toolbar and topbar duplicate global/navigation energy.

Simplify:
- Let the canvas own the center visually.
- Make palette and inspector feel like contextual elevated rails.
- Keep bottom tabs compact and elevated; empty panels should explain the next action.
- Add smooth panel transitions and allow secondary panels to feel temporary.

### Pipeline Toolbar

Current behavior:
- Handles pipeline name, dirty state, workflow guide, check, new/open/save/import/export/templates, run, cancel, script preview, and validation dialogs.

Issues:
- Many actions live in one horizontal strip.
- Check results and workflow guide are useful but dense.
- Run review modal has good safety content but uses heavy boxes and borders.

Simplify:
- Keep primary actions visible: check, run, save.
- Move less common actions into contextual menus.
- Make check/run states animate instead of abruptly swapping text.
- Keep warnings grouped by plain-language category.

### Canvas and Graph Controls

Current behavior:
- React Flow canvas with background grid, minimap, controls, draggable tools/files, port picking, grouping context menus, and empty canvas prompt.

Issues:
- Empty state is static and framed.
- Selected blocks rely mostly on border/ring rather than lift.
- Edges are static even when a run is active.
- Minimap and controls add visual weight.
- Drop feedback is a floating bordered toast.

Simplify:
- Animate the empty prompt subtly.
- Use shadow elevation for selection.
- Animate edges connected to running nodes.
- Make drop messages feel like soft notifications.
- Keep controls small and low-contrast.

### Block System: ToolNode, FileNode, MergeNode, TransferNode, TransformNode, NoteNode

Current behavior:
- Blocks show labels, categories, file types, required/optional chips, status badges, ports, output previews, errors, and job ids.
- File nodes support split item chips and missing status.

Issues:
- Category border colors are decorative and create a rainbow canvas.
- Required/optional chips are visible but small.
- Status badge changes are abrupt.
- Node chrome is heavy relative to content.

Simplify:
- Neutral block body with small type/icon accents.
- Larger required/optional signal in the input row.
- Selected node lifts with stronger shadow.
- Completed/running/failed state pulses only when state changes.
- Missing connected files should remain prominent and blocking.

### Node Inspector

Current behavior:
- Fixed right panel for selected node; edits file paths, tool inputs, outputs, parameters, Slurm, merge, transfer, transform, note settings.

Issues:
- Empty inspector still occupies 320px.
- Tool inspector is long and visually repetitive.
- Runtime, Slurm, output folders, and advanced setup are always in the same scroll flow.
- Many sections are bordered boxes.

Simplify:
- Empty state should be subtle.
- Selected inspector should slide/fade as a contextual panel.
- Show common settings first: label, inputs, outputs, essential parameters.
- Put runtime, modules, Slurm, output folder, cleanup, and advanced settings behind disclosures unless warning/error state needs them.

### PLINK Flags and AnalysisOptionsPanel

Current behavior:
- Searchable option UI, recommended flags, custom flags, validation action, command preview, command editing.
- Human-readable labels exist, with raw flags shown in muted mono.
- File-valued custom flags are supported.

Issues:
- The panel is still dense for a user who is vague on PLINK flags.
- Raw flags can visually compete with readable labels in some rows.
- Command preview and editing are always near the main flow.
- Validation is opt-in and not visually connected enough to required flags.

Simplify:
- Group common flags first, advanced collapsed.
- Readable label should be dominant; raw flag is meta text below.
- Keep "Validate settings" visible.
- Required unset flags should show warning styling before Run.
- Custom file flag should read as "File value" and make canvas vs path source obvious.

### Bash Node Editor

Current behavior:
- Shell script textarea, documented `$INPUT`, `$INPUT_1`, `$INPUT_2`, `${INPUTS[@]}`, `$OUTPUT`, basic validation, output behavior.

Issues:
- Good functional coverage, but the script editor blends with ordinary settings.
- Variable help is a bordered paragraph instead of a compact reference.
- Output behavior is visible but could be more clearly separated as default vs advanced.

Simplify:
- Treat the editor like a code surface.
- Keep variable reference visible and copyable/scannable.
- Keep validation inline and plain language.
- Advanced output contract can be collapsed after the default is selected.

### File Explorer Sidebar

Current behavior:
- Connection-aware file browser with tabs, breadcrumb, toolbar, upload/download/copy/move/delete, bookmarks, search, data cart, multi-select, icon/list modes, context menu, and file pick mode banner.

Issues:
- It is powerful but very dense for a permanent sidebar.
- Toolbar verbs crowd the file list.
- Pick-mode banner is useful but visually loud.
- Data cart is good but adds another panel inside a panel.

Simplify:
- Keep navigation/search/selection primary.
- Hide destructive and transfer actions until a selection exists.
- Keep multi-select affordances visible.
- Use elevated selection toolbar rather than a long permanent toolbar.
- Keep wrong-type warnings prominent.

### File Browser Popup

Current behavior:
- Dialog browser with local/SSH/DNX sources, favorites, recents, navigation, type filters, dotfile toggle, transfer/copy/move/upload/download, select footer.

Issues:
- Good coverage but too many controls are shown at once.
- Type filters are visually similar to actions.
- Empty/loading/error states are plain.

Simplify:
- Left source rail, main content table/grid, contextual selected-file toolbar.
- Loading should show skeleton rows.
- Wrong file type should be a warning row, not silent filtering only.

### SSH and Cluster Connection Flow

Current behavior:
- Connection dialog supports local browsing, saved connections, key/password/agent, key generation, existing key detection, copy public key/path, MFA notes, connection trace, OpenSSH transport explanation.
- Connection status dropdown supports cluster doctor, refresh caches, diagnostic log, Slurm settings, disconnect.

Issues:
- Key setup is feature-rich but too much explanatory text appears at once.
- Advanced OpenSSH/alias details are shown in the primary connection flow.
- Connection trace is useful but visually heavy.

Simplify:
- Primary path: choose local, saved connection, or Rorqual details.
- Key setup becomes a contextual panel with existing-key detection and copy actions.
- Advanced transport, alias, keepalive, and ControlPersist move behind Advanced.
- Connection feedback should be live and calm: spinner, trace disclosure, success pulse.

### Delete Temp Files and Missing Files

Current behavior:
- File explorer confirms delete, protects pipeline inputs, marks affected file nodes as missing.
- Run review offers delete intermediates after success; output rows can mark temporary outputs.

Issues:
- Cleanup choices are scattered across output rows and run review.
- Missing connected file state exists but should be easier to notice in both canvas and inspector.

Simplify:
- Keep deletion confirmation strong.
- Preserve missing-node flagging on canvas.
- Show final filename before run near output configuration and run review.
- Merge failure must not delete unmerged files; this belongs in run review language.

### Auto-Merge and Cleanup

Current behavior:
- Tool outputs show final merged file preview and auto-merge toggle for array outputs.
- Run review explains cleanup plan and intermediate deletion.

Issues:
- Auto-merge/fan-out concepts are compact and hard to parse.
- Final filename is present but buried in output cards.

Simplify:
- Use plain language: "One final file" vs "One file per array task."
- Show final filename preview before run.
- Cleanup defaults to keep all and explains what would be deleted.

### SCP to Local Output

Current behavior:
- Transfer node has "Local destination folder" with required validation, and download actions exist in file/result browsers.

Issues:
- Progress is mostly message-based, not a visible progress row.
- Missing local path validation exists but should read as a blocking requirement.

Simplify:
- Label local destination clearly.
- Show missing path as a warning/error before run.
- Use inline progress bars/messages for transfer actions.

### Bottom Panels: Terminal, Data Preview, Jobs, Results, Queue

Current behavior:
- Tabs switch panels. Jobs owns run selector and node log viewer. Results shows run outputs with reuse/copy/preview/folder actions. Terminal and queue have their own panels.

Issues:
- Bottom panel is fixed and border-heavy.
- Empty states are text-only.
- Jobs header contains many actions in a single row.
- Results cards use repeated borders.

Simplify:
- Tabs remain, but the panel should feel like a drawer.
- Empty states should be centered and action-oriented.
- Jobs/Results actions should collapse based on selected run/output.
- Status badges animate on run transitions.

### Settings and Workspace

Current behavior:
- Workspace dialog captures defaults, tools paths, Slurm, recommended template, notes. Settings dialog controls theme and advanced preferences.

Issues:
- Workspace setup exposes many advanced paths immediately.
- Theme exists but CSS still reads primarily as a dark GitHub-like UI.

Simplify:
- Workspace primary fields: name, connection, analysis root, Slurm account.
- Tools and annotation paths behind Advanced.
- Light/dark themes use the same tokens and interaction rules.

## Redesign Priorities

1. Re-tokenize the app around neutral surfaces, one accent, and three text levels.
2. Replace border-heavy panels/cards with elevated surfaces.
3. Make canvas selection, running edges, empty state, and success/error state animated.
4. Make inspector and palette lighter and more contextual.
5. Make PLINK flags readable first and raw flags secondary.
6. Preserve safety: validation, missing file flags, delete confirmation, cleanup defaults, and local transfer path requirements.
7. Add motion/focus utilities that respect reduced motion.

## Dialog Architecture Rules

Dialogs are decision surfaces, not documentation surfaces.

Structure:
- Header: icon, title, and optional subtitle only. No body copy in the header.
- Body: primary fields or the primary decision only. Anything not needed for most uses goes in a closed disclosure.
- Footer: cancel plus one primary action. On narrow windows, footer actions stack full-width.

Information hierarchy:
- Explanatory paragraphs do not belong in the visible dialog body.
- Move explanations to an info tooltip, docs link, help drawer, or a closed disclosure.
- A dialog with more than five visible fields must be split into primary fields plus one or more disclosures.

BioFlow application:
- Connection shows host, username, and private key path by default. Saved/local access, auth alternatives, passphrase, remote directory, key generation, MFA notes, and advanced SSH settings live behind disclosures.
- Run review shows the run decision and blocking warnings first. Cleanup details, merge plan, transfer plan, and intermediate paths live behind disclosures.
- File browsers and setup wizards keep their primary selection/action visible, with transfers, setup notes, and uncommon settings hidden until requested.

## Pass 4: Additional Sources

Sources:
- Linear, "A calmer interface for a product in motion" (March 12, 2026): https://linear.app/now/behind-the-latest-design-refresh
- Vercel Design / Geist Design System: https://vercel.com/design, https://vercel.com/geist/introduction, https://vercel.com/design/guidelines, https://vercel.com/geist/material, https://vercel.com/geist/button, https://vercel.com/geist/input, https://vercel.com/geist/badge

Principles for BioFlow:
- Calm density: reduce the visual weight of navigation, secondary controls, and persistent chrome so the canvas and current inspector task remain dominant.
- Structure should be felt, not seen: use fewer separators, softer borders, and subtle surface changes so dense workflow screens stay readable without becoming grid-heavy.
- Elevation is a role, not decoration: base panels stay quiet; cards, dialogs, popovers, and inspector surfaces get a small lift with restrained shadows and a top-edge highlight.
- Use the lowest elevation that reads correctly. Over-raised surfaces create the same visual noise as too many borders.
- Interactions must increase contrast predictably. Hover raises one surface level; active state raises two levels and compresses only true buttons.
- Inputs and code fields should feel recessed into the interface with inset shadow, while output cards and dialogs sit slightly above it.
- Dense metadata should use small, steady badges: readable text, restrained status color only when it carries meaning, and no stacked badge/icon noise.
- Icon use should be consistent and quiet: Lucide only, with fixed size tiers for toolbar, panel rows, badges, and empty states.
- Loading controls keep their footprint stable and retain context; spinner states should not make a button jump.
- Handle hit targets may be larger than the visible dot, but the visible handle geometry must match the DOM rect React Flow uses for edge coordinates.
