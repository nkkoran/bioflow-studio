import { create } from 'zustand'

export type AppDialogKind = 'alert' | 'confirm' | 'prompt'

export interface AppDialogRequest {
  kind: AppDialogKind
  title: string
  message: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  defaultValue?: string
  placeholder?: string
}

interface ActiveDialog extends AppDialogRequest {
  id: string
  resolve: (value: boolean | string | null | void) => void
}

interface DialogStoreState {
  active: ActiveDialog | null
  alert: (request: Omit<AppDialogRequest, 'kind'>) => Promise<void>
  confirm: (request: Omit<AppDialogRequest, 'kind'>) => Promise<boolean>
  prompt: (request: Omit<AppDialogRequest, 'kind'>) => Promise<string | null>
  resolveActive: (value: boolean | string | null | void) => void
  clear: () => void
}

function makeId(): string {
  return `dialog_${Math.random().toString(36).slice(2, 10)}`
}

function enqueue(
  set: (fn: (state: DialogStoreState) => Partial<DialogStoreState>) => void,
  request: AppDialogRequest,
): Promise<boolean | string | null | void> {
  return new Promise((resolve) => {
    set(() => ({
      active: {
        ...request,
        id: makeId(),
        resolve,
      },
    }))
  })
}

export const useDialogStore = create<DialogStoreState>((set, get) => ({
  active: null,

  alert: async (request) => {
    await enqueue(set, { ...request, kind: 'alert' })
  },

  confirm: async (request) => {
    const result = await enqueue(set, { ...request, kind: 'confirm' })
    return result === true
  },

  prompt: async (request) => {
    const result = await enqueue(set, { ...request, kind: 'prompt' })
    return typeof result === 'string' ? result : null
  },

  resolveActive: (value) => {
    const current = get().active
    if (!current) return
    current.resolve(value)
    set({ active: null })
  },

  clear: () => set({ active: null }),
}))
