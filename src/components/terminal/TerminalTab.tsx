import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

interface TerminalTabProps {
  terminalId: string
  active: boolean
}

const terminalTheme = {
  background: '#0f1419',
  foreground: '#e6edf3',
  cursor: '#4c9eed',
  cursorAccent: '#0f1419',
  selectionBackground: 'rgba(76, 158, 237, 0.3)',
  black: '#1a1f26',
  red: '#f85149',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#4c9eed',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#e6edf3',
}

export function TerminalTab({ terminalId, active }: TerminalTabProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  const fit = useCallback(() => {
    if (fitAddonRef.current && terminalRef.current && containerRef.current) {
      try {
        fitAddonRef.current.fit()
        window.api.terminal.resize(
          terminalId,
          terminalRef.current.cols,
          terminalRef.current.rows,
        )
      } catch {
        // Container may not be visible yet
      }
    }
  }, [terminalId])

  // Initialize terminal on mount
  useEffect(() => {
    if (!containerRef.current) return

    const terminal = new Terminal({
      theme: terminalTheme,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.open(containerRef.current)

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    // Initial fit
    fitAddon.fit()
    window.api.terminal.resize(terminalId, terminal.cols, terminal.rows)

    // Connect data flow: user input -> IPC
    const onDataDisposable = terminal.onData((data) => {
      window.api.terminal.write(terminalId, data)
    })

    // Connect data flow: IPC -> terminal output
    const unsub = window.api.terminal.onData(terminalId, (data: string) => {
      terminal.write(data)
    })

    // Handle remote close (e.g., user types "exit")
    const unsubClose = window.api.terminal.onClose(terminalId, () => {
      terminal.write('\r\n\x1b[33m[Session ended]\x1b[0m\r\n')
    })

    // Resize observer
    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current && terminalRef.current) {
        try {
          fitAddonRef.current.fit()
          window.api.terminal.resize(
            terminalId,
            terminalRef.current.cols,
            terminalRef.current.rows,
          )
        } catch {
          // Ignore resize errors when not visible
        }
      }
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      onDataDisposable.dispose()
      unsub()
      unsubClose()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [terminalId])

  // When becoming active, refit and focus
  useEffect(() => {
    if (active) {
      // Small delay to let layout settle after becoming visible
      const timer = setTimeout(() => {
        fit()
        terminalRef.current?.focus()
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [active, fit])

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ backgroundColor: '#0f1419' }}
    />
  )
}
