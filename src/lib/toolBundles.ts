import type { Edge } from '@xyflow/react'
import { getTool } from '@/lib/toolRegistry'
import type { BioflowNode } from '@/stores/pipelineStore'

type BundleNode = BioflowNode

export interface ToolBundle {
  id: string
  label: string
  description: string
  pack: 'GWAS/PRS' | 'Variant Annotation' | 'UKB/RAP Extraction' | 'File QC/Transforms' | 'Custom Shell'
  expectedOutputs?: string[]
  help?: string
  build: (position: { x: number; y: number }) => { nodes: BundleNode[]; edges: Edge[] }
}

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function defaultParamValues(toolId: string): Record<string, unknown> {
  const tool = getTool(toolId)
  if (!tool) return {}
  const values: Record<string, unknown> = {}
  for (const param of tool.params) {
    if (param.default !== undefined) values[param.name] = param.default
  }
  return values
}

function toolNode(toolId: string, label: string | undefined, position: { x: number; y: number }): BundleNode {
  const tool = getTool(toolId)
  return {
    id: makeId('node'),
    type: 'tool',
    position,
    data: {
      toolId,
      label: label ?? tool?.name ?? toolId,
      paramValues: defaultParamValues(toolId),
      status: 'idle',
    },
  }
}

export const TOOL_BUNDLES: ToolBundle[] = [
  {
    id: 'grs.withClumping',
    label: 'GRS with clumping',
    description: 'PLINK2 clumping followed by score calculation with lead variant IDs wired into --extract.',
    pack: 'GWAS/PRS',
    expectedOutputs: ['Clumped lead variant IDs', 'PLINK profile/score table'],
    help: 'Use this when you already have GWAS summary statistics and want a clean PRS/GRS scoring handoff.',
    build: (position) => {
      const clumpId = makeId('node')
      const scoreId = makeId('node')
      const clump = getTool('plink2.clump')
      const score = getTool('plink2.score')
      const nodes: BundleNode[] = [
        {
          id: clumpId,
          type: 'tool',
          position,
          data: {
            toolId: 'plink2.clump',
            label: clump?.name ?? 'PLINK2 Clump',
            paramValues: defaultParamValues('plink2.clump'),
            status: 'idle',
          },
        },
        {
          id: scoreId,
          type: 'tool',
          position: { x: position.x + 460, y: position.y + 20 },
          data: {
            toolId: 'plink2.score',
            label: score?.name ?? 'PLINK2 Score / GRS',
            paramValues: defaultParamValues('plink2.score'),
            status: 'idle',
          },
        },
      ]
      const edges: Edge[] = [
        {
          id: makeId('edge'),
          source: clumpId,
          sourceHandle: 'leadIds',
          target: scoreId,
          targetHandle: 'extract',
          animated: false,
        },
      ]
      return { nodes, edges }
    },
  },
  {
    id: 'gwas.plink2.basic',
    label: 'PLINK2 GWAS starter',
    description: 'Association, clumping, and scoring scaffold for a compact GWAS/PRS run.',
    pack: 'GWAS/PRS',
    expectedOutputs: ['GWAS association summary', 'Clumped lead variants', 'PRS/profile table'],
    help: 'Wire genotype, phenotype, and optional covariates into the first step, then inspect role mappings before running.',
    build: (position) => {
      const assoc = toolNode('plink2.assoc', undefined, position)
      const clump = toolNode('plink2.clump', undefined, { x: position.x + 430, y: position.y })
      const score = toolNode('plink2.score', undefined, { x: position.x + 860, y: position.y + 20 })
      return {
        nodes: [assoc, clump, score],
        edges: [
          { id: makeId('edge'), source: assoc.id, sourceHandle: 'output', target: clump.id, targetHandle: 'clump', animated: false },
          { id: makeId('edge'), source: clump.id, sourceHandle: 'leadIds', target: score.id, targetHandle: 'extract', animated: false },
        ],
      }
    },
  },
  {
    id: 'annotation.vcfToTables',
    label: 'VCF annotation',
    description: 'Filter variants, lift coordinates if needed, then annotate with ANNOVAR.',
    pack: 'Variant Annotation',
    expectedOutputs: ['Filtered VCF/BCF', 'Liftover output', 'Annotation tables'],
    help: 'Keep liftover only when source and target genome builds differ; readiness will flag build mismatches.',
    build: (position) => {
      const view = toolNode('bcftools.view', undefined, position)
      const liftover = toolNode('crossmap.liftover', undefined, { x: position.x + 420, y: position.y })
      const annovar = toolNode('annovar.table_annovar', undefined, { x: position.x + 840, y: position.y })
      return {
        nodes: [view, liftover, annovar],
        edges: [
          { id: makeId('edge'), source: view.id, sourceHandle: 'output', target: liftover.id, targetHandle: 'input', animated: false },
          { id: makeId('edge'), source: liftover.id, sourceHandle: 'output', target: annovar.id, targetHandle: 'input', animated: false },
        ],
      }
    },
  },
  {
    id: 'ukb.rapExtractToQc',
    label: 'UKB/RAP extract to QC',
    description: 'DNAnexus UKB Spark extraction followed by explicit transfer and local/HPC table QC.',
    pack: 'UKB/RAP Extraction',
    expectedOutputs: ['Extracted UKB table', 'Explicit cross-backend handoff', 'Filtered analysis table'],
    help: 'This pack is visible in dev mode only while RAP access is unavailable for testing.',
    build: (position) => {
      const extract = toolNode('ukb.spark-extract', undefined, position)
      const transferId = makeId('transfer')
      const filter = toolNode('flow.filterFile', 'Filter extracted table', { x: position.x + 840, y: position.y })
      const transfer: BundleNode = {
        id: transferId,
        type: 'transfer',
        position: { x: position.x + 420, y: position.y },
        data: {
          label: 'RAP to cluster transfer',
          from: 'dnx',
          to: 'ssh',
          sshFolder: '~/BioFlow/rap-inputs',
          status: 'idle',
        },
      }
      return {
        nodes: [extract, transfer, filter],
        edges: [
          { id: makeId('edge'), source: extract.id, sourceHandle: 'output', target: transfer.id, targetHandle: 'input', animated: false },
          { id: makeId('edge'), source: transfer.id, sourceHandle: 'output', target: filter.id, targetHandle: 'input', animated: false },
        ],
      }
    },
  },
  {
    id: 'qc.fastqcMultiqc',
    label: 'FastQC to MultiQC',
    description: 'Run FastQC and aggregate reports with MultiQC.',
    pack: 'File QC/Transforms',
    expectedOutputs: ['FastQC reports', 'MultiQC HTML report'],
    help: 'Use this for FASTQ inspection before alignment or as a standalone QC pipeline.',
    build: (position) => {
      const fastqc = toolNode('fastqc', undefined, position)
      const multiqc = toolNode('multiqc', undefined, { x: position.x + 430, y: position.y })
      return {
        nodes: [fastqc, multiqc],
        edges: [
          { id: makeId('edge'), source: fastqc.id, sourceHandle: 'output', target: multiqc.id, targetHandle: 'input', animated: false },
        ],
      }
    },
  },
  {
    id: 'custom.shellWithTransfer',
    label: 'Custom shell with transfer',
    description: 'Explicitly stage local input to SSH before a custom shell command.',
    pack: 'Custom Shell',
    expectedOutputs: ['Staged input', 'Custom command output'],
    help: 'Use this when the command is unique to the lab but data movement should still be visible and auditable.',
    build: (position) => {
      const transfer: BundleNode = {
        id: makeId('transfer'),
        type: 'transfer',
        position,
        data: {
          label: 'Upload local input',
          from: 'local',
          to: 'ssh',
          sshFolder: '~/BioFlow/uploads',
          status: 'idle',
        },
      }
      const shell = toolNode('custom.shell', undefined, { x: position.x + 420, y: position.y })
      return {
        nodes: [transfer, shell],
        edges: [
          { id: makeId('edge'), source: transfer.id, sourceHandle: 'output', target: shell.id, targetHandle: 'input', animated: false },
        ],
      }
    },
  },
]

export function getToolBundle(id: string): ToolBundle | undefined {
  return TOOL_BUNDLES.find((bundle) => bundle.id === id)
}
