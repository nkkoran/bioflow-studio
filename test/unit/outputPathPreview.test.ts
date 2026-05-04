import { describe, expect, it } from 'vitest'
import { computeNodeOutputPreview, computeToolPortPhysicalOutputPreviews, physicalPlotOutputPaths } from '@/lib/outputPathPreview'
import type { PipelineSnapshot } from '@/types/pipeline'
import type { PathSettings } from '@/stores/settingsStore'

const pathSettings: PathSettings = {
  runFolderTemplate: 'runs/{pipelineSlug}-{timestamp}',
  createSubfolders: true,
  scriptsSubfolder: 'scripts',
  outputsSubfolder: 'outputs',
  logsSubfolder: 'logs',
  uploadsSubfolder: 'uploads',
}

describe('plot output path previews', () => {
  it('expands a logical plot artifact into physical PNG/PDF paths', () => {
    expect(physicalPlotOutputPaths('/work/manhattan.plot.txt', 'both')).toEqual([
      '/work/manhattan.plot.png',
      '/work/manhattan.plot.pdf',
    ])
    expect(physicalPlotOutputPaths('/work/manhattan.plot.txt', 'pdf')).toEqual(['/work/manhattan.plot.pdf'])
  })

  it('shows selected Manhattan plot files before run', () => {
    const snapshot: PipelineSnapshot = {
      version: 1,
      id: 'plot-preview',
      name: 'Plot Preview',
      createdAt: 1,
      updatedAt: 1,
      nodes: [
        {
          id: 'manhattan',
          type: 'tool',
          position: { x: 0, y: 0 },
          data: {
            toolId: 'plot.manhattan',
            label: 'Manhattan',
            paramValues: { outputFormats: 'png' },
            status: 'idle',
          },
        },
      ],
      edges: [],
    }

    const paths = computeToolPortPhysicalOutputPreviews('manhattan', 'plot', snapshot, pathSettings)

    expect(paths).toHaveLength(1)
    expect(paths[0]).toMatch(/\.plot\.png$/)
    expect(paths[0]).not.toMatch(/\.txt$/)
  })

  it('uses physical plot files for the node-card output preview', () => {
    const snapshot: PipelineSnapshot = {
      version: 1,
      id: 'plot-card-preview',
      name: 'Plot Card Preview',
      createdAt: 1,
      updatedAt: 1,
      nodes: [
        {
          id: 'manhattan',
          type: 'tool',
          position: { x: 0, y: 0 },
          data: {
            toolId: 'plot.manhattan',
            label: 'Manhattan',
            paramValues: { outputFormats: 'both' },
            status: 'idle',
          },
        },
      ],
      edges: [],
    }

    const preview = computeNodeOutputPreview('manhattan', snapshot, pathSettings)

    expect(preview).toContain('.plot.png')
    expect(preview).toContain('.plot.pdf')
    expect(preview).not.toContain('.plot.txt')
  })
})
