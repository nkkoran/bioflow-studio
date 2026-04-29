import { useEffect, useMemo, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { HelpButton } from '@/components/ui/HelpButton'
import { useCustomNodesStore, type CustomNodeDefinition } from '@/stores/customNodesStore'
import type { FileType, ToolParam, ToolPort } from '@/types/pipeline'

const FILE_TYPES: FileType[] = ['any', 'tsv', 'csv', 'txt', 'vcf', 'bcf', 'plink', 'pgen', 'bed', 'bam', 'fastq', 'fasta', 'json']
const PARAM_TYPES: ToolParam['type'][] = ['string', 'number', 'boolean', 'file']

function emptyParam(): ToolParam {
  return { name: '', label: '', type: 'string', default: '', description: '' }
}

function emptyPort(kind: 'input' | 'output', index: number): ToolPort {
  return { id: `${kind}${index + 1}`, label: `${kind === 'input' ? 'Input' : 'Output'} ${index + 1}`, fileType: 'any', required: kind === 'input' }
}

export function CustomNodeBuilder({
  open,
  onClose,
  editing,
}: {
  open: boolean
  onClose: () => void
  editing?: CustomNodeDefinition | null
}) {
  const saveNode = useCustomNodesStore((s) => s.saveNode)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [commandTemplate, setCommandTemplate] = useState('cat {{input}} > {{output}}')
  const [params, setParams] = useState<ToolParam[]>([])
  const [inputs, setInputs] = useState<ToolPort[]>([emptyPort('input', 0)])
  const [outputs, setOutputs] = useState<ToolPort[]>([emptyPort('output', 0)])

  useEffect(() => {
    if (!open) return
    setName(editing?.name ?? '')
    setDescription(editing?.description ?? '')
    setCommandTemplate(editing?.commandTemplate ?? 'cat {{input}} > {{output}}')
    setParams(editing?.params ?? [])
    setInputs(editing?.inputs?.length ? editing.inputs : [emptyPort('input', 0)])
    setOutputs(editing?.outputs?.length ? editing.outputs : [emptyPort('output', 0)])
  }, [editing, open])

  const canSave = useMemo(() => name.trim().length > 0 && commandTemplate.trim().length > 0, [commandTemplate, name])

  const save = async () => {
    if (!canSave) return
    await saveNode({
      id: editing?.id,
      name,
      description,
      category: 'custom',
      commandTemplate,
      params,
      inputs,
      outputs,
    })
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit Custom Node' : 'New Custom Node'}
      width="max-w-4xl"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={!canSave}>Save node</Button>
        </>
      )}
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-3">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My analysis" />
          <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this node does" />
          <div>
            <div className="mb-1 flex items-center gap-1 text-xs font-medium text-text-secondary">
              Command template
              <HelpButton id="inspector.custom" />
            </div>
            <textarea
              value={commandTemplate}
              onChange={(e) => setCommandTemplate(e.target.value)}
              className="h-32 w-full resize-none rounded-md border border-border bg-bg-tertiary px-2 py-1.5 font-mono text-xs text-text-primary outline-none focus:ring-1 focus:ring-accent"
              placeholder="my-tool --in {{input}} --out {{output}} --alpha {{param:alpha}}"
            />
            <p className="mt-1 text-[11px] text-text-muted">
              Placeholders: <code>{'{{input}}'}</code>, <code>{'{{output}}'}</code>, <code>{'{{param:name}}'}</code>.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <PortTable title="Inputs" kind="input" ports={inputs} onChange={setInputs} />
          <PortTable title="Outputs" kind="output" ports={outputs} onChange={setOutputs} />
        </div>

        <div className="lg:col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1 text-sm font-medium text-text-primary">
              Parameters
              <HelpButton id="params.row" />
            </div>
            <Button variant="secondary" size="sm" icon={<Plus size={12} />} onClick={() => setParams([...params, emptyParam()])}>
              Add parameter
            </Button>
          </div>
          <div className="space-y-2">
            {params.map((param, index) => (
              <div key={index} className="grid grid-cols-[1fr_110px_1fr_1.5fr_28px] gap-2">
                <Input value={param.name} placeholder="name" onChange={(e) => updateParam(index, { name: e.target.value, label: e.target.value })} />
                <select value={param.type} onChange={(e) => updateParam(index, { type: e.target.value as ToolParam['type'] })} className="h-8 rounded-md border border-border bg-bg-tertiary px-2 text-xs text-text-primary">
                  {PARAM_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
                <Input value={String(param.default ?? '')} placeholder="default" onChange={(e) => updateParam(index, { default: e.target.value })} />
                <Input value={param.description ?? ''} placeholder="description" onChange={(e) => updateParam(index, { description: e.target.value })} />
                <button type="button" className="rounded text-text-muted hover:bg-bg-hover hover:text-error" onClick={() => setParams(params.filter((_, i) => i !== index))}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {params.length === 0 && <div className="rounded border border-dashed border-border px-3 py-3 text-xs text-text-muted">No parameters yet.</div>}
          </div>
        </div>
      </div>
    </Dialog>
  )

  function updateParam(index: number, patch: Partial<ToolParam>) {
    setParams(params.map((param, i) => i === index ? { ...param, ...patch } : param))
  }
}

function PortTable({
  title,
  kind,
  ports,
  onChange,
}: {
  title: string
  kind: 'input' | 'output'
  ports: ToolPort[]
  onChange: (ports: ToolPort[]) => void
}) {
  const update = (index: number, patch: Partial<ToolPort>) => onChange(ports.map((port, i) => i === index ? { ...port, ...patch } : port))
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-medium text-text-primary">{title}</div>
        <Button variant="secondary" size="sm" icon={<Plus size={12} />} onClick={() => onChange([...ports, emptyPort(kind, ports.length)])}>
          Add
        </Button>
      </div>
      <div className="space-y-2">
        {ports.map((port, index) => (
          <div key={index} className="grid grid-cols-[1fr_100px_28px] gap-2">
            <Input value={port.label} onChange={(e) => update(index, { label: e.target.value, id: e.target.value.toLowerCase().replace(/\W+/g, '_') })} />
            <select value={port.fileType} onChange={(e) => update(index, { fileType: e.target.value as FileType })} className="h-8 rounded-md border border-border bg-bg-tertiary px-2 text-xs text-text-primary">
              {FILE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
            <button type="button" className="rounded text-text-muted hover:bg-bg-hover hover:text-error" onClick={() => onChange(ports.filter((_, i) => i !== index))}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

export function CustomNodeActions({ node }: { node: CustomNodeDefinition }) {
  const [editing, setEditing] = useState(false)
  const deleteNode = useCustomNodesStore((s) => s.deleteNode)
  return (
    <span className="ml-auto flex items-center gap-1">
      <button type="button" className="rounded p-1 text-text-muted hover:text-text-primary" onClick={(event) => { event.stopPropagation(); setEditing(true) }} title="Edit custom node">
        <Pencil size={11} />
      </button>
      <button
        type="button"
        className="rounded p-1 text-text-muted hover:text-error"
        onClick={(event) => {
          event.stopPropagation()
          if (window.confirm(`Delete custom node "${node.name}"? This cannot be undone.`)) {
            void deleteNode(node.id)
          }
        }}
        title="Delete custom node"
      >
        <Trash2 size={11} />
      </button>
      <CustomNodeBuilder open={editing} onClose={() => setEditing(false)} editing={node} />
    </span>
  )
}
