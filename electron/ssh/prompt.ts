import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'crypto'

export interface PromptRequestPayload {
  title: string
  message: string
  detail?: string
  isPassword: boolean
  placeholder?: string
}

/**
 * Ask the renderer to show a prompt dialog and return the user's input.
 * Used for MFA/2FA codes during keyboard-interactive auth and OpenSSH askpass.
 */
export function promptUser(request: PromptRequestPayload): Promise<string | null> {
  return new Promise((resolve) => {
    const windows = BrowserWindow.getAllWindows()
    if (windows.length === 0) {
      console.warn('[SSH] Cannot show authentication prompt because no BrowserWindow is available')
      resolve(null)
      return
    }

    const promptId = randomUUID()
    let settled = false

    const handler = (_event: Electron.IpcMainEvent, data: { promptId: string; value: string | null }) => {
      if (data.promptId === promptId) {
        settled = true
        ipcMain.removeListener('ssh:prompt-response', handler)
        console.log(`[SSH] Authentication prompt answered (${data.value === null ? 'cancelled' : 'submitted'})`)
        resolve(data.value)
      }
    }
    ipcMain.on('ssh:prompt-response', handler)

    console.log(`[SSH] Showing authentication prompt: ${request.message}`)
    for (const win of windows) {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send('ssh:prompt', {
          promptId,
          ...request,
        })
      }
    }

    setTimeout(() => {
      if (settled) return
      ipcMain.removeListener('ssh:prompt-response', handler)
      console.warn('[SSH] Authentication prompt timed out after 60 seconds')
      resolve(null)
    }, 60_000)
  })
}
