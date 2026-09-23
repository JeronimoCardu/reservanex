import { relativeTimeEs } from '@/lib/tenant-setup-status'
import { channelLabel, humanAttentionReasonLabel } from '@/lib/human-attention/semantics'
import {
  MUTED,
  escapeHtml,
  renderEmailShell,
  renderPanel,
  renderPanelRow,
  renderShellText,
  type RenderedEmail,
} from './shell'

// ════════════════════════════════════════════════════════════════════════════
// El email de "atención humana pendiente desde hace 2 horas".
//
// Función pura: entra un caso, sale { subject, preheader, html, text }. La
// carcasa (paleta, card, CTA, footer, escaping, text/plain) vive en shell.ts y
// la comparten todos los emails de ReservaNex; acá queda sólo lo propio de
// este aviso.
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

export type { RenderedEmail }
export { escapeHtml }

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
  const conTelefono  = Boolean(input.contactPhone && input.contactName)

  const e = escapeHtml

  const eyebrow = 'Atención requerida'
  const title   = 'Un cliente necesita atención humana.'
  const intro   = `Esta atención sigue marcada como pendiente en ReservaNex desde ${pendiente}.`
  const note    = 'Si ya atendiste este caso, marcalo como atendido desde ReservaNex para que el asistente vuelva a responderle.'

  const ctas = [
    ...(input.whatsappHref ? [{ href: input.whatsappHref, label: 'Abrir WhatsApp', primary: true }] : []),
    { href: input.attentionUrl, label: 'Ver en ReservaNex', primary: false },
  ]

  const blocks = renderPanel([
    renderPanelRow('Cliente', `<strong>${e(cliente)}</strong>${conTelefono ? `<br /><span style="color:${MUTED};font-size:13px;">${e(input.contactPhone!)}</span>` : ''}`),
    renderPanelRow('Canal', e(canal)),
    renderPanelRow('Pendiente desde', e(pendiente.charAt(0).toUpperCase() + pendiente.slice(1))),
    renderPanelRow('Motivo', e(motivo), !ultimo),
    ultimo ? renderPanelRow(ultimoLabel, `<em>&laquo;${e(ultimo)}&raquo;</em>`, true) : '',
  ])

  const shell = renderEmailShell({
    subject:     `Un cliente necesita atención humana — ${cliente}`,
    preheader:   `Tenés una atención pendiente en ReservaNex desde ${pendiente}.`,
    eyebrow,
    title,
    intro:       [intro],
    blocks,
    ctas,
    note,
    footerLines: ['Notificación automática de ReservaNex', input.tenantName],
  })

  const text = renderShellText({
    eyebrow,
    title,
    intro: [intro],
    blockLines: [
      `Cliente: ${cliente}${conTelefono ? ` (${input.contactPhone})` : ''}`,
      `Canal: ${canal}`,
      `Pendiente desde: ${pendiente}`,
      `Motivo: ${motivo}`,
      ...(ultimo ? [`${ultimoLabel}: «${ultimo}»`] : []),
    ],
    ctas,
    note,
    footerLines: ['Notificación automática de ReservaNex', input.tenantName],
  })

  return { ...shell, text }
}
