import { useEffect, useMemo, useRef, useState } from 'react'

import { useConnectionStore, LOCAL_CONNECTION_ID } from '@/stores/connectionStore'
import { autocompleteContext, collapseHomePath } from '@/lib/remotePath'
import type { RemoteFileEntry } from '@/types'
import type { FileOrigin } from '@/constants/connections'

interface RemotePathInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  mode?: 'file' | 'directory'
  className?: string
  minPrefixChars?: number
  origin?: FileOrigin
  projectId?: string | null
}

export function RemotePathInput({
  value,
  onChange,
  placeholder,
  mode = 'file',
  className,
  minPrefixChars = 2,
  origin,
  projectId,
}: RemotePathInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const effectiveOrigin: FileOrigin = origin ?? (activeConnectionId === LOCAL_CONNECTION_ID ? 'local' : 'ssh')
  const [focused, setFocused] = useState(false)
  const [homeDir, setHomeDir] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<RemoteFileEntry[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const requestIdRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    async function loadHome() {
      if (effectiveOrigin === 'dnx') {
        if (!cancelled) setHomeDir(null)
        return
      }
      if (effectiveOrigin === 'local') {
        const home = await window.api.local.homedir()
        if (!cancelled) setHomeDir(home)
        return
      }
      if (!activeConnectionId || activeConnectionId === LOCAL_CONNECTION_ID) return
      const result = await window.api.ssh.exec(activeConnectionId, 'printf %s "$HOME"')
      if (!cancelled) setHomeDir(result.stdout.trim() || null)
    }
    void loadHome().catch(() => {
      if (!cancelled) setHomeDir(null)
    })
    return () => { cancelled = true }
  }, [activeConnectionId, effectiveOrigin])

  useEffect(() => {
    const canSuggest = effectiveOrigin === 'local'
      || (effectiveOrigin === 'ssh' && Boolean(activeConnectionId && activeConnectionId !== LOCAL_CONNECTION_ID))
      || (effectiveOrigin === 'dnx' && Boolean(projectId))
    if (!focused || !canSuggest) {
      setSuggestions([])
      return
    }
    const { dir, prefix } = autocompleteContext(value, homeDir)
    const normalizedPrefix = prefix.trim()
    const minChars = prefix.length === 0 ? 0 : minPrefixChars
    if (normalizedPrefix.length < minChars) {
      setSuggestions([])
      return
    }
    let cancelled = false
    const requestId = ++requestIdRef.current
    const timer = window.setTimeout(() => {
      const list = effectiveOrigin === 'local'
        ? window.api.local.ls(dir)
        : effectiveOrigin === 'dnx'
          ? window.api.dnx.listFiles({ projectId: projectId!, path: dir })
          : window.api.sftp.ls(activeConnectionId!, dir)
      void list.then((entries) => {
        if (cancelled || requestId !== requestIdRef.current) return
        const needle = normalizedPrefix.toLowerCase()
        const filtered = [...entries]
          .filter((entry) => entry.name.toLowerCase().includes(needle))
          .filter((entry) => mode === 'directory' ? entry.isDirectory : true)
          .sort((a, b) => {
            const aStarts = a.name.toLowerCase().startsWith(needle)
            const bStarts = b.name.toLowerCase().startsWith(needle)
            if (aStarts !== bStarts) return aStarts ? -1 : 1
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
            return a.name.localeCompare(b.name, undefined, { numeric: true })
          })
          .slice(0, 20)
        setSuggestions(filtered)
        setActiveIndex(0)
      }).catch(() => {
        if (!cancelled && requestId === requestIdRef.current) setSuggestions([])
      })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activeConnectionId, effectiveOrigin, focused, homeDir, minPrefixChars, mode, projectId, value])

  const renderedSuggestions = useMemo(() => suggestions.map((entry) => ({
    ...entry,
    displayPath: collapseHomePath(entry.path, homeDir),
  })), [homeDir, suggestions])

  const applySuggestion = (entry: RemoteFileEntry) => {
    const next = collapseHomePath(
      entry.isDirectory && mode === 'directory' ? entry.path : entry.path,
      homeDir,
    )
    onChange(next)
    setSuggestions([])
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => window.setTimeout(() => setFocused(false), 120)}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (suggestions.length === 0) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActiveIndex((index) => Math.min(index + 1, suggestions.length - 1))
            return
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActiveIndex((index) => Math.max(index - 1, 0))
            return
          }
          if (e.key === 'Tab') {
            e.preventDefault()
            const entry = suggestions[activeIndex] ?? suggestions[0]
            if (!entry) return
            const collapsed = collapseHomePath(entry.path, homeDir)
            onChange(entry.isDirectory ? `${collapsed}/` : collapsed)
            return
          }
          if (e.key === 'Enter') {
            const entry = suggestions[activeIndex]
            if (!entry) return
            e.preventDefault()
            applySuggestion(entry)
          }
        }}
        className={`bioflow-field h-8 w-full rounded-md px-3 text-sm text-text-primary placeholder-text-muted outline-none transition-colors ${className ?? ''}`}
      />
      {focused && renderedSuggestions.length > 0 && (
        <div className="surface-popover absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-md py-1">
          {renderedSuggestions.map((entry, index) => (
            <button
              key={entry.path}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault()
                applySuggestion(entry)
              }}
              className={`block w-full truncate px-2 py-1.5 text-left text-xs ${
                index === activeIndex ? 'bg-accent/10 text-text-primary' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              {entry.displayPath}{entry.isDirectory && !entry.displayPath.endsWith('/') ? '/' : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
