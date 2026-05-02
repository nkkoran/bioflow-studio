import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import type { PipelineTemplate } from '@/lib/pipelineTemplates'

interface Props {
  open: boolean
  templates: PipelineTemplate[]
  onClose: () => void
  onSelect: (template: PipelineTemplate) => void
}

export function TemplateGallery({ open, templates, onClose, onSelect }: Props) {
  return (
    <Dialog open={open} onClose={onClose} title="Start from template">
      <div className="grid max-h-[70vh] grid-cols-1 gap-3 overflow-y-auto md:grid-cols-2">
        {templates.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => onSelect(template)}
            className="rounded-md border border-border bg-bg-tertiary p-4 text-left transition-colors hover:border-accent/50 hover:bg-bg-hover"
          >
            <div className="mb-1 text-sm font-semibold text-text-primary">{template.name}</div>
            <div className="text-xs leading-relaxed text-text-muted">{template.description}</div>
          </button>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </Dialog>
  )
}
