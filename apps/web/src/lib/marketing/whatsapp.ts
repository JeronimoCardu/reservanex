import { publicEnv } from './env'

/**
 * NEXT_PUBLIC_WHATSAPP_NUMBER must be stored in international format,
 * digits only (e.g. 5491112345678). If it's not configured, callers should
 * treat the button as disabled instead of linking to an invalid wa.me URL.
 */
export function getWhatsappNumber(): string | null {
  const raw = publicEnv.NEXT_PUBLIC_WHATSAPP_NUMBER
  if (!raw) return null
  const digitsOnly = raw.replace(/\D/g, '')
  return digitsOnly.length > 0 ? digitsOnly : null
}

export function buildWhatsappLink(message: string): string | null {
  const number = getWhatsappNumber()
  if (!number) return null
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`
}
