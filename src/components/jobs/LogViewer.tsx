/**
 * Log viewer — right pane of the Jobs panel.
 *
 * Non-array jobs: content comes from the runStore ring buffer, which is
 * populated by `pipeline:job-log` streaming events (tail -F over SSH).
 * The display updates live as new chunks arrive — no polling needed.
 *
 * Array jobs: no per-task streaming (22+ tail -F channels would be
 * expensive), so we fall back to SFTP reads with a 5s auto-refresh while
 * the job is running.
 *
 * The Refresh button always re-reads from SFTP and replaces the buffer,
 * which is useful for seeing the full file after the job finishes or for
 * recovering if streaming missed content.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRunStore } from '@/stores/runStore'
import type { RunState, NodeRunState } from '@/types/pipeline'
import { Button } from '@/components/ui/Button'
import { RefreshCw } from 'lucide-react'

type Stream = 'stdout' | 'stderr'

/**
 * Stable empty-array reference used as a fallback in the Zustand selector.
 *
 * Without this, `s.logs[nodeId]?.[stream] ?? []` would allocate a fresh `[]`
 * every render. Zustand's default equality is reference comparison, so a new
 * `[]` each time means the selector reports a change on every render, which
 * re-renders the component, which re-runs the selector — an infinite loop
 * that trips React's "Maximum update depth exceeded" guard.
 */
const EMPTY_LINES: readonly string[] = Object.freeze([])

interface Props {
  run: RunState
  connectionId: string
}

export function LogViewer({ run, connectionId }: Props) {
  const selectedNodeId = useRunStore((s) => s.selectedNodeId)
  const setLog = useRunStore((s) => s.setLog)
  const ns = selectedNodeId ? run.nodes[selectedNodeId] : null

  const [stream, setStream] = useState<Stream>('stdout')
  const [taskIdx, setTaskIdx] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scrollRef = useRef<HTMLPreElement>(null)
  const autoScrollRef = useRef(true)

  // For non-array: subscribe to the live ring buffer. Use the module-level
  // EMPTY_LINES constant so the selector returns a stable reference when the
  // buffer is empty — a fresh `[]` here causes an infinite re-render loop.
  const logLines = useRunStore((s) =>
    ns && !ns.isArray ? (s.logs[ns.nodeId]?.[stream] ?? EMPTY_LINES) : EMPTY_LINES,
  ) as readonly string[]

  // The concrete log file path (null when not yet known or array-with-placeholder).
  const resolvedPath = ns ? resolveLogPath(ns, stream, taskIdx) : null

  // ── SFTP read ────────────────────────────────────────────────────────────
  // Used for: array jobs (all reads), non-array jobs (manual Refresh only).

  const sftpRefresh = useCallback(async () => {
    if (!ns) return
    if (!resolvedPath) {
      // Refresh pressed before the runner has reported stdoutPath/stderrPath.
      // Surface it so the user knows why nothing happened.
      setError('Log path not known yet — wait for the job to be submitted.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const text = await window.api.sftp.read(connectionId, resolvedPath)
      const lines = (text ?? '').split('\n')
      setLog(ns.nodeId, stream, lines)
    } catch (err: any) {
      const msg = String(err?.message ?? err)
      if (msg.includes('No such file') || msg.includes('code 2')) {
        setError('Log file not available yet (job still queued?).')
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }, [connectionId, resolvedPath, ns, stream, setLog])

  // Load via SFTP on initial selection AND when a non-array job transitions
  // into a terminal state — streaming (tail -F) may have ended before the
  // final bytes flushed, so we always do one last SFTP pull.
  useEffect(() => {
    if (!ns) return
    const isTerminal = ns.status === 'done' || ns.status === 'failed' || ns.status === 'cancelled'
    if (ns.isArray || isTerminal) {
      void sftpRefresh()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ns?.nodeId, ns?.status, stream, taskIdx])

  // Array jobs: auto-refresh while running.
  useEffect(() => {
    if (!ns?.isArray) return
    if (ns.status !== 'running' && ns.status !== 'queued') return
    const t = setInterval(() => { void sftpRefresh() }, 5000)
    return () => clearInterval(t)
  }, [ns?.isArray, ns?.status, sftpRefresh])

  // Auto-scroll to bottom when new log content arrives (if user hasn't scrolled up).
  useEffect(() => {
    if (!autoScrollRef.current || !scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [logLines])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 20
  }

  // ── Render ───────────────────────────────────────────────────────────────

  if (!ns) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-text-muted">
        Select a node to view its logs.
      </div>
    )
  }

  const isArray = !!ns.isArray && (ns.arraySize ?? 0) > 0
  const displayContent = logLines.join('\n')

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-light shrink-0">
        <StreamTab label="stdout" active={stream === 'stdout'} onClick={() => setStream('stdout')} />
        <StreamTab label="stderr" active={stream === 'stderr'} onClick={() => setStream('stderr')} />

        {isArray && (
          <>
            <span className="text-[10px] text-text-muted ml-2">task:</span>
            <select
              value={taskIdx}
              onChange={(e) => setTaskIdx(Number(e.target.value))}
              className="bg-bg-primary border border-border rounded px-1.5 py-0.5 text-[10px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            >
              {Array.from({ length: ns.arraySize ?? 0 }, (_, i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </>
        )}

        <div className="flex-1" />

        <span className="text-[10px] text-text-muted font-mono truncate max-w-[60%]" title={resolvedPath ?? ''}>
          {resolvedPath}
        </span>

        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw size={11} className={loading ? 'animate-spin' : ''} />}
          onClick={() => void sftpRefresh()}
          disabled={loading}
          className="h-6 px-2 text-[10px]"
        >
          Refresh
        </Button>
      </div>

      {/* Log body */}
      <pre
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-auto m-0 px-3 py-2 text-[11px] leading-relaxed font-mono bg-bg-primary text-text-primary whitespace-pre-wrap break-all"
      >
        {error && <div className="text-warning italic">{error}</div>}
        {!error && displayContent.length === 0 && !loading && (
          <div className="text-text-muted italic">
            {ns.status === 'queued' ? 'Waiting for job to start…' : '— empty —'}
          </div>
        )}
        {displayContent}
      </pre>
    </div>
  )
}

function StreamTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 text-[10px] font-mono rounded ${
        active
          ? 'bg-bg-hover text-text-primary'
          : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
      }`}
    >
      {label}
    </button>
  )
}

/**
 * Resolve the `%a` placeholder in array log paths to a concrete task index.
 * Non-array paths are returned unchanged.
 */
function resolveLogPath(ns: NodeRunState, stream: Stream, taskIdx: number): string | null {
  const raw = stream === 'stdout' ? ns.stdoutPath : ns.stderrPath
  if (!raw) return null
  if (!ns.isArray) return raw
  return raw.replace('%a', String(taskIdx))
}
