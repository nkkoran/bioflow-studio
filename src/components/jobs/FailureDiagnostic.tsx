import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { FailureDiagnostic as FailureDiagnosticData } from '@/stores/runStore'
import type { ToolNodeData } from '@/types/pipeline'
import { usePipelineStore } from '@/stores/pipelineStore'
import { CUSTOM_FLAG_ID, createCustomFlagBlock, ensureFlagBlocks, flagBlocksToParamValues } from '@/lib/flagRegistry'
import { analysisOptionsToParamValues, normalizeAnalysisOptions } from '@/lib/analysisOptions'
import { getTool } from '@/lib/toolRegistry'

interface Props {
  nodeId: string
  diagnostic?: FailureDiagnosticData
  onRerun: () => void
}

export function FailureDiagnostic({ nodeId, diagnostic, onRerun }: Props) {
  const updateNodeData = usePipelineStore((s) => s.updateNodeData)
  const node = usePipelineStore((s) => s.nodes.find((candidate) => candidate.id === nodeId))
  if (!diagnostic) return null

  const applyFix = () => {
    if (!diagnostic.fix || !node || (node.type !== 'tool' && node.type !== 'merge' && node.type !== 'transform')) return
    const data = node.data as ToolNodeData
    const current = data.slurmOverride ?? {}
    if (diagnostic.fix.kind === 'memory') {
      updateNodeData(nodeId, {
        slurmOverride: {
          ...current,
          memoryGB: Math.max(1, Math.ceil((current.memoryGB ?? 8) * diagnostic.fix.multiplier)),
        },
      })
    } else if (diagnostic.fix.kind === 'flags') {
      if (node.type !== 'tool') return
      const nextBlocks = [...ensureFlagBlocks(data.toolId, data.flagBlocks, data.paramValues)]
      for (const suggested of diagnostic.fix.blocks) {
        const existing = nextBlocks.find((block) =>
          suggested.flagId === CUSTOM_FLAG_ID
            ? block.flagId === CUSTOM_FLAG_ID && block.customFlag === suggested.customFlag
            : block.flagId === suggested.flagId,
        )
        if (existing) {
          existing.enabled = true
          existing.value = suggested.value
          if (suggested.flagId === CUSTOM_FLAG_ID) {
            existing.customFlag = suggested.customFlag
            existing.customLabel = suggested.customLabel
          }
          continue
        }
        const block = suggested.flagId === CUSTOM_FLAG_ID
          ? {
              ...createCustomFlagBlock(data.toolId),
              customFlag: suggested.customFlag,
              customLabel: suggested.customLabel,
              value: suggested.value ?? '',
            }
          : {
              id: `${suggested.flagId}_${Math.random().toString(36).slice(2, 10)}`,
              flagId: suggested.flagId,
              enabled: true,
              value: suggested.value,
            }
        nextBlocks.push(block)
      }
      const tool = getTool(data.toolId)
      const migratedOptions = tool
        ? normalizeAnalysisOptions(tool, { ...data, flagBlocks: nextBlocks, paramValues: flagBlocksToParamValues(data.toolId, nextBlocks, data.paramValues) })
        : data.analysisOptions
      updateNodeData(nodeId, {
        flagBlocks: nextBlocks,
        analysisOptions: migratedOptions,
        paramValues: tool && migratedOptions
          ? analysisOptionsToParamValues(tool, migratedOptions, flagBlocksToParamValues(data.toolId, nextBlocks, data.paramValues))
          : flagBlocksToParamValues(data.toolId, nextBlocks, data.paramValues),
      })
    } else {
      updateNodeData(nodeId, {
        slurmOverride: {
          ...current,
          timeHours: Math.max(1, Math.ceil((current.timeHours ?? 1) * diagnostic.fix.multiplier)),
        },
      })
    }
    onRerun()
  }

  return (
    <div className="border-b border-border bg-error/5 px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-error">
        <AlertTriangle size={14} />
        {diagnostic.cause}
      </div>
      <div className="mb-2 text-[11px] text-text-secondary">{diagnostic.suggestion}</div>
      {diagnostic.fix && (
        <Button variant="secondary" size="sm" className="mb-2 h-6 text-xs" onClick={applyFix}>
          {diagnostic.fix.kind === 'flags' ? 'Apply suggested flag and rerun' : 'Apply fix and rerun'}
        </Button>
      )}
      <details className="text-[10px] text-text-muted">
        <summary className="cursor-pointer">Last stderr lines</summary>
        <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-bg-primary p-2 font-mono">
          {diagnostic.tail.join('\n')}
        </pre>
      </details>
    </div>
  )
}
