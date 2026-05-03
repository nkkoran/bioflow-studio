/**
 * Tool Palette — sidebar of draggable bioinformatics tools.
 *
 * Tools are grouped by category. Dragging a tool onto the canvas creates
 * a new tool node at the drop location (handled in PipelineCanvas).
 * The drag payload uses the dataTransfer API with a "application/bioflow-tool"
 * MIME type carrying the tool id.
 */
import { useCallback, useEffect, useState, useMemo } from 'react'
import { ChevronRight, Clock3, Plus, Search, Star } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { classNames } from '@/lib/utils'
import { TOOLS, CATEGORY_LABELS, getToolsByCategory } from '@/lib/toolRegistry'
import { TOOL_BUNDLES } from '@/lib/toolBundles'
import { iconForBundle, iconForCategory, iconForNodeType } from '@/lib/toolIcons'
import type { ToolCategory, ToolDef } from '@/types/pipeline'
import type { ToolBundle } from '@/lib/toolBundles'
import { ToolHoverCard } from './ToolHoverCard'
import { CustomNodeActions, CustomNodeBuilder } from './CustomNodeBuilder'
import { useCustomNodesStore } from '@/stores/customNodesStore'
import { useSettingsStore } from '@/stores/settingsStore'

export const DRAG_MIME = 'application/bioflow-tool'
export const BUNDLE_DRAG_MIME = 'application/bioflow-bundle'

interface PaletteItemProps {
  tool: ToolDef
  favorite?: boolean
  onToggleFavorite?: (toolId: string) => void
  onUse?: (toolId: string) => void
}

function PaletteItem({ tool, favorite, onToggleFavorite, onUse }: PaletteItemProps) {
  const Icon = iconForCategory(tool.category)
  const onDragStart = (event: React.DragEvent) => {
    event.dataTransfer.setData(DRAG_MIME, tool.id)
    event.dataTransfer.effectAllowed = 'copy'
    onUse?.(tool.id)
  }

  return (
    <ToolHoverCard tool={tool}>
      <div
        draggable
        onDragStart={onDragStart}
        className={classNames(
          'group px-3 py-1.5 rounded-md text-xs cursor-grab active:cursor-grabbing',
          'hover:bg-bg-hover/80 hover:shadow-sm',
          'transition-all duration-150 select-none',
        )}
        title={tool.description}
      >
        <div className="flex items-center gap-1.5 font-medium text-text-primary">
          <Icon size={11} className="shrink-0 text-text-muted" />
          <span className="truncate">{tool.name}</span>
          {onToggleFavorite && (
            <button
              type="button"
              draggable={false}
              onMouseDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onToggleFavorite(tool.id)
              }}
              className={classNames(
                'ml-auto shrink-0 rounded p-0.5 transition-colors',
                favorite ? 'text-amber-300' : 'text-text-muted opacity-0 group-hover:opacity-100 hover:text-amber-300',
              )}
              title={favorite ? 'Remove favorite' : 'Favorite tool'}
            >
              <Star size={11} className={favorite ? 'fill-current' : undefined} />
            </button>
          )}
        </div>
        <div className="text-xs text-text-muted truncate">{tool.command}</div>
      </div>
    </ToolHoverCard>
  )
}

function BundleItem({ bundle }: { bundle: ToolBundle }) {
  const Icon = iconForBundle()
  const onDragStart = (event: React.DragEvent) => {
    event.dataTransfer.setData(BUNDLE_DRAG_MIME, bundle.id)
    event.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div
      draggable
      onDragStart={onDragStart}
      className={classNames(
        'px-3 py-1.5 rounded-md text-xs cursor-grab active:cursor-grabbing',
        'hover:bg-bg-hover/80 hover:shadow-sm',
        'transition-all duration-150 select-none',
      )}
      title={bundle.description}
    >
      <div className="flex items-center gap-1.5 font-medium text-text-primary">
        <Icon size={11} className="shrink-0 text-text-muted" />
        <span className="truncate">{bundle.label}</span>
      </div>
      <div className="text-xs text-text-muted truncate">{bundle.pack}</div>
      <div className="text-xs text-text-muted truncate">{bundle.description}</div>
    </div>
  )
}

interface SpecialItemProps {
  type: 'file-input' | 'file-output' | 'note' | 'merge' | 'transfer' | 'transform'
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
        'flex items-center gap-2 px-3 py-1.5 rounded-md text-xs cursor-grab active:cursor-grabbing',
        'hover:bg-bg-hover/80 hover:shadow-sm',
        'transition-all duration-150 select-none',
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
  const [customBuilderOpen, setCustomBuilderOpen] = useState(false)
  const [favoriteToolIds, setFavoriteToolIds] = useState<string[]>([])
  const [recentToolIds, setRecentToolIds] = useState<string[]>([])
  const customNodes = useCustomNodesStore((s) => s.nodes)
  const loadCustomNodes = useCustomNodesStore((s) => s.load)
  const customLoaded = useCustomNodesStore((s) => s.loaded)
  const devMode = useSettingsStore((s) => s.devMode)
  const FileIcon = iconForNodeType('file')
  const TransformIcon = iconForNodeType('transform')
  const MergeIcon = iconForNodeType('merge')
  const TransferIcon = iconForNodeType('transfer')
  const NoteIcon = iconForNodeType('note')
  const BundleIcon = iconForBundle()

  useEffect(() => {
    if (!customLoaded) void loadCustomNodes()
  }, [customLoaded, loadCustomNodes])

  useEffect(() => {
    let cancelled = false
    void window.api.store.get<{ favorites?: unknown; recent?: unknown }>('toolPalette:preferences').then((stored) => {
      if (cancelled || !stored || typeof stored !== 'object') return
      if (Array.isArray(stored.favorites)) {
        setFavoriteToolIds(stored.favorites.filter((id): id is string => typeof id === 'string'))
      }
      if (Array.isArray(stored.recent)) {
        setRecentToolIds(stored.recent.filter((id): id is string => typeof id === 'string'))
      }
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  const persistPalettePreferences = useCallback((favorites: string[], recent: string[]) => {
    void window.api.store.set('toolPalette:preferences', { favorites, recent }).catch((err) => {
      console.warn('[ToolPalette] failed to persist preferences:', err)
    })
  }, [])

  const visibleTools = useMemo(
    () => TOOLS.filter((tool) => devMode || (!(tool.backends?.length === 1 && tool.backends.includes('dnx')) && !tool.dnxApplet && !tool.id.includes('ukb'))),
    [devMode],
  )
  const visibleToolById = useMemo(() => new Map(visibleTools.map((tool) => [tool.id, tool])), [visibleTools])
  const favoriteToolSet = useMemo(() => new Set(favoriteToolIds), [favoriteToolIds])
  const favoriteTools = useMemo(
    () => favoriteToolIds.map((id) => visibleToolById.get(id)).filter((tool): tool is ToolDef => Boolean(tool)),
    [favoriteToolIds, visibleToolById],
  )
  const recentTools = useMemo(
    () => recentToolIds.map((id) => visibleToolById.get(id)).filter((tool): tool is ToolDef => Boolean(tool)),
    [recentToolIds, visibleToolById],
  )

  const toggleFavorite = useCallback((toolId: string) => {
    setFavoriteToolIds((current) => {
      const next = current.includes(toolId) ? current.filter((id) => id !== toolId) : [toolId, ...current].slice(0, 24)
      persistPalettePreferences(next, recentToolIds)
      return next
    })
  }, [persistPalettePreferences, recentToolIds])

  const recordRecentTool = useCallback((toolId: string) => {
    setRecentToolIds((current) => {
      const next = [toolId, ...current.filter((id) => id !== toolId)].slice(0, 8)
      persistPalettePreferences(favoriteToolIds, next)
      return next
    })
  }, [favoriteToolIds, persistPalettePreferences])

  const groups = useMemo(() => {
    if (!search.trim()) {
      const groupMap = new Map<string, ToolDef[]>()
      for (const tool of visibleTools) {
        if (!groupMap.has(tool.category)) groupMap.set(tool.category, [])
        groupMap.get(tool.category)!.push(tool)
      }
      return Array.from(groupMap.entries()).map(([category, tools]) => ({ category, tools }))
    }
    const q = search.toLowerCase()
    const matches = visibleTools.filter(
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
  }, [search, visibleTools])

  const bundles = useMemo(() => {
    const visibleBundles = TOOL_BUNDLES.filter((bundle) => devMode || bundle.pack !== 'UKB/RAP Extraction')
    const q = search.trim().toLowerCase()
    if (!q) return visibleBundles
    return visibleBundles.filter((bundle) =>
      bundle.label.toLowerCase().includes(q) ||
      bundle.description.toLowerCase().includes(q) ||
      bundle.pack.toLowerCase().includes(q) ||
      bundle.id.toLowerCase().includes(q),
    )
  }, [devMode, search])

  const toggleGroup = (cat: string) => {
    const next = new Set(collapsed)
    if (next.has(cat)) next.delete(cat)
    else next.add(cat)
    setCollapsed(next)
  }

  return (
    <div className="bioflow-tool-palette-surface surface-panel animate-fade-up">
      {/* Header */}
      <div className="px-3 py-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
          Tool Palette
        </div>
        <Input
          placeholder="Search tools..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          icon={<Search size={12} />}
        />
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus size={12} />}
          className="mt-2 w-full justify-center text-xs"
          onClick={() => setCustomBuilderOpen(true)}
        >
          New Custom Node
        </Button>
      </div>

      {/* Special items */}
      <div className="p-2 flex flex-col gap-0.5">
        <SpecialItem type="file-input" label="Input File" icon={<FileIcon size={12} className="text-amber-400" />} />
        <SpecialItem type="file-output" label="Output File" icon={<FileIcon size={12} className="text-amber-400" />} />
        <SpecialItem type="transform" label="Transform" icon={<TransformIcon size={12} className="text-teal-400" />} />
        <SpecialItem type="merge" label="Merge (fan-in)" icon={<MergeIcon size={12} className="text-indigo-400" />} />
        <SpecialItem type="transfer" label="Transfer" icon={<TransferIcon size={12} className="text-cyan-400" />} />
        <SpecialItem type="note" label="Note" icon={<NoteIcon size={12} className="text-amber-400" />} />
      </div>

      {/* Tools grouped by category */}
      <div className="bioflow-tool-palette-scroll scroll-region py-1">
        {!search.trim() && favoriteTools.length > 0 && (
          <div className="mb-1">
            <div className="w-full flex items-center gap-1 px-3 py-1 text-xs uppercase tracking-wide text-text-muted">
              <Star size={10} className="fill-current text-amber-300" />
              Favorites
              <span className="ml-auto text-text-muted">{favoriteTools.length}</span>
            </div>
            <div className="px-2 flex flex-col gap-0.5">
              {favoriteTools.map((tool) => (
                <PaletteItem
                  key={`favorite-${tool.id}`}
                  tool={tool}
                  favorite
                  onToggleFavorite={toggleFavorite}
                  onUse={recordRecentTool}
                />
              ))}
            </div>
          </div>
        )}
        {!search.trim() && recentTools.length > 0 && (
          <div className="mb-1">
            <div className="w-full flex items-center gap-1 px-3 py-1 text-xs uppercase tracking-wide text-text-muted">
              <Clock3 size={10} />
              Recent
              <span className="ml-auto text-text-muted">{recentTools.length}</span>
            </div>
            <div className="px-2 flex flex-col gap-0.5">
              {recentTools.map((tool) => (
                <PaletteItem
                  key={`recent-${tool.id}`}
                  tool={tool}
                  favorite={favoriteToolSet.has(tool.id)}
                  onToggleFavorite={toggleFavorite}
                  onUse={recordRecentTool}
                />
              ))}
            </div>
          </div>
        )}
        {bundles.length > 0 && (
          <div className="mb-1">
            <div className="w-full flex items-center gap-1 px-3 py-1 text-xs uppercase tracking-wide text-text-muted">
              <BundleIcon size={10} />
              Workflow packs
              <span className="ml-auto text-text-muted">{bundles.length}</span>
            </div>
            <div className="px-2 flex flex-col gap-0.5">
              {bundles.map((bundle) => (
                <BundleItem key={bundle.id} bundle={bundle} />
              ))}
            </div>
          </div>
        )}
        {groups.length === 0 && bundles.length === 0 && (
          <div className="px-3 py-4 text-xs text-text-muted text-center">No matching tools</div>
        )}
        {customNodes.length > 0 && (
          <div className="mb-1">
            <div className="w-full flex items-center gap-1 px-3 py-1 text-xs uppercase tracking-wide text-text-muted">
              Custom
              <span className="ml-auto text-text-muted">{customNodes.length}</span>
            </div>
            <div className="px-2 flex flex-col gap-0.5">
              {customNodes.map((custom) => (
                <div key={custom.id} className="flex items-center">
                  <div className="min-w-0 flex-1">
                    <PaletteItem tool={{
                      id: custom.id,
                      name: custom.name,
                      category: 'custom',
                      description: custom.description,
                      command: 'bash',
                      inputs: custom.inputs,
                      outputs: custom.outputs,
                      params: custom.params,
                    }} />
                  </div>
                  <CustomNodeActions node={custom} />
                </div>
              ))}
            </div>
          </div>
        )}
        {groups.map(({ category, tools }) => {
          const isCollapsed = collapsed.has(category)
          const CategoryIcon = iconForCategory(category as ToolCategory)
          return (
            <div key={category} className="mb-1">
              <button
                onClick={() => toggleGroup(category)}
                className="w-full flex items-center gap-1 px-3 py-1 text-xs uppercase tracking-wide text-text-muted hover:text-text-primary transition-colors"
              >
                <ChevronRight
                  size={10}
                  className={classNames('transition-transform', isCollapsed ? '' : 'rotate-90')}
                />
                <CategoryIcon size={10} />
                {CATEGORY_LABELS[category] ?? category}
                <span className="ml-auto text-text-muted">{tools.length}</span>
              </button>
              {!isCollapsed && (
                <div className="px-2 flex flex-col gap-0.5">
                  {tools.map((tool) => (
                    <PaletteItem
                      key={tool.id}
                      tool={tool}
                      favorite={favoriteToolSet.has(tool.id)}
                      onToggleFavorite={toggleFavorite}
                      onUse={recordRecentTool}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Footer hint */}
      <div className="px-3 py-2 text-xs text-text-muted">
        Drag tools onto the canvas to build your pipeline.
      </div>
      <CustomNodeBuilder open={customBuilderOpen} onClose={() => setCustomBuilderOpen(false)} />
    </div>
  )
}
