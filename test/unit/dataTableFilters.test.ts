import { describe, expect, it } from 'vitest'

import {
  filterAndSortRows,
  getFilterRuleIssue,
  getUsableFilterRules,
  rowMatchesFilters,
} from '@/components/data-preview/DataTable'
import type { TransformFilterRule } from '@/types/pipeline'

const headers = ['id', 'gene', 'p', 'note']
const rows = [
  ['1', 'BRCA1', '0.02', 'case'],
  ['2', 'BRCA2', '0.001', 'case'],
  ['3', 'GENE3', '0.20', 'control'],
  ['4', 'GENE4', '', ''],
]

function rule(patch: Partial<TransformFilterRule>): TransformFilterRule {
  return {
    id: `rule-${patch.column ?? 'x'}-${patch.op ?? 'contains'}`,
    column: 'gene',
    op: 'contains',
    value: 'BRCA',
    join: 'and',
    ...patch,
  }
}

describe('data table filters', () => {
  it('treats incomplete value filters as draft-only rules', () => {
    const blankFilter = rule({ value: '' })

    expect(getFilterRuleIssue(blankFilter, headers)).toBe('Enter a filter value.')
    expect(getUsableFilterRules([blankFilter], headers)).toEqual([])
    expect(filterAndSortRows(rows, headers, [blankFilter], undefined)).toEqual(rows)
  })

  it('applies AND/OR filter joins in row order', () => {
    const filtered = filterAndSortRows(rows, headers, [
      rule({ column: 'gene', op: 'contains', value: 'BRCA' }),
      rule({ column: 'p', op: 'lt', value: '0.01', join: 'and' }),
      rule({ column: 'note', op: 'equals', value: 'control', join: 'or' }),
    ], undefined)

    expect(filtered.map((row) => row[0])).toEqual(['2', '3'])
  })

  it('matches regex filters case-insensitively like the generated transform script', () => {
    expect(rowMatchesFilters(['BRCA1'], ['gene'], [
      rule({ column: 'gene', op: 'regex', value: '^brca' }),
    ])).toBe(true)
  })

  it('rejects invalid regex and nonnumeric numeric filters before applying', () => {
    expect(getFilterRuleIssue(rule({ op: 'regex', value: '[' }), headers)).toBe('Fix the regular expression before applying.')
    expect(getFilterRuleIssue(rule({ column: 'p', op: 'gt', value: 'abc' }), headers)).toBe('Enter a numeric value.')
  })

  it('does not treat blank table cells as zero for numeric filters', () => {
    const filtered = filterAndSortRows(rows, headers, [
      rule({ column: 'p', op: 'gte', value: '0' }),
    ], undefined)

    expect(filtered.map((row) => row[0])).toEqual(['1', '2', '3'])
  })
})
