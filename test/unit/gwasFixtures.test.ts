import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeDelimitedProbe, parseFamProbe } from '@/lib/fileProbes'
import { evaluateWorkflowReadiness } from '@/lib/workflowReadiness'
import type { PipelineSnapshot } from '@/types/pipeline'

const fixtureDir = join(process.cwd(), 'test', 'fixtures', 'gwas-grs')

describe('GWAS fixture set', () => {
  it('contains coherent metadata and keep-file fixtures', async () => {
    const metadataText = await readFile(join(fixtureDir, 'metadata.tsv'), 'utf8')
    const keepText = await readFile(join(fixtureDir, 'expected_eur_keep.txt'), 'utf8')
    const metadataProbe = analyzeDelimitedProbe('metadata.tsv', metadataText)

    expect(metadataProbe.sampleIds).toHaveLength(8)
    expect(keepText.trim().split('\n')).toHaveLength(4)
  })

  it('supports a non-empty GWAS p-value filter preview', async () => {
    const gwasText = await readFile(join(fixtureDir, 'gwas.glm.linear.tsv'), 'utf8')
    const famText = await readFile(join(fixtureDir, 'cohort.fam'), 'utf8')
    const gwasProbe = analyzeDelimitedProbe('gwas.glm.linear.tsv', gwasText)
    const famProbe = parseFamProbe(famText)

    const snapshot: PipelineSnapshot = {
      version: 1,
      id: 'pipeline_fixture',
      name: 'fixture',
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        { id: 'geno', type: 'file', position: { x: 0, y: 0 }, data: { label: 'Genotypes', path: '/fixtures/cohort.bed', fileType: 'plink', isInput: true } },
        { id: 'gwas', type: 'file', position: { x: 0, y: 1 }, data: { label: 'GWAS', path: '/fixtures/gwas.glm.linear.tsv', fileType: 'tsv', isInput: true } },
        {
          id: 'sig',
          type: 'transform',
          position: { x: 1, y: 1 },
          data: {
            label: 'Sig hits',
            fileType: 'tsv',
            preset: 'gwas-pval-filter',
            presetConfig: { threshold: 5e-8 },
            roleMappings: {
              p_value: { roleId: 'p_value', column: 'P', confirmed: true },
            },
            status: 'idle',
          },
        },
      ],
      edges: [
        { id: 'e1', source: 'gwas', sourceHandle: 'output', target: 'sig', targetHandle: 'input' },
      ],
    }

    const report = evaluateWorkflowReadiness(snapshot, {
      probes: {
        '/fixtures/cohort.bed': {
          key: '/fixtures/cohort.bed',
          path: '/fixtures/cohort.bed',
          exists: true,
          sidecars: { '.bim': true, '.fam': true },
          sampleIds: famProbe.sampleIds,
        },
        '/fixtures/gwas.glm.linear.tsv': {
          key: '/fixtures/gwas.glm.linear.tsv',
          path: '/fixtures/gwas.glm.linear.tsv',
          exists: true,
          header: gwasProbe.header,
          delimiter: gwasProbe.delimiter,
          previewRows: gwasProbe.previewRows,
          recordIds: gwasProbe.recordIds,
        },
      },
    })

    expect(report.issues.some((issue) => issue.code === 'PVAL_FILTER_EMPTY_PREVIEW')).toBe(false)
  })
})
