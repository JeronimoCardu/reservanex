import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeWhatsAppStatus, whatsAppStatusBadge, type WhatsAppAccountStatusRow } from './whatsapp-status'

// MVP P0-B — estado de WhatsApp sin afirmar lo que no sabemos. Con
// AutoResponder no hay heartbeat: "Configurado" + "Última actividad".

function ar(overrides: Partial<WhatsAppAccountStatusRow> = {}): WhatsAppAccountStatusRow {
  return {
    provider: 'autoresponder', phone_number: '5491100000000', display_phone_number: null, active: true,
    inbound_token_hash: 'hash-del-token', access_token_encrypted: null,
    last_inbound_at: null, last_device_seen_at: null, last_verified_at: null,
    ...overrides,
  }
}
function meta(overrides: Partial<WhatsAppAccountStatusRow> = {}): WhatsAppAccountStatusRow {
  return { ...ar(), provider: 'meta', inbound_token_hash: null, access_token_encrypted: 'enc', ...overrides }
}

describe('AutoResponder', () => {
  it('configurado y sin actividad todavía → "Configurado", sin timestamp (nunca "Inactivo")', () => {
    const view = describeWhatsAppStatus(ar())
    expect(view).toEqual({ kind: 'autoresponder', phone: '5491100000000', active: true, lastActivityAt: null })
    expect(whatsAppStatusBadge(view)).toEqual({ label: 'Configurado', tone: 'ok' })
  })

  describe('P0-B.1 — tres estados de configuración', () => {
    it('A. faltan datos esenciales → "Sin configurar" (activa o no)', () => {
      for (const row of [
        ar({ inbound_token_hash: null }), ar({ phone_number: null }),
        ar({ inbound_token_hash: null, active: false }), ar({ phone_number: null, active: false }),
      ]) {
        expect(whatsAppStatusBadge(describeWhatsAppStatus(row))).toEqual({ label: 'Sin configurar', tone: 'muted' })
      }
    })

    it('B. completa + active false → "Desactivado", conserva número y última actividad histórica', () => {
      const view = describeWhatsAppStatus(ar({ active: false, last_inbound_at: '2026-10-01T09:00:00Z' }))
      expect(view).toEqual({ kind: 'autoresponder', phone: '5491100000000', active: false, lastActivityAt: '2026-10-01T09:00:00Z' })
      expect(whatsAppStatusBadge(view)).toEqual({ label: 'Desactivado', tone: 'muted' })
    })

    it('B. desactivada y sin actividad nunca → sin timestamp', () => {
      expect(describeWhatsAppStatus(ar({ active: false }))).toMatchObject({ active: false, lastActivityAt: null })
    })

    it('C. completa + active true → "Configurado"', () => {
      expect(whatsAppStatusBadge(describeWhatsAppStatus(ar({ last_inbound_at: '2026-10-13T10:00:00Z' }))))
        .toEqual({ label: 'Configurado', tone: 'ok' })
    })

    it('ninguno afirma conectividad en tiempo real', () => {
      const rows = [ar(), ar({ active: false }), ar({ inbound_token_hash: null }), ar({ phone_number: null }), ar({ last_inbound_at: '2026-10-13T10:00:00Z' })]
      for (const row of rows) {
        expect(whatsAppStatusBadge(describeWhatsAppStatus(row)).label).not.toMatch(/Conectado|Desconectado|Online|Offline|Inactivo/i)
      }
    })
  })

  it('configurado con actividad → la marca de actividad autenticada más reciente', () => {
    expect(describeWhatsAppStatus(ar({ last_inbound_at: '2026-10-13T10:00:00Z', last_device_seen_at: '2026-10-13T10:00:00Z' })))
      .toMatchObject({ lastActivityAt: '2026-10-13T10:00:00Z' })
    expect(describeWhatsAppStatus(ar({ last_inbound_at: '2026-10-13T09:00:00Z', last_device_seen_at: '2026-10-13T10:30:00Z' })))
      .toMatchObject({ lastActivityAt: '2026-10-13T10:30:00Z' })
    expect(describeWhatsAppStatus(ar({ last_inbound_at: '2026-10-13T11:00:00Z', last_device_seen_at: null })))
      .toMatchObject({ lastActivityAt: '2026-10-13T11:00:00Z' })
  })

  it('el número que se muestra prefiere el formateado', () => {
    expect(describeWhatsAppStatus(ar({ display_phone_number: '+54 9 11 0000-0000' }))).toMatchObject({ phone: '+54 9 11 0000-0000' })
  })

  it.each([
    ['sin token del dispositivo', ar({ inbound_token_hash: null })],
    ['sin número', ar({ phone_number: null })],
  ])('no configurado (%s) → "Sin configurar"', (_, row) => {
    const view = describeWhatsAppStatus(row)
    expect(view).toEqual({ kind: 'not_configured' })
    expect(whatsAppStatusBadge(view)).toEqual({ label: 'Sin configurar', tone: 'muted' })
  })

  it('sin cuenta → "Sin configurar"', () => {
    expect(whatsAppStatusBadge(describeWhatsAppStatus(null))).toEqual({ label: 'Sin configurar', tone: 'muted' })
  })

  it('el token de Meta vacío ya no hace que AutoResponder figure "Inactivo" (el bug)', () => {
    const view = describeWhatsAppStatus(ar({ access_token_encrypted: null }))
    expect(whatsAppStatusBadge(view).label).not.toMatch(/Inactivo|Conectado|Desconectado|Online/)
  })

  it('la vista nunca lleva el token ni su hash', () => {
    expect(JSON.stringify(describeWhatsAppStatus(ar({ access_token_encrypted: 'enc-secret' })))).not.toMatch(/hash-del-token|enc-secret/)
  })
})

describe('Meta (legacy) no cambia', () => {
  it('activa con token → "Conectado"; sin token → "Inactivo"', () => {
    expect(whatsAppStatusBadge(describeWhatsAppStatus(meta()))).toEqual({ label: 'Conectado', tone: 'ok' })
    expect(whatsAppStatusBadge(describeWhatsAppStatus(meta({ access_token_encrypted: null })))).toEqual({ label: 'Inactivo', tone: 'error' })
  })

  it('cuenta Meta apagada → "Sin configurar", como antes (no "Desactivado")', () => {
    expect(whatsAppStatusBadge(describeWhatsAppStatus(meta({ active: false })))).toEqual({ label: 'Sin configurar', tone: 'muted' })
  })

  it('conserva token y último test', () => {
    expect(describeWhatsAppStatus(meta({ last_verified_at: '2026-10-01T00:00:00Z' })))
      .toEqual({ kind: 'meta', phone: '5491100000000', connected: true, hasToken: true, lastVerifiedAt: '2026-10-01T00:00:00Z' })
  })
})

describe('superficies (estructural)', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

  it('la tarjeta del negocio toma el estado de whatsAppStatusBadge; el bloque de AutoResponder no usa palabras de estado en vivo ni jerga', () => {
    const form = src('app/(tenant)/dashboard/settings/whatsapp/whatsapp-settings-form.tsx')
    expect(form).toContain('whatsAppStatusBadge(settings)')
    const arBlock = form.slice(form.indexOf("settings.kind === 'autoresponder'"), form.indexOf("settings.kind === 'meta'"))
    expect(arBlock).toContain('Última actividad')
    expect(arBlock).toContain('Sin actividad registrada')
    expect(arBlock).not.toMatch(/Conectado|Desconectado|Online|Inactivo|heartbeat|inbound|token|provider/i)
  })

  it('la acción no expone el token ni su hash: devuelve la vista derivada', () => {
    const action = src('actions/whatsapp-settings.ts')
    expect(action).toContain('describeWhatsAppStatus(data)')
    expect(action).not.toMatch(/has_token|inbound_token_hash:/)
  })

  it('la acción lee también la cuenta apagada (para "Desactivado"), prefiriendo la activa', () => {
    const action = src('actions/whatsapp-settings.ts')
    expect(action).not.toContain(".eq('active', true)")
    expect(action).toMatch(/\.order\('active', \{ ascending: false \}\)\s*\.order\('updated_at', \{ ascending: false \}\)\s*\.limit\(1\)\s*\.maybeSingle\(\)/)
  })

  it('la tarjeta explica "Desactivado" como decisión de ReservaNex, sin hablar de conexión', () => {
    const form = src('app/(tenant)/dashboard/settings/whatsapp/whatsapp-settings-form.tsx')
    expect(form).toContain('ReservaNex desactivó este número')
  })

  it('la guía de instalación no llama "Heartbeat" a lo que es actividad de mensajes', () => {
    const guide = src('app/(platform)/platform/tenants/[id]/whatsapp/android-install-guide.tsx')
    expect(guide).not.toMatch(/>1\. Heartbeat<|Dispositivo conectado/)
    expect(guide).toContain('1. Actividad del dispositivo')
  })
})
