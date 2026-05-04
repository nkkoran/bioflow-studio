import { describe, expect, it } from 'vitest'
import { CATEGORY_LABELS, getTool, getToolsByCategory } from '@/lib/toolRegistry'

describe('tool registry categories', () => {
  it('groups tools into workflow categories in palette order', () => {
    const groups = getToolsByCategory()
    const categories = groups.map((group) => group.category)

    expect(categories.indexOf('gwas')).toBeLessThan(categories.indexOf('qc'))
    expect(categories.indexOf('qc')).toBeLessThan(categories.indexOf('stats'))
    expect(categories.indexOf('stats')).toBeLessThan(categories.indexOf('visualization'))
    expect(CATEGORY_LABELS.stats).toBe('Phenotypes & Stats')
    expect(CATEGORY_LABELS.visualization).toBe('Visualization')
    expect(CATEGORY_LABELS['file-ops']).toBe('File Operations')
  })

  it('places the R reporting tools under their workflow categories', () => {
    expect(getTool('table.gtsummary')?.category).toBe('stats')
    expect(getTool('r.regression')?.category).toBe('stats')
    expect(getTool('plot.manhattan')?.category).toBe('visualization')
    expect(getTool('plot.qq')?.category).toBe('visualization')
    expect(getTool('r.plot')?.category).toBe('visualization')
    expect(getTool('custom.r')?.category).toBe('custom')
    expect(getTool('flow.filterFile')?.category).toBe('file-ops')
    expect(getTool('bcftools.view')?.category).toBe('file-ops')
  })

  it('exposes generated plot tools as one logical plot artifact', () => {
    for (const toolId of ['plot.manhattan', 'plot.qq', 'r.plot']) {
      const tool = getTool(toolId)
      expect(tool?.outputs.map((output) => output.id)).toEqual(['plot'])
      expect(tool?.params.find((param) => param.name === 'outputFormats')?.options).toEqual(['both', 'png', 'pdf'])
    }
  })
})
