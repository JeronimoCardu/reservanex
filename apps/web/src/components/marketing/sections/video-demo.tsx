import { getTranslations } from 'next-intl/server'
import Image from 'next/image'
import { Play } from 'lucide-react'
import { Container } from '@/components/marketing/ui/container'
import { Button } from '@/components/marketing/ui/button'
import { getVideoPosterPath } from '@/lib/marketing/product-assets'

/**
 * Ready to receive a real video: once available, wire videoUrl/posterUrl
 * here (e.g. from env or CMS) and swap the placeholder <button> below for a
 * real <video>/iframe using those URLs. Until then this renders an elegant
 * "coming soon" state instead of a broken or fake embed. The poster image
 * (public/product/video-poster.webp) is already wired up: drop the file in
 * and it replaces the gradient placeholder automatically.
 */
export async function VideoDemo() {
  const t = await getTranslations('videoDemo')
  const posterSrc = getVideoPosterPath()

  return (
    <section className="bg-brand-deep py-20 sm:py-24">
      <Container>
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-brand-yellow">
            {t('eyebrow')}
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            {t('title')}
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-slate-300">{t('description')}</p>
        </div>

        <div className="mx-auto mt-12 max-w-4xl">
          <div className="relative aspect-video overflow-hidden rounded-2xl border border-white/10 bg-white/5">
            {posterSrc ? (
              <Image
                src={posterSrc}
                alt=""
                fill
                sizes="(min-width: 1024px) 896px, 100vw"
                className="object-cover opacity-60"
              />
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-brand-green/20 via-transparent to-brand-yellow/10" />
            )}
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
              <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white">
                {t('pendingBadge')}
              </span>
              <button
                type="button"
                aria-label={t('playAria')}
                disabled
                className="flex h-16 w-16 items-center justify-center rounded-full bg-white/15 text-white transition-colors disabled:cursor-not-allowed"
              >
                <Play className="ml-1 h-7 w-7" aria-hidden="true" />
              </button>
              <p className="max-w-sm text-sm text-slate-300">{t('pendingMessage')}</p>
            </div>
          </div>

          <div className="mt-6 flex justify-center">
            <Button href="#contact" variant="onDark" size="md">
              {t('requestDemo')}
            </Button>
          </div>
        </div>
      </Container>
    </section>
  )
}
