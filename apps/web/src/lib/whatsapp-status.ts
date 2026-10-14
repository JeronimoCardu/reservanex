// ════════════════════════════════════════════════════════════════════════════
// MVP P0-B — qué le mostramos al negocio sobre su WhatsApp, sin afirmar lo que
// no sabemos.
//
// Con AutoResponder no hay heartbeat periódico: ReservaNex sólo se entera de
// que el teléfono anda cuando llega un mensaje autenticado de un cliente. Así
// que para AutoResponder nunca se dice "Conectado", "Desconectado", "Online" ni
// "Inactivo" — esas palabras afirman un estado en tiempo real que no tenemos.
// Lo que sí sabemos, y es lo que se muestra:
//
//   · la CONFIGURACIÓN que dejó ReservaNex, en tres estados:
//       - "Sin configurar": falta el número o el token del dispositivo;
//       - "Desactivado":    completa, pero la cuenta está apagada en ReservaNex
//                           (sus mensajes se rechazan). Es configuración, no
//                           una afirmación sobre si el teléfono está prendido;
//       - "Configurado":    completa y activa;
//   · la ÚLTIMA ACTIVIDAD registrada (último mensaje autenticado que llegó
//     desde el teléfono), o que todavía no hubo ninguna. Una cuenta
//     desactivada conserva la suya, como historial.
//
// Meta (legacy) conserva su semántica: "Conectado" si la cuenta está activa y
// tiene el token de la API.
// ════════════════════════════════════════════════════════════════════════════

export interface WhatsAppAccountStatusRow {
  provider:               string
  phone_number:           string | null
  display_phone_number:   string | null
  active:                 boolean
  inbound_token_hash:     string | null
  access_token_encrypted: string | null
  last_inbound_at:        string | null
  last_device_seen_at:    string | null
  last_verified_at:       string | null
}

export type WhatsAppStatusView =
  | { kind: 'not_configured' }
  | { kind: 'autoresponder'; phone: string | null; active: boolean; lastActivityAt: string | null }
  | { kind: 'meta'; phone: string | null; connected: boolean; hasToken: boolean; lastVerifiedAt: string | null }

function latest(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b
}

/**
 * Vista saneada (sin token ni hash) a partir de la cuenta del tenant que
 * corresponde mostrar (la activa o, si no hay, la última), o null si no hay.
 */
export function describeWhatsAppStatus(row: WhatsAppAccountStatusRow | null): WhatsAppStatusView {
  if (!row) return { kind: 'not_configured' }
  const phone = row.display_phone_number ?? row.phone_number ?? null

  if (row.provider === 'autoresponder') {
    // Sin token del dispositivo (o sin número) la cuenta no puede recibir nada.
    if (!row.inbound_token_hash || !row.phone_number) return { kind: 'not_configured' }
    // Actividad autenticada: cada mensaje entrante mueve las dos marcas; la del
    // dispositivo también la movería un heartbeat si algún día se configura.
    return {
      kind: 'autoresponder', phone, active: row.active,
      lastActivityAt: latest(row.last_inbound_at, row.last_device_seen_at),
    }
  }

  // Meta (legacy), como siempre: una cuenta apagada es "sin configurar".
  if (!row.active) return { kind: 'not_configured' }
  const hasToken = Boolean(row.access_token_encrypted)
  return { kind: 'meta', phone, connected: hasToken, hasToken, lastVerifiedAt: row.last_verified_at }
}

export type WhatsAppStatusBadge =
  | { label: 'Sin configurar'; tone: 'muted' }
  | { label: 'Configurado';    tone: 'ok' }
  | { label: 'Desactivado';    tone: 'muted' } // AutoResponder apagado en ReservaNex
  | { label: 'Conectado';      tone: 'ok' }   // sólo Meta (legacy)
  | { label: 'Inactivo';       tone: 'error' } // sólo Meta (legacy)

export function whatsAppStatusBadge(view: WhatsAppStatusView): WhatsAppStatusBadge {
  switch (view.kind) {
    case 'not_configured': return { label: 'Sin configurar', tone: 'muted' }
    case 'autoresponder':  return view.active ? { label: 'Configurado', tone: 'ok' } : { label: 'Desactivado', tone: 'muted' }
    case 'meta':           return view.connected ? { label: 'Conectado', tone: 'ok' } : { label: 'Inactivo', tone: 'error' }
  }
}
