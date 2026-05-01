import { useMemo, useState } from 'react'
import { Copy, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Tabs } from '@/components/ui/Tabs'
import type { RunManifest } from '@/types/workspace'

interface Props {
  report: RunManifest
  onClose: () => void
}

type ViewTab = 'summary' | 'readiness' | 'transfers' | 'results' | 'steps' | 'commands' | 'scripts' | 'json'

export function RunReportModal({ report, onClose }: Props) {
  const [tab, setTab] = useState<ViewTab>('summary')
  const [selectedId, setSelectedId] = useState(report.steps[0]?.nodeId ?? '')
  const [copied, setCopied] = useState(false)
  const selectedStep = useMemo(
    () => report.steps.find((step) => step.nodeId === selectedId) ?? report.steps[0],
    [report.steps, selectedId],
  )

  const selectedText = useMemo(() => {
    if (!selectedStep) return report.summary
    if (tab === 'commands') return selectedStep.commands.join('\n\n')
    if (tab === 'scripts') return selectedStep.script ?? ''
    if (tab === 'json') return JSON.stringify(report, null, 2)
    if (tab === 'readiness') return readinessText(report)
    if (tab === 'transfers') return transferText(report)
    if (tab === 'results') return resultText(report)
    return `${selectedStep.plainLanguage}\n\nInputs:\n${selectedStep.inputs.join('\n') || 'None'}\n\nOutputs:\n${selectedStep.outputs.join('\n') || 'None'}`
  }, [report, selectedStep, tab])

  const copySelected = async () => {
    await copyText(selectedText)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="flex h-[760px] max-h-[92vh] w-[1120px] max-w-[96vw] flex-col overflow-hidden rounded-xl border border-border bg-bg-primary shadow-2xl">
        <div className="flex items-center gap-3 border-b border-border bg-bg-secondary px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-text-primary">Run report</div>
            <div className="text-[11px] text-text-muted">Plain-language summary, commands, scripts, and captured validation state.</div>
          </div>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" icon={<X size={13} />} onClick={onClose} className="h-7 px-2" />
        </div>

        <div className="border-b border-border px-3 py-2">
          <Tabs
            tabs={[
              { id: 'summary', label: 'Summary' },
              { id: 'readiness', label: 'Readiness' },
              { id: 'transfers', label: 'Transfers' },
              { id: 'results', label: 'Results' },
              { id: 'steps', label: 'Steps' },
              { id: 'commands', label: 'Commands' },
              { id: 'scripts', label: 'Scripts' },
              { id: 'json', label: 'Raw JSON' },
            ]}
            activeId={tab}
            onSelect={(value) => setTab(value as ViewTab)}
          />
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="w-72 overflow-y-auto border-r border-border bg-bg-secondary/40">
            {report.steps.map((step) => (
              <button
                key={step.nodeId}
                onClick={() => setSelectedId(step.nodeId)}
                className={`w-full border-b border-border-light/60 px-3 py-2 text-left hover:bg-bg-hover ${
                  selectedStep?.nodeId === step.nodeId ? 'border-l-2 border-l-accent bg-bg-hover' : ''
                }`}
              >
                <div className="truncate text-xs text-text-primary">{step.label}</div>
                <div className="text-[10px] text-text-muted">{step.mode ?? step.nodeType}</div>
              </button>
            ))}
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-border-light bg-bg-secondary/30 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-text-primary">
                  {tab === 'summary' || tab === 'readiness' || tab === 'transfers' || tab === 'results'
                    ? report.run.pipelineName || report.snapshot?.name || 'Run summary'
                    : selectedStep?.label || 'No step selected'}
                </div>
                <div className="truncate text-[10px] text-text-muted">
                  {tab === 'summary' || tab === 'readiness' || tab === 'transfers' || tab === 'results'
                    ? report.summary
                    : selectedStep?.plainLanguage || 'No step details available.'}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                icon={<Copy size={11} />}
                onClick={() => void copySelected()}
                className="h-6 px-2 text-[10px]"
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-3">
              {tab === 'summary' && (
                <div className="flex flex-col gap-3 text-sm text-text-secondary">
                  <div className="rounded-md border border-border bg-bg-secondary p-3 text-text-primary">{report.summary}</div>
                  <div className="grid gap-2 md:grid-cols-2">
                    <InfoCard label="Validation" value={summarizeValidation(report.validation)} />
                    <InfoCard label="Run readiness" value={summarizeRunReadiness(report.runReadiness, report.readiness)} />
                    <InfoCard label="Transfers" value={`${report.transferPlans?.length ?? 0} planned`} />
                    <InfoCard label="Result cards" value={`${report.resultCards?.length ?? 0} classified`} />
                    <InfoCard label="Run folder" value={report.environment.workDir} />
                    <InfoCard label="Lifecycle" value={report.environment.fileLifecyclePolicy ?? 'keep-all'} />
                  </div>
                </div>
              )}

              {tab === 'readiness' && (
                <div className="flex flex-col gap-2">
                  {(report.runReadiness?.issues.length ?? 0) === 0 ? (
                    <Section label="Run readiness" body="No readiness issues captured." />
                  ) : report.runReadiness?.issues.map((issue, index) => (
                    <IssueSection key={`${issue.code}-${issue.nodeId ?? issue.edgeId ?? index}`} issue={issue} />
                  ))}
                </div>
              )}

              {tab === 'transfers' && (
                <div className="flex flex-col gap-2">
                  {(report.transferPlans?.length ?? 0) === 0 ? (
                    <Section label="Transfer plan" body="No cross-backend transfers were planned for this run." />
                  ) : report.transferPlans?.map((plan) => (
                    <Section
                      key={plan.id}
                      label={`${plan.mode === 'implicit' ? 'Implicit' : 'Explicit'} ${plan.route}`}
                      body={[
                        `Source: ${formatArtifact(plan.source)}`,
                        `Target: ${formatArtifact(plan.target)}`,
                        `Status: ${plan.status}`,
                        plan.totalBytes ? `Bytes: ${plan.bytesTransferred ?? 0} / ${plan.totalBytes}` : null,
                        plan.warnings?.length ? `Warnings: ${plan.warnings.join(' ')}` : null,
                      ].filter(Boolean).join('\n')}
                      mono
                    />
                  ))}
                </div>
              )}

              {tab === 'results' && (
                <div className="flex flex-col gap-2">
                  {(report.resultCards?.length ?? 0) === 0 ? (
                    <Section label="Results" body="No result cards were generated." />
                  ) : report.resultCards?.map((card) => (
                    <Section
                      key={`${card.nodeId}-${card.kind}`}
                      label={`${card.primary ? 'Primary' : 'Intermediate'} ${card.kind}`}
                      body={[
                        card.label,
                        ...card.artifacts.map((artifact) => formatArtifact(artifact)),
                      ].join('\n')}
                      mono
                    />
                  ))}
                </div>
              )}

              {tab === 'steps' && selectedStep && (
                <div className="flex flex-col gap-3">
                  <Section label="What this step does" body={selectedStep.plainLanguage} />
                  <Section label="Inputs" body={selectedStep.inputs.join('\n') || 'None'} mono />
                  <Section label="Outputs" body={selectedStep.outputs.join('\n') || 'None'} mono />
                  <Section label="Selected options" body={selectedStep.selectedOptions.join('\n') || 'Defaults only'} />
                </div>
              )}

              {tab === 'commands' && (
                <pre className="m-0 whitespace-pre-wrap rounded-md border border-border bg-[#0e1320] p-3 text-[11px] leading-relaxed text-slate-100">
                  {selectedStep?.commands.join('\n\n') || 'No extracted commands.'}
                </pre>
              )}

              {tab === 'scripts' && (
                <pre className="m-0 whitespace-pre-wrap rounded-md border border-border bg-[#0e1320] p-3 text-[11px] leading-relaxed text-slate-100">
                  {selectedStep?.script || 'No generated script.'}
                </pre>
              )}

              {tab === 'json' && (
                <pre className="m-0 whitespace-pre-wrap rounded-md border border-border bg-[#0e1320] p-3 text-[11px] leading-relaxed text-slate-100">
                  {JSON.stringify(report, null, 2)}
                </pre>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-bg-secondary p-3">
      <div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-1 text-sm text-text-primary">{value}</div>
    </div>
  )
}

function Section({ label, body, mono = false }: { label: string; body: string; mono?: boolean }) {
  return (
    <div className="rounded-md border border-border bg-bg-secondary p-3">
      <div className="mb-2 text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className={mono ? 'whitespace-pre-wrap font-mono text-[11px] text-text-primary' : 'whitespace-pre-wrap text-sm text-text-primary'}>
        {body}
      </div>
    </div>
  )
}

function IssueSection({ issue }: { issue: NonNullable<RunManifest['runReadiness']>['issues'][number] }) {
  return (
    <div className="rounded-md border border-border bg-bg-secondary p-3">
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${severityClass(issue.severity)}`}>{issue.severity}</span>
        <span className="text-[10px] uppercase tracking-wide text-text-muted">{issue.category}</span>
        {issue.action && <span className="text-[10px] text-text-muted">Action: {issue.action}</span>}
      </div>
      <div className="mt-2 text-sm text-text-primary">{issue.message}</div>
      {issue.suggestion && <div className="mt-1 text-xs text-text-secondary">{issue.suggestion}</div>}
    </div>
  )
}

function severityClass(severity: 'error' | 'warning' | 'info'): string {
  if (severity === 'error') return 'bg-red-500/15 text-red-300'
  if (severity === 'warning') return 'bg-amber-500/15 text-amber-300'
  return 'bg-blue-500/15 text-blue-300'
}

function summarizeValidation(validation: RunManifest['validation']): string {
  if (!validation) return 'Not captured'
  if (validation.errorCount === 0 && validation.warningCount === 0) return 'No blocking validation issues'
  return `${validation.errorCount} errors, ${validation.warningCount} warnings`
}

function summarizeRunReadiness(runReadiness: RunManifest['runReadiness'], readiness: RunManifest['readiness']): string {
  if (runReadiness) {
    if (runReadiness.ok) return 'Ready'
    return `${runReadiness.errorCount} errors, ${runReadiness.warningCount} warnings`
  }
  if (!readiness) return 'Not captured'
  if (readiness.ok) return 'Ready'
  return `${readiness.blockingCount} blocking issue${readiness.blockingCount === 1 ? '' : 's'}`
}

function readinessText(report: RunManifest): string {
  const issues = report.runReadiness?.issues ?? []
  if (issues.length === 0) return 'No readiness issues captured.'
  return issues.map((issue) => [
    `[${issue.severity}] ${issue.category}: ${issue.message}`,
    issue.suggestion ? `Suggestion: ${issue.suggestion}` : null,
    issue.action ? `Action: ${issue.action}` : null,
  ].filter(Boolean).join('\n')).join('\n\n')
}

function transferText(report: RunManifest): string {
  const plans = report.transferPlans ?? []
  if (plans.length === 0) return 'No cross-backend transfers were planned for this run.'
  return plans.map((plan) => [
    `${plan.mode} ${plan.route}`,
    `Source: ${formatArtifact(plan.source)}`,
    `Target: ${formatArtifact(plan.target)}`,
    `Status: ${plan.status}`,
    plan.warnings?.length ? `Warnings: ${plan.warnings.join(' ')}` : null,
  ].filter(Boolean).join('\n')).join('\n\n')
}

function resultText(report: RunManifest): string {
  const cards = report.resultCards ?? []
  if (cards.length === 0) return 'No result cards were generated.'
  return cards.map((card) => [
    `${card.primary ? 'Primary' : 'Intermediate'} ${card.kind}: ${card.label}`,
    ...card.artifacts.map((artifact) => formatArtifact(artifact)),
  ].join('\n')).join('\n\n')
}

function formatArtifact(artifact: NonNullable<RunManifest['resultCards']>[number]['artifacts'][number]): string {
  const id = artifact.fileId ? ` (${artifact.fileId})` : ''
  const project = artifact.projectId ? ` project=${artifact.projectId}` : ''
  const type = artifact.fileType ? ` type=${artifact.fileType}` : ''
  return `${artifact.origin}:${artifact.path}${id}${project}${type}`
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
