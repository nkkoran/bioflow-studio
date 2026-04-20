/**
 * Infer a bioinformatics FileType from a file path or extension.
 *
 * Used by the file-picker hand-off so that when a user clicks `sample.vcf.gz`
 * in the sidebar, the receiving FileNode gets `fileType: 'vcf'` without them
 * having to touch the dropdown.
 *
 * Returns 'any' as a safe fallback — downstream compatibility checks treat
 * 'any' as permissive (see areTypesCompatible in toolRegistry).
 */
export type InferredFileType =
  | 'any' | 'vcf' | 'bcf' | 'fastq' | 'fasta' | 'bam' | 'sam' | 'cram'
  | 'bed' | 'gff' | 'gtf' | 'plink' | 'bgen' | 'pgen'
  | 'tsv' | 'csv' | 'txt' | 'json' | 'yaml'

export function inferFileType(pathOrName: string): InferredFileType {
  const lower = pathOrName.toLowerCase()
  // Compound extensions first (order matters)
  if (lower.endsWith('.vcf.gz') || lower.endsWith('.vcf.bgz') || lower.endsWith('.vcf')) return 'vcf'
  if (lower.endsWith('.bcf')) return 'bcf'
  if (lower.endsWith('.fastq.gz') || lower.endsWith('.fq.gz') || lower.endsWith('.fastq') || lower.endsWith('.fq')) return 'fastq'
  if (lower.endsWith('.fasta') || lower.endsWith('.fa') || lower.endsWith('.fna') || lower.endsWith('.ffn')) return 'fasta'
  if (lower.endsWith('.bam')) return 'bam'
  if (lower.endsWith('.sam')) return 'sam'
  if (lower.endsWith('.cram')) return 'cram'
  if (lower.endsWith('.bed')) return 'bed'
  if (lower.endsWith('.gff') || lower.endsWith('.gff3')) return 'gff'
  if (lower.endsWith('.gtf')) return 'gtf'
  if (lower.endsWith('.bgen')) return 'bgen'
  if (lower.endsWith('.pgen')) return 'pgen'
  // PLINK fileset markers (.bed is ambiguous with BED intervals; plink uses it
  // alongside .bim/.fam — treat .bim/.fam explicitly and leave .bed as 'bed').
  if (lower.endsWith('.bim') || lower.endsWith('.fam')) return 'plink'
  if (
    lower.endsWith('.tsv') ||
    lower.endsWith('.pheno') ||
    lower.endsWith('.phen') ||
    lower.endsWith('.covar') ||
    lower.endsWith('.sample') ||
    lower.endsWith('.psam') ||
    lower.endsWith('.eigenvec') ||
    lower.endsWith('.profile')
  ) return 'tsv'
  if (lower.endsWith('.csv')) return 'csv'
  if (lower.endsWith('.txt') || lower.endsWith('.log')) return 'txt'
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml'
  return 'any'
}
