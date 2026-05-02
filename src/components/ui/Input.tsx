import React, { forwardRef, useId } from 'react'
import { classNames } from '@/lib/utils'

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  labelNode?: React.ReactNode
  error?: string
  icon?: React.ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, labelNode, error, icon, className, id, ...props }, ref) => {
    const autoId = useId()
    const inputId = id ?? autoId

    return (
      <div className="flex flex-col gap-1">
        {(label || labelNode) && (
          <label
            htmlFor={inputId}
            className="text-text-secondary text-xs font-medium"
          >
            {labelNode ?? label}
          </label>
        )}
        <div className="relative">
          {icon && (
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none">
              {icon}
            </span>
          )}
          <input
            ref={ref}
            id={inputId}
            className={classNames(
              'bioflow-field h-8 w-full rounded-md border px-3 text-sm text-text-primary placeholder-text-muted shadow-sm',
              'border-border-light bg-bg-tertiary/90 outline-none transition-all duration-150 ease-out',
              'focus:border-accent focus:ring-2 focus:ring-accent/25',
              error && 'border-error focus:border-error focus:ring-error/20',
              icon && 'pl-8',
              className,
            )}
            {...props}
          />
        </div>
        {error && (
          <span className="text-error text-xs">{error}</span>
        )}
      </div>
    )
  },
)

Input.displayName = 'Input'
