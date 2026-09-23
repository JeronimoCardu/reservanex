/**
 * Preview local de los emails de acceso. NO envía nada y NO usa tokens reales.
 *
 * Genera un HTML por variante más un índice para verlas juntas:
 *
 *   owner invite · receptionist invite · seller invite · recovery
 *
 * Usage:
 *   pnpm --filter @orderflow/web preview:invitation-email [carpeta-de-salida]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderInvitationEmail, type InvitationEmailInput } from '../src/lib/email/invitation-email'

// Token obviamente falso: que nadie confunda un preview con un link vivo.
const FAKE = 'https://reservanex.com/auth/confirm?token_hash=TOKEN-DE-EJEMPLO-NO-VALIDO&type='

const variantes: { slug: string; label: string; input: InvitationEmailInput }[] = [
  {
    slug: 'owner-invite', label: 'Owner · invitación',
    input: { role: 'owner', kind: 'invite', businessName: 'Restaurante Prueba ReservaNex', recipientName: 'Jeronimo', accessUrl: `${FAKE}invite` },
  },
  {
    slug: 'owner-invite-sin-negocio', label: 'Owner · invitación (sin nombre de negocio)',
    input: { role: 'owner', kind: 'invite', businessName: null, accessUrl: `${FAKE}invite` },
  },
  {
    slug: 'receptionist-invite', label: 'Receptionist · invitación',
    input: { role: 'receptionist', kind: 'invite', businessName: 'Restaurante Prueba ReservaNex', recipientName: 'Ana', accessUrl: `${FAKE}invite` },
  },
  {
    slug: 'seller-invite', label: 'Seller · invitación',
    input: { role: 'seller', kind: 'invite', recipientName: 'Lucía', accessUrl: `${FAKE}invite` },
  },
  {
    slug: 'recovery', label: 'Recovery · cuenta existente',
    input: { role: 'owner', kind: 'recovery', businessName: 'Restaurante Prueba ReservaNex', accessUrl: `${FAKE}recovery` },
  },
]

const outDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(os.tmpdir(), 'reservanex-invitation-emails')

fs.mkdirSync(outDir, { recursive: true })

const filas: string[] = []
for (const v of variantes) {
  const email = renderInvitationEmail(v.input)
  const html  = path.join(outDir, `${v.slug}.html`)
  fs.writeFileSync(html, email.html, 'utf8')
  fs.writeFileSync(path.join(outDir, `${v.slug}.txt`), email.text, 'utf8')
  filas.push(
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #E5E7EB;font-weight:600;">${v.label}</td>` +
    `<td style="padding:8px 12px;border-bottom:1px solid #E5E7EB;">${email.subject}</td>` +
    `<td style="padding:8px 12px;border-bottom:1px solid #E5E7EB;"><a href="./${v.slug}.html">HTML</a> · <a href="./${v.slug}.txt">texto</a></td></tr>`,
  )
  console.log(`${v.label.padEnd(44)} ${email.subject}`)
}

const indice = `<!doctype html><meta charset="utf-8"><title>Previews — emails de acceso</title>
<body style="font-family:system-ui,sans-serif;background:#EEF2F7;padding:32px;">
<h1 style="color:#0F2A47;">Emails de acceso — previews</h1>
<p style="color:#6B7280;">Tokens de ejemplo, no válidos. Ningún email fue enviado.</p>
<table style="background:#fff;border-radius:12px;border-collapse:collapse;width:100%;max-width:960px;">${filas.join('')}</table>
</body>`
fs.writeFileSync(path.join(outDir, 'index.html'), indice, 'utf8')

console.log(`\nÍndice: ${path.join(outDir, 'index.html')}`)
console.log('(no se envió nada)')
