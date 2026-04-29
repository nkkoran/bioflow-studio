import { useCallback, useRef, useEffect, useState } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { useRunStore } from '@/stores/runStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useDnxStore } from '@/stores/dnxStore'
import { TopBar } from './TopBar'
import { Sidebar } from './Sidebar'
import { CenterPanel } from './CenterPanel'
import { BottomPanel } from './BottomPanel'
import { MfaPrompt } from '@/components/connection/MfaPrompt'
import { LoginPolicyToast } from '@/components/connection/LoginPolicyToast'
import { DnxBridgeBanner } from '@/components/connection/DnxBridgeBanner'
import { AppDialogs } from '@/components/ui/AppDialogs'
import { Toaster } from '@/components/ui/Toaster'
import { WelcomeWizard } from '@/components/onboarding/WelcomeWizard'
import { GuidedTour } from '@/components/onboarding/GuidedTour'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useCustomNodesStore } from '@/stores/customNodesStore'
import { savePipelineSnapshot } from '@/lib/pipelinePersistence'
import { exportBugReport } from '@/lib/bugReport'

const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 480
const BOTTOM_MIN = 120
const BOTTOM_MAX = 600

export function AppLayout() {
  const [windowDragActive, setWindowDragActive] = useState(false)
  const sidebarWidth = useUIStore((s) => s.sidebarWidth)
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth)
  const bottomPanelHeight = useUIStore((s) => s.bottomPanelHeight)
  const setBottomPanelHeight = useUIStore((s) => s.setBottomPanelHeight)
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const theme = useUIStore((s) => s.theme)
  const setTheme = useUIStore((s) => s.setTheme)
  const devMode = useSettingsStore((s) => s.devMode)
  const [tourRun, setTourRun] = useState(false)

  const dragging = useRef<'sidebar' | 'bottom' | null>(null)
  const dragDepth = useRef(0)
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
    void useSettingsStore.getState().load().then(() => {
      const pipeline = usePipelineStore.getState()
      const settings = useSettingsStore.getState().settings
      if (!pipeline.dirty && pipeline.nodes.length === 0) {
        usePipelineStore.setState({
          arrayChainMode: settings.arrayChainMode,
          fileLifecyclePolicy: settings.fileLifecyclePolicy,
        })
      }
      void window.api.store.get<'dark' | 'light' | 'simple'>('settings:theme').then((stored) => {
        if (stored === 'dark' || stored === 'light' || stored === 'simple') {
          setTheme(stored)
          return
        }
        setTheme('dark')
        void window.api.store.set('settings:theme', 'dark')
      })
    }).catch((err) => {
      console.error('[AppLayout] load settings failed:', err)
    })
    void useCustomNodesStore.getState().load().catch((err) => {
      console.error('[AppLayout] load custom nodes failed:', err)
    })
    void useWorkspaceStore.getState().load().then(() => {
      void useWorkspaceStore.getState().applyActiveWorkspace(useConnectionStore.getState().activeConnectionId)
    }).catch((err) => {
      console.error('[AppLayout] load workspaces failed:', err)
    })
    void useUIStore.getState().loadAdvancedExpanded().catch((err) => {
      console.error('[AppLayout] load advanced params state failed:', err)
    })
    void useDnxStore.getState().load().catch((err) => {
      console.error('[AppLayout] load DNX state failed:', err)
    })
    const unsubscribeDnx = useDnxStore.getState().subscribeToEvents()
    return () => {
      try { unsubscribe?.() } catch (e) { console.error(e) }
      try { unsubscribeDnx() } catch (e) { console.error(e) }
    }
  }, [])

  useEffect(() => {
    document.body.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    void useWorkspaceStore.getState().applyActiveWorkspace(activeConnectionId).catch((err) => {
      console.error('[AppLayout] apply workspace failed:', err)
    })
  }, [activeConnectionId])

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const inEditable = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      if (inEditable && !event.shiftKey) {
        // Preserve the shortcut, but don't interfere with the field value.
      }
      window.dispatchEvent(new CustomEvent('bioflow:menu-command', {
        detail: { command: event.shiftKey ? 'saveAs' : 'save' },
      }))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!window.api.app?.onMenuCommand) return
    return window.api.app.onMenuCommand((data) => {
      if (data.command === 'tour') {
        setTourRun(true)
        return
      }
      if (data.command === 'bugReport') {
        void exportBugReport({ title: 'BioFlow Studio bug report', reason: 'User exported from Help menu' })
          .then((dir) => {
            if (dir) window.dispatchEvent(new CustomEvent('bioflow:toast', { detail: { kind: 'success', message: `Bug report saved to ${dir}` } }))
          })
          .catch((err) => {
            window.dispatchEvent(new CustomEvent('bioflow:toast', { detail: { kind: 'error', message: `Bug report failed: ${err instanceof Error ? err.message : String(err)}` } }))
          })
        return
      }
      if (data.command === 'settings') {
        useUIStore.getState().openSettings('General')
        return
      }
      if (data.command === 'addConnection') {
        useUIStore.getState().openConnectionDialog()
        return
      }
      window.dispatchEvent(new CustomEvent('bioflow:menu-command', { detail: data }))
    })
  }, [])

  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth.current = Math.max(1, dragDepth.current)
      setWindowDragActive(true)
    }
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      dragDepth.current += 1
      setWindowDragActive(true)
    }
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setWindowDragActive(false)
    }
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth.current = 0
      setWindowDragActive(false)
      const paths = Array.from(event.dataTransfer?.files ?? [])
        .map((file) => window.api.local.pathForFile(file))
        .filter(Boolean)
      if (paths.length === 0) return
      window.dispatchEvent(new CustomEvent('bioflow:global-file-drop', {
        detail: { clientX: event.clientX, clientY: event.clientY, paths },
      }))
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
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
      <AppDialogs />
      <Toaster />
      <WelcomeWizard />
      <GuidedTour run={tourRun} onDone={() => setTourRun(false)} />
      <MfaPrompt />
      <LoginPolicyToast />
      {devMode && <DnxBridgeBanner />}
      {windowDragActive && (
        <div className="pointer-events-none fixed inset-0 z-[80] flex items-center justify-center bg-accent/10 backdrop-blur-[1px]">
          <div className="rounded-2xl border border-accent/30 bg-bg-secondary/95 px-6 py-4 text-sm text-text-primary shadow-2xl">
            Drop file here to add it to the pipeline
          </div>
        </div>
      )}

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
