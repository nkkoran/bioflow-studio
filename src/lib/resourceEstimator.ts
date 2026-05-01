import type { ToolDef, ToolNodeData } from '@/types/pipeline'
import type { LearnedResourceSummary } from '@/types/ssh'

export interface EstimateInput {
  tool: ToolDef
  nodeData: ToolNodeData
  inputSizes: Record<string, number>
  isArray: boolean
  arraySize?: number
  hasFilter: boolean
  partitionMaxMemGB?: number
  learned?: LearnedResourceSummary | null
}

export interface EstimateOutput {
  cpus: number
  memGB: number
  timeHours: number
  rationale: string[]
  confidence: 'low' | 'medium' | 'high'
  source: 'registry' | 'learned'
  learnedSampleCount?: number
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

function isLikelyUkbScale(input: EstimateInput, sizeGB: number): boolean {
  const joined = [
    ...Object.keys(input.inputSizes),
    ...Object.values(input.nodeData.paramValues ?? {}).map((value) => String(value ?? '')),
  ].join(' ')
  return /ukb|ukbiobank|biobank/i.test(joined)
    || sizeGB >= 1
    || (input.arraySize ?? 0) >= 10
}

function splitListCount(raw: unknown): number {
  if (Array.isArray(raw)) return raw.filter(Boolean).length
  if (typeof raw !== 'string') return 0
  return raw
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .length
}

function selectedPhenotypeCount(input: EstimateInput): number {
  const params = input.nodeData.paramValues ?? {}
  return Math.max(1, splitListCount(params['pheno-name']) || splitListCount(params.phenotypes))
}

function selectedCovariateCount(input: EstimateInput): number {
  return splitListCount(input.nodeData.paramValues?.['covar-name'])
}

function plinkGlmComplexity(input: EstimateInput): { label: string; multiplier: number } {
  const raw = String(input.nodeData.paramValues?.glm ?? '').toLowerCase()
  const flags = [
    raw,
    input.nodeData.paramValues?.['allow-no-covars'] === true ? 'allow-no-covars' : '',
    input.nodeData.paramValues?.['hide-covar'] === true ? 'hide-covar' : '',
  ].join(' ')
  if (flags.includes('firth-fallback')) return { label: 'firth-fallback', multiplier: 1.6 }
  if (/\bfirth\b/.test(flags)) return { label: 'firth', multiplier: 2.4 }
  return { label: raw.trim() || 'standard glm', multiplier: 1 }
}

function estimatePlinkGwasResources(input: EstimateInput, sizeGB: number): Pick<EstimateOutput, 'cpus' | 'memGB' | 'timeHours' | 'rationale'> {
  const arraySize = input.arraySize ?? 0
  const chromosomeSplit = input.isArray && arraySize >= 10 && arraySize <= 30
  const ukbScale = isLikelyUkbScale(input, sizeGB)
  const covariates = selectedCovariateCount(input)
  const phenotypes = selectedPhenotypeCount(input)
  const model = plinkGlmComplexity(input)
  const perTaskGB = Math.max(0.25, sizeGB || (chromosomeSplit ? 2 : 8))

  const cpus = perTaskGB >= 8 || model.multiplier > 1.5 ? 40 : 32
  const memGB = ukbScale
    ? Math.min(128, Math.max(80, roundUp(76 + perTaskGB * 5 + covariates * 1.5, 4)))
    : Math.min(96, Math.max(32, roundUp(32 + perTaskGB * 6 + covariates, 4)))

  const phenotypeMultiplier = input.tool.id === 'plink2.phewas'
    ? Math.min(4, Math.max(1, phenotypes / 25))
    : 1
  const rawHours = chromosomeSplit
    ? (4 + perTaskGB * 3 + covariates * 0.2) * model.multiplier * phenotypeMultiplier
    : (10 + perTaskGB * 4.5 + covariates * 0.3) * model.multiplier * phenotypeMultiplier
  const minHours = chromosomeSplit ? 8 : ukbScale ? 24 : 12
  const maxHours = chromosomeSplit ? 48 : ukbScale ? 84 : 48
  const timeHours = Math.min(maxHours, Math.max(minHours, roundUp(rawHours * 1.35, 1)))

  const rationale = [
    chromosomeSplit
      ? `Chromosome-split array detected (${arraySize} tasks), so walltime is estimated per chromosome from the largest split input.`
      : 'No chromosome split was detected, so walltime is estimated for a larger whole-genome task.',
    `${sizeGB > 0 ? sizeGB.toFixed(1) : 'unknown'} GB per-task genotype input, ${covariates} covariate${covariates === 1 ? '' : 's'}, ${phenotypes} phenotype${phenotypes === 1 ? '' : 's'}, ${model.label} model.`,
    `Formula uses a safety multiplier and caps PLINK2 GWAS walltime at ${maxHours} h for this run shape.`,
  ]
  return { cpus, memGB, timeHours, rationale }
}

function confidenceFor(inputSizes: Record<string, number>): EstimateOutput['confidence'] {
  const known = Object.values(inputSizes).filter((size) => size > 0).length
  if (known === 0) return 'low'
  return known >= 2 ? 'high' : 'medium'
}

export function estimateResources(input: EstimateInput): EstimateOutput {
  if (input.learned && input.learned.sampleCount >= 2 && input.tool.id !== 'plink2.assoc' && input.tool.id !== 'plink2.phewas') {
    const cpus = input.tool.slurm?.cpus ?? 2
    const memGB = Math.max(1, Math.ceil(input.learned.p90MemoryGB))
    const timeHours = Math.max(0.25, input.learned.p90RuntimeHours)
    return {
      cpus,
      memGB: input.partitionMaxMemGB ? Math.min(input.partitionMaxMemGB, memGB) : memGB,
      timeHours,
      rationale: [
        `Learned from ${input.learned.sampleCount} successful BioFlow jobs on this cluster.`,
        `P90 memory ${input.learned.p90MemoryGB} GB and P90 runtime ${input.learned.p90RuntimeHours} h were used.`,
      ],
      confidence: input.learned.sampleCount >= 4 ? 'high' : 'medium',
      source: 'learned',
      learnedSampleCount: input.learned.sampleCount,
    }
  }

  const id = input.tool.id
  const sizeGB = largestInputGB(input.inputSizes)
  const rationale: string[] = []
  let cpus = input.tool.slurm?.cpus ?? 2
  let memGB = input.tool.slurm?.memoryGB ?? 8
  let timeHours = input.tool.slurm?.timeHours ?? 1

  if (id === 'plink2.assoc' || id === 'plink2.phewas' || id === 'regenie.step2') {
    if (id === 'plink2.assoc' || id === 'plink2.phewas') {
      const plinkEstimate = estimatePlinkGwasResources(input, sizeGB)
      cpus = plinkEstimate.cpus
      memGB = plinkEstimate.memGB
      timeHours = plinkEstimate.timeHours
      rationale.push(...plinkEstimate.rationale)
      if (input.hasFilter) {
        rationale.push('Filters are present, but GWAS resources are not reduced automatically because PLINK runtime still depends on samples, variants, covariates, and phenotype model.')
      }
    } else {
      cpus = 16
      memGB = Math.min(128, roundUp(Math.max(64, 32 + sizeGB * 8), 8))
      timeHours = 8
      rationale.push(`${sizeGB > 0 ? sizeGB.toFixed(1) : 'unknown'} GB genotype input drives REGENIE step 2 memory estimate.`)
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
    source: 'registry',
  }
}
