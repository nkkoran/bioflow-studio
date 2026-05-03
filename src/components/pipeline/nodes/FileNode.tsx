/**
 * File node — represents a concrete input or output file on the remote filesystem.
 * Input files have a source handle on the right; output files have a target handle on the left.
 */
import { memo, useMemo } from 'react'
import { Position, type NodeProps } from '@xyflow/react'
import { classNames } from '@/lib/utils'
import { AlertTriangle, FileText, Share2 } from 'lucide-react'
import type { FileNodeData } from '@/types/pipeline'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { computeFileOutputPreview } from '@/lib/outputPathPreview'
import { MiddleEllipsis } from '@/components/ui/MiddleEllipsis'
import { nodeChromeStyle, nodeTypeTone } from './nodeTones'
import { PortHandle } from './PortHandle'

function FileNodeInner({ id, data, selected }: NodeProps) {
  const nodeData = data as FileNodeData
  const isInput = nodeData.isInput
  const missing = nodeData.status === 'missing'
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
  const fanOutCount = edges.filter((edge) => edge.source === id && (edge.sourceHandle ?? 'output') === 'output').length
  const wireFileNodeToCompatibleInputs = usePipelineStore((s) => s.wireFileNodeToCompatibleInputs)
  const tone = nodeTypeTone('file')

  return (
    <div
      className={classNames(
        'animate-fade-up relative min-w-[180px] max-w-[320px] rounded-lg border bg-bg-secondary/95 px-4 py-2 transition-all duration-150 ease-out',
        missing && 'ring-2 ring-error/35',
      )}
      style={nodeChromeStyle(tone, Boolean(selected))}
    >
      <div className="flex items-center gap-2">
        <FileText size={14} className="text-amber-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-wide text-text-muted">
            {nodeData.fileType} {isInput ? 'input' : 'output'}{isInput && nodeData.source === 'local' ? ' · local' : ''}
          </div>
          <div className="bioflow-canvas-node-label truncate text-xs font-semibold text-text-primary">
            {nodeData.label}
          </div>
          {isInput && nodeData.path && (
            <div className="text-xs text-text-muted font-mono truncate">
              <MiddleEllipsis value={nodeData.path} max={40} />
            </div>
          )}
          {missing && (
            <div className="mt-1 flex items-center gap-1 rounded bg-error/10 px-1.5 py-0.5 text-xs text-error">
              <AlertTriangle size={10} />
              Path deleted or missing
            </div>
          )}
          {isInput && nodeData.split?.items?.length && (
            <div className="mt-1 flex max-h-16 flex-wrap gap-1 overflow-hidden">
              {nodeData.split.items.slice(0, 6).map((item) => (
                <span key={item.key} className="rounded bg-amber-500/10 px-1 py-0.5 text-xs text-amber-200" title={item.path}>
                  {item.key}
                </span>
              ))}
              {nodeData.split.items.length > 6 && (
                <span className="rounded bg-bg-tertiary px-1 py-0.5 text-xs text-text-muted">+{nodeData.split.items.length - 6}</span>
              )}
            </div>
          )}
          {isInput && fanOutCount > 1 && (
            <div className="mt-1 text-xs text-accent">
              Fan-out: {fanOutCount} downstream inputs
            </div>
          )}
          {!isInput && outputLabel && (
            <div className="text-xs text-text-muted font-mono truncate" title={outputFolder || 'Default output folder'}>
              → <MiddleEllipsis value={outputLabel} max={34} />
            </div>
          )}
          {!isInput && outputPreview && (
            <div className="text-xs text-text-muted font-mono truncate">
              <MiddleEllipsis value={outputPreview} max={40} />
            </div>
          )}
        </div>
      </div>

      {isInput ? (
        <>
          <button
            type="button"
            onClick={() => void wireFileNodeToCompatibleInputs(id)}
            className="absolute right-4 top-2 rounded bg-bg-tertiary p-1 text-text-muted shadow-sm hover:bg-bg-hover hover:text-text-primary"
            title="Wire this file to all compatible inputs on the canvas"
          >
            <Share2 size={12} />
          </button>
          <PortHandle
            nodeId={id}
            type="source"
            position={Position.Right}
            id="output"
            tone="file"
          />
          {fanOutCount > 1 && (
            <div className="absolute right-4 top-1/2 -translate-y-1/2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-200">
              {fanOutCount}x
            </div>
          )}
        </>
      ) : (
        <PortHandle
          nodeId={id}
          type="target"
          position={Position.Left}
          id="input"
          tone="file"
        />
      )}
    </div>
  )
}

export const FileNode = memo(FileNodeInner)
