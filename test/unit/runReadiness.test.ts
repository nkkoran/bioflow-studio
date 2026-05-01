import { describe, expect, it } from 'vitest'
import { buildRunReadinessReport } from '@/lib/runReadiness'

describe('runReadiness', () => {
  it('merges validation, workflow readiness, cluster checks, and transfer plans into one report', () => {
    const report = buildRunReadinessReport({
      validation: {
        ok: false,
        errorCount: 1,
        warningCount: 0,
        infoCount: 0,
        issues: [{
          code: 'BACKEND_MISMATCH_NEEDS_TRANSFER',
          severity: 'error',
          message: 'A DNX input feeds an SSH tool.',
          edgeId: 'edge-1',
        }],
      },
      readiness: {
        ok: false,
        blockingCount: 1,
        issueCount: 1,
        issues: [{
          code: 'MISSING_FILE',
          severity: 'error',
          blocking: true,
          category: 'Files',
          message: 'Missing cohort file.',
          path: '/data/cohort.tsv',
        }],
        probes: {},
        roleMappings: {},
      },
      clusterDoctor: {
        connectionId: 'conn',
        createdAt: 0,
        checks: [{
          id: 'slurm-account',
          title: 'Slurm account',
          severity: 'warning',
          status: 'warning',
          detail: 'No account configured.',
          suggestion: 'Open Settings and choose an account.',
        }],
      },
      transferPlans: [{
        id: 'implicit:edge-1',
        edgeId: 'edge-1',
        source: { origin: 'dnx', path: '/data/input.vcf.gz', fileType: 'vcf' },
        target: { origin: 'ssh', path: 'Cluster tool', fileType: 'vcf' },
        route: 'dnx->ssh',
        mode: 'implicit',
        status: 'planned',
        warnings: ['This cross-backend handoff will be staged automatically unless you insert a Transfer node.'],
      }],
    })

    expect(report.ok).toBe(false)
    expect(report.errorCount).toBe(2)
    expect(report.warningCount).toBe(2)
    expect(report.issues.map((issue) => issue.category)).toEqual(['Backends', 'Files', 'Cluster', 'Backends'])
    expect(report.issues.find((issue) => issue.code === 'BACKEND_MISMATCH_NEEDS_TRANSFER')?.action).toBe('insert-transfer')
    expect(report.issues.find((issue) => issue.code === 'MISSING_FILE')?.action).toBe('preview-file')
  })

  it('preserves module suggestion details from validation issues', () => {
    const report = buildRunReadinessReport({
      validation: {
        issues: [{
          code: 'MODULE_UNAVAILABLE',
          severity: 'error',
          message: 'Cluster module "plink/2.00a3" is not loadable.',
          nodeId: 'assoc',
          details: {
            category: 'Cluster',
            requestedModule: 'plink/2.00a3',
            moduleCandidate: 'plink/2.00a5',
            moduleCandidates: 'plink/2.00a5|plink/1.9',
          },
        }],
      },
    })

    const issue = report.issues[0]
    expect(issue.category).toBe('Cluster')
    expect(issue.details?.moduleCandidates).toBe('plink/2.00a5|plink/1.9')
  })
})
