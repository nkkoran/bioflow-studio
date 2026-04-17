/**
 * Static registry of bioinformatics tools available in the pipeline builder.
 *
 * Each tool definition includes its inputs, outputs, parameters, and
 * default Slurm resource requests. Categories drive the palette grouping.
 *
 * To add a tool: append a new `ToolDef` to `TOOLS` below and it will
 * appear automatically in the palette.
 */
import type { ToolDef } from '@/types/pipeline'

export const TOOLS: ToolDef[] = [
  // ==================== GWAS ====================
  {
    id: 'plink2.assoc',
    name: 'PLINK2 Association',
    category: 'gwas',
    description: 'Genome-wide association testing (linear or logistic regression)',
    command: 'plink2',
    module: 'plink/2.00a3',
    inputs: [
      { id: 'input', label: 'Genotypes', fileType: 'plink', required: true },
      { id: 'pheno', label: 'Phenotype', fileType: 'tsv' },
      { id: 'covar', label: 'Covariates', fileType: 'tsv' },
    ],
    outputs: [
      { id: 'output', label: 'Results', fileType: 'tsv' },
    ],
    params: [
      { name: 'glm', flag: '--glm', label: 'Model', type: 'select', options: ['linear', 'logistic', 'firth-fallback'], default: 'linear', required: true },
      { name: 'maf', flag: '--maf', label: 'Min MAF', type: 'number', default: 0.01, min: 0, max: 0.5, step: 0.001 },
      { name: 'geno', flag: '--geno', label: 'Max missing genotype rate', type: 'number', default: 0.05, min: 0, max: 1, step: 0.01 },
      { name: 'hwe', flag: '--hwe', label: 'HWE p-value', type: 'number', default: 1e-6, step: 1e-6 },
      { name: 'pheno-name', flag: '--pheno-name', label: 'Phenotype column', type: 'string', columnRef: true, columnSourcePortId: 'pheno' },
      { name: 'covar-name', flag: '--covar-name', label: 'Covariate columns', type: 'string', placeholder: 'age,sex,PC1-PC10', columnRef: true, columnSourcePortId: 'covar' },
    ],
    slurm: { cpus: 8, memoryGB: 32, timeHours: 4 },
  },
  {
    id: 'plink2.qc',
    name: 'PLINK2 QC',
    category: 'qc',
    description: 'Quality control filtering on genotype data',
    command: 'plink2',
    module: 'plink/2.00a3',
    inputs: [{ id: 'input', label: 'Genotypes', fileType: 'plink', required: true }],
    outputs: [{ id: 'output', label: 'Filtered genotypes', fileType: 'plink' }],
    params: [
      { name: 'maf', flag: '--maf', label: 'Min MAF', type: 'number', default: 0.01 },
      { name: 'geno', flag: '--geno', label: 'Max missing genotype', type: 'number', default: 0.02 },
      { name: 'mind', flag: '--mind', label: 'Max missing per sample', type: 'number', default: 0.02 },
      { name: 'hwe', flag: '--hwe', label: 'HWE p-value', type: 'number', default: 1e-6 },
      { name: 'make-bed', flag: '--make-bed', label: 'Output BED format', type: 'boolean', default: true },
    ],
    slurm: { cpus: 4, memoryGB: 16, timeHours: 2 },
  },
  {
    id: 'regenie.step1',
    name: 'REGENIE Step 1',
    category: 'gwas',
    description: 'Whole-genome regression (null model fitting)',
    command: 'regenie',
    module: 'regenie/3.4',
    inputs: [
      { id: 'input', label: 'Genotypes', fileType: 'plink', required: true },
      { id: 'pheno', label: 'Phenotype', fileType: 'tsv', required: true },
      { id: 'covar', label: 'Covariates', fileType: 'tsv' },
    ],
    outputs: [{ id: 'output', label: 'Predictions (step 1)', fileType: 'any' }],
    params: [
      { name: 'step', flag: '--step', label: 'Step', type: 'select', options: ['1'], default: '1', required: true },
      { name: 'bt', flag: '--bt', label: 'Binary trait', type: 'boolean', default: false },
      { name: 'bsize', flag: '--bsize', label: 'Block size', type: 'number', default: 1000 },
      { name: 'lowmem', flag: '--lowmem', label: 'Low memory mode', type: 'boolean', default: false },
      { name: 'loocv', flag: '--loocv', label: 'LOOCV', type: 'boolean', default: false },
      { name: 'phenoColList', flag: '--phenoColList', label: 'Phenotype columns', type: 'string', columnRef: true, columnSourcePortId: 'pheno' },
      { name: 'covarColList', flag: '--covarColList', label: 'Covariate columns', type: 'string', columnRef: true, columnSourcePortId: 'covar' },
    ],
    slurm: { cpus: 16, memoryGB: 64, timeHours: 12 },
  },
  {
    id: 'regenie.step2',
    name: 'REGENIE Step 2',
    category: 'gwas',
    description: 'Association testing using step-1 predictions',
    command: 'regenie',
    module: 'regenie/3.4',
    inputs: [
      { id: 'input', label: 'Genotypes', fileType: 'bgen', required: true },
      { id: 'pheno', label: 'Phenotype', fileType: 'tsv', required: true },
      { id: 'covar', label: 'Covariates', fileType: 'tsv' },
      { id: 'pred', label: 'Step 1 predictions', fileType: 'any', required: true },
    ],
    outputs: [{ id: 'output', label: 'Association results', fileType: 'tsv' }],
    params: [
      { name: 'step', flag: '--step', label: 'Step', type: 'select', options: ['2'], default: '2', required: true },
      { name: 'bt', flag: '--bt', label: 'Binary trait', type: 'boolean', default: false },
      { name: 'firth', flag: '--firth', label: 'Firth correction', type: 'boolean', default: false },
      { name: 'spa', flag: '--spa', label: 'SPA test', type: 'boolean', default: false },
      { name: 'bsize', flag: '--bsize', label: 'Block size', type: 'number', default: 400 },
      { name: 'minMAC', flag: '--minMAC', label: 'Minimum MAC', type: 'number', default: 5 },
    ],
    slurm: { cpus: 16, memoryGB: 32, timeHours: 8 },
  },

  // ==================== Variant Calling ====================
  {
    id: 'bcftools.view',
    name: 'bcftools view',
    category: 'format',
    description: 'View, subset and filter VCF/BCF files',
    command: 'bcftools',
    module: 'bcftools/1.19',
    inputs: [{ id: 'input', label: 'VCF/BCF', fileType: 'vcf', required: true }],
    outputs: [{ id: 'output', label: 'Filtered VCF', fileType: 'vcf' }],
    params: [
      { name: 'regions', flag: '-r', label: 'Regions', type: 'string', placeholder: 'chr1:1000-2000' },
      { name: 'samples', flag: '-s', label: 'Samples', type: 'string' },
      { name: 'exclude', flag: '-e', label: 'Exclude filter', type: 'string' },
      { name: 'include', flag: '-i', label: 'Include filter', type: 'string' },
      { name: 'output-type', flag: '-O', label: 'Output type', type: 'select', options: ['v', 'z', 'b', 'u'], default: 'z' },
    ],
    slurm: { cpus: 2, memoryGB: 8, timeHours: 2 },
  },
  {
    id: 'bcftools.merge',
    name: 'bcftools merge',
    category: 'format',
    description: 'Merge multiple VCF/BCF files',
    command: 'bcftools',
    module: 'bcftools/1.19',
    inputs: [{ id: 'input', label: 'VCF files', fileType: 'vcf', required: true, multi: true }],
    outputs: [{ id: 'output', label: 'Merged VCF', fileType: 'vcf' }],
    params: [
      { name: 'merge', flag: '-m', label: 'Merge mode', type: 'select', options: ['none', 'snps', 'indels', 'both', 'all', 'id'], default: 'both' },
      { name: 'output-type', flag: '-O', label: 'Output type', type: 'select', options: ['v', 'z', 'b'], default: 'z' },
    ],
    slurm: { cpus: 4, memoryGB: 16, timeHours: 4 },
  },

  // ==================== Alignment ====================
  {
    id: 'samtools.sort',
    name: 'samtools sort',
    category: 'alignment',
    description: 'Sort BAM/SAM files by coordinate',
    command: 'samtools',
    module: 'samtools/1.19',
    inputs: [{ id: 'input', label: 'BAM/SAM', fileType: 'bam', required: true }],
    outputs: [{ id: 'output', label: 'Sorted BAM', fileType: 'bam' }],
    params: [
      { name: 'threads', flag: '-@', label: 'Threads', type: 'number', default: 4 },
      { name: 'memory', flag: '-m', label: 'Memory per thread', type: 'string', default: '2G' },
      { name: 'by-name', flag: '-n', label: 'Sort by name', type: 'boolean', default: false },
    ],
    slurm: { cpus: 4, memoryGB: 16, timeHours: 4 },
  },
  {
    id: 'samtools.index',
    name: 'samtools index',
    category: 'alignment',
    description: 'Index a coordinate-sorted BAM file',
    command: 'samtools',
    module: 'samtools/1.19',
    inputs: [{ id: 'input', label: 'Sorted BAM', fileType: 'bam', required: true }],
    outputs: [{ id: 'output', label: 'Indexed BAM', fileType: 'bam' }],
    params: [
      { name: 'threads', flag: '-@', label: 'Threads', type: 'number', default: 2 },
    ],
    slurm: { cpus: 2, memoryGB: 4, timeHours: 1 },
  },
  {
    id: 'bwa.mem',
    name: 'BWA-MEM',
    category: 'alignment',
    description: 'Align short reads to a reference genome',
    command: 'bwa',
    module: 'bwa/0.7.17',
    inputs: [
      { id: 'reference', label: 'Reference', fileType: 'fasta', required: true },
      { id: 'reads1', label: 'Reads R1', fileType: 'fastq', required: true },
      { id: 'reads2', label: 'Reads R2', fileType: 'fastq' },
    ],
    outputs: [{ id: 'output', label: 'Alignment', fileType: 'sam' }],
    params: [
      { name: 'threads', flag: '-t', label: 'Threads', type: 'number', default: 8 },
      { name: 'read-group', flag: '-R', label: 'Read group', type: 'string', placeholder: '@RG\\tID:sample\\tSM:sample' },
      { name: 'mark-short', flag: '-M', label: 'Mark short splits', type: 'boolean', default: true },
    ],
    slurm: { cpus: 16, memoryGB: 32, timeHours: 8 },
  },

  // ==================== QC ====================
  {
    id: 'fastqc',
    name: 'FastQC',
    category: 'qc',
    description: 'Quality control reports for FASTQ files',
    command: 'fastqc',
    module: 'fastqc/0.12.1',
    inputs: [{ id: 'input', label: 'FASTQ', fileType: 'fastq', required: true, multi: true }],
    outputs: [{ id: 'output', label: 'QC report', fileType: 'any' }],
    params: [
      { name: 'threads', flag: '-t', label: 'Threads', type: 'number', default: 4 },
      { name: 'nogroup', flag: '--nogroup', label: 'Disable grouping', type: 'boolean', default: false },
    ],
    slurm: { cpus: 4, memoryGB: 8, timeHours: 2 },
  },
  {
    id: 'multiqc',
    name: 'MultiQC',
    category: 'qc',
    description: 'Aggregate QC reports from multiple tools',
    command: 'multiqc',
    module: 'multiqc/1.21',
    inputs: [{ id: 'input', label: 'Reports', fileType: 'any', required: true, multi: true }],
    outputs: [{ id: 'output', label: 'Combined report', fileType: 'any' }],
    params: [
      { name: 'force', flag: '-f', label: 'Overwrite', type: 'boolean', default: true },
    ],
    slurm: { cpus: 2, memoryGB: 8, timeHours: 1 },
  },

  // ==================== Utility ====================
  {
    id: 'custom.shell',
    name: 'Custom Shell',
    category: 'custom',
    description: 'Run an arbitrary shell command',
    command: 'bash',
    inputs: [{ id: 'input', label: 'Input', fileType: 'any', multi: true }],
    outputs: [{ id: 'output', label: 'Output', fileType: 'any' }],
    params: [
      { name: 'script', label: 'Shell script', type: 'string', required: true, placeholder: 'cat "$INPUT"' },
    ],
    slurm: { cpus: 1, memoryGB: 4, timeHours: 1 },
  },
]

/** Quick lookup by tool id. */
export const TOOL_MAP: Record<string, ToolDef> = Object.fromEntries(
  TOOLS.map((t) => [t.id, t]),
)

export function getTool(id: string): ToolDef | undefined {
  return TOOL_MAP[id]
}

/** Group tools by category, preserving registry order within each group. */
export function getToolsByCategory(): Array<{ category: string; tools: ToolDef[] }> {
  const groups = new Map<string, ToolDef[]>()
  for (const tool of TOOLS) {
    if (!groups.has(tool.category)) groups.set(tool.category, [])
    groups.get(tool.category)!.push(tool)
  }
  return Array.from(groups.entries()).map(([category, tools]) => ({ category, tools }))
}

export const CATEGORY_LABELS: Record<string, string> = {
  'gwas': 'GWAS',
  'qc': 'Quality Control',
  'variant-calling': 'Variant Calling',
  'alignment': 'Alignment',
  'annotation': 'Annotation',
  'format': 'Format Conversion',
  'utility': 'Utilities',
  'custom': 'Custom',
}

/** Check whether two file types are compatible (for edge validation). */
export function areTypesCompatible(source: string, target: string): boolean {
  if (source === 'any' || target === 'any') return true
  if (source === target) return true
  // VCF and BCF are interchangeable
  if ((source === 'vcf' && target === 'bcf') || (source === 'bcf' && target === 'vcf')) return true
  // SAM/BAM/CRAM are interchangeable alignment formats
  const alignments = new Set(['bam', 'sam', 'cram'])
  if (alignments.has(source) && alignments.has(target)) return true
  // Tabular formats are loose compatible
  const tabular = new Set(['tsv', 'csv', 'txt'])
  if (tabular.has(source) && tabular.has(target)) return true
  return false
}
