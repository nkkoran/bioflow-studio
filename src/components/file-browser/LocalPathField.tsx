import { Folder } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

interface LocalPathFieldProps {
  label?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  mode?: 'file' | 'directory'
  error?: string
  className?: string
}

export function LocalPathField({
  label,
  value,
  onChange,
  placeholder,
  mode = 'file',
  error,
  className,
}: LocalPathFieldProps) {
  return (
    <div className={`flex flex-col gap-1 ${className ?? ''}`}>
      {label && <label className="text-text-secondary text-xs font-medium">{label}</label>}
      <div className="flex items-end gap-1.5">
        <Input
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="flex-1"
        />
        <Button
          variant="secondary"
          size="sm"
          className="h-8 shrink-0 px-2"
          title={mode === 'directory' ? 'Browse local folder' : 'Browse local file'}
          onClick={async () => {
            const path = mode === 'directory'
              ? await window.api.dialog.openDirectory({ defaultPath: value || undefined })
              : await window.api.dialog.openFile({ defaultPath: value || undefined })
            if (path) onChange(path)
          }}
        >
          <Folder size={12} className="mr-1" />
          Browse
        </Button>
      </div>
      {error && <span className="text-error text-xs">{error}</span>}
    </div>
  )
}
