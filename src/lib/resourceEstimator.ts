import type { ToolDef, ToolNodeData } from '@/types/pipeline'

export interface EstimateInput {
  tool: ToolDef
  nodeData: ToolNodeData
  inputSizes: Record<string, number>
  isArray: boolean
  arraySize?: number
  hasFilter: boolean
  partitionMaxMemGB?: number
}

export interface EstimateOutput {
  cpus: number
  memGB: number
  timeHours: number
  rationale: string[]
  confidence: 'low' | 'medium' | 'high'
}

function roundUp(value: number, step: number): number {
  return Math.max(step, Math.ceil(value / step) * step)
}

function gb(bytes: number): number {
  return bytes / 1_000_000_000
}

function largestInputGB(inputSizes: Record<string, number>): number {
  return Math.max(0, ...Object.values(inputSizes).map(gb))
}

function confidenceFor(inputSizes: Record<string, number>): EstimateOutput['confidence'] {
  const known = Object.values(inputSizes).filter((size) => size > 0).length
  if (known === 0) return 'low'
  return known >= 2 ? 'high' : 'medium'
}

export function estimateResources(input: EstimateInput): EstimateOutput {
  const id = input.tool.id
  const sizeGB = largestInputGB(input.inputSizes)
  const rationale: string[] = []
  let cpus = input.tool.slurm?.cpus ?? 2
  let memGB = input.tool.slurm?.memoryGB ?? 8
  let timeHours = input.tool.slurm?.timeHours ?? 1

  if (id === 'plink2.assoc' || id === 'regenie.step2') {
    cpus = id === 'regenie.step2' ? 16 : 8
    memGB = Math.min(64, roundUp(Math.max(16, 16 * Math.max(1, sizeGB)), 4))
    timeHours = id === 'regenie.step2' ? 8 : 2
    rationale.push(`${sizeGB > 0 ? sizeGB.toFixed(1) : 'unknown'} GB genotype input drives memory estimate.`)
    if (input.hasFilter) {
      memGB = Math.max(8, roundUp(memGB / 2, 4))
      timeHours = Math.max(1, timeHours / 2)
      rationale.push('Filter parameters are set, so memory and time are reduced.')
    }
    if (input.isArray) rationale.push('Array jobs use per-split input size rather than total input size.')
  } else if (id === 'regenie.step1') {
    cpus = 16
    memGB = Math.min(128, roundUp(Math.max(64, 32 + sizeGB * 8), 8))
    timeHours = 12
    rationale.push('REGENIE step 1 keeps a conservative null-model baseline.')
  } else if (id.startsWith('bcftools.')) {
    cpus = 4
    memGB = Math.min(64, roundUp(Math.max(8, 8 + sizeGB * 2), 4))
    timeHours = Math.max(1, Math.min(8, roundUp(Math.max(1, sizeGB / 2), 0.5)))
    rationale.push('VCF/BCF size scales bcftools memory and time.')
  } else if (id.startsWith('samtools.')) {
    cpus = 4
    memGB = Math.min(32, roundUp(Math.max(8, 4 + sizeGB), 4))
    timeHours = Math.max(1, Math.min(8, roundUp(Math.max(1, sizeGB / 3), 0.5)))
    rationale.push('BAM/CRAM input size scales samtools time and a modest memory baseline.')
  } else if (id.startsWith('bwa.')) {
    cpus = 8
    memGB = Math.min(64, roundUp(Math.max(16, 8 + sizeGB), 4))
    timeHours = Math.max(2, Math.min(24, roundUp(Math.max(2, sizeGB / 2), 1)))
    rationale.push('Read alignment benefits from more CPUs and memory proportional to FASTQ size.')
  } else if (id === 'fastqc') {
    cpus = 2
    memGB = 4
    timeHours = Math.max(0.5, Math.min(4, roundUp(Math.max(0.5, sizeGB / 4), 0.5)))
    rationale.push('FastQC uses a small fixed memory baseline and time from input size.')
  } else if (id === 'multiqc') {
    cpus = 1
    memGB = 4
    timeHours = 0.5
    rationale.push('MultiQC aggregates reports and usually needs only a small allocation.')
  } else if (id === 'plink2.clump') {
    cpus = 4
    memGB = 16
    timeHours = 1
    rationale.push('Clumping uses a fixed moderate PLINK2 allocation.')
  } else if (id === 'plink2.score') {
    cpus = 2
    memGB = Math.min(64, roundUp(Math.max(8, 8 * Math.max(1, sizeGB)), 4))
    timeHours = Math.max(0.5, Math.min(4, roundUp(Math.max(0.5, sizeGB / 4), 0.5)))
    rationale.push('GRS scoring scales mostly with genotype input size.')
  } else if (id === 'annovar.table_annovar' || id === 'vep') {
    const fork = Number(input.nodeData.paramValues?.fork)
    cpus = id === 'vep' && Number.isFinite(fork) && fork > 0 ? Math.min(32, Math.ceil(fork)) : 4
    memGB = 16
    timeHours = 2
    rationale.push(id === 'vep' ? 'VEP uses --fork to choose CPU count.' : 'Annotation tools use a capped database lookup baseline.')
  } else if (input.tool.command === 'bash') {
    cpus = input.tool.slurm?.cpus ?? 1
    memGB = input.tool.slurm?.memoryGB ?? 4
    timeHours = input.tool.slurm?.timeHours ?? 1
    rationale.push('Custom shell keeps the registry defaults.')
  } else {
    rationale.push('Using registry defaults because no tool-specific heuristic exists.')
  }

  let confidence = confidenceFor(input.inputSizes)
  const cap = input.partitionMaxMemGB
  if (cap && memGB > cap) {
    memGB = cap
    confidence = 'low'
    rationale.push(`Memory estimate was capped at the configured partition limit (${cap} GB).`)
  }

  return {
    cpus,
    memGB,
    timeHours,
    rationale,
    confidence,
  }
}
