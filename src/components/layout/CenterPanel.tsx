import { ToolPalette } from '@/components/pipeline/ToolPalette'
import { PipelineCanvas } from '@/components/pipeline/PipelineCanvas'
import { NodeInspector } from '@/components/pipeline/NodeInspector'
import { PipelineToolbar } from '@/components/pipeline/PipelineToolbar'
import { usePipelineStore } from '@/stores/pipelineStore'

/**
 * Center panel layout:
 *
 *   ┌────────────────────────────────────────────────────┐
 *   │                 PipelineToolbar                    │
 *   ├────────┬───────────────────────────────┬───────────┤
 *   │        │                               │           │
 *   │  Tool  │       PipelineCanvas          │   Node    │
 *   │Palette │       (React Flow)            │ Inspector │
 *   │        │                               │           │
 *   └────────┴───────────────────────────────┴───────────┘
 *
 * The pipeline builder is always available, even without a server connection,
 * so users can design pipelines offline and execute later.
 */
export function CenterPanel() {
  const selectedNodeId = usePipelineStore((s) => s.selectedNodeId)

  return (
    <div className="bioflow-center-shell flex-1 flex flex-col bg-[var(--color-canvas)] min-h-0">
      <PipelineToolbar />
      <div className="bioflow-center-body flex-1 flex min-h-0">
        <div className="bioflow-tool-palette-rail shrink-0" data-tour="tool-palette">
          <ToolPalette />
        </div>
        <PipelineCanvas />
        <div className="bioflow-inspector-rail" data-inspector-open={Boolean(selectedNodeId)}>
          <NodeInspector />
        </div>
      </div>
    </div>
  )
}
