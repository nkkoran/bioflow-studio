/**
 * Tool Palette — sidebar of draggable bioinformatics tools.
 *
 * Tools are grouped by category. Dragging a tool onto the canvas creates
 * a new tool node at the drop location (handled in PipelineCanvas).
 * The drag payload uses the dataTransfer API with a "application/bioflow-tool"
 * MIME type carrying the tool id.
 */
import { useState, useMemo } from 'react'
import { ChevronRight, Search, FileText, StickyNote, GitMerge, SlidersHorizontal } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { classNames } from '@/lib/utils'
import { TOOLS, CATEGORY_LABELS, getToolsByCategory } from '@/lib/toolRegistry'
import type { ToolDef } from '@/types/pipeline'

export const DRAG_MIME = 'application/bioflow-tool'

interface PaletteItemProps {
  tool: ToolDef
}

function PaletteItem({ tool }: PaletteItemProps) {
  const onDragStart = (event: React.DragEvent) => {
    event.dataTransfer.setData(DRAG_MIME, tool.id)
    event.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div
      draggable
      onDragStart={onDragStart}
      className={classNames(
        'px-3 py-1.5 rounded text-xs cursor-grab active:cursor-grabbing',
        'border border-transparent hover:border-accent/40 hover:bg-bg-tertiary',
        'transition-colors select-none',
      )}
      title={tool.description}
    >
      <div className="font-medium text-text-primary truncate">{tool.name}</div>
      <div className="text-[10px] text-text-muted truncate">{tool.command}</div>
    </div>
  )
}

interface SpecialItemProps {
  type: 'file-input' | 'file-output' | 'note' | 'merge' | 'transform'
  label: string
  icon: React.ReactNode
}

function SpecialItem({ type, label, icon }: SpecialItemProps) {
  const onDragStart = (event: React.DragEvent) => {
    event.dataTransfer.setData(DRAG_MIME, `__special__:${type}`)
    event.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div
      draggable
      onDragStart={onDragStart}
      className={classNames(
        'flex items-center gap-2 px-3 py-1.5 rounded text-xs cursor-grab active:cursor-grabbing',
        'border border-transparent hover:border-accent/40 hover:bg-bg-tertiary',
        'transition-colors select-none',
      )}
    >
      {icon}
      <span className="text-text-primary">{label}</span>
    </div>
  )
}

export function ToolPalette() {
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const groups = useMemo(() => {
    if (!search.trim()) return getToolsByCategory()
    const q = search.toLowerCase()
    const matches = TOOLS.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.command.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q),
    )
    const groupMap = new Map<string, ToolDef[]>()
    for (const t of matches) {
      if (!groupMap.has(t.category)) groupMap.set(t.category, [])
      groupMap.get(t.category)!.push(t)
    }
    return Array.from(groupMap.entries()).map(([category, tools]) => ({ category, tools }))
  }, [search])

  const toggleGroup = (cat: string) => {
    const next = new Set(collapsed)
    if (next.has(cat)) next.delete(cat)
    else next.add(cat)
    setCollapsed(next)
  }

  return (
    <div className="flex flex-col h-full bg-bg-secondary border-r border-border">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border">
        <div className="text-[10px] uppercase tracking-wide text-text-muted font-medium mb-2">
          Tool Palette
        </div>
        <Input
          placeholder="Search tools..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          icon={<Search size={12} />}
        />
      </div>

      {/* Special items */}
      <div className="p-2 flex flex-col gap-0.5 border-b border-border">
        <SpecialItem type="file-input" label="Input File" icon={<FileText size={12} className="text-amber-400" />} />
        <SpecialItem type="file-output" label="Output File" icon={<FileText size={12} className="text-amber-400" />} />
        <SpecialItem type="transform" label="Transform" icon={<SlidersHorizontal size={12} className="text-teal-400" />} />
        <SpecialItem type="merge" label="Merge (fan-in)" icon={<GitMerge size={12} className="text-indigo-400" />} />
        <SpecialItem type="note" label="Note" icon={<StickyNote size={12} className="text-amber-400" />} />
      </div>

      {/* Tools grouped by category */}
      <div className="flex-1 overflow-y-auto py-1">
        {groups.length === 0 && (
          <div className="px-3 py-4 text-xs text-text-muted text-center">No matching tools</div>
        )}
        {groups.map(({ category, tools }) => {
          const isCollapsed = collapsed.has(category)
          return (
            <div key={category} className="mb-1">
              <button
                onClick={() => toggleGroup(category)}
                className="w-full flex items-center gap-1 px-3 py-1 text-[10px] uppercase tracking-wide text-text-muted hover:text-text-primary transition-colors"
              >
                <ChevronRight
                  size={10}
                  className={classNames('transition-transform', isCollapsed ? '' : 'rotate-90')}
                />
                {CATEGORY_LABELS[category] ?? category}
                <span className="ml-auto text-text-muted">{tools.length}</span>
              </button>
              {!isCollapsed && (
                <div className="px-2 flex flex-col gap-0.5">
                  {tools.map((tool) => (
                    <PaletteItem key={tool.id} tool={tool} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Footer hint */}
      <div className="px-3 py-2 border-t border-border text-[10px] text-text-muted">
        Drag tools onto the canvas to build your pipeline.
      </div>
    </div>
  )
}
