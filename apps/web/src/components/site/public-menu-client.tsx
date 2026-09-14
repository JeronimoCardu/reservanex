'use client'

import { useRef, useState } from 'react'
import Image from 'next/image'
import { UtensilsCrossedIcon, PlusIcon, ShoppingBagIcon } from 'lucide-react'
import { formatMoneyString } from '@orderflow/validators'
import type { PublicTenant, PublicMenuCategory, PublicMenuItem } from '@/lib/repositories/public-site.repository'
import { formatPublicPrice } from '@/lib/site/public-menu'
import { addToCart, cartCount, cartSubtotal, type CartLine } from '@/lib/site/cart'
import { PublicSiteHeader } from './public-site-header'
import { PublicSiteFooter } from './public-site-footer'
import { CartSheet } from './cart-sheet'

// Fase 3E-C3A2 — la carta pública de un tenant gastronómico.
//
// Reutiliza el header, el footer y la paleta del sitio público que ya existían:
// lo único propio de este rubro es cómo se lista el contenido. Un catálogo de
// propiedades y una carta se leen distinto —tarjetas grandes con filtros contra
// secciones con renglones— pero el marco es el mismo sitio.
//
// ── EL CARRITO (Fase 3E-C3B1) ───────────────────────────────────────────────
//
// El estado del carrito vive ACÁ, en useState, y nada más: sin localStorage, sin
// sessionStorage y sin ruta propia. Recargar la página lo pierde, y está
// asumido para V1 — persistirlo abre preguntas (¿cuánto dura?, ¿qué pasa si
// entretanto cambió el precio?) que esta fase no va a responder a medias.
//
// Las REGLAS del carrito no están en este archivo: viven en @/lib/site/cart,
// puras y con tests. Acá solo se dibuja y se guarda el resultado.

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
  idempotencyKey,
  whatsappNumber,
}: {
  tenant:         PublicTenant
  categories:     PublicMenuCategory[]
  currency:       string
  waPhone:        string | null
  tenantSlug:     string
  idempotencyKey: string
  whatsappNumber: string | null
}) {
  const nombre = tenant.public_name ?? tenant.name
  const total  = categories.reduce((n, c) => n + c.items.length, 0)

  const [lines, setLines] = useState<CartLine[]>([])
  const [abierto, setAbierto] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)

  // Contador para client_line_id. Un contador y no un uuid: es identidad LOCAL
  // de React, no se manda a ningún lado, y así addToCart/duplicateLine siguen
  // siendo funciones puras que se pueden testear sin mockear nada.
  const contador = useRef(0)
  const nextLineId = () => `cl-${++contador.current}`

  const unidades = cartCount(lines)
  const subtotal = cartSubtotal(lines) ?? '0.00'

  function agregar(item: PublicMenuItem) {
    const r = addToCart(lines, { id: item.id, name: item.name, base_price: item.base_price, available: item.available }, nextLineId())
    if (r.ok) {
      setLines(r.lines)
      setAviso(null)
      return
    }
    setAviso(
      r.reason === 'unavailable'
        ? 'Ese producto no está disponible en este momento.'
        : r.reason === 'cart_full'
          ? 'El pedido llegó al máximo. Revisalo antes de agregar más.'
          : 'No pudimos agregar ese producto.',
    )
  }

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

                        <div className="mt-1.5 flex items-center gap-2">
                          {!item.available && (
                            <span className="inline-flex w-fit items-center rounded-full border border-zinc-300 bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700">
                              No disponible
                            </span>
                          )}

                          {/* §12 — un producto sin disponibilidad se sigue
                              mostrando con su precio, pero NO se puede agregar.
                              El botón queda deshabilitado en vez de
                              desaparecer: así se ve que existe y que hoy no. */}
                          <button
                            type="button"
                            disabled={!item.available}
                            onClick={() => agregar(item)}
                            aria-label={`Agregar ${item.name} al pedido`}
                            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:border-zinc-200 disabled:text-zinc-400 enabled:border-zinc-300 enabled:text-zinc-800 enabled:hover:bg-zinc-100"
                          >
                            <PlusIcon className="h-3.5 w-3.5" />
                            Agregar
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </main>

      {aviso && (
        <p
          role="alert"
          className="fixed inset-x-0 bottom-24 z-40 mx-auto w-[min(92%,32rem)] rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-center text-sm text-amber-800 shadow-lg"
        >
          {aviso}
        </p>
      )}

      {/* ── Barra del pedido ── */}
      {lines.length > 0 && (
        <div className="sticky bottom-0 z-30 border-t bg-white/95 px-4 py-3 backdrop-blur">
          <button
            type="button"
            onClick={() => setAbierto(true)}
            className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 rounded-xl px-4 py-3.5 text-base font-medium text-white shadow-sm transition"
            style={{ background: 'var(--tenant-primary, #0F766E)' }}
          >
            <span className="inline-flex items-center gap-2">
              <ShoppingBagIcon className="h-5 w-5" />
              Ver pedido ({unidades})
            </span>
            <span className="tabular-nums">{formatMoneyString(subtotal, currency)}</span>
          </button>
        </div>
      )}

      <CartSheet
        open={abierto}
        onClose={() => setAbierto(false)}
        lines={lines}
        onLines={setLines}
        currency={currency}
        tenantSlug={tenantSlug}
        idempotencyKey={idempotencyKey}
        whatsappNumber={whatsappNumber}
        nextLineId={nextLineId}
      />

      <PublicSiteFooter tenant={tenant} />
    </div>
  )
}
