import { describe, expect, it } from 'vitest'
import { buildContactWhatsAppHref } from './contact-whatsapp-href'

// 7. "Abrir WhatsApp" usa el teléfono correcto, y sólo si es un teléfono.

describe('buildContactWhatsAppHref', () => {
  it('teléfono canónico (como lo guarda el worker) → wa.me/549…', () => {
    expect(buildContactWhatsAppHref('5492325471890')).toBe('https://wa.me/5492325471890')
  })

  it('re-normaliza variantes argentinas por si el contacto entró por el CRM', () => {
    expect(buildContactWhatsAppHref('+54 9 2325 471890')).toBe('https://wa.me/5492325471890')
    expect(buildContactWhatsAppHref('02325 15 471890')).toBe('https://wa.me/5492325471890')
    expect(buildContactWhatsAppHref('542325471890')).toBe('https://wa.me/5492325471890')
  })

  it('null / vacío / letras / demasiado corto → null (el botón no se muestra)', () => {
    for (const bad of [null, undefined, '', '   ', 'sin telefono', 'abc123', '123', '12345']) {
      expect(buildContactWhatsAppHref(bad as string | null | undefined), String(bad)).toBeNull()
    }
  })

  it('nunca devuelve un link con caracteres que no sean dígitos', () => {
    const href = buildContactWhatsAppHref('+54 (9) 2325-471890')
    expect(href).toMatch(/^https:\/\/wa\.me\/\d+$/)
  })
})
