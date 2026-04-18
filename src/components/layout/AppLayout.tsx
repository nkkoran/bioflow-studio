import { useCallback, useRef, useEffect } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { useRunStore } from '@/stores/runStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { savePipelineSnapshot } from '@/lib/pipelinePersistence'
import { TopBar } from './TopBar'
import { Sidebar } from './Sidebar'
import { CenterPanel } from './CenterPanel'
import { BottomPanel } from './BottomPanel'
import { MfaPrompt } from '@/components/connection/MfaPrompt'

const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 480
const BOTTOM_MIN = 120
const BOTTOM_MAX = 600

export function AppLayout() {
  const sidebarWidth = useUIStore((s) => s.sidebarWidth)
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth)
  const bottomPanelHeight = useUIStore((s) => s.bottomPanelHeight)
  const setBottomPanelHeight = useUIStore((s) => s.setBottomPanelHeight)

  const dragging = useRef<'sidebar' | 'bottom' | null>(null)
  const startPos = useRef(0)
  const startSize = useRef(0)

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging.current) return

      if (dragging.current === 'sidebar') {
        const delta = e.clientX - startPos.current
        const newWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startSize.current + delta))
        setSidebarWidth(newWidth)
      } else {
        const delta = startPos.current - e.clientY
        const newHeight = Math.min(BOTTOM_MAX, Math.max(BOTTOM_MIN, startSize.current + delta))
        setBottomPanelHeight(newHeight)
      }
    },
    [setSidebarWidth, setBottomPanelHeight],
  )

  const onMouseUp = useCallback(() => {
    dragging.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  useEffect(() => {
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [onMouseMove, onMouseUp])

  // Subscribe to pipeline run events from the main process. This forwards
  // per-node status transitions into pipelineStore so canvas badges update
  // live, and mirrors run state into runStore for the Jobs panel / toolbar.
  //
  // Wrapped in try/catch: if the preload is stale and a listener function is
  // missing, we'd throw synchronously from the effect body. React 18 would
  // unmount the tree and the user would see a blank window. Swallow the error
  // (runStore.subscribeToEvents already guards each listener individually;
  // this is belt-and-suspenders for the refreshRuns call and any future ones).
  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = useRunStore.getState().subscribeToEvents()
      void useRunStore.getState().refreshRuns().catch((err) => {
        console.error('[AppLayout] refreshRuns failed:', err)
      })
    } catch (err) {
      console.error('[AppLayout] subscribeToEvents failed:', err)
    }
    // Re-populate the connection store from whatever ssh2 Clients the main
    // process is still holding. After a renderer reload, the UI would
    // otherwise show "not connected" even though the SSH session is alive.
    void useConnectionStore.getState().hydrateFromMain().catch((err) => {
      console.error('[AppLayout] hydrateFromMain failed:', err)
    })
    void useSettingsStore.getState().load().catch((err) => {
      console.error('[AppLayout] load settings failed:', err)
    })
    return () => { try { unsubscribe?.() } catch (e) { console.error(e) } }
  }, [])

  useEffect(() => {
    let disposed = false
    void window.api.store.get<any>('pipeline:autosave:latest').then((snapshot) => {
      if (disposed || !snapshot || snapshot.version !== 1) return
      const state = usePipelineStore.getState()
      if (!state.dirty && state.nodes.length === 0) state.loadSnapshot(snapshot)
    }).catch((err) => console.error('[AppLayout] autosave restore failed:', err))

    const runAutosave = async () => {
      const settings = useSettingsStore.getState().settings
      const state = usePipelineStore.getState()
      if (!settings.autosaveEnabled || !state.dirty) return
      const snapshot = state.exportSnapshot()
      await savePipelineSnapshot(snapshot)
      usePipelineStore.getState().markSaved()
    }
    const startTimer = () => {
      const seconds = Math.max(5, useSettingsStore.getState().settings.autosaveIntervalSeconds || 15)
      return window.setInterval(() => {
        void runAutosave().catch((err) => console.error('[AppLayout] autosave write failed:', err))
      }, seconds * 1000)
    }
    let timer = startTimer()
    const unsubscribeSettings = useSettingsStore.subscribe(() => {
      window.clearInterval(timer)
      timer = startTimer()
    })
    return () => {
      disposed = true
      window.clearInterval(timer)
      unsubscribeSettings()
    }
  }, [])

  const startSidebarDrag = useCallback(
    (e: React.MouseEvent) => {
      dragging.current = 'sidebar'
      startPos.current = e.clientX
      startSize.current = sidebarWidth
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [sidebarWidth],
  )

  const startBottomDrag = useCallback(
    (e: React.MouseEvent) => {
      dragging.current = 'bottom'
      startPos.current = e.clientY
      startSize.current = bottomPanelHeight
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [bottomPanelHeight],
  )

  return (
    <div className="flex flex-col h-screen w-screen bg-bg-primary text-text-primary overflow-hidden">
      <TopBar />
      <MfaPrompt />

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <Sidebar width={sidebarWidth} />

        {/* Sidebar resize handle */}
        <div
          className="w-1 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors shrink-0"
          onMouseDown={startSidebarDrag}
        />

        {/* Main area: center + bottom */}
        <div className="flex flex-col flex-1 min-w-0">
          <CenterPanel />

          {/* Bottom panel resize handle */}
          <div
            className="h-1 cursor-row-resize hover:bg-accent/30 active:bg-accent/50 transition-colors shrink-0"
            onMouseDown={startBottomDrag}
          />

          <BottomPanel height={bottomPanelHeight} />
        </div>
      </div>
    </div>
  )
}
