import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  ArrowRightLeft,
  Boxes,
  Dna,
  FileCog,
  FileText,
  GitMerge,
  Rows3,
  ShieldCheck,
  SlidersHorizontal,
  StickyNote,
  Tags,
  Terminal,
  Workflow,
} from 'lucide-react'
import { getTool } from '@/lib/toolRegistry'
import type { BioflowNodeType, ToolCategory } from '@/types/pipeline'

const CATEGORY_ICONS: Record<ToolCategory, LucideIcon> = {
  gwas: Dna,
  annotation: Tags,
  qc: ShieldCheck,
  format: FileCog,
  utility: Workflow,
  custom: Terminal,
  'variant-calling': Activity,
  alignment: Rows3,
}

const NODE_ICONS: Record<BioflowNodeType, LucideIcon> = {
  tool: Workflow,
  file: FileText,
  note: StickyNote,
  merge: GitMerge,
  transfer: ArrowRightLeft,
  transform: SlidersHorizontal,
}

export function iconForCategory(category: ToolCategory): LucideIcon {
  return CATEGORY_ICONS[category] ?? Workflow
}

export function iconForTool(toolId: string): LucideIcon {
  const tool = getTool(toolId)
  if (!tool) return Workflow
  return iconForCategory(tool.category)
}

export function iconForNodeType(type: BioflowNodeType): LucideIcon {
  return NODE_ICONS[type] ?? Workflow
}

export function iconForBundle(): LucideIcon {
  return Boxes
}
