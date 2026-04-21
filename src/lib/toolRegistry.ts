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
      { id: 'input', label: 'Genotypes', description: 'PLINK file set to test, usually a .pgen/.pvar/.psam or bed/bim/fam prefix.', fileType: 'plink', required: true },
      { id: 'pheno', label: 'Phenotype', description: 'Tabular phenotype file with one row per sample and the trait column named in the parameters.', fileType: 'tsv' },
      { id: 'covar', label: 'Covariates', description: 'Optional tabular covariates such as age, sex, or PCs; choose columns in the parameters.', fileType: 'tsv' },
    ],
    outputs: [
      { id: 'output', label: 'Results', description: 'Association result table from PLINK2 --glm, suitable for clumping or downstream review.', fileType: 'tsv' },
    ],
    params: [
      { name: 'glm', flag: '--glm', label: 'GLM output', type: 'select', options: ['hide-covar', 'firth-fallback', 'allow-no-covars', 'omit-ref', 'none'], default: 'hide-covar', required: true },
      { name: 'maf', flag: '--maf', label: 'Min MAF', type: 'number', default: 0.01, min: 0, max: 0.5, step: 0.001 },
      { name: 'geno', flag: '--geno', label: 'Max missing genotype rate', type: 'number', default: 0.05, min: 0, max: 1, step: 0.01 },
      { name: 'hwe', flag: '--hwe', label: 'HWE p-value', type: 'number', default: 1e-6, step: 1e-6 },
      { name: 'pheno-name', flag: '--pheno-name', label: 'Phenotype column', type: 'string', columnRef: true, columnSourcePortId: 'pheno' },
      { name: 'covar-name', flag: '--covar-name', label: 'Covariate columns', type: 'string', placeholder: 'age,sex,PC1-PC10', columnRef: true, columnSourcePortId: 'covar', columnMulti: true },
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
    inputs: [{ id: 'input', label: 'Genotypes', description: 'Raw PLINK genotype file set to filter by missingness, MAF, HWE, and sample QC.', fileType: 'plink', required: true }],
    outputs: [{ id: 'output', label: 'Filtered genotypes', description: 'Cleaned PLINK genotype file set to use in association testing or scoring.', fileType: 'plink' }],
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
    id: 'plink2.clump',
    name: 'PLINK2 Clump',
    category: 'gwas',
    description: 'LD clumping from GWAS summary statistics',
    command: 'plink2',
    module: 'plink/2.00a3',
    inputs: [
      { id: 'input', label: 'Genotypes', description: 'Reference genotype file set used to estimate LD between candidate variants.', fileType: 'plink', required: true },
      { id: 'clump', label: 'Summary stats', description: 'GWAS summary statistics table containing variant IDs and p-values for clumping.', fileType: 'tsv', required: true, arrayable: false },
    ],
    outputs: [
      { id: 'clumped', label: 'Clumped variants', description: 'Clumping report listing the lead SNPs retained after LD pruning.', fileType: 'tsv' },
      { id: 'ranges', label: 'Extract ranges', description: 'Variant/range list for the independent clumped SNPs; connect this to PLINK2 Score extract ranges.', fileType: 'bed' },
    ],
    params: [
      { name: 'clump-p1', flag: '--clump-p1', label: 'Primary p-value', type: 'number', default: 5e-8, step: 1e-8 },
      { name: 'clump-p2', flag: '--clump-p2', label: 'Secondary p-value', type: 'number', default: 1e-4, step: 1e-5 },
      { name: 'clump-r2', flag: '--clump-r2', label: 'LD r2 threshold', type: 'number', default: 0.1, min: 0, max: 1, step: 0.01 },
      { name: 'clump-kb', flag: '--clump-kb', label: 'Window (kb)', type: 'number', default: 250, min: 1 },
      { name: 'clump-snp-field', flag: '--clump-snp-field', label: 'Variant ID column', type: 'string', default: 'ID', columnRef: true, columnSourcePortId: 'clump' },
      { name: 'clump-field', flag: '--clump-field', label: 'P-value column', type: 'string', default: 'P', columnRef: true, columnSourcePortId: 'clump' },
    ],
    slurm: { cpus: 4, memoryGB: 16, timeHours: 2 },
  },
  {
    id: 'plink2.score',
    name: 'PLINK2 Score / GRS',
    category: 'gwas',
    description: 'Genetic risk score calculation with optional clumped variant extraction',
    command: 'plink2',
    module: 'plink/2.00a3',
    inputs: [
      { id: 'input', label: 'Genotypes', description: 'Target sample genotype file set that will receive genetic risk scores.', fileType: 'plink', required: true },
      { id: 'score', label: 'Score file', description: 'Allele/weight table for scoring, usually built from GWAS summary statistics.', fileType: 'tsv', required: true, arrayable: false },
      { id: 'sumstats', label: 'Summary stats', description: 'Optional source summary statistics kept beside the score run for provenance.', fileType: 'tsv', arrayable: false },
      { id: 'extract', label: 'Extract ranges', description: 'Optional list of SNPs/ranges to keep before scoring. The PLINK2 Clump ranges output is meant to connect here.', fileType: 'bed', arrayable: false },
    ],
    outputs: [
      { id: 'profile', label: 'Profile', description: 'Per-sample genetic risk score table produced by PLINK2 --score.', fileType: 'tsv' },
    ],
    params: [
      { name: 'score-col-nums', flag: '--score-col-nums', label: 'Score columns', type: 'string', placeholder: '3 4 5' },
      { name: 'header', flag: 'header', label: 'Score file has header', type: 'boolean', default: true },
      { name: 'center', flag: 'center', label: 'Center scores', type: 'boolean', default: false },
      { name: 'variance-standardize', flag: 'variance-standardize', label: 'Variance standardize', type: 'boolean', default: false },
      { name: 'no-mean-imputation', flag: 'no-mean-imputation', label: 'Disable mean imputation', type: 'boolean', default: false },
    ],
    slurm: { cpus: 2, memoryGB: 8, timeHours: 1 },
  },
  {
    id: 'regenie.step1',
    name: 'REGENIE Step 1',
    category: 'gwas',
    description: 'Whole-genome regression (null model fitting)',
    command: 'regenie',
    module: 'regenie/3.4',
    inputs: [
      { id: 'input', label: 'Genotypes', description: 'PLINK genotype file set used to fit the whole-genome null model.', fileType: 'plink', required: true },
      { id: 'pheno', label: 'Phenotype', description: 'Phenotype table with sample IDs and one or more traits for model fitting.', fileType: 'tsv', required: true },
      { id: 'covar', label: 'Covariates', description: 'Optional covariate table with columns such as age, sex, batch, and PCs.', fileType: 'tsv' },
    ],
    outputs: [{ id: 'output', label: 'Predictions (step 1)', description: 'REGENIE prediction files consumed by REGENIE Step 2.', fileType: 'any' }],
    params: [
      { name: 'step', flag: '--step', label: 'Step', type: 'select', options: ['1'], default: '1', required: true },
      { name: 'bt', flag: '--bt', label: 'Binary trait', type: 'boolean', default: false },
      { name: 'bsize', flag: '--bsize', label: 'Block size', type: 'number', default: 1000 },
      { name: 'lowmem', flag: '--lowmem', label: 'Low memory mode', type: 'boolean', default: false },
      { name: 'loocv', flag: '--loocv', label: 'LOOCV', type: 'boolean', default: false },
      { name: 'phenoColList', flag: '--phenoColList', label: 'Phenotype columns', type: 'string', columnRef: true, columnSourcePortId: 'pheno', columnMulti: true },
      { name: 'covarColList', flag: '--covarColList', label: 'Covariate columns', type: 'string', columnRef: true, columnSourcePortId: 'covar', columnMulti: true },
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
      { id: 'input', label: 'Genotypes', description: 'Imputed or target genotype data to association-test, typically BGEN.', fileType: 'bgen', required: true },
      { id: 'pheno', label: 'Phenotype', description: 'Same phenotype table used for the association test traits.', fileType: 'tsv', required: true },
      { id: 'covar', label: 'Covariates', description: 'Optional covariates aligned to the phenotype and sample IDs.', fileType: 'tsv' },
      { id: 'pred', label: 'Step 1 predictions', description: 'Prediction files produced by REGENIE Step 1.', fileType: 'any', required: true },
    ],
    outputs: [{ id: 'output', label: 'Association results', description: 'Per-variant association results from REGENIE Step 2.', fileType: 'tsv' }],
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
    inputs: [{ id: 'input', label: 'VCF/BCF', description: 'Variant file to view, subset, or filter.', fileType: 'vcf', required: true }],
    outputs: [{ id: 'output', label: 'Filtered VCF', description: 'Subset or filtered VCF/BCF written by bcftools view.', fileType: 'vcf' }],
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
    inputs: [{ id: 'input', label: 'VCF files', description: 'Two or more VCF/BCF files to merge into one cohort or variant set.', fileType: 'vcf', required: true, multi: true }],
    outputs: [{ id: 'output', label: 'Merged VCF', description: 'Combined VCF/BCF containing records from the connected inputs.', fileType: 'vcf' }],
    params: [
      { name: 'merge', flag: '-m', label: 'Merge mode', type: 'select', options: ['none', 'snps', 'indels', 'both', 'all', 'id'], default: 'both' },
      { name: 'output-type', flag: '-O', label: 'Output type', type: 'select', options: ['v', 'z', 'b'], default: 'z' },
    ],
    slurm: { cpus: 4, memoryGB: 16, timeHours: 4 },
  },

  // ==================== Annotation ====================
  {
    id: 'annovar.table_annovar',
    name: 'ANNOVAR table_annovar',
    category: 'annotation',
    description: 'Annotate variants with ANNOVAR protocol databases',
    command: 'table_annovar.pl',
    requiresDatabase: { name: 'ANNOVAR humandb', guideKey: 'annovar-humandb' },
    inputs: [
      { id: 'input', label: 'Variants', description: 'VCF or ANNOVAR input file containing variants to annotate.', fileType: 'vcf', required: true },
    ],
    outputs: [
      { id: 'output', label: 'Annotated variants', description: 'ANNOVAR multianno table with requested functional and frequency annotations.', fileType: 'tsv' },
    ],
    params: [
      { name: 'toolPath', label: 'ANNOVAR scripts folder', type: 'string', placeholder: '~/bioflow/tools/annovar' },
      { name: 'annotationDbPath', flag: '--humandb', label: 'humandb folder', type: 'string', placeholder: '/project/.../annovar/humandb' },
      { name: 'annotationFeatures', label: 'Annotation features', type: 'string', default: 'gene,rsid' },
      { name: 'buildver', flag: '--buildver', label: 'Genome build', type: 'select', options: ['hg19', 'hg38'], default: 'hg38' },
      { name: 'protocol', flag: '--protocol', label: 'Protocols', type: 'string', default: 'refGene,avsnp150' },
      { name: 'operation', flag: '--operation', label: 'Operations', type: 'string', default: 'g,f' },
      { name: 'remove', flag: '--remove', label: 'Remove intermediate files', type: 'boolean', default: true },
      { name: 'nastring', flag: '--nastring', label: 'Missing value', type: 'string', default: '.' },
      { name: 'vcfinput', flag: '--vcfinput', label: 'VCF input', type: 'boolean', default: true },
    ],
    slurm: { cpus: 4, memoryGB: 16, timeHours: 2 },
  },
  {
    id: 'vep',
    name: 'VEP',
    category: 'annotation',
    description: 'Annotate variants with Ensembl Variant Effect Predictor',
    command: 'vep',
    requiresDatabase: { name: 'VEP cache', guideKey: 'vep-cache' },
    inputs: [
      { id: 'input', label: 'Variants', description: 'VCF containing variants to annotate with Ensembl consequence data.', fileType: 'vcf', required: true },
    ],
    outputs: [
      { id: 'output', label: 'Annotated variants', description: 'VEP annotation output for each variant, usually VCF or tabular depending on parameters.', fileType: 'vcf' },
    ],
    params: [
      { name: 'toolPath', label: 'VEP executable or folder', type: 'string', placeholder: 'vep or ~/bioflow/tools/ensembl-vep/vep' },
      { name: 'annotationDbPath', flag: '--dir_cache', label: 'Cache folder', type: 'string', placeholder: '/project/.../vep/cache' },
      { name: 'annotationFeatures', label: 'Annotation features', type: 'string', default: 'consequence,rsid' },
      { name: 'assembly', flag: '--assembly', label: 'Assembly', type: 'select', options: ['GRCh37', 'GRCh38'], default: 'GRCh38' },
      { name: 'cache', flag: '--cache', label: 'Use cache', type: 'boolean', default: true },
      { name: 'offline', flag: '--offline', label: 'Offline mode', type: 'boolean', default: true },
      { name: 'everything', flag: '--everything', label: 'Everything preset', type: 'boolean', default: true },
      { name: 'check_existing', flag: '--check_existing', label: 'Known IDs', type: 'boolean', default: true },
      { name: 'af_gnomad', flag: '--af_gnomad', label: 'gnomAD frequencies', type: 'boolean', default: false },
      { name: 'nearest', flag: '--nearest', label: 'Nearest gene', type: 'string' },
      { name: 'plugin', flag: '--plugin', label: 'Plugin', type: 'string', placeholder: 'LoF,loftee_path:/path/to/loftee' },
      { name: 'fork', flag: '--fork', label: 'Forks', type: 'number', default: 4, min: 1 },
    ],
    slurm: { cpus: 4, memoryGB: 16, timeHours: 2 },
  },

  // ==================== Alignment ====================
  {
    id: 'samtools.sort',
    name: 'samtools sort',
    category: 'alignment',
    description: 'Sort BAM/SAM files by coordinate',
    command: 'samtools',
    module: 'samtools/1.19',
    inputs: [{ id: 'input', label: 'BAM/SAM', description: 'Alignment file to sort by coordinate or read name.', fileType: 'bam', required: true }],
    outputs: [{ id: 'output', label: 'Sorted BAM', description: 'Sorted alignment file ready for indexing or downstream analysis.', fileType: 'bam' }],
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
    inputs: [{ id: 'input', label: 'Sorted BAM', description: 'Coordinate-sorted BAM/CRAM that needs an index.', fileType: 'bam', required: true }],
    outputs: [{ id: 'output', label: 'Indexed BAM', description: 'Index file created for the connected alignment.', fileType: 'bam' }],
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
      { id: 'reference', label: 'Reference', description: 'Indexed reference genome FASTA to align reads against.', fileType: 'fasta', required: true },
      { id: 'reads1', label: 'Reads R1', description: 'Forward reads FASTQ, or single-end reads if no R2 is connected.', fileType: 'fastq', required: true },
      { id: 'reads2', label: 'Reads R2', description: 'Reverse reads FASTQ for paired-end alignment.', fileType: 'fastq' },
    ],
    outputs: [{ id: 'output', label: 'Alignment', description: 'SAM alignment output from BWA-MEM.', fileType: 'sam' }],
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
    inputs: [{ id: 'input', label: 'FASTQ', description: 'One or more FASTQ files to generate per-file quality reports for.', fileType: 'fastq', required: true, multi: true }],
    outputs: [{ id: 'output', label: 'QC report', description: 'FastQC report files for each connected FASTQ.', fileType: 'any' }],
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
    inputs: [{ id: 'input', label: 'Reports', description: 'FastQC or other tool report folders/files to summarize together.', fileType: 'any', required: true, multi: true }],
    outputs: [{ id: 'output', label: 'Combined report', description: 'MultiQC HTML report and summary data for the connected reports.', fileType: 'any' }],
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
    inputs: [{ id: 'input', label: 'Input', description: 'Any connected files become $INPUT, $INPUT_1, $INPUT_2, and ${INPUTS[@]} in the script.', fileType: 'any', multi: true }],
    outputs: [{ id: 'output', label: 'Output', description: 'Stdout from the shell script is captured into this output path as $OUTPUT.', fileType: 'any' }],
    params: [
      { name: 'script', label: 'Shell script', type: 'string', required: true, placeholder: 'cat "$INPUT"' },
    ],
    slurm: { cpus: 1, memoryGB: 4, timeHours: 1 },
  },
]

const TOOL_DOCS: Record<string, string> = {
  'plink2.assoc': 'https://www.cog-genomics.org/plink/2.0/assoc',
  'plink2.qc': 'https://www.cog-genomics.org/plink/2.0/filter',
  'plink2.clump': 'https://www.cog-genomics.org/plink/2.0/postproc',
  'plink2.score': 'https://www.cog-genomics.org/plink/2.0/score',
  'regenie.step1': 'https://rgcgithub.github.io/regenie/options/',
  'regenie.step2': 'https://rgcgithub.github.io/regenie/options/',
  'bcftools.view': 'https://samtools.github.io/bcftools/bcftools.html#view',
  'bcftools.merge': 'https://samtools.github.io/bcftools/bcftools.html#merge',
  'annovar.table_annovar': 'https://annovar.openbioinformatics.org/en/latest/user-guide/startup/',
  vep: 'https://www.ensembl.org/info/docs/tools/vep/script/vep_options.html',
}

const PARAM_DESCRIPTIONS: Record<string, string> = {
  glm: 'Controls PLINK2 association output modifiers. hide-covar keeps covariate effects out of the main report.',
  maf: 'Exclude variants with minor allele frequency below this threshold.',
  geno: 'Exclude variants with missing genotype rate above this threshold.',
  hwe: 'Exclude variants failing Hardy-Weinberg equilibrium at this p-value.',
  'pheno-name': 'Trait column in the connected phenotype file.',
  'covar-name': 'Covariate columns in the connected covariate file. PLINK expects these separated by spaces.',
  mind: 'Exclude samples with missing genotype rate above this threshold.',
  'make-bed': 'Write a PLINK1 BED/BIM/FAM fileset.',
  'clump-p1': 'Primary p-value threshold for lead variants.',
  'clump-p2': 'Secondary p-value threshold for variants included around a lead.',
  'clump-r2': 'Maximum LD r-squared allowed inside a clump.',
  'clump-kb': 'Window size around each lead variant, in kilobases.',
  'clump-snp-field': 'Column containing variant IDs for PLINK clumping.',
  'clump-field': 'Column containing p-values for PLINK clumping.',
  'score-col-nums': 'One-based score columns to use from the score file.',
  header: 'Tell PLINK2 the score file includes a header row.',
  center: 'Center genotype dosages before scoring.',
  'variance-standardize': 'Variance-standardize genotypes before scoring.',
  'no-mean-imputation': 'Disable PLINK2 mean imputation for missing dosages.',
  step: 'REGENIE step number.',
  bt: 'Use binary-trait model settings.',
  bsize: 'Number of variants per block.',
  lowmem: 'Reduce memory use by writing temporary predictions to disk.',
  loocv: 'Use leave-one-chromosome-out predictions.',
  phenoColList: 'Phenotype columns in the connected phenotype file.',
  covarColList: 'Covariate columns in the connected covariate file.',
  firth: 'Enable Firth correction in REGENIE step 2.',
  spa: 'Enable saddlepoint approximation for binary traits.',
  minMAC: 'Minimum minor allele count for variants tested.',
  regions: 'Genomic regions to include.',
  samples: 'Samples to include.',
  exclude: 'bcftools expression for variants to exclude.',
  include: 'bcftools expression for variants to include.',
  'output-type': 'Output encoding: v=VCF, z=compressed VCF, b=BCF, u=uncompressed BCF.',
  merge: 'How bcftools should merge records at the same position.',
  toolPath: 'Executable or scripts folder to use instead of relying on a loaded module.',
  annotationDbPath: 'Reference database/cache directory used by the annotation tool.',
  annotationFeatures: 'BioFlow-managed annotation feature selection.',
  buildver: 'Reference build name used by ANNOVAR.',
  protocol: 'ANNOVAR protocol list.',
  operation: 'ANNOVAR operation list matching the protocol list.',
  remove: 'Delete ANNOVAR intermediate files after completion.',
  nastring: 'String written for missing ANNOVAR annotations.',
  vcfinput: 'Tell ANNOVAR the input is VCF.',
  assembly: 'Reference assembly used by VEP.',
  cache: 'Use the local VEP cache.',
  offline: 'Run VEP without network lookups.',
  everything: 'Enable VEP broad annotation preset.',
  check_existing: 'Annotate known variant IDs.',
  af_gnomad: 'Include gnomAD allele frequencies when available.',
  nearest: 'Report nearest gene for intergenic variants.',
  plugin: 'VEP plugin configuration string.',
  fork: 'Number of VEP worker processes.',
  threads: 'Number of worker threads used by the tool.',
  memory: 'Memory per thread or block, using the tool-specific syntax.',
  'by-name': 'Sort alignments by read name instead of coordinate.',
  reference: 'Reference genome input.',
  'read-group': 'Read group header string for alignments.',
  'mark-short': 'Mark shorter split hits as secondary.',
  nogroup: 'Disable FastQC base grouping.',
  force: 'Overwrite an existing report in the output directory.',
  script: 'Shell body run by bash. Use $INPUT, ${INPUTS[@]}, and $OUTPUT.',
}

const ADVANCED_PARAMS = new Set([
  'memory',
  'threads',
  'bsize',
  'lowmem',
  'loocv',
  'remove',
  'nastring',
  'vcfinput',
  'toolPath',
  'annotationDbPath',
  'annotationFeatures',
  'protocol',
  'operation',
  'cache',
  'offline',
  'everything',
  'check_existing',
  'af_gnomad',
  'nearest',
  'plugin',
  'fork',
  'nogroup',
  'force',
  'read-group',
  'mark-short',
])

for (const tool of TOOLS) {
  for (const param of tool.params) {
    param.description = param.description ?? PARAM_DESCRIPTIONS[param.name]
    param.docUrl = param.docUrl ?? TOOL_DOCS[tool.id]
    param.advanced = param.advanced ?? ADVANCED_PARAMS.has(param.name)
  }
}

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
  // PLINK2 `.pgen` is one concrete representation of a PLINK fileset.
  if ((source === 'pgen' && target === 'plink') || (source === 'plink' && target === 'pgen')) return true
  return false
}
