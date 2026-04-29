import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EventEmitter } from 'node:events'

const execFileAsync = promisify(execFile)
const READY_MARKER = '.bioflow-ready'
const DXPY_VERSION_PIN = 'dxpy'

export interface BootstrapProgressEvent {
  level: 'info' | 'warning' | 'error'
  message: string
  code?: string
}

export class PythonEnvBootstrap extends EventEmitter {
  private static instance: PythonEnvBootstrap | null = null
  private inFlight: Promise<string> | null = null

  static getInstance(): PythonEnvBootstrap {
    if (!this.instance) this.instance = new PythonEnvBootstrap()
    return this.instance
  }

  async ensureReady(options?: { force?: boolean }): Promise<string> {
    if (!this.inFlight || options?.force) {
      this.inFlight = this.bootstrap(options).finally(() => {
        this.inFlight = null
      })
    }
    return this.inFlight
  }

  private async bootstrap(options?: { force?: boolean }): Promise<string> {
    const baseDir = join(app.getPath('userData'), 'python-bridge')
    const venvDir = join(baseDir, 'venv')
    const markerPath = join(venvDir, READY_MARKER)
    mkdirSync(baseDir, { recursive: true })

    const python = await this.resolvePython()
    const venvPython = process.platform === 'win32'
      ? join(venvDir, 'Scripts', 'python.exe')
      : join(venvDir, 'bin', 'python3')

    if (!options?.force && existsSync(venvPython) && this.markerMatches(markerPath)) {
      this.emitProgress('info', 'DNAnexus Python environment is already ready.', 'READY')
      return venvPython
    }

    this.emitProgress('info', `Creating DNAnexus Python environment with ${python}.`, 'CREATE_VENV')
    await execFileAsync(python, ['-m', 'venv', venvDir])

    this.emitProgress('info', 'Upgrading pip in the DNAnexus Python environment.', 'UPGRADE_PIP')
    await execFileAsync(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'])

    this.emitProgress('info', 'Installing dxpy into the DNAnexus Python environment.', 'INSTALL_DXPY')
    await execFileAsync(venvPython, ['-m', 'pip', 'install', 'dxpy'])

    writeFileSync(markerPath, `${DXPY_VERSION_PIN}\n`, 'utf-8')
    this.emitProgress('info', 'DNAnexus Python environment is ready.', 'READY')
    return venvPython
  }

  private markerMatches(markerPath: string): boolean {
    if (!existsSync(markerPath)) return false
    try {
      return readFileSync(markerPath, 'utf-8').includes(DXPY_VERSION_PIN)
    } catch {
      return false
    }
  }

  private async resolvePython(): Promise<string> {
    for (const candidate of ['python3.11', 'python3.10', 'python3.9', 'python3']) {
      try {
        const { stdout, stderr } = await execFileAsync(candidate, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'])
        const version = (stdout || stderr).trim()
        const [majorRaw, minorRaw] = version.split('.')
        const major = Number(majorRaw)
        const minor = Number(minorRaw)
        if (major > 3 || (major === 3 && minor >= 9)) return candidate
      } catch {
        continue
      }
    }
    throw new Error('BioFlow Studio needs Python 3.9 or newer to enable DNAnexus support.')
  }

  private emitProgress(level: BootstrapProgressEvent['level'], message: string, code?: string): void {
    this.emit('progress', { level, message, code } satisfies BootstrapProgressEvent)
  }
}

