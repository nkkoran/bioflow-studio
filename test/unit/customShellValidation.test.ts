import { describe, expect, it } from 'vitest'
import { validateCustomShellScript } from '@/lib/customShellValidation'

describe('custom shell validation', () => {
  it('flags basic shell syntax mistakes before run submission', () => {
    const issues = validateCustomShellScript('awk "{print $1}" "$INPUT')
    expect(issues.some((issue) => issue.code === 'CUSTOM_SHELL_UNCLOSED_DOUBLE_QUOTE')).toBe(true)
  })

  it('requires $OUTPUT when the script owns output creation', () => {
    const issues = validateCustomShellScript('cat "$INPUT"', { mode: 'script-writes-output', requireNonEmpty: true })
    expect(issues.some((issue) => issue.code === 'CUSTOM_SHELL_OUTPUT_MISSING')).toBe(true)
  })
})
