import { cn } from '@/lib/utils'

/**
 * Single place that renders the ReservaNex brand mark. Pass `src` (resolved
 * server-side by getBrandLogoHorizontalPath(), see lib/brand-assets.ts) once
 * public/brand/reservanex-logo-horizontal.svg exists; every caller then
 * switches to the real asset automatically, with no per-component changes.
 * Until then it falls back to a typographic placeholder — the real mark is
 * never redrawn here.
 */
export function Logo({
  tone = 'dark',
  className,
  src,
}: {
  tone?: 'dark' | 'light'
  className?: string
  src?: string | null
}) {
  const isLight = tone === 'light'

  if (src) {
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary-size SVG logo, next/image's optimizer doesn't help here
    return <img src={src} alt="ReservaNex" className={cn('h-8 w-auto', className)} />
  }

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span
        className="from-brand-green to-brand-yellow flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-sm font-bold text-white"
        aria-hidden="true"
      >
        OF
      </span>
      <span className="text-lg font-bold tracking-tight">
        <span className={isLight ? 'text-white' : 'text-brand-deep'}>Reserva</span>
        <span className="text-brand-green">Nex</span>
      </span>
    </span>
  )
}
