import { describe, expect, it } from 'vitest'
import { ensureFlagBlocks } from '@/lib/flagRegistry'
import { normalizeAnalysisOptions } from '@/lib/analysisOptions'
import { getTool } from '@/lib/toolRegistry'
import type { ToolNodeData, TransformNodeData } from '@/types/pipeline'
import type { AxisPlan } from '../../electron/pipeline/axisPlanner'
import { generateToolScript, generateTransformScript } from '../../electron/pipeline/ScriptGenerator'

function singleAxisPlan(inputs: AxisPlan['inputs'], outputs: AxisPlan['outputs']): AxisPlan {
  return {
    nodeId: 'node1',
    nodeType: 'tool',
    mode: 'single',
    dependsOnArrayNodeIds: [],
    inputs,
    outputs,
  }
}

describe('ScriptGenerator', () => {
  it('routes Slurm stdout and stderr into one job log file', () => {
    const tool = getTool('samtools.sort')
    if (!tool) throw new Error('missing tool')
    const nodeData: ToolNodeData = {
      toolId: 'samtools.sort',
      label: 'Sort',
      paramValues: {},
      status: 'idle',
    }

    const generated = generateToolScript({
      nodeId: 'sort',
      nodeSlug: 'samtools-sort',
      tool,
      nodeData,
      axisPlan: singleAxisPlan(
        { input: { kind: 'single', path: '/data/input.bam' } },
        { output: { kind: 'single', path: '/work/sorted.bam' } },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('#SBATCH --output=/logs/samtools-sort-%j.slurm.log')
    expect(generated.script).toContain('#SBATCH --error=/logs/samtools-sort-%j.slurm.log')
    expect(generated.script).not.toContain('.err')
  })

  it('does not emit generic boolean flags whose default is false', () => {
    const tool = getTool('samtools.sort')
    if (!tool) throw new Error('missing tool')
    const nodeData: ToolNodeData = {
      toolId: 'samtools.sort',
      label: 'Sort',
      paramValues: {},
      status: 'idle',
    }

    const generated = generateToolScript({
      nodeId: 'sort',
      tool,
      nodeData,
      axisPlan: singleAxisPlan(
        { input: { kind: 'single', path: '/data/input.bam' } },
        { output: { kind: 'single', path: '/work/sorted.bam' } },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('-@ 4')
    expect(generated.script).toContain('-m 2G')
    expect(generated.script).not.toMatch(/(^|\s)-n(\s|\\|\n)/)
  })

  it('emits connected PLINK association inputs when flag-builder mode is active', () => {
    const tool = getTool('plink2.assoc')
    if (!tool) throw new Error('missing tool')
    const nodeData: ToolNodeData = {
      toolId: 'plink2.assoc',
      label: 'Assoc',
      paramValues: {
        glm: 'hide-covar',
        maf: 0.01,
        geno: 0.05,
        hwe: 1e-6,
        'pheno-name': 'trait',
        one: true,
        'covar-name': 'age sex PC1 PC2',
      },
      flagBlocks: ensureFlagBlocks('plink2.assoc', undefined, {
        glm: 'hide-covar',
        maf: 0.01,
        geno: 0.05,
        hwe: 1e-6,
        'pheno-name': 'trait',
        one: true,
        'covar-name': 'age sex PC1 PC2',
      }),
      status: 'idle',
    }
    const axisPlan = singleAxisPlan(
      {
        input: { kind: 'single', path: '/data/cohort.bed' },
        pheno: { kind: 'single', path: '/data/pheno.tsv' },
        covar: { kind: 'single', path: '/data/covar.tsv' },
        keep: { kind: 'single', path: '/data/keep.txt' },
      },
      {
        output: { kind: 'single', path: '/work/assoc.tsv' },
      },
    )

    const generated = generateToolScript({
      nodeId: 'assoc',
      tool,
      nodeData,
      axisPlan,
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('--pheno /data/pheno.tsv')
    expect(generated.script).toContain('--1')
    expect(generated.script).toContain('--covar /data/covar.tsv')
    expect(generated.script).toContain('--keep /data/keep.txt')
  })

  it('does not emit PLINK iid-only modifiers from stale false-valued switch state', () => {
    const tool = getTool('plink2.assoc')
    if (!tool) throw new Error('missing tool')
    const paramValues = {
      glm: 'hide-covar',
      'pheno-name': 'trait',
      'pheno-iid-only': true,
      'covar-name': 'age sex PC1',
      'covar-iid-only': true,
      one: true,
    }
    const analysisOptions = normalizeAnalysisOptions(tool, { paramValues }).map((option) => {
      if (option.optionId === 'pheno-iid-only' || option.optionId === 'covar-iid-only') {
        return { ...option, enabled: true, value: false }
      }
      if (option.optionId === 'covar') return { ...option, enabled: true }
      if (option.optionId === 'one') return { ...option, enabled: true, value: false }
      return option
    })
    const flagBlocks = ensureFlagBlocks('plink2.assoc', undefined, paramValues).map((block) => (
      block.flagId === 'pheno-iid-only' || block.flagId === 'covar-iid-only'
        ? { ...block, enabled: true, value: false }
        : block
    ))
    const nodeData: ToolNodeData = {
      toolId: 'plink2.assoc',
      label: 'Assoc',
      paramValues,
      flagBlocks,
      analysisOptions,
      status: 'idle',
    }

    const generated = generateToolScript({
      nodeId: 'assoc',
      tool,
      nodeData,
      axisPlan: singleAxisPlan(
        {
          input: { kind: 'single', path: '/data/cohort.pgen' },
          pheno: { kind: 'single', path: '/data/pheno.tsv' },
          covar: { kind: 'single', path: '/data/covar.tsv' },
        },
        { output: { kind: 'single', path: '/work/assoc.tsv' } },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('--pheno /data/pheno.tsv')
    expect(generated.script).toContain('--covar /data/covar.tsv')
    expect(generated.script).not.toContain('--pheno iid-only')
    expect(generated.script).not.toContain('--covar iid-only')
    expect(generated.script).toContain('--1')
  })

  it('emits PLINK --read-freq from a dynamic split-aware input port', () => {
    const tool = getTool('plink2.assoc')
    if (!tool) throw new Error('missing tool')
    const options = normalizeAnalysisOptions(tool, { paramValues: {} }).map((option) =>
      option.optionId === 'read-freq'
        ? { ...option, enabled: true, source: { kind: 'upstream-file' as const, portId: 'read-freq' } }
        : option,
    )
    const nodeData: ToolNodeData = {
      toolId: 'plink2.assoc',
      label: 'Assoc',
      paramValues: {},
      analysisOptions: options,
      status: 'idle',
    }

    const generated = generateToolScript({
      nodeId: 'assoc',
      tool,
      nodeData,
      axisPlan: singleAxisPlan(
        {
          input: { kind: 'single', path: '/data/cohort.pgen' },
          pheno: { kind: 'single', path: '/data/pheno.tsv' },
          'read-freq': { kind: 'single', path: '/data/freq.tsv' },
        },
        { output: { kind: 'single', path: '/work/assoc.tsv' } },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('--read-freq /data/freq.tsv')
  })

  it('uses configured module defaults before registry module names', () => {
    const tool = getTool('plink2.assoc')
    if (!tool) throw new Error('missing tool')
    const generated = generateToolScript({
      nodeId: 'assoc',
      tool,
      nodeData: {
        toolId: tool.id,
        label: 'Assoc',
        paramValues: {},
        status: 'idle',
      },
      axisPlan: singleAxisPlan(
        { input: { kind: 'single', path: '/data/cohort.pgen' } },
        { output: { kind: 'single', path: '/work/assoc.tsv' } },
      ),
      outputDir: '/work',
      logDir: '/logs',
      connectionDefaults: { moduleDefaults: { plink: 'plink/2.0-rorqual' } },
    })

    expect(generated.script).toContain('module load plink/2.0-rorqual')
    expect(generated.script).not.toContain('module load plink/2.00a3')
  })

  it('lets custom shell nodes write the declared output file themselves', () => {
    const tool = getTool('custom.shell')
    if (!tool) throw new Error('missing tool')
    const nodeData: ToolNodeData = {
      toolId: 'custom.shell',
      label: 'Custom',
      paramValues: { script: 'awk \'{print $1}\' "$INPUT" > "$OUTPUT"' },
      outputContract: { mode: 'script-writes-output', requireNonEmpty: true },
      status: 'idle',
    }

    const generated = generateToolScript({
      nodeId: 'custom',
      tool,
      nodeData,
      axisPlan: singleAxisPlan(
        { input: { kind: 'single', path: '/data/input.tsv' } },
        { output: { kind: 'single', path: '/local/out.tsv' } },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('The script is responsible for writing the final result to $OUTPUT')
    expect(generated.script).toContain('INPUT_1=/data/input.tsv')
    expect(generated.script).toContain('INPUT="${INPUTS[0]:-}"')
    expect(generated.script).toContain('> "$OUTPUT"')
    expect(generated.script).not.toContain('} > "$OUTPUT"')
    expect(generated.script).toContain('test -s "$OUTPUT"')
  })

  it('renders multi-phenotype PLINK association as a Slurm array', () => {
    const tool = getTool('plink2.assoc')
    if (!tool) throw new Error('missing tool')
    const nodeData: ToolNodeData = {
      toolId: 'plink2.assoc',
      label: 'Assoc',
      paramValues: {
        glm: 'hide-covar',
        'pheno-name': 'bmi asthma height',
        'covar-name': 'age sex PC1',
      },
      status: 'idle',
    }

    const generated = generateToolScript({
      nodeId: 'assoc',
      tool,
      nodeData,
      axisPlan: singleAxisPlan(
        {
          input: { kind: 'single', path: '/data/cohort.pgen' },
          pheno: { kind: 'single', path: '/data/pheno.tsv' },
          covar: { kind: 'single', path: '/data/covar.tsv' },
        },
        { output: { kind: 'single', path: '/work/assoc.tsv' } },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.arraySize).toBe(3)
    expect(generated.script).toContain('#SBATCH --array=0-2')
    expect(generated.script).toContain('# --- PLINK2 association phenotype array ---')
    expect(generated.script).toContain('--pheno /data/pheno.tsv')
    expect(generated.script).toContain('--covar /data/covar.tsv')
    expect(generated.script).toContain('--pheno-name "$pheno"')
  })

  it('renders typed PLINK PheWAS phenotypes as a Slurm array', () => {
    const tool = getTool('plink2.phewas')
    if (!tool) throw new Error('missing tool')
    const nodeData: ToolNodeData = {
      toolId: 'plink2.phewas',
      label: 'PheWAS',
      paramValues: {
        phenotypes: 'bmi asthma height',
        glm: 'hide-covar',
        one: true,
        'covar-name': 'age sex PC1',
      },
      status: 'idle',
    }

    const generated = generateToolScript({
      nodeId: 'phewas',
      tool,
      nodeData,
      axisPlan: singleAxisPlan(
        {
          input: { kind: 'single', path: '/data/cohort.pgen' },
          pheno: { kind: 'single', path: '/data/pheno.tsv' },
          covar: { kind: 'single', path: '/data/covar.tsv' },
        },
        { output: { kind: 'single', path: '/work/phewas.tsv' } },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.arraySize).toBe(3)
    expect(generated.script).toContain('#SBATCH --array=0-2')
    expect(generated.script).toContain('PHENO="${PHENOS[$SLURM_ARRAY_TASK_ID]}"')
    expect(generated.script).toContain('--pheno /data/pheno.tsv')
    expect(generated.script).toContain('--1')
    expect(generated.script).toContain('--covar /data/covar.tsv')
    expect(generated.script).toContain('--pheno-name "$pheno"')
  })

  it('renders curated PLINK QC options and dynamic keep input', () => {
    const tool = getTool('plink2.qc')
    if (!tool) throw new Error('missing tool')
    const nodeData: ToolNodeData = {
      toolId: 'plink2.qc',
      label: 'QC',
      paramValues: {},
      status: 'idle',
      analysisOptions: normalizeAnalysisOptions(tool, { paramValues: {} }).map((option) =>
        option.optionId === 'keep'
          ? { ...option, enabled: true, source: { kind: 'upstream-file' as const, portId: 'keep' } }
          : option,
      ),
    }

    const generated = generateToolScript({
      nodeId: 'qc',
      tool,
      nodeData,
      axisPlan: singleAxisPlan(
        {
          input: { kind: 'single', path: '/data/cohort.pgen' },
          keep: { kind: 'single', path: '/data/keep.txt' },
        },
        { output: { kind: 'single', path: '/work/qc.pgen' } },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('--maf 0.01')
    expect(generated.script).toContain('--geno 0.02')
    expect(generated.script).toContain('--keep /data/keep.txt')
    expect(generated.script).toContain('--make-bed')
  })

  it('renders PLINK clump file and column options from the unified option state', () => {
    const tool = getTool('plink2.clump')
    if (!tool) throw new Error('missing tool')
    const nodeData: ToolNodeData = {
      toolId: 'plink2.clump',
      label: 'Clump',
      paramValues: {},
      status: 'idle',
      analysisOptions: normalizeAnalysisOptions(tool, { paramValues: {} }),
    }

    const generated = generateToolScript({
      nodeId: 'clump',
      tool,
      nodeData,
      axisPlan: singleAxisPlan(
        {
          input: { kind: 'single', path: '/data/ref.pgen' },
          clump: { kind: 'single', path: '/data/assoc.tsv' },
        },
        {
          clumped: { kind: 'single', path: '/work/clumped.tsv' },
          leadIds: { kind: 'single', path: '/work/lead-ids.txt' },
        },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('--clump /data/assoc.tsv')
    expect(generated.script).toContain('--clump-snp-field ID')
    expect(generated.script).toContain('--clump-field P')
    expect(generated.script).toContain('--clump-p1 5e-8')
    expect(generated.script).toContain('cp "$CLUMP_REPORT" "$CLUMP_OUT"')
    expect(generated.script).toContain('LEAD_IDS_OUT=/work/lead-ids.txt')
  })

  it('renders PLINK score as one file-backed compound command', () => {
    const tool = getTool('plink2.score')
    if (!tool) throw new Error('missing tool')
    const baseOptions = normalizeAnalysisOptions(tool, { paramValues: {} })
    const nodeData: ToolNodeData = {
      toolId: 'plink2.score',
      label: 'Score',
      paramValues: {},
      status: 'idle',
      analysisOptions: baseOptions.map((option) =>
        option.optionId === 'score'
          ? {
              ...option,
              enabled: true,
              subOptions: {
                ...(option.subOptions ?? {}),
                center: { enabled: true, value: true },
              },
            }
          : option.optionId === 'extract'
            ? { ...option, enabled: true, source: { kind: 'upstream-file' as const, portId: 'extract' } }
          : option,
      ),
    }

    const generated = generateToolScript({
      nodeId: 'score',
      tool,
      nodeData,
      axisPlan: singleAxisPlan(
        {
          input: { kind: 'single', path: '/data/target.pgen' },
          score: { kind: 'single', path: '/data/score.tsv' },
          extract: { kind: 'single', path: '/data/leads.txt' },
        },
        { profile: { kind: 'single', path: '/work/profile.tsv' } },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('--score /data/score.tsv 1 2 3 header center')
    expect(generated.script).toContain('--extract /data/leads.txt')
    expect(generated.script).not.toContain('--score-col-nums')
  })

  it('renders PLINK PCA defaults and optional keep input through analysis options', () => {
    const tool = getTool('plink2.pca')
    if (!tool) throw new Error('missing tool')
    const nodeData: ToolNodeData = {
      toolId: 'plink2.pca',
      label: 'PCA',
      paramValues: {},
      status: 'idle',
      analysisOptions: normalizeAnalysisOptions(tool, { paramValues: {} }).map((option) =>
        option.optionId === 'keep'
          ? { ...option, enabled: true, source: { kind: 'upstream-file' as const, portId: 'keep' } }
          : option,
      ),
    }

    const generated = generateToolScript({
      nodeId: 'pca',
      tool,
      nodeData,
      axisPlan: singleAxisPlan(
        {
          input: { kind: 'single', path: '/data/cohort.pgen' },
          keep: { kind: 'single', path: '/data/keep.txt' },
        },
        {
          eigenvec: { kind: 'single', path: '/work/pca.eigenvec' },
          eigenval: { kind: 'single', path: '/work/pca.eigenval' },
        },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('--pca 10')
    expect(generated.script).toContain('--keep /data/keep.txt')
    expect(generated.script).toContain('--maf 0.01')
  })

  it('renders cohort keep-file transforms with FID/IID writing logic', () => {
    const transformData: TransformNodeData = {
      label: 'Keep file',
      fileType: 'txt',
      preset: 'cohort-filter',
      presetConfig: { matchValue: 'EUR', artifactMode: 'keep-file' },
      roleMappings: {
        sample_id: { roleId: 'sample_id', column: 'IID', confirmed: true },
        family_id: { roleId: 'family_id', column: 'FID', confirmed: true },
        cohort: { roleId: 'cohort', column: 'ethnicity', confirmed: true },
      },
      filters: [],
      renames: [],
      status: 'idle',
    }

    const generated = generateTransformScript({
      nodeId: 'cohort_keep',
      transformData,
      axisPlan: {
        nodeId: 'cohort_keep',
        nodeType: 'transform',
        mode: 'single',
        dependsOnArrayNodeIds: [],
        inputs: { input: { kind: 'single', path: '/data/metadata.tsv' } },
        outputs: { output: { kind: 'single', path: '/work/keep.txt' } },
      },
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('artifact_mode == "keep-file"')
    expect(generated.script).toContain('writer.writerow([fid, iid])')
  })

  it('does not emit ANNOVAR --remove unless explicitly enabled', () => {
    const tool = getTool('annovar.table_annovar')
    if (!tool) throw new Error('missing tool')
    const nodeData: ToolNodeData = {
      toolId: tool.id,
      label: 'ANNOVAR',
      paramValues: {},
      status: 'idle',
    }

    const generated = generateToolScript({
      nodeId: 'annovar',
      tool,
      nodeData,
      axisPlan: singleAxisPlan(
        { input: { kind: 'single', path: '/data/input.vcf' } },
        { output: { kind: 'single', path: '/work/annotated.tsv' } },
      ),
      outputDir: '/work',
      logDir: '/logs',
      connectionDefaults: {
        annovarScriptsPath: '/tools/annovar',
        annovarDbPath: '/tools/annovar/humandb',
      },
    })

    expect(generated.script).not.toContain('--remove')
  })

  it('uses a command override when one is set', () => {
    const tool = getTool('plink2.qc')
    if (!tool) throw new Error('missing tool')
    const generated = generateToolScript({
      nodeId: 'qc',
      tool,
      nodeData: {
        toolId: tool.id,
        label: 'QC',
        paramValues: {},
        status: 'idle',
        commandOverride: 'plink2 --pfile /data/custom --make-bed --out /work/custom',
      },
      axisPlan: singleAxisPlan(
        { input: { kind: 'single', path: '/data/cohort.pgen' } },
        { output: { kind: 'single', path: '/work/qc.pgen' } },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('plink2 --pfile /data/custom --make-bed --out /work/custom')
    expect(generated.script).not.toContain('--maf 0.01')
  })

  it('generates a Manhattan plot script with R package bootstrap and plot outputs', () => {
    const tool = getTool('plot.manhattan')
    if (!tool) throw new Error('missing tool')
    const generated = generateToolScript({
      nodeId: 'manhattan',
      tool,
      nodeData: {
        toolId: tool.id,
        label: 'Manhattan',
        paramValues: { chrCol: 'CHR', bpCol: 'BP', pCol: 'P', snpCol: 'ID' },
        status: 'idle',
      },
      axisPlan: singleAxisPlan(
        { sumstats: { kind: 'multi', paths: ['/work/chr1.tsv', '/work/chr2.tsv'] } },
        {
          plot: { kind: 'single', path: '/work/manhattan.plot.txt' },
        },
      ),
      outputDir: '/work',
      logDir: '/logs',
      connectionDefaults: { toolsRoot: '~/bioflow/tools' },
    })

    expect(generated.script).toContain('packages <- c("data.table", "ggplot2", "qqman", "scales", "gtsummary", "gt", "openxlsx", "broom", "broom.helpers", "dplyr", "tidyr")')
    expect(generated.script).toContain('flock -w 900')
    expect(generated.script).toContain('INPUT_FILES=(/work/chr1.tsv /work/chr2.tsv)')
    expect(generated.script).toContain('PLOT_OUT=/work/manhattan.plot.txt')
    expect(generated.script).toContain('PNG_OUT=/work/manhattan.plot.png')
    expect(generated.script).toContain('PDF_OUT=/work/manhattan.plot.pdf')
    expect(generated.script).toContain('qqman::manhattan')
    expect(generated.script).toContain('Rscript "$R_SCRIPT" "$PNG_OUT" "$PDF_OUT" "$OUTPUT_FORMATS" "${INPUT_FILES[@]}"')
  })

  it('can leave R package installation to a manually prepared library', () => {
    const tool = getTool('plot.qq')
    if (!tool) throw new Error('missing tool')
    const generated = generateToolScript({
      nodeId: 'qq',
      tool,
      nodeData: {
        toolId: tool.id,
        label: 'QQ',
        paramValues: { pCol: 'P' },
        status: 'idle',
      },
      axisPlan: singleAxisPlan(
        { sumstats: { kind: 'single', path: '/work/gwas.tsv' } },
        { plot: { kind: 'single', path: '/work/qq.plot.txt' } },
      ),
      outputDir: '/work',
      logDir: '/logs',
      connectionDefaults: { rPackageInstallMode: 'manual' },
    })

    expect(generated.script).toContain('R package installation is disabled')
    expect(generated.script).not.toContain('install.packages')
  })

  it('generates a QQ plot script with lambda GC output', () => {
    const tool = getTool('plot.qq')
    if (!tool) throw new Error('missing tool')
    const generated = generateToolScript({
      nodeId: 'qq',
      tool,
      nodeData: {
        toolId: tool.id,
        label: 'QQ',
        paramValues: { pCol: 'P' },
        status: 'idle',
      },
      axisPlan: singleAxisPlan(
        { sumstats: { kind: 'single', path: '/work/gwas.tsv' } },
        {
          plot: { kind: 'single', path: '/work/qq.plot.txt' },
        },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('lambda <- stats::median')
    expect(generated.script).toContain('ggplot2::ggsave(png_path')
    expect(generated.script).toContain('INPUT_FILES=(/work/gwas.tsv)')
  })

  it('generates a gtsummary table script with TSV and Excel outputs', () => {
    const tool = getTool('table.gtsummary')
    if (!tool) throw new Error('missing tool')
    const generated = generateToolScript({
      nodeId: 'summary',
      tool,
      nodeData: {
        toolId: tool.id,
        label: 'Summary table',
        paramValues: {
          includeColumns: 'age sex bmi',
          byColumn: 'case_control',
          addOverall: true,
          addP: true,
          percentStyle: 'row',
        },
        status: 'idle',
      },
      axisPlan: singleAxisPlan(
        { table: { kind: 'single', path: '/work/pheno.tsv' } },
        {
          tsv: { kind: 'single', path: '/work/summary.tsv' },
          excel: { kind: 'single', path: '/work/summary.xlsx' },
        },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('gtsummary::tbl_summary')
    expect(generated.script).toContain('openxlsx::saveWorkbook')
    expect(generated.script).toContain('OUTPUT_TSV=/work/summary.tsv')
    expect(generated.script).toContain('OUTPUT_XLSX=/work/summary.xlsx')
    expect(generated.script).toContain('by_col <- choose_col(df, "case_control"')
    expect(generated.script).toContain('percent = "row"')
    expect(generated.script).toContain('gtsummary::add_overall')
    expect(generated.script).toContain('gtsummary::add_p')
  })

  it('generates an R regression script that joins covariates and fits guided lm/glm models', () => {
    const tool = getTool('r.regression')
    if (!tool) throw new Error('missing tool')
    const generated = generateToolScript({
      nodeId: 'regression',
      tool,
      nodeData: {
        toolId: tool.id,
        label: 'Regression',
        paramValues: {
          phenoIdCol: 'IID',
          covarIdCol: 'IID',
          outcomeColumn: 'bmi',
          predictorColumns: 'prs',
          covariateColumns: 'age sex PC1',
          modelType: 'linear-lm',
          confidenceLevel: 0.95,
        },
        status: 'idle',
      },
      axisPlan: singleAxisPlan(
        {
          pheno: { kind: 'single', path: '/work/pheno.tsv' },
          covar: { kind: 'single', path: '/work/covar.tsv' },
        },
        {
          coefficients: { kind: 'single', path: '/work/regression.coefficients.tsv' },
          table: { kind: 'single', path: '/work/regression.table.tsv' },
          excel: { kind: 'single', path: '/work/regression.xlsx' },
        },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('df <- merge(pheno, covar')
    expect(generated.script).toContain('fit <- stats::lm(model_formula, data = model_df)')
    expect(generated.script).toContain('fit <- stats::glm(model_formula, data = model_df, family = family)')
    expect(generated.script).toContain('broom::tidy(fit')
    expect(generated.script).toContain('gtsummary::tbl_regression')
  })

  it('generates an R regression script with a formula override', () => {
    const tool = getTool('r.regression')
    if (!tool) throw new Error('missing tool')
    const generated = generateToolScript({
      nodeId: 'regression',
      tool,
      nodeData: {
        toolId: tool.id,
        label: 'Regression',
        paramValues: {
          outcomeColumn: 'status',
          predictorColumns: 'prs',
          formulaOverride: 'status ~ prs + age + sex',
          modelType: 'logistic-glm',
          familyLink: 'logit',
        },
        status: 'idle',
      },
      axisPlan: singleAxisPlan(
        { pheno: { kind: 'single', path: '/work/pheno.tsv' } },
        {
          coefficients: { kind: 'single', path: '/work/regression.coefficients.tsv' },
          table: { kind: 'single', path: '/work/regression.table.tsv' },
          excel: { kind: 'single', path: '/work/regression.xlsx' },
        },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('formula_override <- "status ~ prs + age + sex"')
    expect(generated.script).toContain('formula_text <- formula_override')
    expect(generated.script).toContain('stats::binomial(link = link)')
  })

  it('generates a Custom R script with fixed table and plot outputs plus extra packages', () => {
    const tool = getTool('custom.r')
    if (!tool) throw new Error('missing tool')
    const generated = generateToolScript({
      nodeId: 'custom-r',
      tool,
      nodeData: {
        toolId: tool.id,
        label: 'Custom R',
        paramValues: {
          packages: 'survival lubridate',
          script: 'df <- read_table(input_file)\ndata.table::fwrite(df, output_table, sep = "\\t")',
        },
        status: 'idle',
      },
      axisPlan: singleAxisPlan(
        { input: { kind: 'single', path: '/work/input.tsv' } },
        {
          table: { kind: 'single', path: '/work/custom.table.tsv' },
          png: { kind: 'single', path: '/work/custom.png' },
          pdf: { kind: 'single', path: '/work/custom.pdf' },
        },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('"survival"')
    expect(generated.script).toContain('"lubridate"')
    expect(generated.script).toContain('output_table <- args[[1]]')
    expect(generated.script).toContain('plot_png <- args[[2]]')
    expect(generated.script).toContain('plot_pdf <- args[[3]]')
    expect(generated.script).toContain('input_files <- if (length(args) > 4)')
  })

  it('emits CrossMap VCF options that match the inspector controls', () => {
    const tool = getTool('crossmap.liftover')
    if (!tool) throw new Error('missing tool')
    const generated = generateToolScript({
      nodeId: 'liftover',
      tool,
      nodeData: {
        toolId: tool.id,
        label: 'Liftover',
        paramValues: { format: 'vcf', chromid: 's', compress: true },
        status: 'idle',
      },
      axisPlan: singleAxisPlan(
        {
          input: { kind: 'single', path: '/data/input.vcf.gz' },
          chain: { kind: 'single', path: '/refs/hg19ToHg38.over.chain.gz' },
          reference: { kind: 'single', path: '/refs/GRCh38.fa' },
        },
        { output: { kind: 'single', path: '/work/lifted.vcf.gz' } },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('CrossMap \\\n  vcf')
    expect(generated.script).toContain('--chromid \\\n  s')
    expect(generated.script).toContain('--compress')
    expect(generated.script).toContain('/refs/GRCh38.fa')
  })

  it('emits VEP VCF output flags for the declared VCF output', () => {
    const tool = getTool('vep')
    if (!tool) throw new Error('missing tool')
    const generated = generateToolScript({
      nodeId: 'vep',
      tool,
      nodeData: {
        toolId: tool.id,
        label: 'VEP',
        paramValues: { assembly: 'GRCh38', cache: true, offline: true, fork: 4 },
        status: 'idle',
      },
      axisPlan: singleAxisPlan(
        { input: { kind: 'single', path: '/data/input.vcf.gz' } },
        { output: { kind: 'single', path: '/work/annotated.vcf.gz' } },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('--vcf')
    expect(generated.script).toContain('--compress_output \\\n  bgzip')
    expect(generated.script).toContain('--output_file \\\n  /work/annotated.vcf.gz')
  })

  it('materializes REGENIE declared outputs from tool-native files', () => {
    const step1 = getTool('regenie.step1')
    const step2 = getTool('regenie.step2')
    if (!step1 || !step2) throw new Error('missing regenie tools')

    const generatedStep1 = generateToolScript({
      nodeId: 'regenie-step1',
      tool: step1,
      nodeData: { toolId: step1.id, label: 'Step 1', paramValues: { step: '1' }, status: 'idle' },
      axisPlan: singleAxisPlan(
        {
          input: { kind: 'single', path: '/data/cohort.bed' },
          pheno: { kind: 'single', path: '/data/pheno.tsv' },
        },
        { output: { kind: 'single', path: '/work/step1.pred.list' } },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })
    expect(generatedStep1.script).toContain('--out /work/step1')
    expect(generatedStep1.script).toContain('cp "$REGENIE_PREFIX"_pred.list "$REGENIE_PRED_OUT"')

    const generatedStep2 = generateToolScript({
      nodeId: 'regenie-step2',
      tool: step2,
      nodeData: { toolId: step2.id, label: 'Step 2', paramValues: { step: '2' }, status: 'idle' },
      axisPlan: singleAxisPlan(
        {
          input: { kind: 'single', path: '/data/chr1.bgen' },
          pheno: { kind: 'single', path: '/data/pheno.tsv' },
          pred: { kind: 'single', path: '/work/step1.pred.list' },
        },
        { output: { kind: 'single', path: '/work/step2.tsv' } },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })
    expect(generatedStep2.script).toContain('REGENIE_RESULTS=("$REGENIE_PREFIX"*.regenie)')
    expect(generatedStep2.script).toContain('test -s "$REGENIE_ASSOC_OUT"')
  })
})
