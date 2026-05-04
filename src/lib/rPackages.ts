import type { ToolNodeData } from '@/types/pipeline'

export const DEFAULT_R_PACKAGES = [
  'data.table',
  'ggplot2',
  'qqman',
  'scales',
  'gtsummary',
  'gt',
  'openxlsx',
  'broom',
  'broom.helpers',
  'dplyr',
  'tidyr',
]

export function parseRPackageList(raw: unknown): string[] {
  if (raw === undefined || raw === null) return []
  return String(raw)
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter((value) => /^[A-Za-z][A-Za-z0-9.]*$/.test(value))
}

export function rPackagesForTool(toolId: string, nodeData?: Pick<ToolNodeData, 'paramValues'>): string[] {
  const packages = [...DEFAULT_R_PACKAGES]
  if (toolId === 'custom.r') packages.push(...parseRPackageList(nodeData?.paramValues?.packages))
  return Array.from(new Set(packages))
}
