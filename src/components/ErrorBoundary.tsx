/**
 * Top-level ErrorBoundary.
 *
 * A throw from a render function or a useEffect without a try/catch
 * unmounts the whole React tree by default — the user sees a blank window.
 * Wrapping the app root in this boundary turns those failures into a visible
 * error card with the stack trace, so we can recover with Reload instead of
 * guessing from a blank screen.
 */
import { Component, type ReactNode, type ErrorInfo } from 'react'
import { useDataPreviewStore } from '@/stores/dataPreviewStore'
import { useUIStore } from '@/stores/uiStore'
import { exportBugReport } from '@/lib/bugReport'

interface Props { children: ReactNode }
interface State { error: Error | null; info: ErrorInfo | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] render crash:', error, info)
    this.setState({ error, info })
  }

  handleReload = (): void => {
    window.location.reload()
  }

  handleReset = (): void => {
    useDataPreviewStore.getState().clearTabs()
    useUIStore.getState().setBottomPanelMode('terminal')
    this.setState({ error: null, info: null })
  }

  handleBugReport = async (): Promise<void> => {
    const reportDir = await exportBugReport({
      title: 'render-crash',
      reason: this.state.error?.message ?? 'Render crash',
      extra: {
        componentStack: this.state.info?.componentStack ?? '',
        errorStack: this.state.error?.stack ?? '',
      },
    })
    if (reportDir) {
      window.alert(`Bug report written to:\n${reportDir}`)
    }
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="fixed inset-0 flex items-center justify-center bg-bg-primary text-text-primary p-8 overflow-auto">
        <div className="max-w-2xl w-full bg-bg-secondary border border-error/50 rounded-lg p-6 shadow-2xl">
          <h2 className="text-lg font-semibold text-error mb-2">Something went wrong</h2>
          <p className="text-sm text-text-secondary mb-4">
            The app hit an unexpected error. Your pipeline canvas state is preserved —
            clicking <b>Dismiss</b> will attempt to recover without losing unsaved work.
            If the error repeats, click <b>Reload</b> to restart the window.
          </p>
          <pre className="text-[11px] font-mono bg-bg-primary border border-border rounded p-3 max-h-64 overflow-auto text-error whitespace-pre-wrap break-all">
            {this.state.error.message}
            {this.state.info?.componentStack ? `\n\nComponent stack:${this.state.info.componentStack}` : ''}
          </pre>
          <div className="flex gap-2 mt-4 justify-end">
            <button
              onClick={() => void this.handleBugReport()}
              className="px-3 py-1.5 text-xs rounded bg-bg-primary border border-border hover:bg-bg-hover"
            >
              Create bug report
            </button>
            <button
              onClick={this.handleReset}
              className="px-3 py-1.5 text-xs rounded bg-bg-primary border border-border hover:bg-bg-hover"
            >
              Dismiss
            </button>
            <button
              onClick={this.handleReload}
              className="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/90"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
