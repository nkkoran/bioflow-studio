import { ipcMain, dialog } from 'electron'

export function registerDialogHandlers(): void {
  ipcMain.handle('dialog:openFile', async (_event, options?: any) => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: options?.filters,
      defaultPath: options?.defaultPath
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('dialog:openDirectory', async (_event, options?: any) => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      defaultPath: options?.defaultPath
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
