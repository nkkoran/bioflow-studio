const TITLE_CASE_WORDS = new Set(['id', 'iid', 'fid', 'maf', 'mac', 'hwe', 'vcf', 'bcf', 'glm', 'pca', 'qq', 'ukb'])

function humanizeToken(value: string): string {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase()
      if (TITLE_CASE_WORDS.has(lower)) return lower.toUpperCase()
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(' ')
}

function withCode(label: string, value: string): string {
  return label === value ? value : `${label} - ${value}`
}

export function optionDisplayLabel(value: string, context?: string): string {
  const key = context?.toLowerCase() ?? ''

  if (key === 'output-type') {
    const outputTypes: Record<string, string> = {
      v: 'VCF text (.vcf)',
      z: 'Compressed VCF (.vcf.gz)',
      b: 'BCF binary (.bcf)',
      u: 'Uncompressed BCF',
    }
    return withCode(outputTypes[value] ?? value, value)
  }

  if (key === 'chromid') {
    const chromosomeNames: Record<string, string> = {
      a: 'Keep input chromosome style',
      s: 'Short names (1, 2, X)',
      l: 'Long names (chr1, chr2, chrX)',
    }
    return withCode(chromosomeNames[value] ?? value, value)
  }

  if (key === 'sift' || key === 'polyphen') {
    const predictionModes: Record<string, string> = {
      b: 'Prediction and score',
      p: 'Prediction only',
      s: 'Score only',
    }
    return withCode(predictionModes[value] ?? value, value)
  }

  const known: Record<string, string> = {
    'array-if-list-is-typed': 'Slurm array for typed phenotype list',
    'single-job-loop': 'Single job loop',
    'linear-lm': 'Linear regression (lm)',
    'logistic-glm': 'Logistic regression (glm)',
    'poisson-glm': 'Poisson regression (glm)',
    'complete-case': 'Complete-case analysis',
    'pca-scatter': 'PCA scatter',
    'grouped-bar': 'Grouped bar',
    'hide-covar': 'Hide covariate rows',
    standard: 'Standard association test',
    'firth-fallback': 'Firth fallback',
    firth: 'Firth correction',
    'allow-no-covars': 'Allow no covariates',
    'omit-ref': 'Omit reference allele row',
    'no-firth': 'No Firth correction',
    'input-only': 'Input p-values are -log10',
    'output-only': 'Write -log10 p-values',
    'force-first': 'Keep first duplicate',
    'retain-mismatch': 'Retain mismatched duplicates',
    'exclude-mismatch': 'Exclude mismatched duplicates',
    'exclude-all': 'Exclude all duplicates',
    'just-acgt': 'A/C/G/T SNPs only',
  }
  if (known[value]) return withCode(known[value], value)
  if (/[-_]/.test(value)) return humanizeToken(value)
  return value
}
