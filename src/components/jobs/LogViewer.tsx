/**
 * Log viewer — right pane of the Jobs panel.
 *
 * Reads stdout / stderr files from the remote host via SFTP. Not truly live
 * yet — we auto-refresh every 5s while the selected node is running, and
 * provide a manual Refresh button. True `tail -F` streaming is a planned
 * follow-up (needs a streaming exec channel on SshManager).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRunStore } from '@/stores/runStore'
import type { RunState, NodeRunState } from '@/types/pipeline'
import { Button } from '@/components/ui/Button'
import { RefreshCw } from 'lucide-react'

type Stream = 'stdout' | 'stderr'

interface Props {
  run: RunState
  connectionId: string
}

export function LogViewer({ run, connectionId }: Props) {
  const selectedNodeId = useRunStore((s) => s.selectedNodeId)
  const ns = selectedNodeId ? run.nodes[selectedNodeId] : null
  const [stream, setStream] = useState<Stream>('stdout')
  const [taskIdx, setTaskIdx] = useState(0)
  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLPreElement>(null)
  const autoScrollRef = useRef(true)

  // Resolve the actual log path for this stream/task. For arrays, the runner
  // stored `%a` as a placeholder — we substitute the real task index.
  const resolvedPath = ns ? resolveLogPath(ns, stream, taskIdx) : null

  const refresh = useCallback(async () => {
    if (!resolvedPath) { setContent(''); return }
    setLoading(true)
    setError(null)
    try {
      // Tail the last ~200 lines via a remote `tail` — avoids pulling megabytes
      // when a job has been running a while. window.api.sftp.head only reads
      // from the start; we use the raw file read with no offset for now.
      // (When we wire a streaming exec channel later this becomes proper tail.)
      const text = await window.api.sftp.read(connectionId, resolvedPath)
      setContent(text ?? '')
      // Scroll to bottom on fresh load if auto-scroll is engaged.
      setTimeout(() => {
        if (autoScrollRef.current && scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
      }, 0)
    } catch (err: any) {
      const msg = String(err?.message ?? err)
      // File doesn't exist yet — common while the job is still queued.
      if (msg.includes('No such file') || msg.includes('code 2')) {
        setContent('')
        setError('Log file not available yet (job still queued?).')
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }, [connectionId, resolvedPath])

  // Fetch on selection or stream/task change.
  useEffect(() => { void refresh() }, [refresh])

  // Auto-refresh every 5s while the selected node is running. Stops on
  // terminal states so we don't hammer the cluster after jobs finish.
  useEffect(() => {
    if (!ns) return
    if (ns.status !== 'running' && ns.status !== 'queued') return
    const t = setInterval(() => { void refresh() }, 5000)
    return () => clearInterval(t)
  }, [ns, refresh])

  // Track whether the user has scrolled up — if so, disable auto-scroll.
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20
    autoScrollRef.current = atBottom
  }

  if (!ns) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-text-muted">
        Select a node to view its logs.
      </div>
    )
  }

  const isArray = ns.isArray && (ns.arraySize ?? 0) > 0

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Header: stream tabs + task selector + refresh */}
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
          onClick={() => void refresh()}
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
        {!error && content.length === 0 && !loading && (
          <div className="text-text-muted italic">— empty —</div>
        )}
        {content}
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
 * Turn the stored `%a` placeholder into a concrete task index for arrays.
 * Non-array jobs: path is already concrete (stored with the real job id at
 * submission time), so we just return it unchanged.
 */
function resolveLogPath(ns: NodeRunState, stream: Stream, taskIdx: number): string | null {
  const raw = stream === 'stdout' ? ns.stdoutPath : ns.stderrPath
  if (!raw) return null
  if (!ns.isArray) return raw
  return raw.replace('%a', String(taskIdx))
}
