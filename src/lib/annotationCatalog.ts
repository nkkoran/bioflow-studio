export interface AnnovarFeature {
  id: string
  label: string
  description: string
  protocol: string
  operation: 'g' | 'r' | 'f'
  dbName: string
  builds: Array<'hg19' | 'hg38'>
}

export interface VepFeature {
  id: string
  label: string
  description: string
  params: Record<string, unknown>
}

export const ANNOVAR_FEATURES: AnnovarFeature[] = [
  {
    id: 'gene',
    label: 'Gene consequence',
    description: 'Adds affected gene, exonic function, amino-acid change, and nearby gene context.',
    protocol: 'refGene',
    operation: 'g',
    dbName: 'refGene',
    builds: ['hg19', 'hg38'],
  },
  {
    id: 'rsid',
    label: 'rsID / dbSNP',
    description: 'Adds dbSNP rsIDs from chromosome, position, reference, and alternate allele.',
    protocol: 'avsnp150',
    operation: 'f',
    dbName: 'avsnp150',
    builds: ['hg19', 'hg38'],
  },
  {
    id: 'clinvar',
    label: 'ClinVar clinical significance',
    description: 'Adds ClinVar disease/clinical-significance annotations.',
    protocol: 'clinvar_20220320',
    operation: 'f',
    dbName: 'clinvar_20220320',
    builds: ['hg19', 'hg38'],
  },
  {
    id: 'gnomad_exome',
    label: 'gnomAD exome frequencies',
    description: 'Adds population allele frequencies from gnomAD exomes.',
    protocol: 'gnomad211_exome',
    operation: 'f',
    dbName: 'gnomad211_exome',
    builds: ['hg19', 'hg38'],
  },
  {
    id: 'dbnsfp',
    label: 'Predicted deleteriousness',
    description: 'Adds dbNSFP functional prediction scores for coding variants.',
    protocol: 'dbnsfp42a',
    operation: 'f',
    dbName: 'dbnsfp42a',
    builds: ['hg19', 'hg38'],
  },
]

export const VEP_FEATURES: VepFeature[] = [
  {
    id: 'consequence',
    label: 'Variant consequences',
    description: 'Adds genes, transcripts, Sequence Ontology consequences, and canonical consequence fields.',
    params: { everything: true },
  },
  {
    id: 'rsid',
    label: 'Known variant IDs',
    description: 'Adds known variant identifiers such as dbSNP rsIDs when available in the cache.',
    params: { check_existing: true },
  },
  {
    id: 'frequencies',
    label: 'Population frequencies',
    description: 'Adds allele frequencies available through the VEP cache, including gnomAD where present.',
    params: { af_gnomad: true },
  },
  {
    id: 'nearest',
    label: 'Nearest gene',
    description: 'Adds nearest gene context for intergenic variants.',
    params: { nearest: 'symbol' },
  },
]

export function annovarParamsForFeatures(featureIds: string[]): { protocol: string; operation: string } {
  const selected = ANNOVAR_FEATURES.filter((feature) => featureIds.includes(feature.id))
  return {
    protocol: selected.map((feature) => feature.protocol).join(','),
    operation: selected.map((feature) => feature.operation).join(','),
  }
}

export function annovarDbNames(featureIds: string[]): string[] {
  return ANNOVAR_FEATURES.filter((feature) => featureIds.includes(feature.id)).map((feature) => feature.dbName)
}
