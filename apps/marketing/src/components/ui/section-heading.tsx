import { cn } from '@/lib/utils'

export function SectionHeading({
  eyebrow,
  title,
  subtitle,
  align = 'center',
  className,
}: {
  eyebrow?: string
  title: string
  subtitle?: string
  align?: 'center' | 'left'
  className?: string
}) {
  return (
    <div
      className={cn(
        'max-w-3xl',
        align === 'center' ? 'mx-auto text-center' : 'text-left',
        className,
      )}
    >
      {eyebrow ? (
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-green">{eyebrow}</p>
      ) : null}
      <h2 className="mt-3 text-3xl font-bold tracking-tight text-brand-deep sm:text-4xl">
        {title}
      </h2>
      {subtitle ? <p className="mt-4 text-lg leading-relaxed text-slate-600">{subtitle}</p> : null}
    </div>
  )
}
