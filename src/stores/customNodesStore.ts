import { create } from 'zustand'
import { registerCustomToolDefs } from '@/lib/toolRegistry'
import type { FileType, ToolCategory, ToolDef, ToolParam, ToolPort } from '@/types/pipeline'

export interface CustomNodeDefinition {
  id: string
  name: string
  description: string
  category: ToolCategory
  commandTemplate: string
  params: ToolParam[]
  inputs: ToolPort[]
  outputs: ToolPort[]
}

interface CustomNodesState {
  nodes: CustomNodeDefinition[]
  loaded: boolean
  load: () => Promise<void>
  saveNode: (node: Omit<CustomNodeDefinition, 'id'> & { id?: string }) => Promise<string>
  deleteNode: (id: string) => Promise<void>
}

const STORE_KEY = 'customNodes'

function toToolDef(def: CustomNodeDefinition): ToolDef {
  return {
    id: def.id,
    name: def.name,
    category: 'custom',
    description: def.description || 'Custom analysis command.',
    command: 'bash',
    inputs: def.inputs.length > 0 ? def.inputs : [{ id: 'input', label: 'Input', fileType: 'any' }],
    outputs: def.outputs.length > 0 ? def.outputs : [{ id: 'output', label: 'Output', fileType: 'tsv' }],
    params: def.params,
    backends: ['ssh'],
    customCommandTemplate: def.commandTemplate,
  } as ToolDef
}

function normalizePort(port: Partial<ToolPort>, index: number, fallback: 'input' | 'output'): ToolPort {
  return {
    id: String(port.id || `${fallback}${index + 1}`).replace(/\s+/g, '_'),
    label: String(port.label || `${fallback === 'input' ? 'Input' : 'Output'} ${index + 1}`),
    fileType: (port.fileType || 'any') as FileType,
    required: port.required,
    multi: port.multi,
  }
}

function normalizeParam(param: Partial<ToolParam>, index: number): ToolParam {
  const name = String(param.name || `param${index + 1}`).trim().replace(/\s+/g, '_')
  const type = param.type === 'number' || param.type === 'boolean' || param.type === 'file' || param.type === 'select' ? param.type : 'string'
  return {
    name,
    label: param.label || name,
    type,
    default: param.default,
    description: param.description,
  }
}

function syncRegistry(nodes: CustomNodeDefinition[]): void {
  registerCustomToolDefs(nodes.map(toToolDef))
}

export const useCustomNodesStore = create<CustomNodesState>((set, get) => ({
  nodes: [],
  loaded: false,

  load: async () => {
    const stored = await window.api.store.get<CustomNodeDefinition[]>(STORE_KEY)
    const nodes = Array.isArray(stored) ? stored : []
    syncRegistry(nodes)
    set({ nodes, loaded: true })
  },

  saveNode: async (draft) => {
    const id = draft.id || `custom.${Date.now().toString(36)}`
    const node: CustomNodeDefinition = {
      id,
      name: draft.name.trim() || 'Custom node',
      description: draft.description.trim(),
      category: draft.category,
      commandTemplate: draft.commandTemplate.trim() || 'cp {{input}} {{output}}',
      params: draft.params.map(normalizeParam),
      inputs: draft.inputs.map((port, index) => normalizePort(port, index, 'input')),
      outputs: draft.outputs.map((port, index) => normalizePort(port, index, 'output')),
    }
    const nodes = [...get().nodes.filter((item) => item.id !== id), node]
    await window.api.store.set(STORE_KEY, nodes)
    syncRegistry(nodes)
    set({ nodes, loaded: true })
    return id
  },

  deleteNode: async (id) => {
    const nodes = get().nodes.filter((node) => node.id !== id)
    await window.api.store.set(STORE_KEY, nodes)
    syncRegistry(nodes)
    set({ nodes })
  },
}))
