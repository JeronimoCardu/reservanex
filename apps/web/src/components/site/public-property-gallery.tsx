'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Image from 'next/image'
import type { PublicPropertyImage, PublicPropertyVideo } from '@/lib/repositories/public-site.repository'

// ── Types ──────────────────────────────────────────────────────────────────────
type ImageMedia = PublicPropertyImage & { kind: 'image' }
type VideoMedia = PublicPropertyVideo & { kind: 'video' }
type MediaItem  = ImageMedia | VideoMedia

interface Props {
  images:   PublicPropertyImage[]
  videos?:  PublicPropertyVideo[]
  coverUrl: string | null
  title:    string
}

// Items shown in the hero grid before the "+N" overflow:
//   slot 0 → main (large)
//   slots 1-2 → thumbnails (stacked on the right)
const MAX_VISIBLE = 3

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDuration(s: number): string {
  const m = Math.floor(s / 60)
  const r = s % 60
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `0:${String(r).padStart(2, '0')}`
}

/**
 * Returns the inner content of a media cell (image fill or video placeholder).
 * Must be called inside a `position: relative` container with explicit dimensions.
 */
function MediaCellInner({ item, priority, small }: { item: MediaItem; priority?: boolean; small?: boolean }) {
  if (item.kind === 'image') {
    return (
      <Image
        src={item.image_url}
        alt={item.alt ?? ''}
        fill
        priority={priority}
        className="object-cover transition-transform duration-500 group-hover:scale-105"
        sizes={small ? '(max-width: 1280px) 25vw, 280px' : '(max-width: 768px) 100vw, (max-width: 1280px) 60vw, 700px'}
      />
    )
  }
  // Video thumbnail — real first frame via preload="metadata" + play overlay
  return (
    <>
      {/* Dark base — fallback while metadata loads */}
      <div className="absolute inset-0 bg-zinc-900" />
      {/* Actual video frame, object-cover to fill without bars */}
      <video
        src={`/api/property-videos/${item.id}`}
        preload="metadata"
        muted
        playsInline
        className="absolute inset-0 h-full w-full object-cover pointer-events-none"
      />
      {/* Play overlay — semi-transparent so the frame shows through */}
      <div className="absolute inset-0 flex items-center justify-center bg-black/25 transition-colors duration-300 group-hover:bg-black/35">
        <svg
          viewBox="0 0 24 24"
          fill="white"
          aria-hidden="true"
          className={small ? 'h-8 w-8' : 'h-12 w-12'}
          style={{ filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.7))' }}
        >
          <path d="M8 5v14l11-7z" />
        </svg>
      </div>
      {item.duration_seconds != null && (
        <span className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-xs tabular-nums text-white">
          {fmtDuration(item.duration_seconds)}
        </span>
      )}
    </>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PublicPropertyGallery({ images, videos = [], coverUrl, title }: Props) {
  // Synthesize a single cover-image item when gallery is empty
  const synth: PublicPropertyImage[] = coverUrl
    ? [{ id: 'cover', image_url: coverUrl, alt: title, is_cover: true, sort_order: 0 }]
    : []

  const imageMedia: ImageMedia[] = (images.length > 0 ? images : synth).map(img => ({ ...img, kind: 'image' as const }))
  const videoMedia: VideoMedia[] = videos.map(v => ({ ...v, kind: 'video' as const }))
  const allMedia: MediaItem[]    = [...imageMedia, ...videoMedia]

  const total       = allMedia.length
  const main        = allMedia[0]
  const thumbs      = allMedia.slice(1, MAX_VISIBLE)   // 0-2 items
  const hiddenCount = Math.max(0, total - MAX_VISIBLE)  // items hidden beyond the 3 visible slots

  // ── Lightbox state ─────────────────────────────────────────────────────────
  const [open, setOpen] = useState(false)
  const [idx,  setIdx]  = useState(0)
  const touchStartX     = useRef<number | null>(null)

  const openAt = useCallback((i: number) => { setIdx(i); setOpen(true) }, [])
  const close  = useCallback(() => setOpen(false), [])
  const prev   = useCallback(() => setIdx(i => Math.max(0, i - 1)), [])
  const next   = useCallback(() => setIdx(i => Math.min(total - 1, i + 1)), [total])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape')     close()
      if (e.key === 'ArrowLeft')  prev()
      if (e.key === 'ArrowRight') next()
    }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, close, prev, next])

  const current = allMedia[idx]

  // ── Empty state ─────────────────────────────────────────────────────────────
  if (total === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-2xl bg-zinc-100 md:h-[400px]">
        <svg className="h-16 w-16 text-zinc-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
          <polyline strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} points="9 22 9 12 15 12 15 22" />
        </svg>
      </div>
    )
  }

  // ── Single media: full-width hero ───────────────────────────────────────────
  if (total === 1) {
    return (
      <>
        <button
          type="button"
          className="group relative block w-full overflow-hidden rounded-2xl"
          style={{ height: 'clamp(240px, 45vw, 480px)' }}
          onClick={() => openAt(0)}
          aria-label={main!.kind === 'image' ? 'Ver foto' : 'Ver video'}
        >
          <MediaCellInner item={main!} priority />
        </button>

        {/* Lightbox */}
        {open && current && <Lightbox current={current} idx={idx} total={total} title={title} onClose={close} onPrev={prev} onNext={next} touchRef={touchStartX} />}
      </>
    )
  }

  // ── Multi-media: hero layout ─────────────────────────────────────────────────
  const hasDoubleThumb = thumbs.length >= 2

  return (
    <>
      <div className="relative overflow-hidden rounded-2xl">

        {/* Desktop grid — hidden on mobile */}
        <div
          className="hidden overflow-hidden rounded-2xl md:grid"
          style={{
            height:               'clamp(240px, 45vw, 480px)',
            gridTemplateColumns:  '3fr 1.2fr',
            gridTemplateRows:     hasDoubleThumb ? '1fr 1fr' : '1fr',
            gap:                  '4px',
          }}
        >
          {/* Main slot — spans all rows when there are 2 thumbnails */}
          <button
            type="button"
            className="group relative overflow-hidden"
            style={{ gridRow: hasDoubleThumb ? '1 / -1' : undefined }}
            onClick={() => openAt(0)}
            aria-label="Ver media principal"
          >
            <MediaCellInner item={main!} priority />
          </button>

          {/* Thumbnail slots */}
          {thumbs.map((item, i) => {
            const isLast   = i === thumbs.length - 1
            const showPlus = isLast && hiddenCount > 0
            return (
              <button
                key={item.id ?? i}
                type="button"
                className="group relative overflow-hidden"
                onClick={() => openAt(i + 1)}
                aria-label={`Ver media ${i + 2}`}
              >
                <MediaCellInner item={item} small />
                {showPlus && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55">
                    <span className="text-2xl font-bold text-white drop-shadow-lg">+{hiddenCount}</span>
                  </div>
                )}
              </button>
            )
          })}
        </div>

        {/* Mobile: only the main item, full-width */}
        <button
          type="button"
          className="group relative block w-full overflow-hidden rounded-2xl md:hidden"
          style={{ height: 'clamp(220px, 60vw, 360px)' }}
          onClick={() => openAt(0)}
          aria-label="Abrir galería"
        >
          <MediaCellInner item={main!} priority />
        </button>

        {/* Mobile pill — visible count badge */}
        <button
          type="button"
          className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-lg bg-white/90 px-2.5 py-1.5 text-xs font-semibold text-zinc-800 shadow backdrop-blur-sm md:hidden"
          onClick={() => openAt(0)}
          aria-label={`Ver galería (${total} medios)`}
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          {total}
        </button>
      </div>

      {/* Lightbox */}
      {open && current && (
        <Lightbox
          current={current}
          idx={idx}
          total={total}
          title={title}
          onClose={close}
          onPrev={prev}
          onNext={next}
          touchRef={touchStartX}
        />
      )}
    </>
  )
}

// ── Lightbox ───────────────────────────────────────────────────────────────────

interface LightboxProps {
  current:  MediaItem
  idx:      number
  total:    number
  title:    string
  onClose:  () => void
  onPrev:   () => void
  onNext:   () => void
  touchRef: React.MutableRefObject<number | null>
}

function Lightbox({ current, idx, total, title, onClose, onPrev, onNext, touchRef }: LightboxProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Galería"
      onTouchStart={e => { touchRef.current = e.touches[0]?.clientX ?? null }}
      onTouchEnd={e => {
        if (touchRef.current === null) return
        const dx = (e.changedTouches[0]?.clientX ?? 0) - touchRef.current
        if (dx > 50) onPrev()
        else if (dx < -50) onNext()
        touchRef.current = null
      }}
    >
      {/* Content */}
      {current.kind === 'image' ? (
        <div
          className="relative"
          style={{ width: 'min(90vw, 900px)', height: 'min(82vh, 660px)' }}
          onClick={e => e.stopPropagation()}
        >
          <Image
            src={current.image_url}
            alt={current.alt ?? title}
            fill
            className="object-contain"
            sizes="(max-width: 1280px) 90vw, 900px"
            priority
          />
        </div>
      ) : (
        <div
          className="w-full max-w-4xl px-4"
          onClick={e => e.stopPropagation()}
        >
          <video
            key={current.id}
            src={`/api/property-videos/${current.id}`}
            controls
            preload="metadata"
            playsInline
            className="w-full rounded-xl"
            style={{ maxHeight: 'min(78vh, 620px)' }}
          />
        </div>
      )}

      {/* Counter */}
      <div className="pointer-events-none absolute bottom-5 left-0 right-0 flex select-none justify-center">
        <span className="rounded-full bg-black/60 px-3 py-1 text-sm text-white/80">
          {idx + 1} / {total}
        </span>
      </div>

      {/* Close */}
      <button
        onClick={e => { e.stopPropagation(); onClose() }}
        aria-label="Cerrar galería"
        className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-zinc-900/80 text-white ring-1 ring-white/20 transition-colors hover:bg-zinc-900"
      >
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* Prev */}
      {idx > 0 && (
        <button
          onClick={e => { e.stopPropagation(); onPrev() }}
          aria-label="Anterior"
          className="absolute left-3 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-zinc-900/80 text-white ring-1 ring-white/20 transition-colors hover:bg-zinc-900"
        >
          <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      )}

      {/* Next */}
      {idx < total - 1 && (
        <button
          onClick={e => { e.stopPropagation(); onNext() }}
          aria-label="Siguiente"
          className="absolute right-3 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-zinc-900/80 text-white ring-1 ring-white/20 transition-colors hover:bg-zinc-900"
        >
          <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}
    </div>
  )
}
