import { useEffect, useRef, useState } from 'react'
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
  const rootRef = useRef<HTMLDivElement>(null)
  const activeOption = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className={classNames('relative min-w-0', className)}>
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
      {open && (
        <div className={classNames('surface-popover absolute left-0 top-full z-50 mt-1 max-h-72 min-w-full overflow-y-auto rounded-lg p-1', menuClassName)}>
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
        </div>
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
