import { normalizePhoneForWhatsApp } from '@orderflow/validators'

// ════════════════════════════════════════════════════════════════════════════
// "Abrir WhatsApp" para un contacto.
//
// La atención humana ocurre en WhatsApp / WhatsApp Web, no en ReservaNex. Este
// es el ÚNICO lugar que arma ese link: recibe el teléfono tal como está en
// contacts.phone (el worker y el CRM lo guardan ya normalizado a 549…), lo
// vuelve a pasar por la normalización canónica por si entró por otro camino, y
// se niega a devolver un link si el resultado no son dígitos. Un botón que no
// aparece es mejor que uno que abre "wa.me/undefined".
//
// wa.me funciona igual en celular (abre la app) y en escritorio (abre WhatsApp
// Web o la app de escritorio, según lo que tenga el usuario).
// ════════════════════════════════════════════════════════════════════════════

export function buildContactWhatsAppHref(phone: string | null | undefined): string | null {
  if (!phone) return null
  const normalized = normalizePhoneForWhatsApp(phone)
  const digits = normalized.replace(/\D/g, '')
  // normalizePhoneForWhatsApp devuelve la entrada intacta cuando no la
  // reconoce (letras, vacío); cualquier cosa que no sea un número de WhatsApp
  // plausible se descarta acá.
  if (digits.length < 10 || digits.length > 15) return null
  if (normalized !== digits) return null
  return `https://wa.me/${digits}`
}
