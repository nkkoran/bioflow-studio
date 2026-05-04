import { Folder } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/Button'
import { useConnectionStore } from '@/stores/connectionStore'
import { classNames } from '@/lib/utils'
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
  compact?: boolean
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
  compact = false,
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
          className={classNames('flex-1', compact && 'h-6 px-2 text-[10px]')}
        />
        <Button
          variant="secondary"
          size="sm"
          className={classNames('shrink-0', compact ? 'h-6 px-1.5 text-[10px]' : 'h-8 px-2')}
          title={activeConnectionId ? `Browse ${mode === 'directory' ? 'folders' : 'files'}` : 'Connect first to browse remote paths'}
          disabled={!activeConnectionId}
          onClick={() => setOpen(true)}
        >
          <Folder size={compact ? 10 : 12} className={buttonLabel ? 'mr-1' : undefined} />
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
