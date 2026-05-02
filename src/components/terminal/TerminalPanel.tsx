import { useCallback } from 'react'
import { useTerminalStore } from '@/stores/terminalStore'
import { LOCAL_CONNECTION_ID, useConnectionStore } from '@/stores/connectionStore'
import { Tabs } from '@/components/ui/Tabs'
import { Button } from '@/components/ui/Button'
import { TerminalTab } from './TerminalTab'
import { Plus, Terminal as TerminalIcon } from 'lucide-react'

export function TerminalPanel() {
  const { tabs, activeTabId, addTab, removeTab, setActiveTab } = useTerminalStore()
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const connections = useConnectionStore((s) => s.connections)

  const activeEntry = activeConnectionId ? connections[activeConnectionId] : null
  const isConnected = activeEntry?.status === 'connected'
  const isLocal = activeEntry?.isLocal ?? false

  const handleNewTerminal = useCallback(async () => {
    if (!activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID) return
    try {
      const result = await window.api.terminal.create(activeConnectionId)
      addTab(result, `Terminal ${tabs.length + 1}`)
    } catch (err) {
      console.error('Failed to create terminal:', err)
    }
  }, [activeConnectionId, addTab, tabs.length])

  // Not connected — prompt to connect
  if (!isConnected && tabs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-muted">
        <TerminalIcon size={32} strokeWidth={1.5} />
        <span className="text-sm">Connect to a server to open a terminal</span>
      </div>
    )
  }

  // Local mode — no remote terminal
  if (isLocal && tabs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-text-muted">
        <TerminalIcon size={32} strokeWidth={1.5} />
        <span className="text-sm">Terminal is available for remote SSH connections</span>
      </div>
    )
  }

  // Connected but no terminals yet
  if (tabs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <TerminalIcon size={32} strokeWidth={1.5} className="text-text-muted" />
        <Button variant="secondary" icon={<Plus size={14} />} onClick={handleNewTerminal}>
          New Terminal
        </Button>
      </div>
    )
  }

  const activeTerminalTab = tabs.find((t) => t.id === activeTabId)

  return (
    <div className="flex flex-col h-full">
      <Tabs
        tabs={tabs.map((t) => ({
          id: t.id,
          label: t.title,
          icon: <TerminalIcon size={14} />,
          closable: true,
        }))}
        activeId={activeTabId ?? tabs[0].id}
        onSelect={setActiveTab}
        onClose={(tabId) => {
          const tab = tabs.find((t) => t.id === tabId)
          if (tab) {
            window.api.terminal.close(tab.terminalId)
          }
          removeTab(tabId)
        }}
        rightContent={
          <button
            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
            onClick={handleNewTerminal}
            disabled={!activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID}
            title="New Terminal"
          >
            <Plus size={14} />
          </button>
        }
      />

      <div className="flex-1 min-h-0">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={tab.id === activeTabId ? 'h-full' : 'hidden'}
          >
            <TerminalTab
              terminalId={tab.terminalId}
              active={tab.id === activeTabId}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
