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
 *
 * ── ALCANCE DE CADA MODO ────────────────────────────────────────────────────
 *
 * El modo SETUP sigue atado al tenant demo inmobiliario: crea usuarios, y
 * acotarlo a un único tenant conocido es lo que lo mantiene barato de razonar.
 *
 * El modo --reset-link NO crea ni modifica nada: solo genera un link de
 * recuperación de un solo uso para un usuario que YA existe. Por eso resuelve
 * al usuario por su email y valida su tenant REAL, en vez de asumir el
 * inmobiliario. Así sirve para el owner de cualquier tenant demo — por ejemplo
 * el de gastronomía — sin tocar el camino que sí escribe datos.
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

/**
 * Tenants demo cuyos owners pueden pedir un link de recuperación.
 *
 * Se identifican por la TERNA COMPLETA (nombre + slug + vertical), no por id:
 * el tenant de gastronomía es un fixture que se borra y se vuelve a crear con
 * id nuevo, así que un id fijo se rompería al primer cleanup. La terna, en
 * cambio, es estable y describe exactamente qué tenant es.
 *
 * Es una lista blanca a propósito: generar un link de recuperación es dar
 * acceso a una cuenta, y esto tiene que poder usarse solo sobre entornos de
 * demo conocidos, nunca sobre un tenant real de un cliente.
 */
const TENANTS_DEMO = [
  { name: '[DEMO] AutoResponder QA', slug: 'demo-autoresponder', vertical: 'real_estate'  },
  { name: '[DEMO] Gastronomía QA',   slug: 'demo-gastronomia',   vertical: 'food_service' },
] as const

function esTenantDemo(t: { name: string; slug: string | null; vertical: string | null }): boolean {
  return TENANTS_DEMO.some((d) =>
    d.name === t.name && d.slug === t.slug && d.vertical === t.vertical)
}

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
  console.log(resetOnly ? '  Link de recuperación de un owner demo' : '  Owner del tenant demo')
  console.log(`  target : ${anonUrl}`)
  if (!resetOnly) console.log(`  tenant : ${DEMO_TENANT_ID}`)
  console.log(`  email  : ${email}`)
  console.log(HR)

  // ══ Modo --reset-link ═══════════════════════════════════════════════════
  //
  // No crea ni modifica NADA: resuelve al usuario existente y valida su tenant
  // real antes de generar el link. Cualquier cosa que no cuadre aborta, sin
  // "arreglar" datos.
  if (resetOnly) {
    // 1. Una sola membresía con ese email, en cualquier tenant.
    const { data: memberships, error: mErr } = await admin.from('tenant_users')
      .select('id, tenant_id, email, role, active')
      .ilike('email', email)

    if (mErr) {
      console.error(`\n  No se pudo consultar tenant_users: ${mErr.message}\n`)
      process.exitCode = 1; return
    }
    if (!memberships || memberships.length === 0) {
      console.error('\n  Ese email no pertenece a ningún tenant. Abortando.\n')
      process.exitCode = 1; return
    }
    if (memberships.length > 1) {
      console.error(`\n  Ese email tiene ${memberships.length} membresías. Se esperaba exactamente una. Abortando.\n`)
      process.exitCode = 1; return
    }
    const tu = memberships[0]!

    // 2. El auth user existe y su email es EXACTAMENTE el pedido.
    const { data: authUser, error: aErr } = await admin.auth.admin.getUserById(tu.id)
    if (aErr || !authUser?.user) {
      console.error('\n  La membresía no tiene un usuario de auth asociado. Abortando.\n')
      process.exitCode = 1; return
    }
    if ((authUser.user.email ?? '').toLowerCase().trim() !== email) {
      console.error('\n  El email de auth no coincide con el de la membresía. Abortando.\n')
      process.exitCode = 1; return
    }

    // 3. Tiene que ser owner y estar activo.
    if (tu.role !== 'owner' || tu.active !== true) {
      console.error(`\n  Ese usuario es ${tu.role} y active=${tu.active}. Solo se generan links para owners activos. Abortando.\n`)
      process.exitCode = 1; return
    }

    // 4. Y su tenant tiene que ser uno de los tenants demo conocidos.
    const { data: suTenant } = await admin.from('tenants')
      .select('id, name, slug, vertical, status').eq('id', tu.tenant_id).maybeSingle()
    if (!suTenant) {
      console.error('\n  El tenant de esa membresía no existe. Abortando.\n')
      process.exitCode = 1; return
    }
    if (!esTenantDemo(suTenant)) {
      console.error(`\n  El tenant "${suTenant.name}" (${suTenant.slug}, ${suTenant.vertical}) no está en la lista de tenants demo.`)
      console.error('  Este comando no genera links para tenants reales. Abortando.\n')
      process.exitCode = 1; return
    }

    console.log(`  tenant : ${suTenant.name} (${suTenant.slug}) · ${suTenant.vertical}`)
    console.log(`  rol    : ${tu.role} · activo`)
    console.log(HR)

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
