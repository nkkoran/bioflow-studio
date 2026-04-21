/**
 * File node — represents a concrete input or output file on the remote filesystem.
 * Input files have a source handle on the right; output files have a target handle on the left.
 */
import { memo, useMemo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { classNames } from '@/lib/utils'
import { FileText } from 'lucide-react'
import type { FileNodeData } from '@/types/pipeline'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { computeFileOutputPreview } from '@/lib/outputPathPreview'

function FileNodeInner({ id, data, selected }: NodeProps) {
  const nodeData = data as FileNodeData
  const isInput = nodeData.isInput
  const outputLabel = nodeData.outputFilename || nodeData.path?.split('/').pop()
  const outputFolder = nodeData.outputDir || (nodeData.path?.includes('/') ? nodeData.path.slice(0, nodeData.path.lastIndexOf('/')) : '')
  const nodes = usePipelineStore((s) => s.nodes)
  const edges = usePipelineStore((s) => s.edges)
  const groups = usePipelineStore((s) => s.groups)
  const pipelineId = usePipelineStore((s) => s.pipelineId)
  const pipelineName = usePipelineStore((s) => s.pipelineName)
  const pipelineDescription = usePipelineStore((s) => s.pipelineDescription)
  const pathSettings = useSettingsStore((s) => s.settings.paths)
  const outputPreview = useMemo(() => computeFileOutputPreview(id, {
    version: 1,
    id: pipelineId,
    name: pipelineName,
    description: pipelineDescription,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type ?? 'tool',
      position: node.position,
      data: node.data as any,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle ?? undefined,
      target: edge.target,
      targetHandle: edge.targetHandle ?? undefined,
    })),
    groups,
  }, pathSettings), [id, nodes, edges, groups, pipelineId, pipelineName, pipelineDescription, pathSettings])

  return (
    <div
      className={classNames(
        'bg-bg-secondary border-2 rounded-md shadow-lg px-3 py-2 min-w-[180px] transition-all',
        selected ? 'border-accent ring-2 ring-accent/30' : 'border-amber-500/40',
      )}
    >
      <div className="flex items-center gap-2">
        <FileText size={14} className="text-amber-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-text-muted">
            {nodeData.fileType} {isInput ? 'input' : 'output'}{isInput && nodeData.source === 'local' ? ' · local' : ''}
          </div>
          <div className="text-xs font-semibold text-text-primary truncate">
            {nodeData.label}
          </div>
          {isInput && nodeData.path && (
            <div
              className="text-[10px] text-text-muted font-mono truncate"
              title={nodeData.path}
            >
              {nodeData.path}
            </div>
          )}
          {!isInput && outputLabel && (
            <div
              className="text-[10px] text-text-muted font-mono truncate"
              title={outputFolder || 'Default output folder'}
            >
              → {outputLabel}
            </div>
          )}
          {!isInput && outputPreview && (
            <div className="text-[10px] text-text-muted font-mono truncate" title={outputPreview}>
              {outputPreview}
            </div>
          )}
        </div>
      </div>

      {isInput ? (
        <Handle
          type="source"
          position={Position.Right}
          id="output"
          style={{
            right: -8,
            width: 10,
            height: 10,
            background: '#f59e0b',
            border: '2px solid var(--color-bg-secondary)',
          }}
        />
      ) : (
        <Handle
          type="target"
          position={Position.Left}
          id="input"
          style={{
            left: -8,
            width: 10,
            height: 10,
            background: '#f59e0b',
            border: '2px solid var(--color-bg-secondary)',
          }}
        />
      )}
    </div>
  )
}

export const FileNode = memo(FileNodeInner)
