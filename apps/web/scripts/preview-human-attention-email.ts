/**
 * Atención humana V2 — preview visual del email de las 2 h, SIN enviar nada.
 *
 * Renderiza el template con datos de ejemplo (o los que se pasen por env) y
 * escribe un .html para abrir en el navegador o pegar en un tester de clientes
 * de correo. No toca la base ni Resend.
 *
 * Usage:  pnpm --filter @orderflow/web preview:attention-email [ruta-de-salida.html]
 *
 * Env opcionales para personalizar:
 *   PREVIEW_TENANT_NAME · PREVIEW_CONTACT_NAME · PREVIEW_CONTACT_PHONE
 *   PREVIEW_LAST_MESSAGE · PREVIEW_HOURS_AGO (default 2)
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderHumanAttentionEmail } from '../src/lib/email/human-attention-email'
import { buildContactWhatsAppHref } from '../src/lib/human-attention/contact-whatsapp-href'

const hoursAgo = Number(process.env.PREVIEW_HOURS_AGO ?? '2')
const phone    = process.env.PREVIEW_CONTACT_PHONE ?? '5491123456789'

const email = renderHumanAttentionEmail({
  tenantName:    process.env.PREVIEW_TENANT_NAME ?? 'Restaurante Prueba ReservaNex',
  contactName:   process.env.PREVIEW_CONTACT_NAME ?? 'Lautaro Cardu',
  contactPhone:  phone,
  channel:       'whatsapp',
  requestedAt:   new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
  handoffReason: 'human_requested',
  lastMessage:   process.env.PREVIEW_LAST_MESSAGE ?? 'Quiero hablar con alguien',
  lastMessageBy: 'customer',
  whatsappHref:  buildContactWhatsAppHref(phone),
  attentionUrl:  `${process.env.NEXT_PUBLIC_SITE_URL ?? 'https://reservanex.com'}/dashboard/attention`,
})

const out = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(os.tmpdir(), 'reservanex-human-attention-email.html')

fs.writeFileSync(out, email.html, 'utf8')
fs.writeFileSync(out.replace(/\.html?$/, '') + '.txt', email.text, 'utf8')

console.log(`Subject:   ${email.subject}`)
console.log(`Preheader: ${email.preheader}`)
console.log(`HTML:      ${out}`)
console.log(`Text:      ${out.replace(/\.html?$/, '')}.txt`)
console.log('(no se envió nada)')
