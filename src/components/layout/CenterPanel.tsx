import { ToolPalette } from '@/components/pipeline/ToolPalette'
import { PipelineCanvas } from '@/components/pipeline/PipelineCanvas'
import { NodeInspector } from '@/components/pipeline/NodeInspector'
import { PipelineToolbar } from '@/components/pipeline/PipelineToolbar'

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
  return (
    <div className="flex-1 flex flex-col bg-bg-primary min-h-0">
      <PipelineToolbar />
      <div className="flex-1 flex min-h-0">
        <div className="w-56 shrink-0">
          <ToolPalette />
        </div>
        <PipelineCanvas />
        <NodeInspector />
      </div>
    </div>
  )
}
