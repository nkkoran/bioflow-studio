import { useEffect, useState } from 'react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useDialogStore } from '@/stores/dialogStore'

export function AppDialogs() {
  const active = useDialogStore((s) => s.active)
  const resolveActive = useDialogStore((s) => s.resolveActive)
  const clear = useDialogStore((s) => s.clear)
  const [promptValue, setPromptValue] = useState('')

  useEffect(() => {
    setPromptValue(active?.defaultValue ?? '')
  }, [active?.defaultValue, active?.id])

  if (!active) return null

  const close = () => {
    if (active.kind === 'confirm') resolveActive(false)
    else if (active.kind === 'prompt') resolveActive(null)
    else resolveActive(undefined)
    clear()
  }

  const confirm = () => {
    if (active.kind === 'prompt') resolveActive(promptValue)
    else if (active.kind === 'confirm') resolveActive(true)
    else resolveActive(undefined)
    clear()
  }

  return (
    <Dialog
      open
      onClose={close}
      title={active.title}
      width="max-w-lg"
      footer={(
        <>
          {active.kind !== 'alert' && (
            <Button variant="secondary" onClick={close}>
              {active.cancelLabel ?? 'Cancel'}
            </Button>
          )}
          <Button variant={active.danger ? 'danger' : 'primary'} onClick={confirm}>
            {active.confirmLabel ?? (active.kind === 'alert' ? 'OK' : 'Continue')}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-text-primary leading-relaxed">{active.message}</p>
        {active.detail && (
          <div className="rounded-md border border-border bg-bg-tertiary/60 px-3 py-2 text-xs leading-relaxed text-text-muted whitespace-pre-wrap">
            {active.detail}
          </div>
        )}
        {active.kind === 'prompt' && (
          <Input
            autoFocus
            value={promptValue}
            placeholder={active.placeholder}
            onChange={(e) => setPromptValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirm()
            }}
          />
        )}
      </div>
    </Dialog>
  )
}
