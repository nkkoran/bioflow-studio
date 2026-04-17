import { registerSshHandlers } from './sshHandlers'
import { registerFileHandlers } from './fileHandlers'
import { registerTerminalHandlers } from './terminalHandlers'
import { registerStoreHandlers } from './storeHandlers'
import { registerDialogHandlers } from './dialogHandlers'
import { registerLocalFileHandlers } from './localFileHandlers'
import { registerPipelineHandlers } from './pipelineHandlers'

export function registerAllHandlers(): void {
  registerSshHandlers()
  registerFileHandlers()
  registerTerminalHandlers()
  registerStoreHandlers()
  registerDialogHandlers()
  registerLocalFileHandlers()
  registerPipelineHandlers()
}
