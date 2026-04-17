import { ipcMain } from 'electron'
import { getSettingsStore } from '../store/settingsStore'

export function registerStoreHandlers(): void {
  const store = getSettingsStore()

  ipcMain.handle('store:get', async (_event, key: string) => {
    return store.get(key)
  })

  ipcMain.handle('store:set', async (_event, key: string, value: any) => {
    store.set(key, value)
  })
}
