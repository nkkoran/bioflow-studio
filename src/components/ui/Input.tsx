import React, { forwardRef, useId } from 'react'
import { classNames } from '@/lib/utils'

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  icon?: React.ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, icon, className, id, ...props }, ref) => {
    const autoId = useId()
    const inputId = id ?? autoId

    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label
            htmlFor={inputId}
            className="text-text-secondary text-xs font-medium"
          >
            {label}
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
              'h-8 w-full rounded-md border bg-bg-tertiary px-3 text-sm text-text-primary placeholder-text-muted',
              'outline-none transition-colors',
              'focus:ring-1 focus:ring-accent focus:border-accent',
              error ? 'border-error' : 'border-border',
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
