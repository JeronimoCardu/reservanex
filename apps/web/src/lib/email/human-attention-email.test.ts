import { describe, expect, it } from 'vitest'
import { renderHumanAttentionEmail, escapeHtml, type HumanAttentionEmailInput } from './human-attention-email'

// ════════════════════════════════════════════════════════════════════════════
// 18-19. El email de las 2 h: lo que dice, lo que NO puede decir, y cómo está
// construido para que Gmail/Outlook/celular lo rendericen sin sorpresas.
// ════════════════════════════════════════════════════════════════════════════

const NOW = new Date('2026-09-21T12:00:00.000Z')

const base: HumanAttentionEmailInput = {
  tenantName:    'Restaurante Prueba ReservaNex',
  contactName:   'Lautaro Cardu',
  contactPhone:  '5492325471890',
  channel:       'whatsapp',
  requestedAt:   new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(),
  handoffReason: 'human_requested',
  lastMessage:   'Quiero hablar con alguien',
  lastMessageBy: 'customer',
  whatsappHref:  'https://wa.me/5492325471890',
  attentionUrl:  'https://reservanex.com/dashboard/attention',
  now:           NOW,
}

// Frases que afirmarían algo que ReservaNex NO sabe (no observa el outbound
// manual de WhatsApp Business). Ninguna puede aparecer, en html ni en text.
const PROHIBIDAS = [
  /nadie respondi/i,
  /sin respuesta/i,
  /segu[ií]s sin responder/i,
  /no (le )?respondiste/i,
  /lleva \d+ horas? sin/i,
]

describe('18. copy: sólo afirma el estado en ReservaNex', () => {
  const r = renderHumanAttentionEmail(base)

  it('subject y preheader', () => {
    expect(r.subject).toBe('Un cliente necesita atención humana — Lautaro Cardu')
    expect(r.preheader).toBe('Tenés una atención pendiente en ReservaNex desde hace 2 h.')
  })

  it('la frase central es exactamente "sigue marcada como pendiente en ReservaNex"', () => {
    expect(r.html).toContain('Esta atención sigue marcada como pendiente en ReservaNex desde hace 2 h.')
    expect(r.text).toContain('Esta atención sigue marcada como pendiente en ReservaNex desde hace 2 h.')
  })

  it('no contiene ninguna afirmación sobre falta de respuesta humana', () => {
    for (const p of PROHIBIDAS) {
      expect(r.html, String(p)).not.toMatch(p)
      expect(r.text, String(p)).not.toMatch(p)
      expect(r.subject, String(p)).not.toMatch(p)
      expect(r.preheader, String(p)).not.toMatch(p)
    }
  })

  it('bloque de datos: cliente, canal, pendiente desde, motivo, último mensaje', () => {
    for (const s of ['Cliente', 'Lautaro Cardu', '5492325471890', 'Canal', 'WhatsApp', 'Pendiente desde', 'Hace 2 h',
                     'Motivo', 'Pidió hablar con una persona', 'Último mensaje del cliente', 'Quiero hablar con alguien']) {
      expect(r.html, s).toContain(s)
    }
    expect(r.text).toContain('Cliente: Lautaro Cardu (5492325471890)')
    expect(r.text).toContain('Motivo: Pidió hablar con una persona')
    expect(r.text).toContain('Último mensaje del cliente: «Quiero hablar con alguien»')
  })

  it('CTAs: Abrir WhatsApp (wa.me del contacto) y Ver en ReservaNex (/dashboard/attention)', () => {
    expect(r.html).toContain('href="https://wa.me/5492325471890"')
    expect(r.html).toContain('>Abrir WhatsApp<')
    expect(r.html).toContain('href="https://reservanex.com/dashboard/attention"')
    expect(r.html).toContain('>Ver en ReservaNex<')
    expect(r.text).toContain('Abrir WhatsApp: https://wa.me/5492325471890')
    expect(r.text).toContain('Ver en ReservaNex: https://reservanex.com/dashboard/attention')
    // Nunca un deep-link a una conversación: el login no preserva `next`.
    expect(r.html).not.toMatch(/dashboard\/attention\?/)
  })

  it('nota y footer', () => {
    expect(r.html).toContain('Si ya atendiste este caso, marcalo como atendido desde ReservaNex')
    expect(r.html).toContain('Notificación automática de ReservaNex')
    expect(r.html).toContain('Restaurante Prueba ReservaNex')
    expect(r.text).toContain('Notificación automática de ReservaNex\nRestaurante Prueba ReservaNex')
  })

  it('el último mensaje del ASISTENTE se etiqueta como tal, no como del cliente', () => {
    const ai = renderHumanAttentionEmail({ ...base, lastMessage: 'Un asesor te contactará…', lastMessageBy: 'ai' })
    expect(ai.html).toContain('Último mensaje del asistente')
    expect(ai.html).not.toContain('Último mensaje del cliente')
  })

  it('sin nombre → usa el teléfono; sin teléfono → no hay CTA de WhatsApp pero el email sale igual', () => {
    const sinNombre = renderHumanAttentionEmail({ ...base, contactName: null })
    expect(sinNombre.subject).toBe('Un cliente necesita atención humana — 5492325471890')

    const sinTel = renderHumanAttentionEmail({ ...base, contactName: null, contactPhone: null, whatsappHref: null })
    expect(sinTel.subject).toBe('Un cliente necesita atención humana — Cliente sin nombre')
    expect(sinTel.html).not.toContain('Abrir WhatsApp')
    expect(sinTel.html).toContain('Ver en ReservaNex')
  })

  it('sin último mensaje → la fila no aparece y el bloque sigue bien formado', () => {
    const r2 = renderHumanAttentionEmail({ ...base, lastMessage: null })
    expect(r2.html).not.toContain('Último mensaje')
    expect(r2.text).not.toContain('Último mensaje')
  })
})

describe('19. render: HTML de tablas, inline, 600px, sin JS, sin fuentes externas', () => {
  const r = renderHumanAttentionEmail(base)

  it('estructura', () => {
    expect(r.html).toMatch(/^<!DOCTYPE html/)
    expect(r.html).toContain('width="600"')
    expect(r.html).toContain('max-width:600px')
    expect(r.html).toContain('role="presentation"')
    expect(r.html).toContain('name="viewport"')
  })

  it('paleta de marca', () => {
    for (const c of ['#EEF2F7', '#FFFFFF', '#0F2A47', '#0EA5A4']) expect(r.html, c).toContain(c)
  })

  it('nada que un cliente de correo bloquee o ignore', () => {
    expect(r.html).not.toMatch(/<script/i)
    expect(r.html).not.toMatch(/<link\s/i)
    expect(r.html).not.toMatch(/@import|fonts\.googleapis|<style/i)
    expect(r.html).not.toMatch(/rgba?\(/i)
    expect(r.html).not.toMatch(/display:\s*(flex|grid)/i)
    expect(r.html).not.toMatch(/<img/i)
  })

  it('el contenido del cliente va escapado: no puede romper el layout ni inyectar markup', () => {
    const hostil = renderHumanAttentionEmail({
      ...base,
      contactName: '<b>Lautaro</b> & "Cía"',
      lastMessage: '<img src=x onerror=alert(1)> hola',
    })
    expect(hostil.html).not.toContain('<b>Lautaro</b>')
    expect(hostil.html).toContain('&lt;b&gt;Lautaro&lt;/b&gt; &amp; &quot;Cía&quot;')
    expect(hostil.html).not.toContain('<img src=x')
    expect(hostil.html).toContain('&lt;img src=x onerror=alert(1)&gt; hola')
  })

  it('escapeHtml cubre los cinco caracteres', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
  })

  it('el último mensaje largo se recorta', () => {
    const largo = renderHumanAttentionEmail({ ...base, lastMessage: 'x'.repeat(500) })
    expect(largo.html).not.toContain('x'.repeat(300))
    expect(largo.html).toContain('…')
  })

  it('snapshot estable del texto plano (fallback multipart)', () => {
    expect(r.text).toMatchInlineSnapshot(`
      "ReservaNex

      ATENCIÓN REQUERIDA
      Un cliente necesita atención humana.

      Esta atención sigue marcada como pendiente en ReservaNex desde hace 2 h.

      Cliente: Lautaro Cardu (5492325471890)
      Canal: WhatsApp
      Pendiente desde: hace 2 h
      Motivo: Pidió hablar con una persona
      Último mensaje del cliente: «Quiero hablar con alguien»

      Abrir WhatsApp: https://wa.me/5492325471890
      Ver en ReservaNex: https://reservanex.com/dashboard/attention

      Si ya atendiste este caso, marcalo como atendido desde ReservaNex para que el asistente vuelva a responderle.

      Notificación automática de ReservaNex
      Restaurante Prueba ReservaNex"
    `)
  })
})
