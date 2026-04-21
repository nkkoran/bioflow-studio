import type { PipelineSnapshot } from '@/types/pipeline'

export async function savePipelineSnapshot(snapshot: PipelineSnapshot): Promise<void> {
  const existingSnapshot = await window.api.store.get<PipelineSnapshot>(`pipeline:${snapshot.id}`)
  const saved = {
    ...snapshot,
    createdAt: existingSnapshot?.createdAt ?? snapshot.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }
  await window.api.store.set(`pipeline:${saved.id}`, saved)
  const existingIds = (await window.api.store.get<string[]>('pipelines:ids')) ?? []
  if (!existingIds.includes(saved.id)) {
    await window.api.store.set('pipelines:ids', [...existingIds, saved.id])
  }
  await window.api.store.set('pipeline:autosave:latest', saved)
}

export async function savePipelineSnapshotAs(snapshot: PipelineSnapshot, name: string): Promise<PipelineSnapshot> {
  const saved: PipelineSnapshot = {
    ...snapshot,
    id: `pipeline_${Math.random().toString(36).slice(2, 10)}`,
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await savePipelineSnapshot(saved)
  return saved
}
