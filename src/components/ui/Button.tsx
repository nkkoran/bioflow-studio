import React from 'react'
import { classNames } from '@/lib/utils'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  icon?: React.ReactNode
  children?: React.ReactNode
}

const variantStyles: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover',
  secondary: 'bg-bg-tertiary text-text-primary hover:bg-bg-hover border border-border',
  ghost: 'bg-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary',
  danger: 'bg-error/10 text-error hover:bg-error/20',
}

const sizeStyles: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'h-7 px-2 text-xs',
  md: 'h-8 px-3 text-sm',
  lg: 'h-9 px-4 text-sm',
}

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  children,
  className,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={classNames(
        'inline-flex items-center justify-center rounded-md font-medium transition-colors',
        variantStyles[variant],
        sizeStyles[size],
        icon && children && 'gap-1.5',
        disabled && 'opacity-50 cursor-not-allowed',
        className,
      )}
      disabled={disabled}
      {...props}
    >
      {icon}
      {children}
    </button>
  )
}
