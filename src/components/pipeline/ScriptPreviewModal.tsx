import { useEffect, useMemo, useState } from 'react'
import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { classNames } from '@/lib/utils'
import type { DryRunScript } from '@/types/pipeline'

interface Props {
  scripts: DryRunScript[]
  onClose: () => void
}

interface DetailRow {
  label: string
  value: string
}

interface CommandSummary {
  title: string
  rows: DetailRow[]
  raw: string
}

const FLAG_LABELS: Record<string, string> = {
  '--pfile': 'Genotype files',
  '--bfile': 'Genotype files',
  '--file': 'Genotype files',
  '--pheno': 'Phenotype file',
  '--pheno-name': 'Phenotype column',
  '--covar': 'Covariate file',
  '--covar-name': 'Covariate columns',
  '--keep': 'Keep samples',
  '--extract': 'Variant list',
  '--read-freq': 'Frequency file',
  '--glm': 'Regression model',
  '--maf': 'Min MAF',
  '--geno': 'Max missing genotype rate',
  '--hwe': 'HWE p-value',
  '--ci': 'Confidence interval',
  '--out': 'Output prefix',
}

const ASSIGNMENT_LABELS: Record<string, string> = {
  KEY: 'Array key',
  i_input: 'Input file',
}

export function ScriptPreviewModal({ scripts, onClose }: Props) {
  const [selectedId, setSelectedId] = useState(scripts[0]?.nodeId ?? '')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setSelectedId((current) => (scripts.some((script) => script.nodeId === current) ? current : scripts[0]?.nodeId ?? ''))
  }, [scripts])

  const selectedScript = useMemo(
    () => scripts.find((script) => script.nodeId === selectedId) ?? scripts[0] ?? null,
    [scripts, selectedId],
  )
  const commandSummaries = useMemo(
    () => selectedScript ? summarizeCommands(selectedScript.commands ?? []) : [],
    [selectedScript],
  )
  const executionRows = useMemo(
    () => selectedScript ? scriptExecutionRows(selectedScript) : [],
    [selectedScript],
  )

  const handleCopy = async () => {
    if (!selectedScript?.script) return
    await copyText(selectedScript.script)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Preview generated scripts"
      subtitle="Dry-run only. No files are written and no Slurm jobs are submitted."
      className="bioflow-workbench-dialog"
      bodyClassName="bioflow-workbench-body"
    >
      <div className="bioflow-script-preview flex min-h-0 flex-1">
        <div className="bioflow-script-list scroll-region shrink-0 border-r border-border bg-bg-secondary/40">
          {scripts.length === 0 ? (
            <div className="p-4 text-xs text-text-muted">No runnable nodes.</div>
          ) : (
            scripts.map((script) => (
              <button
                key={script.nodeId}
                onClick={() => setSelectedId(script.nodeId)}
                className={classNames(
                  'w-full border-b border-border-light/60 px-3 py-2 text-left hover:bg-bg-hover',
                  selectedScript?.nodeId === script.nodeId && 'border-l-2 border-l-accent bg-bg-hover',
                )}
              >
                <div className="truncate text-xs text-text-primary">{script.label}</div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-text-muted">
                  <span>{formatMode(script)}</span>
                  {script.arraySize ? <span>{script.arraySize} tasks</span> : null}
                </div>
                {script.summary ? (
                  <div className="mt-1 line-clamp-2 text-[10px] text-text-muted">{script.summary}</div>
                ) : null}
              </button>
            ))
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border-light bg-bg-secondary/30 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-text-primary">
                {selectedScript?.label || 'No step selected'}
              </div>
              <div className="truncate text-[10px] text-text-muted">
                {selectedScript ? formatMode(selectedScript) : 'No runnable nodes.'}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              icon={<Copy size={11} />}
              onClick={() => void handleCopy()}
              disabled={!selectedScript}
              className="h-6 px-2 text-[10px]"
            >
              {copied ? 'Copied' : 'Copy script'}
            </Button>
          </div>

          {selectedScript ? (
            <div className="scroll-region min-h-0 flex-1 p-4">
              <div className="grid min-h-full gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
                <section className="bioflow-script-card flex min-h-[32rem] min-w-0 flex-col rounded-md border border-border bg-bg-secondary p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-text-muted">Raw Slurm script</div>
                      <div className="mt-0.5 text-[11px] text-text-muted">Exact script BioFlow will submit for this node.</div>
                    </div>
                  </div>
                  <pre className="bioflow-script-raw min-h-0 flex-1 overflow-auto rounded-md border border-border-light bg-bg-primary p-3 font-mono text-[11px] leading-relaxed text-slate-100">{selectedScript.script}</pre>
                </section>

                <aside className="space-y-3">
                  <section className="bioflow-script-card rounded-md border border-border bg-bg-secondary p-3">
                    <div className="text-[10px] uppercase tracking-wide text-text-muted">Summary</div>
                    <p className="bioflow-body-copy mt-1 text-sm leading-5 text-text-primary">
                      {selectedScript.summary || 'No summary available.'}
                    </p>
                  </section>

                  <section className="bioflow-script-card rounded-md border border-border bg-bg-secondary p-3">
                    <div className="mb-2 text-[10px] uppercase tracking-wide text-text-muted">Execution</div>
                    <div className="space-y-2">
                      {executionRows.map((row) => (
                        <DetailRowView key={row.label} row={row} />
                      ))}
                    </div>
                  </section>

                  <section className="bioflow-script-card rounded-md border border-border bg-bg-secondary p-3">
                    <div className="mb-2 text-[10px] uppercase tracking-wide text-text-muted">Commands</div>
                    {commandSummaries.length > 0 ? (
                      <div className="space-y-2">
                        {commandSummaries.map((command, index) => (
                          <CommandCard key={`${command.title}-${index}`} command={command} />
                        ))}
                      </div>
                    ) : (
                      <div className="bioflow-body-copy rounded border border-border-light bg-bg-tertiary p-2 text-xs text-text-muted">
                        No extracted commands.
                      </div>
                    )}
                  </section>

                  <section className="bioflow-script-card rounded-md border border-border bg-bg-secondary p-3">
                    <div className="mb-2 text-[10px] uppercase tracking-wide text-text-muted">Outputs</div>
                    <div className="space-y-2">
                      {(selectedScript.outputPaths.length > 0 ? selectedScript.outputPaths : ['No declared outputs.']).map((path, index) => (
                        <div
                          key={`${path}-${index}`}
                          title={path}
                          className="bioflow-script-value break-all rounded border border-border-light bg-bg-tertiary p-2 font-mono text-[10px] leading-4 text-text-primary"
                        >
                          {path}
                        </div>
                      ))}
                    </div>
                  </section>
                </aside>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
              No runnable nodes.
            </div>
          )}
        </div>
      </div>
    </Dialog>
  )
}

function CommandCard({ command }: { command: CommandSummary }) {
  return (
    <div className="bioflow-script-card rounded border border-border-light bg-bg-tertiary p-2">
      <div className="text-xs font-medium text-text-primary">{command.title}</div>
      {command.rows.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          {command.rows.map((row) => (
            <DetailRowView key={`${row.label}-${row.value}`} row={row} />
          ))}
        </div>
      ) : (
        <pre className="mt-2 rounded bg-bg-primary p-2 font-mono text-[10px] leading-relaxed text-text-primary">{command.raw}</pre>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-[10px] text-text-muted">Raw command</summary>
        <pre className="mt-1 rounded bg-bg-primary p-2 font-mono text-[10px] leading-relaxed text-text-primary">{command.raw}</pre>
      </details>
    </div>
  )
}

function DetailRowView({ row }: { row: DetailRow }) {
  return (
    <div className="bioflow-script-row grid grid-cols-[6.25rem_minmax(0,1fr)] gap-2 text-xs">
      <div className="text-text-muted">{row.label}</div>
      <div className="bioflow-script-value break-all font-mono text-text-primary">{row.value}</div>
    </div>
  )
}

function summarizeCommands(commands: string[]): CommandSummary[] {
  return commands.map(summarizeCommand)
}

function summarizeCommand(command: string): CommandSummary {
  const raw = command.trim()
  const normalized = normalizeCommand(raw)
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(normalized)
  if (assignment) {
    const name = assignment[1]
    return {
      title: ASSIGNMENT_LABELS[name] ?? name,
      rows: [{ label: 'Value', value: compactPath(cleanToken(assignment[2])) }],
      raw,
    }
  }

  const tokens = tokenizeCommandLine(normalized)
  const program = basename(tokens[0] ?? 'Command')
  if (program === 'plink2' || program === 'plink') {
    return {
      title: `Run ${program}`,
      rows: plinkRows(tokens),
      raw,
    }
  }
  if (program === 'mkdir') {
    return { title: 'Create output folder', rows: [{ label: 'Path', value: compactPath(cleanToken(tokens.at(-1) ?? '')) }], raw }
  }
  if (program === 'cd') {
    return { title: 'Work directory', rows: [{ label: 'Path', value: compactPath(cleanToken(tokens[1] ?? '')) }], raw }
  }
  return {
    title: program || 'Command',
    rows: [{ label: 'Command', value: normalized }],
    raw,
  }
}

function plinkRows(tokens: string[]): DetailRow[] {
  const rows: DetailRow[] = []
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('-')) continue
    const values: string[] = []
    while (tokens[index + 1] && !tokens[index + 1].startsWith('-')) {
      values.push(tokens[index + 1])
      index += 1
    }
    rows.push({
      label: FLAG_LABELS[token] ?? humanizeFlag(token),
      value: values.length > 0 ? compactPath(values.map(cleanToken).join(' ')) : 'Enabled',
    })
  }
  return rows
}

function scriptExecutionRows(script: DryRunScript): DetailRow[] {
  const rows: DetailRow[] = [{ label: 'Mode', value: formatMode(script) }]
  if (script.arraySize) rows.push({ label: 'Tasks', value: String(script.arraySize) })
  const directiveRows = parseSlurmDirectives(script.script)
  for (const row of directiveRows) {
    if (!rows.some((existing) => existing.label === row.label)) rows.push(row)
  }
  return rows
}

function parseSlurmDirectives(script: string): DetailRow[] {
  const rows: DetailRow[] = []
  const labels: Record<string, string> = {
    '--array': 'Array range',
    '--cpus-per-task': 'CPUs',
    '--mem': 'Memory',
    '--time': 'Time limit',
    '--account': 'Account',
  }
  for (const line of script.split(/\r?\n/)) {
    const match = /^#SBATCH\s+(--[A-Za-z0-9-]+)=(.+)$/.exec(line.trim())
    if (!match) continue
    const label = labels[match[1]]
    if (label) rows.push({ label, value: match[2] })
  }
  return rows
}

function normalizeCommand(command: string): string {
  return command.replace(/\\\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim()
}

function tokenizeCommandLine(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (const char of command) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if ((char === '"' || char === "'") && !quote) {
      quote = char
      continue
    }
    if (char === quote) {
      quote = null
      continue
    }
    if (/\s/.test(char) && !quote) {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}

function humanizeFlag(flag: string): string {
  return flag
    .replace(/^-+/, '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function cleanToken(value: string): string {
  return value.replace(/^["']|["']$/g, '')
}

function basename(path: string): string {
  return cleanToken(path).split('/').filter(Boolean).at(-1) ?? path
}

function compactPath(value: string): string {
  const cleaned = cleanToken(value)
  if (!cleaned.includes('/') || cleaned.length <= 88) return cleaned
  const parts = cleaned.split('/').filter(Boolean)
  const tail = parts.slice(-3).join('/')
  return `.../${tail}`
}

function formatMode(script: DryRunScript): string {
  if (script.mode === 'array') return `Array job${script.arraySize ? ` (${script.arraySize} tasks)` : ''}`
  if (script.mode === 'fanIn') return 'Fan-in dependency job'
  if (script.mode === 'branchFanIn') return 'Branch fan-in job'
  if (script.mode === 'skip') return 'Skipped'
  return 'Single job'
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // Fallback for Electron clipboard permission quirks.
  }
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', 'true')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  document.execCommand('copy')
  document.body.removeChild(el)
}
