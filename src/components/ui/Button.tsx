import React from 'react'
import { classNames } from '@/lib/utils'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  icon?: React.ReactNode
  children?: React.ReactNode
}

const variantStyles: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'bg-accent text-white shadow-md hover:bg-accent-hover font-medium tracking-[0.01em]',
  secondary: 'bg-bg-tertiary/90 text-text-primary shadow-sm hover:bg-bg-hover',
  ghost: 'bg-transparent text-text-secondary hover:bg-bg-hover/80 hover:text-text-primary',
  danger: 'bg-error/10 text-error hover:bg-error/20 shadow-sm',
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
        'interactive-button inline-flex items-center justify-center rounded-md font-medium transition-all duration-150 ease-out',
        'focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-0',
        variantStyles[variant],
        sizeStyles[size],
        icon && children && 'gap-1.5',
        disabled && 'opacity-50 cursor-not-allowed shadow-none',
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
