import type { PipelineSnapshot } from '@/types/pipeline'

export interface PipelineTemplate {
  id: string
  name: string
  description: string
  snapshot: PipelineSnapshot
}

const now = 0

export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  {
    id: 'basic-shell-copy',
    name: 'Shell: copy input to output',
    description: 'Minimal input → custom shell → output graph using $INPUT and $OUTPUT.',
    snapshot: {
      version: 1,
      id: 'template-basic-shell-copy',
      name: 'Shell copy template',
      description: 'Copy one input file to one output file with a custom shell node.',
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          id: 'file_input',
          type: 'file',
          position: { x: 80, y: 120 },
          data: { label: 'Input file', path: '', fileType: 'any', isInput: true },
        },
        {
          id: 'shell_copy',
          type: 'tool',
          position: { x: 360, y: 100 },
          data: {
            toolId: 'custom.shell',
            label: 'Copy file',
            paramValues: { script: 'cat "$INPUT"' },
            status: 'idle',
          },
        },
        {
          id: 'file_output',
          type: 'file',
          position: { x: 660, y: 120 },
          data: { label: 'Output file', path: '~/bioflow-output/copied.txt', fileType: 'txt', isInput: false },
        },
      ],
      edges: [
        { id: 'edge_input_shell', source: 'file_input', sourceHandle: 'output', target: 'shell_copy', targetHandle: 'input' },
        { id: 'edge_shell_output', source: 'shell_copy', sourceHandle: 'output', target: 'file_output', targetHandle: 'input' },
      ],
    },
  },
  {
    id: 'basic-gwas',
    name: 'Basic GWAS',
    description: 'PLINK input → PLINK2 association → TSV output.',
    snapshot: {
      version: 1,
      id: 'template-basic-gwas',
      name: 'Basic GWAS template',
      description: 'Single-node PLINK2 association test.',
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          id: 'plink_input',
          type: 'file',
          position: { x: 80, y: 120 },
          data: { label: 'PLINK fileset', path: '', fileType: 'plink', isInput: true },
        },
        {
          id: 'plink_assoc',
          type: 'tool',
          position: { x: 360, y: 100 },
          data: {
            toolId: 'plink2.assoc',
            label: 'PLINK2 Association',
            paramValues: { glm: 'hide-covar', maf: 0.01, geno: 0.05, hwe: 1e-6 },
            status: 'idle',
          },
        },
        {
          id: 'assoc_output',
          type: 'file',
          position: { x: 690, y: 120 },
          data: { label: 'Association results', path: '~/bioflow-output/assoc.tsv', fileType: 'tsv', isInput: false },
        },
      ],
      edges: [
        { id: 'edge_plink_assoc', source: 'plink_input', sourceHandle: 'output', target: 'plink_assoc', targetHandle: 'input' },
        { id: 'edge_assoc_output', source: 'plink_assoc', sourceHandle: 'output', target: 'assoc_output', targetHandle: 'input' },
      ],
    },
  },
  {
    id: 'vcf-qc',
    name: 'VCF QC',
    description: 'VCF input → bcftools view → filtered VCF output.',
    snapshot: {
      version: 1,
      id: 'template-vcf-qc',
      name: 'VCF QC template',
      description: 'Filter or subset one VCF with bcftools view.',
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          id: 'vcf_input',
          type: 'file',
          position: { x: 80, y: 120 },
          data: { label: 'Input VCF', path: '', fileType: 'vcf', isInput: true },
        },
        {
          id: 'bcftools_view',
          type: 'tool',
          position: { x: 360, y: 100 },
          data: {
            toolId: 'bcftools.view',
            label: 'bcftools view',
            paramValues: { 'output-type': 'z' },
            status: 'idle',
          },
        },
        {
          id: 'vcf_output',
          type: 'file',
          position: { x: 690, y: 120 },
          data: { label: 'Filtered VCF', path: '~/bioflow-output/filtered.vcf.gz', fileType: 'vcf', isInput: false },
        },
      ],
      edges: [
        { id: 'edge_vcf_view', source: 'vcf_input', sourceHandle: 'output', target: 'bcftools_view', targetHandle: 'input' },
        { id: 'edge_view_output', source: 'bcftools_view', sourceHandle: 'output', target: 'vcf_output', targetHandle: 'input' },
      ],
    },
  },
]

export function instantiateTemplate(template: PipelineTemplate): PipelineSnapshot {
  const stamp = Date.now()
  return {
    ...template.snapshot,
    id: `pipeline_${Math.random().toString(36).slice(2, 10)}`,
    name: template.name,
    createdAt: stamp,
    updatedAt: stamp,
    nodes: template.snapshot.nodes.map((node) => ({
      ...node,
      data: { ...node.data },
    })),
    edges: template.snapshot.edges.map((edge) => ({ ...edge })),
  }
}
