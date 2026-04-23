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
    protocol: 'refGeneWithVer',
    operation: 'g',
    dbName: 'refGeneWithVer',
    builds: ['hg19', 'hg38'],
  },
  {
    id: 'rsid',
    label: 'rsID / dbSNP',
    description: 'Adds dbSNP rsIDs from chromosome, position, reference, and alternate allele.',
    protocol: 'avsnp151',
    operation: 'f',
    dbName: 'avsnp151',
    builds: ['hg19', 'hg38'],
  },
  {
    id: 'clinvar',
    label: 'ClinVar clinical significance',
    description: 'Adds ClinVar disease/clinical-significance annotations.',
    protocol: 'clinvar_20240917',
    operation: 'f',
    dbName: 'clinvar_20240917',
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
    protocol: 'dbnsfp47a',
    operation: 'f',
    dbName: 'dbnsfp47a',
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
    id: 'symbol',
    label: 'Gene symbols',
    description: 'Adds HGNC or equivalent gene symbols where available.',
    params: { symbol: true },
  },
  {
    id: 'canonical',
    label: 'Canonical transcripts',
    description: 'Flags canonical transcripts in the VEP output.',
    params: { canonical: true },
  },
  {
    id: 'mane',
    label: 'MANE transcripts',
    description: 'Flags MANE Select and MANE Plus Clinical transcripts where available.',
    params: { mane: true },
  },
  {
    id: 'hgvs',
    label: 'HGVS notation',
    description: 'Adds HGVSc and HGVSp notation. Requires FASTA in offline/cache workflows.',
    params: { hgvs: true },
  },
  {
    id: 'protein',
    label: 'Protein IDs',
    description: 'Adds Ensembl protein identifiers to transcript consequences.',
    params: { protein: true },
  },
  {
    id: 'biotype',
    label: 'Transcript biotype',
    description: 'Adds transcript or regulatory feature biotypes.',
    params: { biotype: true },
  },
  {
    id: 'variant_class',
    label: 'Variant class',
    description: 'Adds Sequence Ontology variant class terms such as SNV or insertion.',
    params: { variant_class: true },
  },
  {
    id: 'sift',
    label: 'SIFT',
    description: 'Adds SIFT predictions and scores where supported.',
    params: { sift: 'b' },
  },
  {
    id: 'polyphen',
    label: 'PolyPhen',
    description: 'Adds PolyPhen predictions and scores where supported.',
    params: { polyphen: 'b' },
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
  {
    id: 'pick',
    label: 'Pick one consequence',
    description: 'Keeps one representative consequence block per variant.',
    params: { pick: true },
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
