import { create } from 'zustand'
import type { DataArtifact, DataArtifactRole } from '@/types/pipeline'

interface DataCartState {
  items: DataArtifact[]
  open: boolean
  setOpen: (open: boolean) => void
  addItems: (items: DataArtifact[]) => void
  removeItem: (id: string) => void
  clear: () => void
  updateRole: (id: string, role: DataArtifactRole) => void
  updateAxis: (id: string, axis: string) => void
  setSidecarStatuses: (id: string, statuses: Record<string, 'present' | 'missing' | 'unknown'>) => void
}

export const useDataCartStore = create<DataCartState>()((set) => ({
  items: [],
  open: true,
  setOpen: (open) => set({ open }),
  addItems: (items) => set((state) => {
    const byId = new Map(state.items.map((item) => [item.id, item]))
    for (const item of items) byId.set(item.id, { ...byId.get(item.id), ...item })
    return { items: [...byId.values()], open: true }
  }),
  removeItem: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
  clear: () => set({ items: [] }),
  updateRole: (id, role) => set((state) => ({
    items: state.items.map((item) => item.id === id ? { ...item, role } : item),
  })),
  updateAxis: (id, axis) => set((state) => ({
    items: state.items.map((item) => item.id === id ? { ...item, axis: axis.trim() || undefined } : item),
  })),
  setSidecarStatuses: (id, statuses) => set((state) => ({
    items: state.items.map((item) => item.id === id
      ? {
          ...item,
          sidecars: item.sidecars?.map((sidecar) => ({
            ...sidecar,
            status: statuses[sidecar.path] ?? sidecar.status ?? 'unknown',
          })),
        }
      : item),
  })),
}))
