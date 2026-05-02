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
          ranges: { kind: 'single', path: '/work/ranges.bed' },
        },
      ),
      outputDir: '/work',
      logDir: '/logs',
    })

    expect(generated.script).toContain('--clump /data/assoc.tsv')
    expect(generated.script).toContain('--clump-snp-field ID')
    expect(generated.script).toContain('--clump-field P')
    expect(generated.script).toContain('--clump-p1 5e-8')
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
})
