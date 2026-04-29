import { useMemo, useRef } from 'react'
import { Plus, Trash2, Save, Upload } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { usePipelineStore } from '@/stores/pipelineStore'
import { useDnxStore } from '@/stores/dnxStore'
import { useDialogStore } from '@/stores/dialogStore'
import {
  mergeUkbPresets,
  normalizeUkbFieldRows,
  parseImportedUkbFields,
  sanitizeUkbFieldRows,
  type UkbFieldRow,
} from '@/lib/ukbFieldPresets'

interface Props {
  nodeId: string
  value: unknown
}

export function UkbFieldBuilder({ nodeId, value }: Props) {
  const updateNodeData = usePipelineStore((s) => s.updateNodeData)
  const fieldPresets = useDnxStore((s) => s.fieldPresets)
  const saveFieldPresets = useDnxStore((s) => s.saveFieldPresets)
  const promptDialog = useDialogStore((s) => s.prompt)
  const importRef = useRef<HTMLInputElement | null>(null)
  const rows = useMemo(() => normalizeUkbFieldRows(value), [value])
  const presets = useMemo(() => mergeUkbPresets(fieldPresets), [fieldPresets])

  const setRows = (next: UkbFieldRow[]) => {
    updateNodeData(nodeId, {
      paramValues: {
        ...(usePipelineStore.getState().nodes.find((node) => node.id === nodeId)?.data as { paramValues?: Record<string, unknown> })?.paramValues,
        fields: next,
      },
    })
  }

  const addRow = () => setRows([...rows, { fieldId: '', label: '' }])

  const applyPreset = (presetId: string) => {
    const preset = presets.find((item) => item.id === presetId)
    if (!preset) return
    setRows(preset.fields.map((field) => ({ fieldId: field.fieldId, label: field.label })))
  }

  const savePreset = async () => {
    const name = await promptDialog({
      title: 'Save field preset',
      message: 'Choose a preset name for these UKB fields.',
      defaultValue: 'UKB preset',
      confirmLabel: 'Save preset',
    })
    if (!name?.trim()) return
    const id = `preset_${Date.now().toString(36)}`
    await saveFieldPresets([
      ...fieldPresets,
      {
        id,
        name: name.trim(),
        fields: sanitizeUkbFieldRows(rows),
      },
    ])
  }

  const importRows = async (file: File | null) => {
    if (!file) return
    const text = await file.text()
    const parsed = parseImportedUkbFields(text)
    if (parsed.length === 0) return
    setRows(parsed)
  }

  return (
    <div className="flex flex-col gap-3">
      <input
        ref={importRef}
        type="file"
        accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
        className="hidden"
        onChange={(event) => {
          void importRows(event.target.files?.[0] ?? null)
          event.currentTarget.value = ''
        }}
      />
      <div className="flex items-center gap-2">
        <select
          defaultValue=""
          onChange={(e) => {
            if (!e.target.value) return
            applyPreset(e.target.value)
            e.currentTarget.value = ''
          }}
          className="h-8 flex-1 rounded-md border border-border bg-bg-tertiary px-2 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent focus:border-accent"
        >
          <option value="">Load preset…</option>
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>{preset.name}</option>
          ))}
        </select>
        <Button variant="secondary" size="sm" icon={<Upload size={12} />} onClick={() => importRef.current?.click()}>
          Import
        </Button>
        <Button variant="secondary" size="sm" icon={<Save size={12} />} onClick={() => void savePreset()}>
          Save preset
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <div key={`${index}-${row.fieldId}`} className="grid grid-cols-[1fr_1fr_auto] gap-2">
            <Input
              label={index === 0 ? 'Field ID' : ''}
              value={row.fieldId}
              placeholder="p21001_i0"
              onChange={(e) => {
                const next = [...rows]
                next[index] = { ...next[index], fieldId: e.target.value }
                setRows(next)
              }}
            />
            <Input
              label={index === 0 ? 'Rename label (optional)' : ''}
              value={row.label ?? ''}
              placeholder="BMI"
              onChange={(e) => {
                const next = [...rows]
                next[index] = { ...next[index], label: e.target.value }
                setRows(next)
              }}
            />
            <button
              type="button"
              className="mt-auto h-8 w-8 rounded border border-border text-text-muted hover:text-error hover:border-error/40"
              onClick={() => setRows(rows.filter((_, rowIndex) => rowIndex !== index))}
              title="Remove field"
            >
              <Trash2 size={13} className="mx-auto" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <p className="text-[10px] text-text-muted">
          Add RAP field ids such as <code className="font-mono">p21001_i0</code>. Rename labels become output column headers.
        </p>
        <Button variant="ghost" size="sm" icon={<Plus size={12} />} onClick={addRow}>
          Add field
        </Button>
      </div>
    </div>
  )
}
