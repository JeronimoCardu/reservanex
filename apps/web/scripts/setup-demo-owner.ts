/**
 * Owner persistente del tenant demo, para probar el CRM a mano.
 *
 * A diferencia de los usuarios que crean los validate-*, este NO se borra al
 * terminar: existe para poder loguearse en el dashboard.
 *
 * ── SOBRE LA CONTRASEÑA ─────────────────────────────────────────────────────
 *
 * El modo setup crea el usuario con una contraseña aleatoria que vive SOLO en
 * memoria de este proceso: nunca se imprime, ni se escribe, ni se devuelve. Se
 * usa una única vez, acá adentro, para hacer un login real y comprobar que el
 * JWT trae los claims correctos — que es lo que de verdad importa verificar.
 *
 * Después nadie la conoce. Para entrar, se genera un link de recuperación con
 * el modo --reset-link y se define la contraseña propia en el navegador. El
 * token queda en la terminal de quien corre el comando y en ningún otro lado.
 *
 * ── USO ─────────────────────────────────────────────────────────────────────
 *
 *   pnpm --filter @orderflow/web setup:demo-owner <email>
 *   pnpm --filter @orderflow/web setup:demo-owner <email> --reset-link
 *
 * Es idempotente: si el owner ya existe, el setup no lo toca y solo informa.
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { randomBytes } from 'node:crypto'
import { createAdminClient } from '@orderflow/supabase/admin'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import type { Database } from '@orderflow/types'
import { assertSafeSupabaseTarget } from './assert-safe-target'

const DEMO_TENANT_ID = 'ace547bb-3a72-4ed6-8ff5-de49d001cd68'
const HR = '─'.repeat(72)

function decodeClaims(accessToken: string): Record<string, any> {
  const part = accessToken.split('.')[1]
  if (!part) throw new Error('access_token con formato inesperado')
  return JSON.parse(Buffer.from(part, 'base64').toString('utf8'))
}

async function main() {
  assertSafeSupabaseTarget()

  const email = (process.argv[2] ?? '').toLowerCase().trim()
  const resetOnly = process.argv.includes('--reset-link')

  if (!email || !email.includes('@')) {
    console.error('\n  Uso: pnpm --filter @orderflow/web setup:demo-owner <email> [--reset-link]\n')
    process.exit(1)
  }

  const admin   = createAdminClient()
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001').replace(/\/$/, '')

  console.log(HR)
  console.log('  Owner del tenant demo')
  console.log(`  target : ${anonUrl}`)
  console.log(`  tenant : ${DEMO_TENANT_ID}`)
  console.log(`  email  : ${email}`)
  console.log(HR)

  // ── Guard: el tenant tiene que existir y ser el demo ──────────────────────
  const { data: tenant } = await admin.from('tenants')
    .select('id, name, status').eq('id', DEMO_TENANT_ID).maybeSingle()
  if (!tenant) {
    console.error('\n  El tenant demo no existe en este proyecto. Abortando.\n')
    process.exit(1)
  }

  // ── Modo --reset-link ────────────────────────────────────────────────────
  if (resetOnly) {
    const { data: tu } = await admin.from('tenant_users')
      .select('id, role, active').eq('tenant_id', DEMO_TENANT_ID).eq('email', email).maybeSingle()
    if (!tu) {
      console.error('\n  Ese email no es usuario de este tenant. Corré primero el modo setup.\n')
      process.exit(1)
    }

    const { data, error } = await admin.auth.admin.generateLink({
      type:    'recovery',
      email,
      options: { redirectTo: `${siteUrl}/auth/reset-password` },
    })

    if (error || !data?.properties?.action_link) {
      console.error('\n  No se pudo generar el link:', error?.message ?? 'sin action_link', '\n')
      process.exit(1)
    }

    const hashed = data.properties.hashed_token
    console.log()
    console.log('  Abrí este link en el navegador y definí tu contraseña.')
    console.log('  Es de un solo uso y caduca. No lo compartas.')
    console.log()
    console.log('  ── link ──')
    console.log(`  ${data.properties.action_link}`)
    if (hashed) {
      console.log()
      console.log('  ── alternativa local (evita el redirect de supabase.co) ──')
      console.log(`  ${siteUrl}/auth/confirm?token_hash=${hashed}&type=recovery`)
    }
    console.log()
    return
  }

  // ── Idempotencia: ¿ya hay un owner activo? ───────────────────────────────
  const { data: existing } = await admin.from('tenant_users')
    .select('id, email, role, active')
    .eq('tenant_id', DEMO_TENANT_ID).eq('role', 'owner').eq('active', true)
    .maybeSingle()

  if (existing) {
    console.log()
    console.log(`  Ya existe un owner activo: ${existing.email}`)
    console.log('  No se creó nada. Para definir su contraseña:')
    console.log(`    pnpm --filter @orderflow/web setup:demo-owner ${existing.email} --reset-link`)
    console.log()
    return
  }

  // ── Crear el usuario de Auth ─────────────────────────────────────────────
  // La contraseña es aleatoria y NUNCA sale de esta variable. Se usa solo para
  // el login de verificación de abajo. email_confirm en true porque un usuario
  // sin confirmar no puede entrar (require-tenant-context redirige), y sin
  // entrar no se pueden verificar los claims.
  const tempPassword = randomBytes(24).toString('base64url')

  const { data: created, error: createErr } =
    await admin.auth.admin.createUser({ email, password: tempPassword, email_confirm: true })

  if (createErr || !created.user) {
    console.error('\n  No se pudo crear el usuario de Auth:', createErr?.message, '\n')
    process.exit(1)
  }
  const authUserId = created.user.id
  console.log('\n  ✓ Usuario creado en Supabase Auth')

  // ── Fila en tenant_users ─────────────────────────────────────────────────
  const { error: tuErr } = await admin.from('tenant_users').insert({
    id:        authUserId,
    tenant_id: DEMO_TENANT_ID,
    name:      'Owner Demo',
    email,
    role:      'owner',
    active:    true,
  })

  if (tuErr) {
    // Rollback: sin fila interna el usuario de Auth no sirve para nada y
    // quedaría huérfano. Mismo criterio que createTenantUser().
    await admin.auth.admin.deleteUser(authUserId).catch(() => {})
    console.error('\n  Falló el insert en tenant_users, se revirtió el usuario:', tuErr.message, '\n')
    process.exit(1)
  }
  console.log('  ✓ Fila en tenant_users (role=owner, active=true)')

  // ── Verificación con LOGIN REAL ──────────────────────────────────────────
  const client = createSupabaseJsClient<Database>(anonUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: session, error: loginErr } =
    await client.auth.signInWithPassword({ email, password: tempPassword })

  if (loginErr || !session.session) {
    console.error('\n  El login de verificación falló:', loginErr?.message, '\n')
    process.exit(1)
  }

  const claims  = decodeClaims(session.session.access_token)
  const meta    = claims.app_metadata ?? {}
  let allOk = true
  function check(label: string, actual: unknown, expected: unknown) {
    const ok = actual === expected
    if (!ok) allOk = false
    console.log(`  ${ok ? '✓' : '✗'} ${label}: ${String(actual)}${ok ? '' : ` (esperado ${String(expected)})`}`)
  }

  console.log('\n  Claims del JWT (login real):')
  check('app_metadata.tenant_id', meta.tenant_id, DEMO_TENANT_ID)
  check('app_metadata.user_type', meta.user_type, 'tenant_user')
  check('app_metadata.role',      meta.role,      'owner')

  const { data: fromDb } = await client.rpc('auth_tenant_id' as never)
  check('auth_tenant_id()', fromDb, DEMO_TENANT_ID)

  await client.auth.signOut().catch(() => {})

  // ── Cerrar el acceso temporal ────────────────────────────────────────────
  // La contraseña aleatoria queda inutilizable: se reemplaza por otra que
  // tampoco se guarda ni se imprime. A partir de acá el único camino de
  // entrada es el link de recuperación, que define quien va a usar la cuenta.
  await admin.auth.admin.updateUserById(authUserId, {
    password: randomBytes(24).toString('base64url'),
  })

  console.log()
  console.log(HR)
  if (allOk) {
    console.log('  Owner listo. La contraseña temporal quedó invalidada.')
    console.log()
    console.log('  Para definir la tuya:')
    console.log(`    pnpm --filter @orderflow/web setup:demo-owner ${email} --reset-link`)
  } else {
    console.log('  ATENCIÓN: los claims no son los esperados. Revisar el hook.')
  }
  console.log(HR)
  console.log()

  process.exit(allOk ? 0 : 1)
}

main().catch((e) => {
  console.error('\n[setup-demo-owner] error:', e instanceof Error ? e.message : String(e), '\n')
  process.exit(1)
})
