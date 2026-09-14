// Fase 3E-C3B1 (fix) — el CTA de WhatsApp de un formulario público.
//
// Estaba como función privada dentro de dynamic-form.tsx. Se extrajo acá SIN
// cambiarle nada porque ahora lo necesitan dos lugares: el formulario genérico y
// la pantalla de éxito del carrito. Duplicarlo habría sido la forma más fácil de
// que el pedido terminara mandando un mensaje con otro formato que el resto del
// sitio — y el worker correlaciona la conversación por esa referencia.
//
// Un solo lugar arma el mensaje, un solo lugar arma el link.

/**
 * El link de WhatsApp con el mensaje prearmado.
 *
 * Deliberadamente mínimo: solo la referencia corta, que alcanza para
 * correlacionar (§2 de 3B). NADA de UUIDs, payload ni tenant_id — el worker
 * recupera todo eso server-side después de un inbound autenticado.
 *
 * `phoneDigits` son solo dígitos (lo que devuelve
 * getTenantAutoResponderWhatsApp). Devuelve null si falta el número o la
 * referencia: sin uno de los dos NO se ofrece un link roto ni se inventa un
 * destino.
 */
export function buildSubmissionWhatsAppHref(
  phoneDigits: string | null | undefined,
  reference:   string | null | undefined,
): string | null {
  if (!phoneDigits || !reference) return null
  const text = `Hola, completé el formulario en ReservaNex.\nReferencia: ${reference}`
  return `https://wa.me/${phoneDigits}?text=${encodeURIComponent(text)}`
}
