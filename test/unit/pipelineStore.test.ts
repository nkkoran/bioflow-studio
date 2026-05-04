import { describe, expect, it } from 'vitest'
import { usePipelineStore } from '@/stores/pipelineStore'

describe('pipelineStore', () => {
  it('preserves split and build metadata when adding file nodes', () => {
    usePipelineStore.getState().reset()

    const id = usePipelineStore.getState().addFileNode(
      { x: 0, y: 0 },
      {
        label: 'Chromosome folder',
        path: '/data/plink',
        fileType: 'pgen',
        genomeBuild: 'GRCh38',
        split: {
          axis: 'chrom',
          folderPath: '/data/plink',
          items: [
            { key: '1', path: '/data/plink/chr1.pgen' },
            { key: '2', path: '/data/plink/chr2.pgen' },
          ],
          pattern: { kind: 'glob', template: '/data/plink/chr*.pgen', capture: 'key' },
        },
      },
    )

    const node = usePipelineStore.getState().nodes.find((candidate) => candidate.id === id)
    expect(node?.data.genomeBuild).toBe('GRCh38')
    expect(node?.data.split).toMatchObject({
      axis: 'chrom',
      folderPath: '/data/plink',
      pattern: { kind: 'glob', template: '/data/plink/chr*.pgen', capture: 'key' },
    })
    expect(node?.data.split?.items).toHaveLength(2)
  })

  it('duplicates selected nodes with internal edges', () => {
    usePipelineStore.getState().reset()

    const inputId = usePipelineStore.getState().addFileNode(
      { x: 0, y: 0 },
      { label: 'Input', path: '/data/input.vcf.gz', fileType: 'vcf' },
    )
    const toolId = usePipelineStore.getState().addToolNode('bcftools.view', { x: 220, y: 0 })
    usePipelineStore.getState().onConnect({
      source: inputId,
      sourceHandle: 'output',
      target: toolId,
      targetHandle: 'input',
    })
    usePipelineStore.getState().selectAllNodes()

    usePipelineStore.getState().duplicateSelection()

    const state = usePipelineStore.getState()
    expect(state.nodes).toHaveLength(4)
    expect(state.edges).toHaveLength(2)
    const duplicatedIds = state.nodes.filter((node) => node.selected).map((node) => node.id)
    expect(duplicatedIds).toHaveLength(2)
    expect(state.edges.some((edge) => duplicatedIds.includes(edge.source) && duplicatedIds.includes(edge.target))).toBe(true)
  })

  it('selects the duplicated single node', () => {
    usePipelineStore.getState().reset()

    const id = usePipelineStore.getState().addFileNode(
      { x: 0, y: 0 },
      { label: 'Input', path: '/data/input.vcf.gz', fileType: 'vcf' },
    )
    usePipelineStore.getState().duplicateNode(id)

    const state = usePipelineStore.getState()
    expect(state.nodes).toHaveLength(2)
    expect(state.selectedNodeId).not.toBe(id)
    expect(state.nodes.find((node) => node.id === state.selectedNodeId)?.selected).toBe(true)
  })

  it('preserves a local output destination when inserting a transfer quick-fix', () => {
    usePipelineStore.getState().reset()

    const toolId = usePipelineStore.getState().addToolNode('custom.shell', { x: 0, y: 0 })
    const outputId = usePipelineStore.getState().addFileNode(
      { x: 320, y: 0 },
      {
        label: 'CAD result',
        path: '/Users/me/BioFlow/cad.tsv',
        source: 'local',
        origin: 'local',
        fileType: 'tsv',
        isInput: false,
      },
    )
    usePipelineStore.getState().onConnect({
      source: toolId,
      sourceHandle: 'output',
      target: outputId,
      targetHandle: 'input',
    })
    const edgeId = usePipelineStore.getState().edges[0]?.id
    expect(edgeId).toBeTruthy()

    const transferId = usePipelineStore.getState().insertTransferNodeForEdge(edgeId!)
    const transfer = usePipelineStore.getState().nodes.find((node) => node.id === transferId)

    expect(transfer?.type).toBe('transfer')
    expect(transfer?.data).toMatchObject({
      from: 'ssh',
      to: 'local',
      localFolder: '/Users/me/BioFlow',
      outputName: 'cad.tsv',
    })
  })

  it('migrates old plot png/pdf output edges to the logical plot port', () => {
    usePipelineStore.getState().loadSnapshot({
      version: 1,
      id: 'plot-migration',
      name: 'Plot migration',
      createdAt: 1,
      updatedAt: 1,
      nodes: [
        {
          id: 'plot',
          type: 'tool',
          position: { x: 0, y: 0 },
          data: { toolId: 'plot.manhattan', label: 'Manhattan', paramValues: {}, status: 'idle' },
        },
        {
          id: 'sink',
          type: 'transfer',
          position: { x: 240, y: 0 },
          data: { label: 'Download', from: 'ssh', to: 'local', status: 'idle' },
        },
      ],
      edges: [
        { id: 'old-png-edge', source: 'plot', sourceHandle: 'png', target: 'sink', targetHandle: 'input' },
      ],
    })

    expect(usePipelineStore.getState().edges[0]?.sourceHandle).toBe('plot')
  })
})
