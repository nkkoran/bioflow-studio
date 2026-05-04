import type { CSSProperties } from 'react'
import type { ToolCategory } from '@/types/pipeline'

interface NodeTone {
  accent: string
  border: string
}

const CATEGORY_TONES: Record<ToolCategory, NodeTone> = {
  gwas: { accent: 'rgb(79 140 255)', border: 'rgb(79 140 255 / 0.82)' },
  stats: { accent: 'rgb(56 189 248)', border: 'rgb(56 189 248 / 0.76)' },
  visualization: { accent: 'rgb(168 85 247)', border: 'rgb(168 85 247 / 0.74)' },
  qc: { accent: 'rgb(49 196 141)', border: 'rgb(49 196 141 / 0.76)' },
  annotation: { accent: 'rgb(244 114 182)', border: 'rgb(244 114 182 / 0.76)' },
  format: { accent: 'rgb(34 211 238)', border: 'rgb(34 211 238 / 0.74)' },
  'file-ops': { accent: 'rgb(34 211 238)', border: 'rgb(34 211 238 / 0.74)' },
  utility: { accent: 'rgb(167 139 250)', border: 'rgb(167 139 250 / 0.76)' },
  custom: { accent: 'rgb(250 204 21)', border: 'rgb(250 204 21 / 0.72)' },
  'variant-calling': { accent: 'rgb(251 113 133)', border: 'rgb(251 113 133 / 0.76)' },
  alignment: { accent: 'rgb(45 212 191)', border: 'rgb(45 212 191 / 0.76)' },
}

const NODE_TONES: Record<'file' | 'transform' | 'merge' | 'transfer', NodeTone> = {
  file: { accent: 'rgb(251 191 36)', border: 'rgb(251 191 36 / 0.78)' },
  transform: { accent: 'rgb(45 212 191)', border: 'rgb(45 212 191 / 0.76)' },
  merge: { accent: 'rgb(129 140 248)', border: 'rgb(129 140 248 / 0.78)' },
  transfer: { accent: 'rgb(34 211 238)', border: 'rgb(34 211 238 / 0.76)' },
}

export function categoryTone(category: ToolCategory): NodeTone {
  return CATEGORY_TONES[category] ?? CATEGORY_TONES.utility
}

export function nodeTypeTone(type: keyof typeof NODE_TONES): NodeTone {
  return NODE_TONES[type]
}

export function nodeChromeStyle(tone: NodeTone, selected: boolean): CSSProperties {
  const baseShadow = selected ? 'var(--shadow-node-selected)' : 'var(--shadow-node)'
  const outline = selected ? `0 0 0 2px ${tone.border}` : `0 0 0 1px ${tone.border}`
  return {
    borderColor: tone.border,
    background: selected
      ? `color-mix(in srgb, var(--color-bg-secondary) 90%, ${tone.accent} 10%)`
      : 'var(--color-bg-secondary)',
    boxShadow: `${baseShadow}, ${outline}, inset 4px 0 0 ${tone.accent}`,
  }
}
