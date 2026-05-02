# Visual Bugs

Total logged: 14

## CRITICAL

- [x] [Connection dialog] — Advanced SSH expansion is clipped behind the sticky footer and the modal body does not visibly scroll, hiding lower fields. — src/components/connection/ConnectionDialog.tsx:600; src/renderer/styles/layout.css:62
- [x] [Popup file explorer preview] — Tabular preview of wide TSV files collapses into oversized columns with clipped headers/cells and no visible horizontal affordance, making the preview unusable. — src/components/file-browser/RemoteFileBrowser.tsx:1275

## DEGRADED

- [x] [File inspector] — "Split into per-item files" description and Enable control collide in the narrow inspector; the control/label is pushed to the right edge. — src/components/pipeline/NodeInspector.tsx:2515
- [x] [Tool palette] — Tool row metadata, category labels, and workflow descriptions use 10px text that reads too small/low-contrast in the dense sidebar. — src/components/pipeline/ToolPalette.tsx:80
- [x] [Canvas nodes] — Node meta labels, port headings, small badges, and edge count labels use 9-10px text, below the visual QA floor and hard to read at normal zoom. — src/components/pipeline/nodes/ToolNode.tsx:134; src/components/pipeline/nodes/FileNode.tsx:65; src/components/pipeline/edges/AxedEdge.tsx:37
- [x] [Data Preview panel] — Toolbar badges and secondary controls use 10px text and crowd the loaded table header at bottom-panel height. — src/components/data-preview/DataTable.tsx:175
- [x] [Jobs panel] — The "Run:" label truncates to "Ru..." beside the run selector because the header row does not reserve enough width for the label. — src/components/jobs/JobsPanel.tsx:162
- [x] [Connection dialog] — Saved preset host/user details are too small and truncate aggressively, making presets harder to compare. — src/components/connection/ConnectionDialog.tsx:453
- [x] [Popup file explorer grid] — Grid file names wrap awkwardly around underscores and directory suffixes, producing uneven card labels. — src/components/file-browser/RemoteFileBrowser.tsx:1133
- [x] [Global typography contract] — Fast re-walk found legacy 8–10px utility classes in secondary panels and popovers, below the visual QA readability floor. — src/renderer/styles/layout.css:31

## POLISH

- [ ] [Settings dialog] — In light theme, the settings side navigation remains a very dark surface while the rest of the dialog switches light, producing a jarring mixed-theme panel. — src/components/settings/SettingsDialog.tsx
- [ ] [Workspace dialog] — Expanded advanced tool path placeholders are clipped without a clear ellipsis in the two-column form. — src/components/workspace/WorkspaceSwitcher.tsx:303
- [ ] [Canvas minimap] — The minimap has high visual weight and competes with selected-node/inspector content in the upper-right canvas area. — src/components/pipeline/PipelineCanvas.tsx
- [ ] [Bottom panel tabs] — Small tab badges can render below the readable text floor. — src/components/layout/BottomPanel.tsx:104
