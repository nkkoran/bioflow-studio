import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { classNames } from '@/lib/utils'

export interface MenuSelectOption<T extends string = string> {
  value: T
  label: string
  description?: string
}

interface MenuSelectProps<T extends string = string> {
  value: T | ''
  options: Array<MenuSelectOption<T>>
  onChange: (value: T | '') => void
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
  className?: string
  buttonClassName?: string
  menuClassName?: string
  allowEmpty?: boolean
  emptyLabel?: string
}

export function MenuSelect<T extends string = string>({
  value,
  options,
  onChange,
  placeholder = 'Choose',
  ariaLabel,
  disabled,
  className,
  buttonClassName,
  menuClassName,
  allowEmpty = false,
  emptyLabel = 'None',
}: MenuSelectProps<T>) {
  const [open, setOpen] = useState(false)
  const [menuRect, setMenuRect] = useState<{ left: number; top: number; minWidth: number; maxHeight: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const activeOption = options.find((option) => option.value === value)

  function updateMenuRect() {
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) {
      setMenuRect(null)
      return
    }
    const gap = 4
    const viewportPadding = 12
    const preferredMaxHeight = 288
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding
    const spaceAbove = rect.top - viewportPadding
    const openAbove = spaceBelow < 160 && spaceAbove > spaceBelow
    const available = Math.max(120, Math.min(preferredMaxHeight, (openAbove ? spaceAbove : spaceBelow) - gap))
    setMenuRect({
      left: Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - rect.width - viewportPadding)),
      top: openAbove ? Math.max(viewportPadding, rect.top - available - gap) : rect.bottom + gap,
      minWidth: rect.width,
      maxHeight: available,
    })
  }

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    updateMenuRect()
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', updateMenuRect)
    window.addEventListener('scroll', updateMenuRect, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', updateMenuRect)
      window.removeEventListener('scroll', updateMenuRect, true)
    }
  }, [open])

  return (
    <div ref={rootRef} className={classNames('relative min-w-0 overflow-visible', className)}>
      <button
        type="button"
        aria-label={ariaLabel ?? placeholder}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((next) => !next)}
        className={classNames(
          'interactive-row flex h-7 w-full min-w-0 items-center gap-2 rounded-md bg-bg-tertiary/70 px-2 text-left text-xs text-text-primary shadow-sm disabled:cursor-not-allowed disabled:opacity-50',
          buttonClassName,
        )}
      >
        <span className={classNames('text-nowrap min-w-0 flex-1', !activeOption && !value && 'text-text-muted')}>
          {activeOption?.label ?? (value || placeholder)}
        </span>
        <ChevronDown size={12} className={classNames('shrink-0 text-text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && menuRect && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          className={classNames('surface-popover fixed z-[1400] overflow-y-auto rounded-lg p-1', menuClassName)}
          style={{
            left: menuRect.left,
            top: menuRect.top,
            minWidth: menuRect.minWidth,
            maxHeight: menuRect.maxHeight,
          }}
          onWheel={(event) => event.stopPropagation()}
        >
          {allowEmpty && (
            <MenuSelectItem
              label={emptyLabel}
              active={value === ''}
              onClick={() => {
                onChange('')
                setOpen(false)
              }}
            />
          )}
          {options.map((option) => (
            <MenuSelectItem
              key={option.value}
              label={option.label}
              description={option.description}
              active={option.value === value}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            />
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

function MenuSelectItem({
  label,
  description,
  active,
  onClick,
}: {
  label: string
  description?: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={classNames(
        'interactive-row flex w-full min-w-0 flex-col items-start px-2 py-1.5 text-left text-xs',
        active ? 'bg-accent/10 text-text-primary' : 'text-text-secondary hover:text-text-primary',
      )}
    >
      <span className="text-nowrap min-w-0 max-w-full">{label}</span>
      {description && <span className="text-wrap mt-0.5 text-[10px] leading-4 text-text-muted">{description}</span>}
    </button>
  )
}
