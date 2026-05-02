import { useState, useEffect, useCallback, useRef } from 'react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { ShieldCheck } from 'lucide-react'

interface PromptRequest {
  promptId: string
  title: string
  message: string
  detail?: string
  isPassword: boolean
  placeholder?: string
}

/**
 * Global MFA/2FA prompt dialog.
 *
 * Listens for `ssh:prompt` events from the main process (triggered during
 * keyboard-interactive auth, e.g., Compute Canada MFA). Shows a dialog
 * asking the user for their MFA response, then sends the response back.
 */
export function MfaPrompt() {
  const [request, setRequest] = useState<PromptRequest | null>(null)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const cleanup = window.api.ssh.onPrompt((data) => {
      setRequest(data)
      setValue('')
    })
    return cleanup
  }, [])

  // Auto-focus input when dialog opens
  useEffect(() => {
    if (request) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [request])

  const handleSubmit = useCallback(() => {
    if (!request) return
    window.api.ssh.respondToPrompt(request.promptId, value)
    setRequest(null)
    setValue('')
  }, [request, value])

  const handleCancel = useCallback(() => {
    if (!request) return
    window.api.ssh.respondToPrompt(request.promptId, null)
    setRequest(null)
    setValue('')
  }, [request])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit],
  )

  if (!request) return null

  const footer = (
    <>
      <Button variant="secondary" onClick={handleCancel}>
        Cancel
      </Button>
      <Button variant="primary" onClick={handleSubmit}>
        Submit
      </Button>
    </>
  )

  return (
    <Dialog
      open={true}
      onClose={handleCancel}
      title={request.title}
      footer={footer}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 text-text-secondary">
          <ShieldCheck size={24} className="text-accent shrink-0" />
          <p className="text-sm">{request.message}</p>
        </div>
        {request.detail && (
          <div className="rounded-md border border-border bg-bg-primary/70 px-3 py-2 text-xs whitespace-pre-wrap text-text-secondary">
            {request.detail}
          </div>
        )}
        <Input
          ref={inputRef}
          type={request.isPassword ? 'password' : 'text'}
          placeholder={request.placeholder ?? 'Enter response...'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        <p className="text-xs text-text-muted">
          Your server requires multi-factor authentication.
          {`${request.message} ${request.detail ?? ''}`.toLowerCase().match(/duo|push|option|1\./)
            ? ' If your cluster offers Duo choices, enter 1 for a push notification or type a passcode.'
            : ' Enter the authenticator code, passcode, or menu choice requested by the cluster.'}
        </p>
      </div>
    </Dialog>
  )
}
