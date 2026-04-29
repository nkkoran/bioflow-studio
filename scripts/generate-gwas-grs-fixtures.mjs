import { mkdir, writeFile, cp } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const fixtureDir = join(root, 'test', 'fixtures', 'gwas-grs')
const incompleteDir = join(fixtureDir, 'incomplete-plink')
const seed = 20260423

function rngFactory(initialSeed) {
  let state = initialSeed >>> 0
  return () => {
    state = (1664525 * state + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const rng = rngFactory(seed)

function randomBetween(min, max, digits = 4) {
  const value = min + (max - min) * rng()
  return Number(value.toFixed(digits))
}

function choice(values) {
  return values[Math.floor(rng() * values.length)]
}

function tsv(headers, rows) {
  return `${headers.join('\t')}\n${rows.map((row) => row.map((value) => String(value)).join('\t')).join('\n')}\n`
}

function makeBedBytes(sampleCount, variantCount) {
  const bytesPerVariant = Math.ceil(sampleCount / 4)
  const out = Buffer.alloc(3 + bytesPerVariant * variantCount)
  out[0] = 0x6c
  out[1] = 0x1b
  out[2] = 0x01
  let offset = 3
  for (let variant = 0; variant < variantCount; variant += 1) {
    for (let byteIndex = 0; byteIndex < bytesPerVariant; byteIndex += 1) {
      let byte = 0
      for (let sampleOffset = 0; sampleOffset < 4; sampleOffset += 1) {
        const sampleIndex = byteIndex * 4 + sampleOffset
        const genotype = sampleIndex < sampleCount ? Math.floor(rng() * 4) : 0
        byte |= genotype << (sampleOffset * 2)
      }
      out[offset] = byte
      offset += 1
    }
  }
  return out
}

const samples = [
  { fid: 'F001', iid: 'S001', ethnicity: 'EUR', sex: 1 },
  { fid: 'F002', iid: 'S002', ethnicity: 'EUR', sex: 2 },
  { fid: 'F003', iid: 'S003', ethnicity: 'EUR', sex: 1 },
  { fid: 'F004', iid: 'S004', ethnicity: 'EUR', sex: 2 },
  { fid: 'F005', iid: 'S005', ethnicity: 'AFR', sex: 1 },
  { fid: 'F006', iid: 'S006', ethnicity: 'AFR', sex: 2 },
  { fid: 'F007', iid: 'S007', ethnicity: 'EAS', sex: 1 },
  { fid: 'F008', iid: 'S008', ethnicity: 'EAS', sex: 2 },
].map((sample, index) => ({
  ...sample,
  age: 38 + index * 3,
  trait: randomBetween(-1.5, 2.2, 3),
  pc1: randomBetween(-0.12, 0.12, 5),
  pc2: randomBetween(-0.09, 0.09, 5),
}))

const variants = Array.from({ length: 12 }, (_, index) => {
  const id = `rs${1000 + index + 1}`
  const beta = randomBetween(-0.45, 0.58, 4)
  const p = index === 1 ? 2.4e-9 : index === 6 ? 4.8e-8 : Number((10 ** -(2 + rng() * 4)).toPrecision(5))
  return {
    chr: index < 6 ? 1 : 2,
    id,
    pos: 100000 + index * 1300,
    ref: choice(['A', 'C', 'G', 'T']),
    alt: choice(['A', 'C', 'G', 'T']),
    beta,
    or: Number(Math.exp(beta).toFixed(5)),
    p,
  }
})

async function main() {
  await mkdir(fixtureDir, { recursive: true })
  await mkdir(incompleteDir, { recursive: true })

  const metadataRows = samples.map((sample) => [
    sample.fid,
    sample.iid,
    sample.ethnicity,
    sample.trait,
    sample.age,
    sample.sex,
    sample.pc1,
    sample.pc2,
  ])
  const eurRows = metadataRows.filter((row) => row[2] === 'EUR')

  await writeFile(join(fixtureDir, 'metadata.tsv'), tsv(['FID', 'IID', 'ethnicity', 'trait', 'age', 'sex', 'PC1', 'PC2'], metadataRows))
  await writeFile(join(fixtureDir, 'phenotypes.tsv'), tsv(['FID', 'IID', 'trait'], samples.map((sample) => [sample.fid, sample.iid, sample.trait])))
  await writeFile(join(fixtureDir, 'covariates.tsv'), tsv(['FID', 'IID', 'age', 'sex', 'PC1', 'PC2'], samples.map((sample) => [sample.fid, sample.iid, sample.age, sample.sex, sample.pc1, sample.pc2])))
  await writeFile(join(fixtureDir, 'expected_eur_keep.txt'), eurRows.map((row) => `${row[0]}\t${row[1]}`).join('\n') + '\n')
  await writeFile(join(fixtureDir, 'expected_eur_pheno.tsv'), tsv(['FID', 'IID', 'ethnicity', 'trait', 'age', 'sex', 'PC1', 'PC2'], eurRows))

  const glmRows = variants.map((variant) => [
    variant.id,
    variant.alt,
    'ADD',
    8,
    variant.beta,
    variant.or,
    variant.p,
  ])
  const significant = variants.filter((variant) => variant.p <= 5e-8)
  await writeFile(join(fixtureDir, 'gwas.glm.linear.tsv'), tsv(['ID', 'A1', 'TEST', 'OBS_CT', 'BETA', 'OR', 'P'], glmRows))
  await writeFile(join(fixtureDir, 'gwas.pval_5e-8.tsv'), tsv(['ID', 'A1', 'TEST', 'OBS_CT', 'BETA', 'OR', 'P'], significant.map((variant) => [variant.id, variant.alt, 'ADD', 8, variant.beta, variant.or, variant.p])))
  await writeFile(
    join(fixtureDir, 'clump.clumped.tsv'),
    tsv(['CHR', 'F', 'SNP', 'BP', 'P', 'TOTAL'], significant.map((variant, index) => [variant.chr, index + 1, variant.id, variant.pos, variant.p, 1])),
  )
  await writeFile(join(fixtureDir, 'clump.leads.txt'), `${significant.map((variant) => variant.id).join('\n')}\n`)
  await writeFile(join(fixtureDir, 'score_file.tsv'), tsv(['ID', 'A1', 'SCORE'], significant.map((variant) => [variant.id, variant.alt, variant.beta])))
  await writeFile(join(fixtureDir, 'grs.profile.tsv'), tsv(['FID', 'IID', 'SCORE1_SUM'], samples.filter((sample) => sample.ethnicity === 'EUR').map((sample) => [sample.fid, sample.iid, randomBetween(-1.2, 2.1, 5)])))

  await writeFile(join(fixtureDir, 'bad_missing_iid.tsv'), tsv(['FID', 'ethnicity', 'trait', 'age', 'sex'], samples.map((sample) => [sample.fid, sample.ethnicity, sample.trait, sample.age, sample.sex])))
  await writeFile(join(fixtureDir, 'bad_wrong_p_column.tsv'), tsv(['SNP', 'A1', 'BETA', 'PVALUE_WRONG'], variants.map((variant) => [variant.id, variant.alt, variant.beta, variant.p])))
  await writeFile(join(fixtureDir, 'bad_zero_overlap_pheno.tsv'), tsv(['FID', 'IID', 'trait'], Array.from({ length: 4 }, (_, index) => [`ZX${index + 1}`, `ZX${index + 1}`, randomBetween(-1, 1, 4)])))
  await writeFile(join(fixtureDir, 'bad_score_missing_allele.tsv'), tsv(['ID', 'SCORE'], significant.map((variant) => [variant.id, variant.beta])))

  const fam = samples.map((sample) => `${sample.fid}\t${sample.iid}\t0\t0\t${sample.sex}\t${sample.trait}`).join('\n') + '\n'
  const bim = variants.map((variant, index) => `${variant.chr}\t${variant.id}\t0\t${variant.pos}\t${['A', 'C', 'G', 'T'][index % 4]}\t${['T', 'G', 'C', 'A'][index % 4]}`).join('\n') + '\n'
  const bed = makeBedBytes(samples.length, variants.length)
  await writeFile(join(fixtureDir, 'cohort.fam'), fam)
  await writeFile(join(fixtureDir, 'cohort.bim'), bim)
  await writeFile(join(fixtureDir, 'cohort.bed'), bed)

  await cp(join(fixtureDir, 'cohort.bed'), join(incompleteDir, 'cohort.bed'))
  await cp(join(fixtureDir, 'cohort.bim'), join(incompleteDir, 'cohort.bim'))

  console.log(`Generated fixtures in ${fixtureDir} with seed ${seed}`)
}

await main()
