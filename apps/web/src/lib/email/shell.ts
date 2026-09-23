// ════════════════════════════════════════════════════════════════════════════
// La carcasa visual de los emails de ReservaNex.
//
// Extraída de human-attention-email.ts sin cambiarle un pixel: ese email fue
// el primero y quedó como referencia de marca. Acá vive sólo lo que de verdad
// comparten todos —paleta, wordmark, card, eyebrow, título, párrafos, CTA,
// link de respaldo, nota, footer, escaping y el text/plain— y nada del
// contenido de ninguno en particular.
//
// Reglas email-safe, no negociables: tablas (nada de flex ni grid), CSS
// inline, 600px máximo, sin JavaScript, sin fuentes externas, sin rgba, sin
// imágenes obligatorias. Lo que Gmail, Outlook y el celular renderizan sin
// pedir permiso.
//
// TODO lo que entra se escapa acá. Quien llama pasa texto plano; si necesita
// HTML (una fila de panel con <strong>), usa los helpers de este módulo, que
// escapan por dentro.
// ════════════════════════════════════════════════════════════════════════════

export interface RenderedEmail {
  subject:   string
  preheader: string
  html:      string
  text:      string
}

// ── Paleta ──────────────────────────────────────────────────────────────────
export const BG     = '#EEF2F7'
export const CARD   = '#FFFFFF'
export const NAVY   = '#0F2A47'
export const TEAL   = '#0EA5A4'
export const TEXT   = '#1F2937'
export const MUTED  = '#6B7280'
export const BORDER = '#E5E7EB'
export const SOFT   = '#F8FAFC'
export const FONT   = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ── Piezas reutilizables ────────────────────────────────────────────────────

export interface EmailCta {
  href:    string
  label:   string
  /** El primario va en sólido navy; el secundario, en contorno. */
  primary: boolean
}

/** Botón "bulletproof": un <a> con padding dentro de una celda con bgcolor. */
export function renderButton({ href, label, primary }: EmailCta): string {
  const e = escapeHtml
  return `
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px 0;width:100%;">
                  <tr>
                    <td align="center" bgcolor="${primary ? NAVY : CARD}" style="border-radius:10px;border:2px solid ${NAVY};">
                      <a href="${e(href)}" target="_blank" style="display:block;padding:14px 20px;font-family:${FONT};font-size:15px;font-weight:700;line-height:20px;text-decoration:none;text-align:center;letter-spacing:0.02em;color:${primary ? '#FFFFFF' : NAVY};border-radius:10px;">${e(label)}</a>
                    </td>
                  </tr>
                </table>`
}

/**
 * Una fila clave/valor del panel de datos. `value` es HTML ya armado por quien
 * llama (para poder poner <strong> o <em>), así que ESE es responsable de
 * escapar lo que interpole; `label` se escapa acá.
 */
export function renderPanelRow(label: string, value: string, last = false): string {
  const border = last ? 'border-bottom:0;' : `border-bottom:1px solid ${BORDER};`
  return `
              <tr>
                <td style="padding:10px 0;${border}font-family:${FONT};font-size:12px;line-height:16px;color:${MUTED};text-transform:uppercase;letter-spacing:0.04em;vertical-align:top;width:150px;">${escapeHtml(label)}</td>
                <td style="padding:10px 0;${border}font-family:${FONT};font-size:15px;line-height:22px;color:${TEXT};vertical-align:top;">${value}</td>
              </tr>`
}

/**
 * El recuadro gris claro que agrupa filas clave/valor.
 *
 * Recibe las filas como array y las une con el mismo sangrado que tenía el
 * markup original. Una fila vacía ('') se conserva a propósito: así el HTML
 * generado no cambia según haya o no última fila.
 */
export function renderPanel(rows: string[]): string {
  const cuerpo = rows.map((r) => `\n                      ${r}`).join('')
  return `
                <tr>
                  <td bgcolor="${SOFT}" style="background-color:${SOFT};border-radius:12px;padding:6px 18px 6px 18px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cuerpo}
                    </table>
                  </td>
                </tr>`
}

// ── La carcasa ──────────────────────────────────────────────────────────────

export interface EmailShellInput {
  subject:   string
  preheader: string
  /** Se muestra en mayúsculas: en HTML por CSS, en texto por toUpperCase(). */
  eyebrow:   string
  title:     string
  /** Párrafos bajo el título, en texto plano. Se escapan acá. */
  intro:     string[]
  /** Filas <tr> ya armadas (renderPanel / renderPanelRow). Opcional. */
  blocks?:   string
  ctas:      EmailCta[]
  /** "Si el botón no funciona…" + la URL, visible y copiable. */
  fallbackLink?: { intro: string; url: string }
  /** Aclaración final, en texto plano. */
  note?:     string
  /** Líneas del pie, en texto plano. */
  footerLines: string[]
}

export function renderEmailShell(input: EmailShellInput): RenderedEmail {
  const e = escapeHtml
  const { subject, preheader, eyebrow, title, intro, blocks, ctas, fallbackLink, note, footerLines } = input

  // Los párrafos: todos menos el último quedan más juntos; el último abre el
  // aire que separa del panel o del botón.
  const introHtml = intro.map((p, i) => `
                <tr>
                  <td style="font-family:${FONT};font-size:15px;line-height:22px;color:${MUTED};padding-bottom:${i === intro.length - 1 ? 22 : 12}px;">${e(p)}</td>
                </tr>`).join('')

  const fallbackHtml = fallbackLink
    ? `
                <tr>
                  <td style="padding-top:4px;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED};">${e(fallbackLink.intro)}<br /><a href="${e(fallbackLink.url)}" target="_blank" style="color:${NAVY};font-size:13px;line-height:20px;word-break:break-all;">${e(fallbackLink.url)}</a></td>
                </tr>`
    : ''

  const noteHtml = note
    ? `
                <tr>
                  <td style="padding-top:12px;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED};">${e(note)}</td>
                </tr>`
    : ''

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
                  <td style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.12em;color:${TEAL};text-transform:uppercase;padding-bottom:10px;">${e(eyebrow)}</td>
                </tr>
                <tr>
                  <td style="font-family:${FONT};font-size:24px;font-weight:700;line-height:30px;color:${NAVY};padding-bottom:8px;">${e(title)}</td>
                </tr>${introHtml}${blocks ?? ''}
                <tr>
                  <td style="padding-top:24px;">
                    ${ctas.map(renderButton).join('\n                    ')}
                  </td>
                </tr>${fallbackHtml}${noteHtml}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 8px 0 8px;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};text-align:center;">${footerLines.map(e).join('<br />')}</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  return { subject, preheader, html, text: '' }
}

/**
 * El text/plain de la carcasa. Va aparte porque el bloque de datos en texto no
 * se deriva del HTML: cada email lo arma con sus propias líneas.
 */
export function renderShellText(input: {
  eyebrow:     string
  title:       string
  intro:       string[]
  blockLines?: string[]
  ctas:        EmailCta[]
  fallbackLink?: { intro: string; url: string }
  note?:       string
  footerLines: string[]
}): string {
  const { eyebrow, title, intro, blockLines, ctas, fallbackLink, note, footerLines } = input
  return [
    'ReservaNex',
    '',
    eyebrow.toUpperCase(),
    title,
    '',
    ...intro,
    ...(blockLines?.length ? ['', ...blockLines] : []),
    '',
    ...ctas.map((c) => `${c.label}: ${c.href}`),
    ...(fallbackLink ? ['', fallbackLink.intro, fallbackLink.url] : []),
    ...(note ? ['', note] : []),
    '',
    ...footerLines,
  ].join('\n')
}
