import { ipcMain } from 'electron'
import { PipelineRunner } from '../pipeline/PipelineRunner'
import type { PipelineSnapshot } from '../../src/types/pipeline'

export function registerPipelineHandlers(): void {
  const runner = PipelineRunner.getInstance()

  ipcMain.handle('pipeline:run', async (
    _event,
    args: { connectionId: string; snapshot: PipelineSnapshot; workDir?: string },
  ) => {
    return runner.start(args)
  })

  ipcMain.handle('pipeline:cancel', async (_event, runId: string) => {
    return runner.cancel(runId)
  })

  ipcMain.handle('pipeline:cancel-node', async (_event, args: { runId: string; nodeId: string }) => {
    return runner.cancelNode(args.runId, args.nodeId)
  })

  ipcMain.handle('pipeline:cancel-job', async (_event, args: { connectionId: string; jobId: string }) => {
    return runner.cancelJobId(args.connectionId, args.jobId)
  })

  ipcMain.handle('pipeline:rerun-node', async (_event, args: { runId: string; nodeId: string; snapshot: PipelineSnapshot }) => {
    return runner.rerunNode(args.runId, args.nodeId, args.snapshot)
  })

  ipcMain.handle('pipeline:list-runs', async () => {
    await runner.reattachPersistedJobs()
    return runner.listRuns()
  })

  ipcMain.handle('pipeline:get-run', async (_event, runId: string) => {
    return runner.getRun(runId)
  })

  ipcMain.handle('pipeline:list-outputs', async (_event, args: { runId: string; nodeId: string }) => {
    return runner.listNodeOutputs(args.runId, args.nodeId)
  })

  ipcMain.handle('pipeline:generate-scripts-dry', async (
    _event,
    args: { connectionId: string; snapshot: PipelineSnapshot; workDir?: string },
  ) => {
    return runner.generateScriptsDry(args)
  })
}
