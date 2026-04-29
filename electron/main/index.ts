import { app, BrowserWindow, Menu, shell, session, ipcMain, crashReporter } from 'electron'
import { join } from 'path'
import { autoUpdater } from 'electron-updater'
import { registerAllHandlers } from '../ipc/registerAll'

// Check if dev: use electron-vite's environment
const isDev = !app.isPackaged

function sendMenuCommand(command: 'new' | 'open' | 'save' | 'saveAs' | 'tour' | 'bugReport' | 'settings' | 'addConnection'): void {
  BrowserWindow.getFocusedWindow()?.webContents.send('app:menu-command', { command })
}

function isAllowedExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'mailto:'
  } catch {
    return false
  }
}

function installSecurityHeaders(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Dev needs 'unsafe-inline' + 'unsafe-eval' for Vite's React Fast Refresh preamble
    // and HMR client. Production loads bundled JS only — keep it strict.
    const scriptSrc = app.isPackaged
      ? "script-src 'self'"
      : "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    const connectSrc = app.isPackaged
      ? "connect-src 'self'"
      : "connect-src 'self' ws://localhost:* http://localhost:*"
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            scriptSrc,
            "style-src 'self' 'unsafe-inline'",
            "font-src 'self' data:",
            "img-src 'self' data: blob:",
            connectSrc,
          ].join('; '),
        ],
      },
    })
  })
}

function checkForUpdates(): void {
  if (!app.isPackaged) return
  void autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error('[autoUpdater] check failed:', err)
  })
}

function openBundledDoc(name: string): void {
  const root = app.isPackaged ? process.resourcesPath : join(__dirname, '../..')
  const filePath = join(root, 'docs', name)
  // shell.openPath resolves with an empty string on success, or an error
  // message on failure. The most common failure here is "no application
  // associated with .md" — fall back to opening the file in the user's
  // browser via a file:// URL, which always works.
  void shell.openPath(filePath).then((errMsg) => {
    if (errMsg) void shell.openExternal(`file://${filePath}`)
  }).catch((err) => {
    console.error('[docs] open failed:', err)
  })
}

function buildMenu(): Menu {
  const isMac = process.platform === 'darwin'
  const appName = app.name || 'BioFlow Studio'
  const macAppMenu: Electron.MenuItemConstructorOptions[] = isMac ? [{
    label: appName,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: () => sendMenuCommand('settings') },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  }] : []
  return Menu.buildFromTemplate([
    ...macAppMenu,
    {
      label: 'File',
      submenu: [
        { label: 'New Pipeline', accelerator: 'CmdOrCtrl+N', click: () => sendMenuCommand('new') },
        { label: 'Open Pipeline', accelerator: 'CmdOrCtrl+O', click: () => sendMenuCommand('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendMenuCommand('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenuCommand('saveAs') },
        { type: 'separator' },
        { label: 'Add Connection…', accelerator: 'CmdOrCtrl+Shift+C', click: () => sendMenuCommand('addConnection') },
        ...(isMac ? [] : [
          { type: 'separator' as const },
          { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendMenuCommand('settings') },
          { type: 'separator' as const },
          { role: 'quit' as const },
        ]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin' ? [{ type: 'separator' as const }, { role: 'front' as const }] : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Build Your First Pipeline', click: () => sendMenuCommand('tour') },
        { label: 'Export Bug Report', click: () => sendMenuCommand('bugReport') },
        { type: 'separator' },
        { label: 'GWAS Quickstart', click: () => openBundledDoc('gwas-quickstart.md') },
        { label: 'bcftools Workflow', click: () => openBundledDoc('bcftools-workflow.md') },
        { label: 'Check for Updates', click: () => checkForUpdates() },
      ],
    },
  ])
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0f1419',
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 10 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'killed') console.error('[render-process-gone]', details)
  })
  mainWindow.webContents.on('preload-error', (_e, p, err) => {
    console.error('[preload-error]', p, err)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isAllowedExternalUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow.webContents.getURL()
    if (url === current || (!app.isPackaged && url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? ''))) return
    event.preventDefault()
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  crashReporter.start({ uploadToServer: false })
  installSecurityHeaders()
  ipcMain.handle('app:check-updates', async () => {
    checkForUpdates()
    return { ok: true }
  })
  registerAllHandlers()
  Menu.setApplicationMenu(buildMenu())
  createWindow()
  checkForUpdates()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
