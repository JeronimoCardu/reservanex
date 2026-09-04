import type { ButtonHTMLAttributes, AnchorHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

const variantClasses = {
  primary:
    'bg-brand-green text-white hover:bg-brand-green/90 focus-visible:outline-brand-green shadow-soft',
  secondary:
    'bg-white text-brand-deep border border-slate-200 hover:border-brand-green/50 hover:text-brand-green focus-visible:outline-brand-green',
  ghost: 'bg-transparent text-brand-deep hover:bg-slate-100 focus-visible:outline-brand-deep',
  onDark:
    'bg-white/10 text-white border border-white/20 hover:bg-white/15 focus-visible:outline-white',
} as const

type Variant = keyof typeof variantClasses

const sizeClasses = {
  md: 'h-11 px-5 text-sm',
  lg: 'h-12 px-6 text-base',
} as const

type Size = keyof typeof sizeClasses

const baseClasses =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl font-semibold transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50'

type CommonProps = {
  variant?: Variant
  size?: Size
  className?: string
  children: ReactNode
}

type ButtonAsButton = CommonProps &
  ButtonHTMLAttributes<HTMLButtonElement> & {
    href?: undefined
  }

type ButtonAsAnchor = CommonProps &
  AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string
  }

type ButtonProps = ButtonAsButton | ButtonAsAnchor

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  children,
  ...props
}: ButtonProps) {
  const classes = cn(baseClasses, variantClasses[variant], sizeClasses[size], className)

  if ('href' in props && props.href) {
    const { href, ...anchorProps } = props as AnchorHTMLAttributes<HTMLAnchorElement> & {
      href: string
    }
    return (
      <a href={href} className={classes} {...anchorProps}>
        {children}
      </a>
    )
  }

  return (
    <button className={classes} {...(props as ButtonHTMLAttributes<HTMLButtonElement>)}>
      {children}
    </button>
  )
}
