import { Folder } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/Button'
import { useConnectionStore } from '@/stores/connectionStore'
import { RemoteFileBrowser } from './RemoteFileBrowser'
import { RemotePathInput } from './RemotePathInput'

interface RemotePathFieldProps {
  label?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  mode?: 'file' | 'directory'
  title: string
  accept?: string[]
  buttonLabel?: string
  className?: string
  error?: string
}

export function RemotePathField({
  label,
  value,
  onChange,
  placeholder,
  mode = 'file',
  title,
  accept,
  buttonLabel = 'Browse',
  className,
  error,
}: RemotePathFieldProps) {
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId)
  const [open, setOpen] = useState(false)

  return (
    <div className={`flex flex-col gap-1 ${className ?? ''}`}>
      {label && <label className="text-text-secondary text-xs font-medium">{label}</label>}
      <div className="flex items-end gap-1.5">
        <RemotePathInput
          value={value}
          placeholder={placeholder}
          onChange={onChange}
          mode={mode}
          className="flex-1"
        />
        <Button
          variant="secondary"
          size="sm"
          className="h-8 shrink-0 px-2"
          title={activeConnectionId ? `Browse ${mode === 'directory' ? 'folders' : 'files'}` : 'Connect first to browse remote paths'}
          disabled={!activeConnectionId}
          onClick={() => setOpen(true)}
        >
          <Folder size={12} className="mr-1" />
          {buttonLabel}
        </Button>
      </div>
      <RemoteFileBrowser
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        mode={mode === 'directory' ? 'directory' : 'file'}
        initialPath={value}
        accept={accept}
        onSelect={(paths) => {
          if (paths[0]) onChange(paths[0])
        }}
      />
      {error && <span className="text-error text-xs">{error}</span>}
    </div>
  )
}
