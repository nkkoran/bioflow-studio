import type { PipelineSnapshot } from '@/types/pipeline'

export async function savePipelineSnapshot(snapshot: PipelineSnapshot): Promise<void> {
  const saved = { ...snapshot, updatedAt: Date.now() }
  await window.api.store.set(`pipeline:${saved.id}`, saved)
  const existing = (await window.api.store.get<string[]>('pipelines:ids')) ?? []
  if (!existing.includes(saved.id)) {
    await window.api.store.set('pipelines:ids', [...existing, saved.id])
  }
  await window.api.store.set('pipeline:autosave:latest', saved)
}
