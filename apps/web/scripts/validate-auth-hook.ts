/**
 * Fase 3A.1 — validación del custom access token hook con LOGIN REAL.
 *
 * Esto es lo único que NO se puede probar sin que el hook esté registrado en
 * el Dashboard del proyecto (Authentication → Hooks → Custom Access Token →
 * public.custom_access_token_hook). Todo lo demás — que la función produzca
 * los claims correctos y que las policies los acepten — ya está probado sin
 * depender del registro, en:
 *
 *   supabase/27-rls-proof-form-submissions.sql
 *   supabase/28-rls-proof-impersonation.sql
 *
 * Acá se verifica el eslabón que falta: que GoTrue efectivamente INVOQUE el
 * hook al emitir el JWT, y que ese JWT real haga funcionar RLS end-to-end.
 *
 * Corré esto INMEDIATAMENTE DESPUÉS de registrar el hook.
 *
 * Usage:  pnpm --filter @orderflow/web validate:auth-hook
 *
 * Nunca imprime un token completo: solo longitud y los claims relevantes.
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { randomBytes, randomUUID } from 'node:crypto'
import { createAdminClient } from '@orderflow/supabase/admin'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import type { Database } from '@orderflow/types'
import { assertSafeSupabaseTarget } from './assert-safe-target'
import { generateSubmissionReference } from '../src/lib/forms/submission-reference'

const HR   = '─'.repeat(78)
const PASS = '  ✓'
const FAIL = '  ✗'

let failures = 0
function ok(msg: string) { console.log(`${PASS} ${msg}`) }
function nok(msg: string, extra?: string) {
  failures++
  console.log(`${FAIL} ${msg}${extra ? `\n      ${extra}` : ''}`)
}

// Decodifica el payload de un JWT SIN verificar la firma: acá solo queremos
// inspeccionar los claims, no autenticar nada.
function decodeClaims(accessToken: string): Record<string, any> {
  const part = accessToken.split('.')[1]
  if (!part) throw new Error('access_token con formato inesperado (no es un JWT de 3 partes)')
  return JSON.parse(Buffer.from(part, 'base64').toString('utf8'))
}

async function main() {
  assertSafeSupabaseTarget()

  const admin  = createAdminClient()
  const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`

  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  if (!anonUrl || !anonKey) {
    console.error('Faltan NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY')
    process.exit(1)
  }

  console.log(HR)
  console.log('  Fase 3A.1 — custom access token hook (login real)')
  console.log(`  target: ${anonUrl}`)
  console.log(`  run:    ${RUN_ID}`)
  console.log(HR)

  const tenantIds:   string[] = []
  const authUserIds: string[] = []

  async function buildTenant(label: string) {
    const slug = `test-hook-${label.toLowerCase()}-${RUN_ID}`
    const { data: tenant, error } = await admin.from('tenants')
      .insert({ name: `[TEST] Hook ${label} ${RUN_ID}`, slug, status: 'active' })
      .select('id').single()
    if (error || !tenant) throw new Error(`tenant insert: ${error?.message}`)
    tenantIds.push(tenant.id)

    const password = randomBytes(18).toString('hex')
    const email    = `owner-hook-${label.toLowerCase()}-${RUN_ID}@example.test`
    const { data: au, error: aErr } =
      await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (aErr || !au.user) throw new Error(`createUser: ${aErr?.message}`)
    authUserIds.push(au.user.id)

    const { error: tuErr } = await admin.from('tenant_users').insert({
      id: au.user.id, tenant_id: tenant.id, name: `Owner ${label}`, email, role: 'owner', active: true,
    })
    if (tuErr) throw new Error(`tenant_users insert: ${tuErr.message}`)

    // Dato en dos tablas tenant-scoped: la nueva y una preexistente.
    const { error: sErr } = await admin.from('form_submissions').insert({
      tenant_id: tenant.id, reference: generateSubmissionReference(),
      intent: 'property_inquiry', status: 'submitted', source: 'public_site',
      payload: { name: `Consulta ${label}` }, idempotency_key: randomUUID(),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    })
    if (sErr) throw new Error(`form_submissions insert: ${sErr.message}`)

    const { error: cErr } = await admin.from('contacts').insert({
      tenant_id: tenant.id, phone: `54911${label === 'A' ? '1111' : '2222'}${RUN_ID.slice(-5)}`,
      name: `Contacto ${label}`,
    })
    if (cErr) throw new Error(`contacts insert: ${cErr.message}`)

    return { tenantId: tenant.id, email, password }
  }

  try {
    const A = await buildTenant('A')
    const B = await buildTenant('B')
    ok('Fixture: dos tenants con owner real, una submission y un contacto cada uno')

    // ═══ LOGIN REAL ═══════════════════════════════════════════════════════
    const client = createSupabaseJsClient<Database>(anonUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data: session, error: sErr } =
      await client.auth.signInWithPassword({ email: A.email, password: A.password })
    if (sErr || !session.session) {
      nok('login real falló', sErr?.message)
      return
    }
    const token = session.session.access_token
    ok(`Login real OK (access_token de ${token.length} chars — no se imprime)`)

    // ═══ 1. CLAIMS DEL JWT ════════════════════════════════════════════════
    const claims = decodeClaims(token)
    const appMeta = claims.app_metadata ?? {}

    if (appMeta.tenant_id) {
      ok(`app_metadata.tenant_id presente: ${appMeta.tenant_id}`)
    } else {
      nok('app_metadata.tenant_id AUSENTE — el hook no se está ejecutando')
      console.log('')
      console.log('      El JWT real no trae el claim. Registrá el hook en:')
      console.log('        Dashboard → Authentication → Hooks → Custom Access Token')
      console.log('        Postgres function: public.custom_access_token_hook')
      console.log(`      app_metadata recibido: ${JSON.stringify(appMeta)}`)
      console.log('')
      return
    }

    if (appMeta.tenant_id === A.tenantId) ok('app_metadata.tenant_id coincide con el tenant correcto')
    else nok('tenant_id NO coincide', `esperado=${A.tenantId} recibido=${appMeta.tenant_id}`)

    if (appMeta.user_type === 'tenant_user') ok('app_metadata.user_type = tenant_user')
    else nok('user_type inesperado', String(appMeta.user_type))

    if (appMeta.role === 'owner') ok('app_metadata.role = owner')
    else nok('role inesperado', String(appMeta.role))

    // ═══ 2. auth_tenant_id() DESDE LA SESIÓN REAL ═════════════════════════
    const { data: fromDb, error: rpcErr } = await client.rpc('auth_tenant_id' as never)
    if (rpcErr) {
      nok('auth_tenant_id() falló', rpcErr.message)
    } else if (fromDb === A.tenantId) {
      ok(`auth_tenant_id() devuelve el UUID correcto desde la sesión real`)
    } else {
      nok('auth_tenant_id() no coincide', `esperado=${A.tenantId} recibido=${String(fromDb)}`)
    }

    // ═══ 3. RLS REAL — form_submissions ═══════════════════════════════════
    {
      const { data: own } = await client.from('form_submissions').select('id').eq('tenant_id', A.tenantId)
      if ((own ?? []).length === 1) ok('form_submissions: el owner ve su propia submission')
      else nok('form_submissions: el owner NO ve lo suyo', `filas=${own?.length ?? 0}`)

      const { data: foreign } = await client.from('form_submissions').select('id').eq('tenant_id', B.tenantId)
      if ((foreign ?? []).length === 0) ok('form_submissions: NO ve las del otro tenant')
      else nok('form_submissions: FUGA entre tenants', JSON.stringify(foreign))

      const { data: all } = await client.from('form_submissions').select('tenant_id')
      const leaked = (all ?? []).filter((r) => r.tenant_id !== A.tenantId)
      if (leaked.length === 0) ok(`form_submissions: SELECT sin WHERE acotado por RLS (${all?.length ?? 0} filas)`)
      else nok('form_submissions: SELECT sin WHERE cruzó tenants', JSON.stringify(leaked.slice(0, 3)))
    }

    // ═══ 4. RLS REAL — contacts (tabla preexistente representativa) ═══════
    {
      const { data: own } = await client.from('contacts').select('id').eq('tenant_id', A.tenantId)
      if ((own ?? []).length === 1) ok('contacts: el owner ve su propio contacto')
      else nok('contacts: el owner NO ve lo suyo', `filas=${own?.length ?? 0}`)

      const { data: foreign } = await client.from('contacts').select('id').eq('tenant_id', B.tenantId)
      if ((foreign ?? []).length === 0) ok('contacts: NO ve los del otro tenant')
      else nok('contacts: FUGA entre tenants', JSON.stringify(foreign))
    }

    await client.auth.signOut().catch(() => {})

  } finally {
    console.log(`\n${HR}\n  limpieza`)
    for (const id of tenantIds) {
      try { await admin.rpc('admin_purge_tenant', { p_tenant_id: id }) } catch { /* ya purgado */ }
      try { await admin.from('tenants').delete().eq('id', id) } catch { /* ya borrado */ }
    }
    for (const uid of authUserIds) {
      try { await admin.auth.admin.deleteUser(uid) } catch { /* ya borrado */ }
    }
    console.log(`  tenants borrados: ${tenantIds.length} · usuarios auth borrados: ${authUserIds.length}`)
  }

  console.log(HR)
  if (failures === 0) {
    console.log('  RESULTADO: hook registrado y RLS funcionando end-to-end ✓')
    console.log(HR)
    process.exit(0)
  }
  console.log(`  RESULTADO: ${failures} check(s) fallaron ✗`)
  console.log(HR)
  process.exit(1)
}

main().catch((err) => {
  console.error('\n[validate-auth-hook] error fatal:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
