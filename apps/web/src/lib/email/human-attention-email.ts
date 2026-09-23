import { relativeTimeEs } from '@/lib/tenant-setup-status'
import { channelLabel, humanAttentionReasonLabel } from '@/lib/human-attention/semantics'

// ════════════════════════════════════════════════════════════════════════════
// El email de "atención humana pendiente desde hace 2 horas".
//
// Función pura: entra un caso, sale { subject, preheader, html, text }. Sin
// React Email, sin dependencia nueva: HTML de tablas con estilos inline, 600px,
// sin fuentes externas, sin JS, sin imágenes — lo que Gmail, Outlook y el
// celular renderizan sin pedir permiso. El text/plain es el fallback multipart.
//
// LO QUE ESTE EMAIL NO PUEDE DECIR:
//
//   "nadie respondió" · "el cliente lleva 2 horas sin respuesta" · "seguís sin
//   responder"
//
// ReservaNex NO ve lo que el negocio contesta desde WhatsApp Business. Lo
// único que sabe es que nadie marcó el caso como atendido EN ReservaNex. El
// copy afirma exactamente eso y nada más. El test lo fija.
// ════════════════════════════════════════════════════════════════════════════

export interface HumanAttentionEmailInput {
  tenantName:      string
  contactName:     string | null
  contactPhone:    string | null
  channel:         string | null
  requestedAt:     string
  handoffReason:   string | null
  lastMessage:     string | null
  /** Quién mandó el último mensaje (customer/ai/human). */
  lastMessageBy:   string | null
  whatsappHref:    string | null
  attentionUrl:    string
  /** Inyectable para tests. */
  now?:            Date
}

export interface RenderedEmail {
  subject:   string
  preheader: string
  html:      string
  text:      string
}

// ── Paleta ──────────────────────────────────────────────────────────────────
const BG        = '#EEF2F7'
const CARD      = '#FFFFFF'
const NAVY      = '#0F2A47'
const TEAL      = '#0EA5A4'
const TEXT      = '#1F2937'
const MUTED     = '#6B7280'
const BORDER    = '#E5E7EB'
const SOFT      = '#F8FAFC'
const FONT      = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function truncate(value: string, max: number): string {
  const v = value.replace(/\s+/g, ' ').trim()
  return v.length > max ? `${v.slice(0, max - 1)}…` : v
}

function senderLabel(by: string | null): string {
  if (by === 'ai') return 'Último mensaje del asistente'
  if (by === 'human') return 'Último mensaje del agente'
  return 'Último mensaje del cliente'
}

export function renderHumanAttentionEmail(input: HumanAttentionEmailInput): RenderedEmail {
  const now          = input.now ?? new Date()
  const cliente      = (input.contactName?.trim() || input.contactPhone || 'Cliente sin nombre')
  const canal        = channelLabel(input.channel)
  const pendiente    = relativeTimeEs(input.requestedAt, now)
  const motivo       = humanAttentionReasonLabel(input.handoffReason)
  const ultimo       = input.lastMessage?.trim() ? truncate(input.lastMessage, 240) : null
  const ultimoLabel  = senderLabel(input.lastMessageBy)

  const subject   = `Un cliente necesita atención humana — ${cliente}`
  const preheader = `Tenés una atención pendiente en ReservaNex desde ${pendiente}.`

  // ── HTML ───────────────────────────────────────────────────────────────────
  const e = escapeHtml
  const row = (label: string, value: string, last = false) => {
    const border = last ? 'border-bottom:0;' : `border-bottom:1px solid ${BORDER};`
    return `
              <tr>
                <td style="padding:10px 0;${border}font-family:${FONT};font-size:12px;line-height:16px;color:${MUTED};text-transform:uppercase;letter-spacing:0.04em;vertical-align:top;width:150px;">${e(label)}</td>
                <td style="padding:10px 0;${border}font-family:${FONT};font-size:15px;line-height:22px;color:${TEXT};vertical-align:top;">${value}</td>
              </tr>`
  }

  const button = (href: string, label: string, primary: boolean) => `
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px 0;width:100%;">
                  <tr>
                    <td align="center" bgcolor="${primary ? NAVY : CARD}" style="border-radius:10px;border:2px solid ${NAVY};">
                      <a href="${e(href)}" target="_blank" style="display:block;padding:14px 20px;font-family:${FONT};font-size:15px;font-weight:700;line-height:20px;text-decoration:none;text-align:center;letter-spacing:0.02em;color:${primary ? '#FFFFFF' : NAVY};border-radius:10px;">${e(label)}</a>
                    </td>
                  </tr>
                </table>`

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="es">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>${e(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BG};">
  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${BG};opacity:0;">${e(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BG}" style="background-color:${BG};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
          <tr>
            <td style="padding:0 8px 18px 8px;font-family:${FONT};font-size:20px;font-weight:800;letter-spacing:-0.02em;color:${NAVY};">ReservaNex</td>
          </tr>
          <tr>
            <td bgcolor="${CARD}" style="background-color:${CARD};border-radius:16px;padding:32px 28px;border:1px solid ${BORDER};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.12em;color:${TEAL};text-transform:uppercase;padding-bottom:10px;">Atención requerida</td>
                </tr>
                <tr>
                  <td style="font-family:${FONT};font-size:24px;font-weight:700;line-height:30px;color:${NAVY};padding-bottom:8px;">Un cliente necesita atención humana.</td>
                </tr>
                <tr>
                  <td style="font-family:${FONT};font-size:15px;line-height:22px;color:${MUTED};padding-bottom:22px;">Esta atención sigue marcada como pendiente en ReservaNex desde ${e(pendiente)}.</td>
                </tr>
                <tr>
                  <td bgcolor="${SOFT}" style="background-color:${SOFT};border-radius:12px;padding:6px 18px 6px 18px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      ${row('Cliente', `<strong>${e(cliente)}</strong>${input.contactPhone && input.contactName ? `<br /><span style="color:${MUTED};font-size:13px;">${e(input.contactPhone)}</span>` : ''}`)}
                      ${row('Canal', e(canal))}
                      ${row('Pendiente desde', e(pendiente.charAt(0).toUpperCase() + pendiente.slice(1)))}
                      ${row('Motivo', e(motivo), !ultimo)}
                      ${ultimo ? row(ultimoLabel, `<em>&laquo;${e(ultimo)}&raquo;</em>`, true) : ''}
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding-top:24px;">
                    ${input.whatsappHref ? button(input.whatsappHref, 'Abrir WhatsApp', true) : ''}
                    ${button(input.attentionUrl, 'Ver en ReservaNex', false)}
                  </td>
                </tr>
                <tr>
                  <td style="padding-top:12px;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED};">Si ya atendiste este caso, marcalo como atendido desde ReservaNex para que el asistente vuelva a responderle.</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 8px 0 8px;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};text-align:center;">Notificación automática de ReservaNex<br />${e(input.tenantName)}</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  // ── text/plain ─────────────────────────────────────────────────────────────
  const text = [
    'ReservaNex',
    '',
    'ATENCIÓN REQUERIDA',
    'Un cliente necesita atención humana.',
    '',
    `Esta atención sigue marcada como pendiente en ReservaNex desde ${pendiente}.`,
    '',
    `Cliente: ${cliente}${input.contactPhone && input.contactName ? ` (${input.contactPhone})` : ''}`,
    `Canal: ${canal}`,
    `Pendiente desde: ${pendiente}`,
    `Motivo: ${motivo}`,
    ...(ultimo ? [`${ultimoLabel}: «${ultimo}»`] : []),
    '',
    ...(input.whatsappHref ? [`Abrir WhatsApp: ${input.whatsappHref}`] : []),
    `Ver en ReservaNex: ${input.attentionUrl}`,
    '',
    'Si ya atendiste este caso, marcalo como atendido desde ReservaNex para que el asistente vuelva a responderle.',
    '',
    'Notificación automática de ReservaNex',
    input.tenantName,
  ].join('\n')

  return { subject, preheader, html, text }
}
