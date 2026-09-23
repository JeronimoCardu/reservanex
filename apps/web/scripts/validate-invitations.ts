/**
 * Invitaciones V2 — validador físico.
 *
 * Ejercita el camino REAL contra el proyecto Supabase enlazado:
 *
 *   · generateLink invite / recovery, y el userId que devuelve
 *   · la URL canónica: /auth/confirm?token_hash=…&type=…
 *   · el canje real con verifyOtp: funciona UNA vez, la segunda falla
 *   · usuario nuevo / no confirmado / confirmado
 *   · el bloqueo del alta de tenant users ante un confirmado de otro contexto
 *   · seller termina en platform_users; owner/receptionist en tenant_users
 *   · aislamiento entre tenants
 *
 * NUNCA manda un email: sendAccessEmail recibe un sender que registra.
 * Todo se purga en `finally`.
 *
 * Usage:  pnpm --filter @orderflow/web validate:invitations
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { randomBytes } from 'node:crypto'
import { createAdminClient } from '@orderflow/supabase/admin'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import type { Database } from '@orderflow/types'
import { assertSafeSupabaseTarget } from './assert-safe-target'
import {
  issueAccessLink,
  ACCESS_LINK_CONFIRMED_OTHER,
} from '../src/lib/auth/issue-access-link'
import { sendAccessEmail } from '../src/lib/auth/send-access-email'
import type { EmailSender, OutgoingEmail, SendEmailResult } from '../src/lib/email/send-email'

const HR = '─'.repeat(78)
let passed = 0, failed = 0
function ok(l: string)  { console.log(`  ✓ ${l}`); passed++ }
function nok(l: string, d?: string) { console.error(`  ✗ ${l}`); if (d) console.error(`      ${d}`); failed++ }
function check(c: boolean, l: string, d?: string) { if (c) ok(l); else nok(l, d) }

/** Sender de prueba: registra, nunca manda. */
function fakeSender(): EmailSender & { sent: OutgoingEmail[] } {
  const s = {
    sent: [] as OutgoingEmail[],
    async send(email: OutgoingEmail): Promise<SendEmailResult> {
      s.sent.push(email)
      return { ok: true, id: `fake-${s.sent.length}` }
    },
  }
  return s
}

async function main() {
  assertSafeSupabaseTarget()

  const admin   = createAdminClient()
  const RUN     = `${Date.now()}${Math.floor(Math.random() * 1000)}`
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  if (!anonUrl || !anonKey) { console.error('Faltan env de Supabase'); process.exit(1) }

  console.log(HR)
  console.log('  Invitaciones V2 — generateLink + /auth/confirm')
  console.log(`  target: ${anonUrl}`)
  console.log(HR)

  const authIds:   string[] = []
  const tenantIds: string[] = []
  const mail = (k: string) => `inv-${k}-${RUN}@example.test`

  const anon = () => createSupabaseJsClient<Database>(anonUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  /** Canjea el token como lo hace /auth/confirm: verifyOtp server-side. */
  async function canjear(url: string): Promise<{ ok: boolean; userId?: string; error?: string }> {
    const u = new URL(url)
    const token_hash = u.searchParams.get('token_hash') ?? ''
    const type       = u.searchParams.get('type') as 'invite' | 'recovery'
    const c = anon()
    const { data, error } = await c.auth.verifyOtp({ token_hash, type })
    if (error) return { ok: false, error: error.message }
    return { ok: true, userId: data.user?.id }
  }

  try {
    // ── 1. Usuario nuevo → invite ──────────────────────────────────────────
    const nuevo = mail('nuevo')
    const link1 = await issueAccessLink(nuevo, { allowRecoveryForConfirmed: true })
    authIds.push(link1.userId)

    check(link1.kind === 'invite', '1. usuario nuevo → kind invite')
    check(link1.isNewUser === true, '1. isNewUser true (se creó en esta llamada)')

    const u1 = new URL(link1.url)
    check(u1.pathname === '/auth/confirm', '2. la URL es /auth/confirm', u1.pathname)
    check(u1.searchParams.get('type') === 'invite', '2. type=invite')
    check((u1.searchParams.get('token_hash') ?? '').length > 10, '2. token_hash presente')
    check(!link1.url.includes('/auth/v1/verify'), '2. NO es el action_link de Supabase')

    const { data: authU } = await admin.auth.admin.getUserById(link1.userId)
    check(authU.user?.email === nuevo, '3. el userId corresponde al email invitado')
    check(!authU.user?.email_confirmed_at, '3. todavía sin confirmar (nadie canjeó)')

    // ── 2. El email se arma con el rol y no se envía ───────────────────────
    const sender = fakeSender()
    await sendAccessEmail({ to: nuevo, role: 'seller', kind: link1.kind, accessUrl: link1.url, sender })
    const mailSeller = sender.sent[0]
    check(sender.sent.length === 1 && mailSeller!.to[0] === nuevo, '4. se arma un email para el destinatario')
    check(mailSeller!.subject === 'Te invitaron al equipo comercial de ReservaNex', '4. copy del rol seller', mailSeller!.subject)
    check(mailSeller!.html.includes(link1.url.replace(/&/g, '&amp;')) && mailSeller!.text.includes(link1.url),
      '4. la URL viaja en HTML y en texto')
    check(!mailSeller!.subject.includes(u1.searchParams.get('token_hash')!), '4. el token NO está en el subject')

    // ── 3. Canje real: una vez ─────────────────────────────────────────────
    const primer = await canjear(link1.url)
    check(primer.ok && primer.userId === link1.userId, '5. /auth/confirm canjea el token (verifyOtp) y devuelve el usuario correcto', primer.error)

    const segundo = await canjear(link1.url)
    check(!segundo.ok, '6. el MISMO token no sirve una segunda vez', segundo.error ? `(${segundo.error})` : 'canjeó de nuevo')

    const { data: authU2 } = await admin.auth.admin.getUserById(link1.userId)
    check(Boolean(authU2.user?.email_confirmed_at), '5. tras el canje, el usuario quedó confirmado')

    // ── 4. Usuario ya confirmado → recovery ────────────────────────────────
    const link2 = await issueAccessLink(nuevo, { allowRecoveryForConfirmed: true })
    check(link2.kind === 'recovery', '7. usuario confirmado → kind recovery')
    check(link2.userId === link1.userId, '7. mismo userId')
    check(link2.isNewUser === false, '7. isNewUser false')
    check(new URL(link2.url).searchParams.get('type') === 'recovery', '7. type=recovery en la URL')

    const senderRec = fakeSender()
    await sendAccessEmail({ to: nuevo, role: 'owner', kind: link2.kind, accessUrl: link2.url, businessName: 'Negocio X', sender: senderRec })
    const mailRec = senderRec.sent[0]!
    check(mailRec.subject === 'Accedé nuevamente a tu cuenta de ReservaNex', '8. copy de recovery, no de invitación', mailRec.subject)
    check(!/Fuiste invitado|Te invitaron/i.test(mailRec.html), '8. el email de recovery no dice que sea una invitación')

    const canjeRec = await canjear(link2.url)
    check(canjeRec.ok, '9. el link de recovery también canjea', canjeRec.error)

    // ── 5. Usuario invitado pero NO confirmado → reinvitación ──────────────
    const pendiente = mail('pendiente')
    const linkA = await issueAccessLink(pendiente, { allowRecoveryForConfirmed: true })
    authIds.push(linkA.userId)
    const linkB = await issueAccessLink(pendiente, { allowRecoveryForConfirmed: true })
    check(linkB.kind === 'invite' && linkB.userId === linkA.userId, '10. invitación repetida sin confirmar → nuevo invite, mismo usuario')
    check(linkB.url !== linkA.url, '10. el token se renueva')
    const canjeB = await canjear(linkB.url)
    check(canjeB.ok, '10. el token nuevo canjea', canjeB.error)

    // ── 6. Alta de tenant user: el bloqueo se conserva ─────────────────────
    let bloqueado = false
    try {
      await issueAccessLink(nuevo, { allowRecoveryForConfirmed: false })
    } catch (err) {
      bloqueado = err instanceof Error && err.message === ACCESS_LINK_CONFIRMED_OTHER
    }
    check(bloqueado, '11. confirmado + allowRecoveryForConfirmed:false → se BLOQUEA (no degrada a recovery)')

    // ── 7. Roles reales: dónde termina cada uno ────────────────────────────
    const { data: t } = await admin.from('tenants').insert({
      name: `[TEST] INV ${RUN}`, slug: `test-inv-${RUN}`, status: 'active', vertical: 'food_service',
    } as never).select('id, name').single()
    if (!t) throw new Error('tenant fixture')
    tenantIds.push(t.id)

    const ownerMail = mail('owner')
    const linkOwner = await issueAccessLink(ownerMail, { allowRecoveryForConfirmed: true })
    authIds.push(linkOwner.userId)
    const { error: tuErr } = await admin.from('tenant_users').insert({
      id: linkOwner.userId, tenant_id: t.id, name: 'Owner QA', email: ownerMail, role: 'owner', active: true,
    } as never)
    check(!tuErr, '12. owner → fila en tenant_users con role owner', tuErr?.message)

    const senderOwner = fakeSender()
    await sendAccessEmail({ to: ownerMail, role: 'owner', kind: linkOwner.kind, accessUrl: linkOwner.url, businessName: t.name, sender: senderOwner })
    check(senderOwner.sent[0]!.subject === 'Te invitaron a administrar tu negocio en ReservaNex', '12. copy de owner')
    check(senderOwner.sent[0]!.html.includes(t.name), '12. el email nombra el negocio real')

    const recepMail = mail('recep')
    const linkRecep = await issueAccessLink(recepMail, { allowRecoveryForConfirmed: true })
    authIds.push(linkRecep.userId)
    const { error: tuErr2 } = await admin.from('tenant_users').insert({
      id: linkRecep.userId, tenant_id: t.id, name: 'Recep QA', email: recepMail, role: 'receptionist', active: true,
    } as never)
    check(!tuErr2, '13. receptionist → fila en tenant_users con role receptionist', tuErr2?.message)

    const senderRecep = fakeSender()
    await sendAccessEmail({ to: recepMail, role: 'receptionist', kind: linkRecep.kind, accessUrl: linkRecep.url, businessName: t.name, sender: senderRecep })
    check(senderRecep.sent[0]!.subject === `Te invitaron al equipo de ${t.name}`, '13. copy de receptionist con el negocio', senderRecep.sent[0]!.subject)

    const sellerMail = mail('seller')
    const linkSeller = await issueAccessLink(sellerMail, { allowRecoveryForConfirmed: true })
    authIds.push(linkSeller.userId)
    const { error: puErr } = await admin.from('platform_users').insert({
      id: linkSeller.userId, name: 'Seller QA', email: sellerMail, role: 'seller', active: true,
    } as never)
    check(!puErr, '14. seller → fila en platform_users con role seller', puErr?.message)

    // ── 8. El rol vive en la base, no en el token ni en el email ──────────
    const { data: authSeller } = await admin.auth.admin.getUserById(linkSeller.userId)
    const meta = { ...(authSeller.user?.app_metadata ?? {}), ...(authSeller.user?.user_metadata ?? {}) } as Record<string, unknown>
    check(!('role' in meta) && !('tenant_id' in meta),
      '15. el usuario de Auth NO lleva role ni tenant_id en su metadata', JSON.stringify(meta))

    const { data: puRow } = await admin.from('platform_users').select('role').eq('id', linkSeller.userId).maybeSingle()
    const { data: tuRow } = await admin.from('tenant_users').select('role, tenant_id').eq('id', linkOwner.userId).maybeSingle()
    check(puRow?.role === 'seller', '15. la autoridad del seller es platform_users')
    check(tuRow?.role === 'owner' && tuRow?.tenant_id === t.id, '15. la del owner es tenant_users, con su tenant')

    // ── 9. Aislamiento entre tenants ──────────────────────────────────────
    const { data: t2 } = await admin.from('tenants').insert({
      name: `[TEST] INV B ${RUN}`, slug: `test-inv-b-${RUN}`, status: 'active', vertical: 'food_service',
    } as never).select('id').single()
    if (t2) tenantIds.push(t2.id)
    const { error: crossErr } = await admin.from('tenant_users').insert({
      id: linkOwner.userId, tenant_id: t2!.id, name: 'Owner QA', email: ownerMail, role: 'owner', active: true,
    } as never)
    check(Boolean(crossErr), '16. el mismo usuario no puede duplicarse en otro tenant (PK)', crossErr ? '' : 'se insertó')
  } catch (err) {
    nok('Error fatal', err instanceof Error ? err.message : String(err))
  } finally {
    console.log(`\n${HR}\n  limpieza`)
    for (const id of tenantIds) {
      try { await admin.from('tenant_users').delete().eq('tenant_id', id) } catch { /* noop */ }
      try { await admin.rpc('admin_purge_tenant', { p_tenant_id: id }) } catch { /* noop */ }
      try { await admin.from('tenants').delete().eq('id', id) } catch { /* noop */ }
    }
    for (const id of authIds) {
      try { await admin.from('platform_users').delete().eq('id', id) } catch { /* noop */ }
      try { await admin.auth.admin.deleteUser(id) } catch { /* noop */ }
    }
    const { count } = await admin.from('tenants').select('id', { count: 'exact', head: true }).like('name', '[TEST] INV%')
    console.log(`  usuarios: ${authIds.length} · tenants: ${tenantIds.length} · [TEST] INV restantes: ${count ?? '?'}`)
  }

  console.log(HR)
  console.log(`  RESULTADO: ${passed} ok · ${failed} fallaron`)
  console.log(HR)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('[validate-invitations] fatal:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})
