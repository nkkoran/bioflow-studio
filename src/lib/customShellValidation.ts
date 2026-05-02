import type { ToolNodeData } from '@/types/pipeline'

export interface CustomShellValidationIssue {
  code: string
  severity: 'error' | 'warning'
  message: string
  suggestion?: string
}

export function validateCustomShellScript(
  script: string,
  outputContract?: ToolNodeData['outputContract'],
): CustomShellValidationIssue[] {
  const issues: CustomShellValidationIssue[] = []
  if (!script.trim()) return issues

  const state = scanShell(script)
  if (state.singleQuoteOpen) {
    issues.push({
      code: 'CUSTOM_SHELL_UNCLOSED_SINGLE_QUOTE',
      severity: 'error',
      message: 'Shell script has an unclosed single quote.',
      suggestion: 'Close the quote or remove the unmatched apostrophe before running.',
    })
  }
  if (state.doubleQuoteOpen) {
    issues.push({
      code: 'CUSTOM_SHELL_UNCLOSED_DOUBLE_QUOTE',
      severity: 'error',
      message: 'Shell script has an unclosed double quote.',
      suggestion: 'Close the quote before running.',
    })
  }
  if (state.backtickOpen) {
    issues.push({
      code: 'CUSTOM_SHELL_UNCLOSED_BACKTICK',
      severity: 'error',
      message: 'Shell script has an unclosed backtick command substitution.',
      suggestion: 'Close the backtick or use $(...) command substitution.',
    })
  }
  if (state.commandSubstitutionDepth > 0) {
    issues.push({
      code: 'CUSTOM_SHELL_UNCLOSED_COMMAND_SUBSTITUTION',
      severity: 'error',
      message: 'Shell script has an unclosed $(...) command substitution.',
      suggestion: 'Close the command substitution before running.',
    })
  }

  const mode = outputContract?.mode ?? 'capture-stdout'
  const referencesOutput = /\$(?:\{OUTPUT\}|OUTPUT)(?![A-Za-z0-9_])/.test(script)
  if (mode === 'script-writes-output' && !referencesOutput) {
    issues.push({
      code: 'CUSTOM_SHELL_OUTPUT_MISSING',
      severity: 'error',
      message: 'Script writes $OUTPUT mode is selected, but the script does not reference $OUTPUT.',
      suggestion: 'Write the final result to "$OUTPUT", or switch the output behavior to Capture stdout.',
    })
  }
  if (mode === 'capture-stdout' && referencesOutput) {
    issues.push({
      code: 'CUSTOM_SHELL_CAPTURE_WITH_OUTPUT',
      severity: 'warning',
      message: 'Capture stdout mode wraps the script and writes stdout to $OUTPUT.',
      suggestion: 'If the script writes "$OUTPUT" itself, switch output behavior to Script writes $OUTPUT.',
    })
  }

  return issues
}

function scanShell(script: string): {
  singleQuoteOpen: boolean
  doubleQuoteOpen: boolean
  backtickOpen: boolean
  commandSubstitutionDepth: number
} {
  let singleQuoteOpen = false
  let doubleQuoteOpen = false
  let backtickOpen = false
  let commandSubstitutionDepth = 0
  let escaped = false

  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i]
    const next = script[i + 1]

    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\' && !singleQuoteOpen) {
      escaped = true
      continue
    }
    if (ch === "'" && !doubleQuoteOpen && !backtickOpen) {
      singleQuoteOpen = !singleQuoteOpen
      continue
    }
    if (ch === '"' && !singleQuoteOpen && !backtickOpen) {
      doubleQuoteOpen = !doubleQuoteOpen
      continue
    }
    if (ch === '`' && !singleQuoteOpen) {
      backtickOpen = !backtickOpen
      continue
    }
    if (ch === '$' && next === '(' && !singleQuoteOpen && !backtickOpen) {
      commandSubstitutionDepth += 1
      i += 1
      continue
    }
    if (ch === ')' && commandSubstitutionDepth > 0 && !singleQuoteOpen && !backtickOpen) {
      commandSubstitutionDepth -= 1
    }
  }

  return { singleQuoteOpen, doubleQuoteOpen, backtickOpen, commandSubstitutionDepth }
}
