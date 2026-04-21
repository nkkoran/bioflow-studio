const ANNOVAR_DB_SIZES_GB: Record<string, number> = {
  refGene: 0.2,
  ensGene: 0.3,
  knownGene: 0.2,
  avsnp150: 0.3,
  clinvar_20240917: 0.7,
  dbnsfp47a: 17.5,
  gnomad41_genome: 24,
  gnomad211_exome: 14,
  ljb26_all: 5.5,
}

const BUILD_ALIAS: Record<string, string[]> = {
  hg38: ['hg38'],
  hg19: ['hg19'],
}

export function annovarEstimatedSizeGB(database: string): number {
  return ANNOVAR_DB_SIZES_GB[database] ?? 1
}

export function annovarExpectedFiles(buildver: string, database: string): string[] {
  const builds = BUILD_ALIAS[buildver] ?? [buildver]
  return builds.flatMap((build) => [
    `${build}_${database}.txt`,
    `${build}_${database}.txt.idx`,
    `${build}_${database}.txt.gz`,
    `${build}_${database}.txt.gz.tbi`,
  ])
}
