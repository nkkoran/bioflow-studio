import type { SavedPreviewView } from '@/stores/dataPreviewStore'

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
    <div className="flex items-center gap-1.5">
      <label className="flex items-center gap-1 text-[11px] text-text-muted">
        View
        <select
          value={activeViewId ?? ''}
          onChange={(e) => onApply(e.target.value)}
          className="bioflow-field h-6 min-w-[120px] rounded px-1.5 text-[11px] text-text-primary outline-none"
        >
          <option value="">Fresh</option>
          {views.map((view) => (
            <option key={view.id} value={view.id}>
              {view.name}
            </option>
          ))}
        </select>
      </label>
      <button className="rounded bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary shadow-sm hover:bg-bg-hover hover:text-text-primary" onClick={onSave}>
        Save view
      </button>
      <button
        className="rounded bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary shadow-sm hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
        onClick={onUpdate}
        disabled={!activeViewId}
      >
        Update current
      </button>
      <button
        className="rounded bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary shadow-sm hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
        onClick={onRename}
        disabled={!activeViewId}
      >
        Rename
      </button>
      <button
        className="rounded bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary shadow-sm hover:bg-error/10 hover:text-error disabled:opacity-40"
        onClick={onDelete}
        disabled={!activeViewId}
      >
        Delete
      </button>
    </div>
  )
}
