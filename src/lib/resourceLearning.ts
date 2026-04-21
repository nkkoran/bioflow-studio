import type { LearnedResourceSummary } from '@/types/ssh'

export interface SacctSample {
  jobId: string
  runtimeHours: number
  maxMemoryGB: number
}

export function parseSacctElapsedHours(raw: string): number {
  const text = raw.trim()
  if (!text) return 0
  const dayMatch = text.match(/^(\d+)-(\d{1,2}):(\d{2}):(\d{2})$/)
  if (dayMatch) {
    const [, days, hours, minutes, seconds] = dayMatch
    return Number(days) * 24 + Number(hours) + Number(minutes) / 60 + Number(seconds) / 3600
  }
  const fullMatch = text.match(/^(\d{1,2}):(\d{2}):(\d{2})$/)
  if (fullMatch) {
    const [, hours, minutes, seconds] = fullMatch
    return Number(hours) + Number(minutes) / 60 + Number(seconds) / 3600
  }
  const minuteMatch = text.match(/^(\d+):(\d{2})$/)
  if (minuteMatch) {
    const [, minutes, seconds] = minuteMatch
    return Number(minutes) / 60 + Number(seconds) / 3600
  }
  return 0
}

export function parseSacctMemoryGB(raw: string): number {
  const text = raw.trim()
  if (!text || text === '0' || text === 'Unknown') return 0
  const match = text.match(/^([0-9]*\.?[0-9]+)([KMGTP])(?:n|c)?$/i)
  if (!match) return 0
  const value = Number(match[1])
  const unit = match[2].toUpperCase()
  const factor =
    unit === 'K' ? 1 / 1_000_000
      : unit === 'M' ? 1 / 1_000
        : unit === 'G' ? 1
          : unit === 'T' ? 1_000
            : 1_000_000
  return value * factor
}

export function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1))
  return sorted[index]
}

export function summarizeSacctSamples(toolId: string, samples: SacctSample[]): LearnedResourceSummary | null {
  if (samples.length === 0) return null
  const runtime = samples.map((sample) => sample.runtimeHours)
  const memory = samples.map((sample) => sample.maxMemoryGB)
  return {
    toolId,
    sampleCount: samples.length,
    p50RuntimeHours: roundMetric(percentile(runtime, 0.5), 0.25),
    p90RuntimeHours: roundMetric(percentile(runtime, 0.9), 0.25),
    p90MemoryGB: roundMetric(percentile(memory, 0.9), 1),
    sourceJobIds: samples.map((sample) => sample.jobId),
    lastUpdated: Date.now(),
  }
}

function roundMetric(value: number, step: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.ceil(value / step) * step
}
