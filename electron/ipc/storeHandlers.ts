import { ipcMain, safeStorage } from 'electron'
import { getSettingsStore } from '../store/settingsStore'

function encodeSecret(value: string): { scheme: 'safeStorage' | 'plain'; value: string } {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      scheme: 'safeStorage',
      value: safeStorage.encryptString(value).toString('base64'),
    }
  }
  return {
    scheme: 'plain',
    value,
  }
}

function decodeSecret(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const payload = raw as { scheme?: string; value?: string }
  if (typeof payload.value !== 'string') return undefined
  if (payload.scheme === 'safeStorage') {
    try {
      return safeStorage.decryptString(Buffer.from(payload.value, 'base64'))
    } catch {
      return undefined
    }
  }
  if (payload.scheme === 'plain') return payload.value
  return undefined
}

export function registerStoreHandlers(): void {
  const store = getSettingsStore()

  ipcMain.handle('store:get', async (_event, key: string) => {
    return store.get(key)
  })

  ipcMain.handle('store:set', async (_event, key: string, value: any) => {
    store.set(key, value)
  })

  ipcMain.handle('store:delete', async (_event, key: string) => {
    store.delete(key)
  })

  ipcMain.handle('store:get-secret', async (_event, key: string) => {
    return decodeSecret(store.get(`secure:${key}`))
  })

  ipcMain.handle('store:set-secret', async (_event, key: string, value: string) => {
    store.set(`secure:${key}`, encodeSecret(value))
  })

  ipcMain.handle('store:delete-secret', async (_event, key: string) => {
    store.delete(`secure:${key}`)
  })
}
