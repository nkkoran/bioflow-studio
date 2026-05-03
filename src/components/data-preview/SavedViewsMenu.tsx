import type { SavedPreviewView } from '@/stores/dataPreviewStore'
import { MenuSelect } from '@/components/ui/MenuSelect'

interface Props {
  views: SavedPreviewView[]
  activeViewId?: string
  onApply: (viewId: string | '') => void
  onSave: () => void
  onUpdate: () => void
  onRename: () => void
  onDelete: () => void
}

export function SavedViewsMenu({
  views,
  activeViewId,
  onApply,
  onSave,
  onUpdate,
  onRename,
  onDelete,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-text-muted">View</span>
      <MenuSelect
        value={activeViewId ?? ''}
        onChange={(value) => onApply(value)}
        options={views.map((view) => ({ value: view.id, label: view.name }))}
        allowEmpty
        emptyLabel="Fresh"
        placeholder="Fresh"
        className="w-32"
        buttonClassName="h-6 text-[11px]"
        menuClassName="w-44"
      />
      <button type="button" className="rounded bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary shadow-sm hover:bg-bg-hover hover:text-text-primary" onClick={onSave}>
        Save view
      </button>
      <button
        type="button"
        className="rounded bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary shadow-sm hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
        onClick={onUpdate}
        disabled={!activeViewId}
      >
        Update current
      </button>
      <button
        type="button"
        className="rounded bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary shadow-sm hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
        onClick={onRename}
        disabled={!activeViewId}
      >
        Rename
      </button>
      <button
        type="button"
        className="rounded bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary shadow-sm hover:bg-error/10 hover:text-error disabled:opacity-40"
        onClick={onDelete}
        disabled={!activeViewId}
      >
        Delete
      </button>
    </div>
  )
}
