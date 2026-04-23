import type { PipelineSnapshot } from '@/types/pipeline'

export interface PipelineTemplate {
  id: string
  name: string
  description: string
  snapshot: PipelineSnapshot
}

const now = 0

export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  {
    id: 'basic-shell-copy',
    name: 'Shell: copy input to output',
    description: 'Minimal input → custom shell → output graph using $INPUT and $OUTPUT.',
    snapshot: {
      version: 1,
      id: 'template-basic-shell-copy',
      name: 'Shell copy template',
      description: 'Copy one input file to one output file with a custom shell node.',
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          id: 'file_input',
          type: 'file',
          position: { x: 80, y: 120 },
          data: { label: 'Input file', path: '', fileType: 'any', isInput: true },
        },
        {
          id: 'shell_copy',
          type: 'tool',
          position: { x: 360, y: 100 },
          data: {
            toolId: 'custom.shell',
            label: 'Copy file',
            paramValues: { script: 'cat "$INPUT"' },
            status: 'idle',
          },
        },
        {
          id: 'file_output',
          type: 'file',
          position: { x: 660, y: 120 },
          data: { label: 'Output file', path: '~/bioflow-output/copied.txt', fileType: 'txt', isInput: false },
        },
      ],
      edges: [
        { id: 'edge_input_shell', source: 'file_input', sourceHandle: 'output', target: 'shell_copy', targetHandle: 'input' },
        { id: 'edge_shell_output', source: 'shell_copy', sourceHandle: 'output', target: 'file_output', targetHandle: 'input' },
      ],
    },
  },
  {
    id: 'basic-gwas',
    name: 'Basic GWAS',
    description: 'PLINK input → PLINK2 association → TSV output.',
    snapshot: {
      version: 1,
      id: 'template-basic-gwas',
      name: 'Basic GWAS template',
      description: 'Single-node PLINK2 association test.',
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          id: 'plink_input',
          type: 'file',
          position: { x: 80, y: 120 },
          data: { label: 'PLINK fileset', path: '', fileType: 'plink', isInput: true },
        },
        {
          id: 'plink_assoc',
          type: 'tool',
          position: { x: 360, y: 100 },
          data: {
            toolId: 'plink2.assoc',
            label: 'PLINK2 Association',
            paramValues: { glm: 'hide-covar', maf: 0.01, geno: 0.05, hwe: 1e-6 },
            status: 'idle',
          },
        },
        {
          id: 'assoc_output',
          type: 'file',
          position: { x: 690, y: 120 },
          data: { label: 'Association results', path: '~/bioflow-output/assoc.tsv', fileType: 'tsv', isInput: false },
        },
      ],
      edges: [
        { id: 'edge_plink_assoc', source: 'plink_input', sourceHandle: 'output', target: 'plink_assoc', targetHandle: 'input' },
        { id: 'edge_assoc_output', source: 'plink_assoc', sourceHandle: 'output', target: 'assoc_output', targetHandle: 'input' },
      ],
    },
  },
  {
    id: 'gwas-to-grs',
    name: 'GWAS → Clump → GRS',
    description: 'Cohort filter, GWAS, p-value filter, clump, score-file build, and PLINK2 scoring.',
    snapshot: {
      version: 1,
      id: 'template-gwas-to-grs',
      name: 'GWAS to GRS template',
      description: 'Replace the genotype and metadata placeholders, confirm the mapped columns, then run the full GWAS-to-GRS flow.',
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          id: 'geno',
          type: 'file',
          position: { x: 60, y: 140 },
          data: { label: 'Genotypes', path: '/project/path/genotypes/cohort.pgen', fileType: 'pgen', isInput: true },
        },
        {
          id: 'metadata',
          type: 'file',
          position: { x: 60, y: 320 },
          data: { label: 'Phenotypes + covariates', path: '/project/path/metadata.tsv', fileType: 'tsv', isInput: true },
        },
        {
          id: 'cohort_table',
          type: 'transform',
          position: { x: 310, y: 260 },
          data: {
            label: 'Filtered cohort table',
            fileType: 'tsv',
            preset: 'cohort-filter',
            presetConfig: { matchValue: 'EUR', artifactMode: 'filtered-table' },
            roleMappings: {},
            status: 'idle',
          },
        },
        {
          id: 'cohort_keep',
          type: 'transform',
          position: { x: 310, y: 420 },
          data: {
            label: 'PLINK keep file',
            fileType: 'txt',
            preset: 'cohort-filter',
            presetConfig: { matchValue: 'EUR', artifactMode: 'keep-file' },
            roleMappings: {},
            status: 'idle',
          },
        },
        {
          id: 'assoc',
          type: 'tool',
          position: { x: 610, y: 140 },
          data: {
            toolId: 'plink2.assoc',
            label: 'GWAS',
            paramValues: {
              glm: 'hide-covar',
              maf: 0.01,
              geno: 0.05,
              hwe: 1e-6,
              'pheno-name': 'trait',
              'covar-name': 'age sex PC1 PC2',
            },
            status: 'idle',
          },
        },
        {
          id: 'gwas_sig',
          type: 'transform',
          position: { x: 900, y: 140 },
          data: {
            label: 'Genome-wide significant hits',
            fileType: 'tsv',
            preset: 'gwas-pval-filter',
            presetConfig: { threshold: 5e-8 },
            roleMappings: {},
            status: 'idle',
          },
        },
        {
          id: 'clump',
          type: 'tool',
          position: { x: 1180, y: 140 },
          data: {
            toolId: 'plink2.clump',
            label: 'Clump',
            paramValues: {
              'clump-p1': 5e-8,
              'clump-p2': 1e-4,
              'clump-r2': 0.1,
              'clump-kb': 250,
              'clump-snp-field': 'ID',
              'clump-field': 'P',
            },
            status: 'idle',
          },
        },
        {
          id: 'clump_leads',
          type: 'transform',
          position: { x: 1460, y: 120 },
          data: {
            label: 'Lead variant list',
            fileType: 'txt',
            preset: 'clump-lead-list',
            presetConfig: {},
            roleMappings: {},
            status: 'idle',
          },
        },
        {
          id: 'score_file',
          type: 'transform',
          position: { x: 1180, y: 340 },
          data: {
            label: 'PLINK score file',
            fileType: 'tsv',
            preset: 'plink-score-file',
            presetConfig: { weightTransform: 'identity' },
            roleMappings: {},
            status: 'idle',
          },
        },
        {
          id: 'score',
          type: 'tool',
          position: { x: 1460, y: 320 },
          data: {
            toolId: 'plink2.score',
            label: 'GRS score',
            paramValues: {
              'score-col-nums': '1 2 3',
              header: true,
            },
            status: 'idle',
          },
        },
        {
          id: 'gwas_out',
          type: 'file',
          position: { x: 900, y: 20 },
          data: { label: 'GWAS results', path: '~/bioflow-output/gwas.tsv', fileType: 'tsv', isInput: false },
        },
        {
          id: 'clump_out',
          type: 'file',
          position: { x: 1460, y: 20 },
          data: { label: 'Clump report', path: '~/bioflow-output/clump.tsv', fileType: 'tsv', isInput: false },
        },
        {
          id: 'score_file_out',
          type: 'file',
          position: { x: 1460, y: 430 },
          data: { label: 'Score file', path: '~/bioflow-output/score_file.tsv', fileType: 'tsv', isInput: false },
        },
        {
          id: 'profile_out',
          type: 'file',
          position: { x: 1760, y: 320 },
          data: { label: 'GRS profile', path: '~/bioflow-output/grs.profile.tsv', fileType: 'tsv', isInput: false },
        },
      ],
      edges: [
        { id: 'e_metadata_cohort_table', source: 'metadata', sourceHandle: 'output', target: 'cohort_table', targetHandle: 'input' },
        { id: 'e_metadata_cohort_keep', source: 'metadata', sourceHandle: 'output', target: 'cohort_keep', targetHandle: 'input' },
        { id: 'e_geno_assoc', source: 'geno', sourceHandle: 'output', target: 'assoc', targetHandle: 'input' },
        { id: 'e_table_assoc_pheno', source: 'cohort_table', sourceHandle: 'output', target: 'assoc', targetHandle: 'pheno' },
        { id: 'e_table_assoc_covar', source: 'cohort_table', sourceHandle: 'output', target: 'assoc', targetHandle: 'covar' },
        { id: 'e_keep_assoc', source: 'cohort_keep', sourceHandle: 'output', target: 'assoc', targetHandle: 'keep' },
        { id: 'e_assoc_gwas_out', source: 'assoc', sourceHandle: 'output', target: 'gwas_out', targetHandle: 'input' },
        { id: 'e_assoc_sig', source: 'assoc', sourceHandle: 'output', target: 'gwas_sig', targetHandle: 'input' },
        { id: 'e_geno_clump', source: 'geno', sourceHandle: 'output', target: 'clump', targetHandle: 'input' },
        { id: 'e_keep_clump', source: 'cohort_keep', sourceHandle: 'output', target: 'clump', targetHandle: 'keep' },
        { id: 'e_sig_clump', source: 'gwas_sig', sourceHandle: 'output', target: 'clump', targetHandle: 'clump' },
        { id: 'e_clump_report_out', source: 'clump', sourceHandle: 'clumped', target: 'clump_out', targetHandle: 'input' },
        { id: 'e_clump_leads', source: 'clump', sourceHandle: 'clumped', target: 'clump_leads', targetHandle: 'input' },
        { id: 'e_sig_score_file', source: 'gwas_sig', sourceHandle: 'output', target: 'score_file', targetHandle: 'input' },
        { id: 'e_geno_score', source: 'geno', sourceHandle: 'output', target: 'score', targetHandle: 'input' },
        { id: 'e_keep_score', source: 'cohort_keep', sourceHandle: 'output', target: 'score', targetHandle: 'keep' },
        { id: 'e_score_file_score', source: 'score_file', sourceHandle: 'output', target: 'score', targetHandle: 'score' },
        { id: 'e_leads_score', source: 'clump_leads', sourceHandle: 'output', target: 'score', targetHandle: 'extract' },
        { id: 'e_score_file_out', source: 'score_file', sourceHandle: 'output', target: 'score_file_out', targetHandle: 'input' },
        { id: 'e_profile_out', source: 'score', sourceHandle: 'profile', target: 'profile_out', targetHandle: 'input' },
      ],
    },
  },
  {
    id: 'vcf-qc',
    name: 'VCF QC',
    description: 'VCF input → bcftools view → filtered VCF output.',
    snapshot: {
      version: 1,
      id: 'template-vcf-qc',
      name: 'VCF QC template',
      description: 'Filter or subset one VCF with bcftools view.',
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          id: 'vcf_input',
          type: 'file',
          position: { x: 80, y: 120 },
          data: { label: 'Input VCF', path: '', fileType: 'vcf', isInput: true },
        },
        {
          id: 'bcftools_view',
          type: 'tool',
          position: { x: 360, y: 100 },
          data: {
            toolId: 'bcftools.view',
            label: 'bcftools view',
            paramValues: { 'output-type': 'z' },
            status: 'idle',
          },
        },
        {
          id: 'vcf_output',
          type: 'file',
          position: { x: 690, y: 120 },
          data: { label: 'Filtered VCF', path: '~/bioflow-output/filtered.vcf.gz', fileType: 'vcf', isInput: false },
        },
      ],
      edges: [
        { id: 'edge_vcf_view', source: 'vcf_input', sourceHandle: 'output', target: 'bcftools_view', targetHandle: 'input' },
        { id: 'edge_view_output', source: 'bcftools_view', sourceHandle: 'output', target: 'vcf_output', targetHandle: 'input' },
      ],
    },
  },
  {
    id: 'plink2-per-chrom-gwas',
    name: 'PLINK2 per-chromosome GWAS',
    description: 'Split PGEN input by chromosome, run PLINK2 association as a Slurm array, then merge the result tables.',
    snapshot: {
      version: 1,
      id: 'template-plink2-per-chrom-gwas',
      name: 'PLINK2 per-chromosome GWAS template',
      description: 'Replace the placeholder genotype, phenotype, and covariate paths before running.',
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          id: 'pgen_chr',
          type: 'file',
          position: { x: 60, y: 90 },
          data: {
            label: 'Per-chromosome PGEN',
            path: '/project/path/genotypes/chr1/sample_chr1.pgen',
            fileType: 'pgen',
            isInput: true,
            split: {
              axis: 'chrom',
              items: Array.from({ length: 22 }, (_, i) => {
                const chr = String(i + 1)
                return { key: chr, path: `/project/path/genotypes/chr${chr}/sample_chr${chr}.pgen` }
              }),
              pattern: { kind: 'brace', template: '/project/path/genotypes/chr{1..22}/sample_chr{1..22}.pgen' },
            },
          },
        },
        { id: 'pheno', type: 'file', position: { x: 70, y: 250 }, data: { label: 'Phenotype file', path: '/project/path/phenotypes.tsv', fileType: 'tsv', isInput: true } },
        {
          id: 'assoc',
          type: 'tool',
          position: { x: 390, y: 150 },
          data: {
            toolId: 'plink2.assoc',
            label: 'PLINK2 Association',
            paramValues: { glm: 'hide-covar', maf: 0.01, geno: 0.05, hwe: 1e-6, 'pheno-name': 'trait', 'covar-name': 'age sex PC1 PC2' },
            status: 'idle',
          },
        },
        { id: 'merge_assoc', type: 'merge', position: { x: 720, y: 160 }, data: { label: 'Merge association tables', strategy: 'tsv-concat-header', convergeMode: 'axed-fan-in', status: 'idle' } },
        { id: 'assoc_out', type: 'file', position: { x: 1020, y: 170 }, data: { label: 'Merged GWAS table', path: '~/bioflow-output/gwas.tsv', fileType: 'tsv', isInput: false } },
      ],
      edges: [
        { id: 'e_pgen_assoc', source: 'pgen_chr', sourceHandle: 'output', target: 'assoc', targetHandle: 'input' },
        { id: 'e_pheno_assoc', source: 'pheno', sourceHandle: 'output', target: 'assoc', targetHandle: 'pheno' },
        { id: 'e_pheno_covar', source: 'pheno', sourceHandle: 'output', target: 'assoc', targetHandle: 'covar' },
        { id: 'e_assoc_merge', source: 'assoc', sourceHandle: 'output', target: 'merge_assoc', targetHandle: 'input' },
        { id: 'e_merge_out', source: 'merge_assoc', sourceHandle: 'output', target: 'assoc_out', targetHandle: 'input' },
      ],
      groups: [
        {
          id: 'g_per_chrom_branch',
          label: 'Per-chromosome branch',
          kind: 'visual',
          collapsed: true,
          axisSummary: 'chrom×22',
          nodeIds: ['pgen_chr', 'assoc', 'merge_assoc'],
        },
      ],
    },
  },
  {
    id: 'sex-stratified-gwas',
    name: 'Sex-stratified GWAS (parallel branches)',
    description: 'Two independent PLINK2 association branches converge through a parallel-branches merge.',
    snapshot: {
      version: 1,
      id: 'template-sex-stratified-gwas',
      name: 'Sex-stratified GWAS template',
      description: 'Replace genotype, phenotype, and keep-file placeholders before running.',
      createdAt: now,
      updatedAt: now,
      nodes: [
        { id: 'geno_all', type: 'file', position: { x: 60, y: 170 }, data: { label: 'Genotypes', path: '/project/path/genotypes/sample.pgen', fileType: 'pgen', isInput: true } },
        { id: 'pheno_sex', type: 'file', position: { x: 60, y: 330 }, data: { label: 'Phenotypes', path: '/project/path/phenotypes.tsv', fileType: 'tsv', isInput: true } },
        { id: 'male_gwas', type: 'tool', position: { x: 390, y: 90 }, data: { toolId: 'plink2.assoc', label: 'Male GWAS', paramValues: { glm: 'hide-covar', 'pheno-name': 'trait', 'covar-name': 'age PC1 PC2' }, status: 'idle' } },
        { id: 'female_gwas', type: 'tool', position: { x: 390, y: 300 }, data: { toolId: 'plink2.assoc', label: 'Female GWAS', paramValues: { glm: 'hide-covar', 'pheno-name': 'trait', 'covar-name': 'age PC1 PC2' }, status: 'idle' } },
        { id: 'branch_merge', type: 'merge', position: { x: 720, y: 200 }, data: { label: 'Merge branches', strategy: 'tsv-concat-header', convergeMode: 'parallel-branches', status: 'idle' } },
        { id: 'branch_out', type: 'file', position: { x: 1010, y: 210 }, data: { label: 'Merged branch output', path: '~/bioflow-output/sex-stratified.tsv', fileType: 'tsv', isInput: false } },
      ],
      edges: [
        { id: 'e_geno_male', source: 'geno_all', sourceHandle: 'output', target: 'male_gwas', targetHandle: 'input' },
        { id: 'e_geno_female', source: 'geno_all', sourceHandle: 'output', target: 'female_gwas', targetHandle: 'input' },
        { id: 'e_pheno_male', source: 'pheno_sex', sourceHandle: 'output', target: 'male_gwas', targetHandle: 'pheno' },
        { id: 'e_pheno_female', source: 'pheno_sex', sourceHandle: 'output', target: 'female_gwas', targetHandle: 'pheno' },
        { id: 'e_male_merge', source: 'male_gwas', sourceHandle: 'output', target: 'branch_merge', targetHandle: 'input' },
        { id: 'e_female_merge', source: 'female_gwas', sourceHandle: 'output', target: 'branch_merge', targetHandle: 'input' },
        { id: 'e_branch_out', source: 'branch_merge', sourceHandle: 'output', target: 'branch_out', targetHandle: 'input' },
      ],
      groups: [
        {
          id: 'g_male_branch',
          label: 'Male branch',
          kind: 'visual',
          collapsed: true,
          nodeIds: ['geno_all', 'pheno_sex', 'male_gwas'],
        },
        {
          id: 'g_female_branch',
          label: 'Female branch',
          kind: 'visual',
          collapsed: true,
          nodeIds: ['geno_all', 'pheno_sex', 'female_gwas'],
        },
      ],
    },
  },
]

export function instantiateTemplate(template: PipelineTemplate): PipelineSnapshot {
  const stamp = Date.now()
  return {
    ...template.snapshot,
    id: `pipeline_${Math.random().toString(36).slice(2, 10)}`,
    name: template.name,
    createdAt: stamp,
    updatedAt: stamp,
    nodes: template.snapshot.nodes.map((node) => ({
      ...node,
      data: { ...node.data },
    })),
    edges: template.snapshot.edges.map((edge) => ({ ...edge })),
    groups: template.snapshot.groups?.map((group) => ({ ...group, nodeIds: [...group.nodeIds] })),
  }
}
