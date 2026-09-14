'use client'

import { useEffect, useState } from 'react'
import { MinusIcon, PlusIcon, Trash2Icon, XIcon, CopyPlusIcon, CheckCircle2Icon } from 'lucide-react'
import { centsToMoneyString, formatMoneyString } from '@orderflow/validators'
import {
  applyPriceChanges,
  cartCount,
  cartSubtotal,
  duplicateLine,
  lineTotalCents,
  linesForItems,
  removeLine,
  setLineNotes,
  setQuantity,
  toApiItems,
  MAX_LINE_QUANTITY,
  type CartLine,
} from '@/lib/site/cart'
import {
  INITIAL_CHECKOUT_STATE,
  fromStructuredError,
  onSheetClosed,
  showsForm,
  toCart,
  toCheckout,
  toSuccess,
  type CheckoutState,
} from '@/lib/site/checkout-flow'
import { buildSubmissionWhatsAppHref } from '@/lib/site/submission-whatsapp'
import { DynamicForm } from './dynamic-form'

// Fase 3E-C3B1 — el carrito y el checkout, en la MISMA página.
//
// No hay ruta /site/[slug]/pedido: esto es un sheet sobre la carta. Salir del
// pedido es cerrar el panel, no navegar y perder el contexto.
//
//   CART  →  CHECKOUT  →  SUCCESS
//
// El checkout NO reimplementa los cinco campos del formulario: monta el mismo
// DynamicForm que usa el resto del sitio y le adjunta los items por
// extraPayload. Los 409 del servidor los atiende este componente, porque
// DynamicForm no sabe —ni tiene que saber— qué es un carrito.
//
// ── EL PASO SUCCESS ES PROPIO, Y ES A PROPÓSITO ─────────────────────────────
//
// La primera versión no tenía paso SUCCESS: el "¡Listo!" lo dibujaba el estado
// INTERNO de DynamicForm. Y el callback de éxito renovaba la clave de
// idempotencia que se usaba como `key` de ese mismo DynamicForm, así que React lo
// desmontaba y montaba otro vacío en 'idle'. El pedido se creaba —había
// SUB-XXXXXX en la base— y en pantalla no quedaba nada.
//
// Ahora el resultado del POST vive en el estado de ESTE componente, y en el paso
// success DynamicForm no se monta. Ningún reset suyo puede borrar la referencia.
// Las transiciones viven en @/lib/site/checkout-flow, puras y con tests.

function nuevaClaveIdempotencia(previa: string): string {
  // El navegador real siempre tiene crypto.randomUUID en un contexto seguro; el
  // fallback existe para no romper en un entorno donde no esté.
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch { /* seguimos con el fallback */ }
  return previa
}

export function CartSheet({
  open, onClose, lines, onLines, currency, tenantSlug, idempotencyKey, whatsappNumber, nextLineId,
}: {
  open:            boolean
  onClose:         () => void
  lines:           CartLine[]
  onLines:         (lines: CartLine[]) => void
  currency:        string
  tenantSlug:      string
  idempotencyKey:  string
  whatsappNumber:  string | null
  nextLineId:      () => string
}) {
  const [flujo, setFlujo] = useState<CheckoutState>(INITIAL_CHECKOUT_STATE)

  // §9 — UNA clave por pedido, no por línea ni por intento.
  //
  // Los reintentos de un mismo pedido comparten clave: es lo que hace que un
  // retry de red devuelva la submission que ya existe en vez de crear otra (y,
  // para food_order, que ni siquiera se miren los precios actuales). Se renueva
  // recién DESPUÉS de un pedido exitoso, porque a partir de ahí un nuevo envío
  // es un pedido nuevo y no un reintento del anterior.
  //
  // Ojo: renovarla remonta el DynamicForm (es su `key`). Eso ahora es inocuo
  // porque en el paso success el formulario no está montado y la referencia vive
  // en `flujo`. Ese acoplamiento fue el bug.
  const [claveIdem, setClaveIdem] = useState(idempotencyKey)

  // Al cerrar el panel se vuelve al estado inicial. Recién ACÁ se descarta el
  // resultado: mientras success esté visible, la referencia tiene que seguir en
  // pantalla.
  useEffect(() => {
    if (!open) setFlujo(onSheetClosed())
  }, [open])

  if (!open) return null

  const subtotal = cartSubtotal(lines) ?? '0.00'
  const unidades = cartCount(lines)
  const waHref   = buildSubmissionWhatsAppHref(whatsappNumber, flujo.result?.reference)

  function actualizar(next: CartLine[]) {
    onLines(next)
    setFlujo((f) => ({ ...f, flagged: [] }))
  }

  // Los 409 estructurados. Devolver true significa "lo manejo yo": DynamicForm
  // no dibuja su propio mensaje de error y NO resetea nada.
  function manejarError(body: { code: string } & Record<string, unknown>): boolean {
    const salida = fromStructuredError(flujo, body)
    if (!salida) return false

    if (salida.code === 'price_changed') {
      // TODAS las líneas de cada item cambiado, no solo la primera.
      onLines(applyPriceChanges(lines, salida.prices))
    }
    // En cart_changed NO se quita nada solo: se marca y decide la persona.
    setFlujo({ ...salida.state, flagged: linesForItems(lines, salida.itemIds) })
    return true
  }

  const titulo = flujo.step === 'cart'
    ? 'Tu pedido'
    : flujo.step === 'checkout'
      ? 'Tus datos'
      : 'Pedido recibido'

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Cerrar el pedido"
        onClick={onClose}
        className="absolute inset-0 bg-zinc-900/40 backdrop-blur-[1px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Tu pedido"
        className="relative flex max-h-[92vh] w-full max-w-lg flex-col rounded-t-2xl bg-white shadow-2xl sm:max-h-[86vh] sm:rounded-2xl"
      >
        {/* ── Encabezado ── */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">{titulo}</h2>
            {flujo.step === 'cart' && unidades > 0 && (
              <p className="text-xs text-zinc-500">
                {unidades} {unidades === 1 ? 'producto' : 'productos'} · {lines.length}{' '}
                {lines.length === 1 ? 'línea' : 'líneas'}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
          >
            <XIcon className="h-5 w-5" />
          </button>
        </div>

        {flujo.notice && (
          <p
            role="alert"
            className={`mx-4 mt-3 rounded-xl border px-3.5 py-2.5 text-sm ${
              flujo.notice.tone === 'price'
                ? 'border-amber-200 bg-amber-50 text-amber-800'
                : 'border-red-200 bg-red-50 text-red-700'
            }`}
          >
            {flujo.notice.text}
          </p>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {/* ── SUCCESS ── */}
          {flujo.step === 'success' ? (
            <div role="status" className="py-4 text-center">
              <CheckCircle2Icon className="mx-auto h-10 w-10 text-emerald-500" aria-hidden="true" />
              <h3 className="mt-3 text-lg font-semibold text-zinc-900">¡Recibimos tu pedido!</h3>
              <p className="mt-2 text-sm text-zinc-600">
                Falta un paso: confirmalo por WhatsApp para que lo empecemos a preparar.
              </p>

              <p className="mt-4 text-sm text-zinc-600">
                Tu número de referencia:{' '}
                <span className="font-mono font-semibold tracking-wide text-zinc-900">
                  {flujo.result?.reference}
                </span>
              </p>

              {waHref ? (
                <a
                  href={waHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#25D366] px-4 py-3.5 text-base font-medium text-white shadow-sm transition hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-[#25D366] focus:ring-offset-2"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-current">
                    <path d="M17.47 14.38c-.3-.15-1.75-.86-2.02-.96-.27-.1-.47-.15-.67.15-.2.3-.77.96-.94 1.16-.17.2-.35.22-.64.07-.3-.15-1.25-.46-2.38-1.47-.88-.78-1.47-1.75-1.65-2.05-.17-.3-.02-.46.13-.6.14-.14.3-.35.45-.53.15-.18.2-.3.3-.5.1-.2.05-.38-.02-.53-.08-.15-.67-1.6-.92-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.22 3.08c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.7.63.71.23 1.36.19 1.87.12.57-.09 1.75-.72 2-1.41.25-.7.25-1.29.17-1.41-.07-.13-.27-.2-.57-.35z" />
                    <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.86 9.86 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm0 18.15h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.19 8.19 0 0 1-1.26-4.38c0-4.54 3.7-8.23 8.25-8.23 2.2 0 4.27.86 5.83 2.42a8.19 8.19 0 0 1 2.41 5.82c0 4.54-3.7 8.23-8.24 8.23z" />
                  </svg>
                  Confirmar por WhatsApp
                </a>
              ) : (
                // Estado controlado: el tenant no tiene una cuenta AutoResponder
                // activa. No se inventa un número ni se ofrece un link roto.
                <p className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
                  Guardá esa referencia: te la vamos a pedir cuando nos contactes.
                </p>
              )}
            </div>
          ) : showsForm(flujo) ? (
            <DynamicForm
              // Remontar con la clave nueva prepara el PRÓXIMO pedido. Ya no
              // puede borrar un éxito: en el paso success esto no está montado.
              key={claveIdem}
              tenantSlug={tenantSlug}
              intent="food_order"
              idempotencyKey={claveIdem}
              whatsappNumber={whatsappNumber}
              extraPayload={{ items: toApiItems(lines) }}
              onStructuredError={manejarError}
              onSubmitted={(result) => {
                // PRIMERO se guarda el resultado y se pasa a success; recién
                // después se limpia el carrito y se renueva la clave. El orden
                // importa: es literalmente el bug que esto corrige.
                setFlujo((f) => toSuccess(f, result))
                onLines([])
                setClaveIdem((previa) => nuevaClaveIdempotencia(previa))
              }}
            />
          ) : lines.length === 0 ? (
            <p className="py-10 text-center text-sm text-zinc-500">
              Todavía no agregaste nada.
            </p>
          ) : (
            <ul className="space-y-3">
              {lines.map((l) => {
                const cents = lineTotalCents(l)
                const marcada = flujo.flagged.includes(l.client_line_id)
                return (
                  <li
                    key={l.client_line_id}
                    className={`rounded-xl border p-3 ${marcada ? 'border-red-300 bg-red-50/60' : 'border-zinc-200'}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-words font-medium text-zinc-900">{l.name}</p>
                        <p className="mt-0.5 text-xs text-zinc-500">
                          {formatMoneyString(l.unit_price, currency)} c/u
                        </p>
                      </div>
                      <span className="shrink-0 whitespace-nowrap text-sm font-semibold tabular-nums text-zinc-900">
                        {cents === null ? '—' : formatMoneyString(centsToMoneyString(cents), currency)}
                      </span>
                    </div>

                    <div className="mt-2.5 flex items-center gap-2">
                      <div className="inline-flex items-center rounded-lg border border-zinc-300">
                        <button
                          type="button"
                          aria-label={`Quitar una unidad de ${l.name}`}
                          disabled={l.quantity <= 1}
                          onClick={() => actualizar(setQuantity(lines, l.client_line_id, l.quantity - 1))}
                          className="px-2.5 py-1.5 text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-40"
                        >
                          <MinusIcon className="h-4 w-4" />
                        </button>
                        <span className="min-w-[2.25rem] text-center text-sm font-medium tabular-nums text-zinc-900">
                          {l.quantity}
                        </span>
                        <button
                          type="button"
                          aria-label={`Agregar una unidad de ${l.name}`}
                          disabled={l.quantity >= MAX_LINE_QUANTITY}
                          onClick={() => actualizar(setQuantity(lines, l.client_line_id, l.quantity + 1))}
                          className="px-2.5 py-1.5 text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-40"
                        >
                          <PlusIcon className="h-4 w-4" />
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          const r = duplicateLine(lines, l.client_line_id, nextLineId())
                          if (r.ok) actualizar(r.lines)
                          else setFlujo((f) => ({
                            ...f,
                            notice: { tone: 'catalog', text: 'El pedido llegó al máximo de líneas.' },
                          }))
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-700 transition hover:bg-zinc-100"
                      >
                        <CopyPlusIcon className="h-3.5 w-3.5" />
                        Otra línea
                      </button>

                      <button
                        type="button"
                        aria-label={`Quitar ${l.name} del pedido`}
                        onClick={() => actualizar(removeLine(lines, l.client_line_id))}
                        className="ml-auto rounded-lg p-1.5 text-zinc-400 transition hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2Icon className="h-4 w-4" />
                      </button>
                    </div>

                    <input
                      type="text"
                      value={l.notes}
                      maxLength={300}
                      placeholder="Aclaración (ej: sin cebolla)"
                      onChange={(e) => onLines(setLineNotes(lines, l.client_line_id, e.target.value))}
                      aria-label={`Aclaración para ${l.name}`}
                      className="mt-2.5 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-base text-zinc-900 placeholder:text-zinc-400 outline-none transition focus:border-zinc-400 focus:ring-2 focus:ring-zinc-200 sm:text-sm"
                    />
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* ── Pie ── */}
        {flujo.step === 'cart' && lines.length > 0 && (
          <div className="border-t px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-600">Subtotal</span>
              <span className="text-base font-semibold tabular-nums text-zinc-900">
                {formatMoneyString(subtotal, currency)}
              </span>
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              El total lo confirmamos al recibir el pedido.
            </p>
            <button
              type="button"
              onClick={() => setFlujo(toCheckout)}
              className="mt-3 w-full rounded-xl px-4 py-3.5 text-base font-medium text-white shadow-sm transition"
              style={{ background: 'var(--tenant-primary, #0F766E)' }}
            >
              Continuar
            </button>
          </div>
        )}

        {flujo.step === 'checkout' && (
          <div className="border-t px-4 py-3">
            <button
              type="button"
              onClick={() => setFlujo(toCart)}
              className="text-sm text-zinc-600 underline-offset-2 transition hover:text-zinc-900 hover:underline"
            >
              Volver al pedido
            </button>
          </div>
        )}

        {flujo.step === 'success' && (
          <div className="border-t px-4 py-3">
            {/* Acción secundaria: el sheet NO se cierra solo al recibir el
                éxito — si lo hiciera, la referencia y el CTA desaparecerían
                antes de que nadie los lea. */}
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-xl border border-zinc-300 px-4 py-3 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100"
            >
              Cerrar
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
