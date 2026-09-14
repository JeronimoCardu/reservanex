'use client'

import Image from 'next/image'
import { UtensilsCrossedIcon } from 'lucide-react'
import type { PublicTenant, PublicMenuCategory } from '@/lib/repositories/public-site.repository'
import { formatPublicPrice } from '@/lib/site/public-menu'
import { PublicSiteHeader } from './public-site-header'
import { PublicSiteFooter } from './public-site-footer'

// Fase 3E-C3A2 — la carta pública de un tenant gastronómico.
//
// Reutiliza el header, el footer y la paleta del sitio público que ya existían:
// lo único propio de este rubro es cómo se lista el contenido. Un catálogo de
// propiedades y una carta se leen distinto —tarjetas grandes con filtros contra
// secciones con renglones— pero el marco es el mismo sitio.
//
// ── LO QUE NO HACE ──────────────────────────────────────────────────────────
//
// Sin carrito, sin cantidades, sin botón "Agregar". Esta fase publica la carta;
// pedir llega después. El CTA de WhatsApp del header es el que ya tenía el sitio
// y no se tocó.

function Foto({ url, alt }: { url: string | null; alt: string }) {
  // Proporción fija y tamaño declarado en las dos ramas: así la fila ocupa
  // exactamente el mismo alto haya foto o no, y la carta no salta al cargar.
  const marco = 'relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-zinc-100 sm:h-24 sm:w-24'

  if (!url) {
    return (
      <div className={`${marco} flex items-center justify-center`} aria-hidden="true">
        <UtensilsCrossedIcon className="h-7 w-7 text-zinc-300" />
      </div>
    )
  }

  return (
    <div className={marco}>
      <Image
        src={url}
        alt={alt}
        fill
        className="object-cover"
        sizes="(max-width: 640px) 80px, 96px"
      />
    </div>
  )
}

export function PublicMenuClient({
  tenant,
  categories,
  currency,
  waPhone,
  tenantSlug,
}: {
  tenant:     PublicTenant
  categories: PublicMenuCategory[]
  currency:   string
  waPhone:    string | null
  tenantSlug: string
}) {
  const nombre = tenant.public_name ?? tenant.name
  const total  = categories.reduce((n, c) => n + c.items.length, 0)

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <PublicSiteHeader tenant={tenant} waPhone={waPhone} tenantSlug={tenantSlug} />

      {/* ── Portada ── */}
      <section
        className="relative overflow-hidden border-b"
        style={{ background: 'var(--tenant-primary-soft)' }}
      >
        <div className="mx-auto w-full max-w-3xl px-4 py-10 text-center sm:py-14">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 sm:text-3xl">
            {nombre}
          </h1>
          <p className="mt-2 text-sm text-zinc-600">
            {tenant.public_description ?? 'Nuestra carta'}
          </p>
        </div>
      </section>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:py-10">
        {total === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <UtensilsCrossedIcon className="h-10 w-10 text-zinc-300" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium text-zinc-700">La carta todavía no está publicada</p>
            <p className="mt-1 max-w-sm text-sm text-zinc-500">
              Escribinos y te contamos qué tenemos disponible.
            </p>
          </div>
        ) : (
          <div className="space-y-10">
            {categories.map((cat) => (
              <section key={cat.id}>
                <h2 className="mb-4 border-b pb-2 text-lg font-semibold tracking-tight text-zinc-900">
                  {cat.name}
                </h2>

                <ul className="space-y-4">
                  {cat.items.map((item) => (
                    <li
                      key={item.id}
                      className={`flex gap-3 sm:gap-4 ${item.available ? '' : 'opacity-60'}`}
                    >
                      <Foto url={item.image_url} alt={item.name} />

                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <h3 className="min-w-0 break-words font-medium text-zinc-900">
                            {item.name}
                          </h3>
                          {/* El precio SIEMPRE visible, también en los no
                              disponibles: quien mira la carta quiere saber
                              cuánto sale igual. */}
                          <span className="ml-auto shrink-0 whitespace-nowrap text-sm font-semibold tabular-nums text-zinc-900">
                            {formatPublicPrice(item.base_price, currency)}
                          </span>
                        </div>

                        {item.description && (
                          <p className="mt-1 break-words text-sm leading-snug text-zinc-600">
                            {item.description}
                          </p>
                        )}

                        {!item.available && (
                          <span className="mt-1.5 inline-flex w-fit items-center rounded-full border border-zinc-300 bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700">
                            No disponible
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </main>

      <PublicSiteFooter tenant={tenant} />
    </div>
  )
}
