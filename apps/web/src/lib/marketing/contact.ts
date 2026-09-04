import { serverEnv } from './env'
import type { ContactInput } from './validation/contact-schema'

export type ContactDeliveryResult =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'delivery_failed' }

const DEFAULT_RESEND_FROM = 'ReservaNex <no-reply@reservanex.com>'

function renderPlainTextBody(data: ContactInput, submittedAt: string): string {
  return [
    `Name: ${data.name}`,
    `Company: ${data.company}`,
    `Country: ${data.country}`,
    `WhatsApp: ${data.whatsapp}`,
    `Email: ${data.email}`,
    `Approximate listings: ${data.propertiesCount ?? 'n/a'}`,
    `Language: ${data.locale ?? 'n/a'}`,
    `Submitted at: ${submittedAt}`,
    `Source URL: ${data.pageUrl ?? 'n/a'}`,
    '',
    'Message:',
    data.message,
  ].join('\n')
}

async function sendViaResend(data: ContactInput, submittedAt: string): Promise<boolean> {
  if (!serverEnv.RESEND_API_KEY || !serverEnv.CONTACT_EMAIL) return false

  try {
    const { Resend } = await import('resend')
    const resend = new Resend(serverEnv.RESEND_API_KEY)
    const { error } = await resend.emails.send({
      from: serverEnv.RESEND_FROM_EMAIL ?? DEFAULT_RESEND_FROM,
      to: serverEnv.CONTACT_EMAIL,
      replyTo: data.email,
      subject: `New ReservaNex inquiry — ${data.company}`,
      text: renderPlainTextBody(data, submittedAt),
    })
    if (error) {
      console.error('Resend delivery error', error)
      return false
    }
    return true
  } catch (error) {
    console.error('Resend delivery threw', error)
    return false
  }
}

async function sendViaWebhook(data: ContactInput, submittedAt: string): Promise<boolean> {
  if (!serverEnv.CONTACT_WEBHOOK_URL) return false

  try {
    const response = await fetch(serverEnv.CONTACT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'reservanex-marketing', submittedAt, ...data }),
    })
    return response.ok
  } catch (error) {
    console.error('Contact webhook delivery threw', error)
    return false
  }
}

/**
 * Resend is tried first whenever it's configured; the webhook is only used
 * as a fallback for sites that haven't set up Resend at all — not as a
 * retry path if Resend's send call fails at runtime.
 */
export async function deliverContactSubmission(
  data: ContactInput,
): Promise<ContactDeliveryResult> {
  const hasResend = Boolean(serverEnv.RESEND_API_KEY && serverEnv.CONTACT_EMAIL)
  const hasWebhook = Boolean(serverEnv.CONTACT_WEBHOOK_URL)

  if (!hasResend && !hasWebhook) {
    return { ok: false, reason: 'not_configured' }
  }

  const submittedAt = new Date().toISOString()
  const delivered = hasResend
    ? await sendViaResend(data, submittedAt)
    : await sendViaWebhook(data, submittedAt)

  return delivered ? { ok: true } : { ok: false, reason: 'delivery_failed' }
}
