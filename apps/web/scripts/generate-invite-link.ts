/**
 * DEV ONLY — genera un invite link de Supabase sin enviar email.
 *
 * Úsalo para aislar si el problema es el scanner de email, el redirectTo,
 * el callback o inviteUserByEmail, copiando el action_link y abriéndolo
 * manualmente en el navegador.
 *
 * NUNCA correr en producción.
 *
 * Uso:
 *   pnpm --filter @orderflow/web dev:invite-link <email>
 *
 * Para abrir el link automáticamente (Windows):
 *   pnpm --filter @orderflow/web dev:invite-link:open <email>
 *
 * Flujo esperado al abrir el action_link:
 *   Supabase invite → /api/auth/callback?code=...&type=invite → /auth/accept-invite → set password
 */

import fs from 'fs'
import path from 'path'
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { assertSafeSupabaseTarget } from './assert-safe-target'

// Load apps/web/.env.local — contains all required vars for local dev
config({ path: path.resolve(__dirname, '..', '.env.local') })

// Fase 10 security audit — this script's existing guard only checks
// NEXT_PUBLIC_SITE_URL is localhost; it never verified WHICH Supabase
// project SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL points to. A stale/wrong
// .env.local could pass the localhost check while still creating/inviting
// a real auth user against the wrong project. Every other admin-client
// script in this repo already calls this first — adding it here too,
// on top of (not replacing) the existing localhost guard below.
assertSafeSupabaseTarget()

const HR = '─'.repeat(64)

async function main(): Promise<void> {
  const email    = process.argv[2]
  const openLink = process.argv[3] === '--open'

  if (!email || !email.includes('@')) {
    console.error('\n  Uso: pnpm --filter @orderflow/web dev:invite-link <email>\n')
    process.exitCode = 1
    return
  }

  const supabaseUrl    = process.env.NEXT_PUBLIC_SUPABASE_URL    ?? ''
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY   ?? ''
  const siteUrl        = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, '')

  const missing: string[] = []
  if (!supabaseUrl)    missing.push('NEXT_PUBLIC_SUPABASE_URL')
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  if (!siteUrl)        missing.push('NEXT_PUBLIC_SITE_URL')

  if (missing.length > 0) {
    console.error('\n  [invite-link] Faltan variables de entorno en .env.local:')
    missing.forEach((v) => console.error(`    • ${v}`))
    console.error('\n  Verificá que apps/web/.env.local esté configurado correctamente.\n')
    process.exitCode = 1
    return
  }

  // Hard guard: do not run against production
  if (!siteUrl.includes('localhost') && !siteUrl.includes('127.0.0.1')) {
    console.error('\n  [invite-link] BLOQUEADO — NEXT_PUBLIC_SITE_URL no apunta a localhost.')
    console.error(`  Valor actual: ${siteUrl}`)
    console.error('  Este script es SOLO PARA DESARROLLO.\n')
    process.exitCode = 1
    return
  }

  const redirectTo = `${siteUrl}/api/auth/callback`
  const normalizedEmail = email.toLowerCase().trim()

  console.log()
  console.log(HR)
  console.log('  ReservaNex — Generar invite link (DEV ONLY)')
  console.log(HR)
  console.log()
  console.log(`  projectUrl  : ${supabaseUrl}`)
  console.log(`  email       : ${normalizedEmail}`)
  console.log(`  redirectTo  : ${redirectTo}`)
  console.log()

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ─── Pre-flight: check DB state before generating link ────────────────────
  console.log('  [pre-flight] Verificando estado en la base de datos...')

  const [platformUserResult, tenantUserResult] = await Promise.all([
    supabase
      .from('platform_users')
      .select('id, role, active')
      .eq('email', normalizedEmail)
      .maybeSingle(),
    supabase
      .from('tenant_users')
      .select('id, role, active, tenant_id')
      .eq('email', normalizedEmail)
      .maybeSingle(),
  ])

  const platformUser = platformUserResult.data
  const tenantUser   = tenantUserResult.data

  if (platformUser) {
    console.log(`    platform_users  : ✓ encontrado — id=${platformUser.id}, role=${platformUser.role}, active=${platformUser.active}`)
  } else {
    console.log('    platform_users  : ✗ NO encontrado')
  }

  if (tenantUser) {
    console.log(`    tenant_users    : ✓ encontrado — id=${tenantUser.id}, role=${tenantUser.role}, active=${tenantUser.active}, tenant_id=${tenantUser.tenant_id}`)
  } else {
    console.log('    tenant_users    : ✗ NO encontrado')
  }

  // Warning: if auth user exists (we'll know after generateLink) but no internal user
  const hasInternalUser = Boolean(platformUser || tenantUser)
  if (!hasInternalUser) {
    console.log()
    console.log('  ⚠️  WARNING: email no encontrado en platform_users ni tenant_users.')
    console.log('     El usuario podrá aceptar la invitación y setear contraseña,')
    console.log('     pero NO podrá entrar a ReservaNex porque no tiene usuario interno.')
    console.log('     Creá el seller o tenant user antes de usar este link.')
  }
  console.log()

  const { data, error } = await supabase.auth.admin.generateLink({
    type:    'invite',
    email:   normalizedEmail,
    options: { redirectTo },
  })

  if (error || !data?.properties?.action_link) {
    console.error('  [invite-link] Error al generar el link:')
    console.error('  ', error)
    if (!error && !data?.properties?.action_link) {
      console.error('  data recibida:')
      console.error('  ', JSON.stringify(data, null, 2))
    }
    console.error()
    process.exitCode = 1
    return
  }

  const actionLink  = data.properties.action_link
  const hashedToken = data.properties?.hashed_token ?? null
  const userId      = data.user?.id ?? '(sin user.id en la respuesta)'

  // Build the local SSR confirm link using hashed_token — bypasses supabase.co/auth/v1/verify
  // and calls verifyOtp directly on our server. This is the recommended link to test locally.
  const localConfirmLink = hashedToken
    ? `${siteUrl}/auth/confirm?token_hash=${hashedToken}&type=invite`
    : null

  console.log(`  user.id     : ${userId}`)
  console.log(`  hashed_token: ${hashedToken ? 'presente ✓' : '(ausente — local_confirm_link no disponible)'}`)
  console.log()

  // ─── Diagnostic: fetch user state after generateLink ──────────────────────
  if (data.user?.id) {
    const { data: userState, error: userError } = await supabase.auth.admin.getUserById(data.user.id)
    console.log('  [diagnóstico] Estado del usuario en auth:')
    if (userError) {
      console.error('    getUserById error:', userError)
    } else {
      console.log(`    email               : ${userState.user.email}`)
      console.log(`    invited_at          : ${userState.user.invited_at ?? 'null'}`)
      console.log(`    email_confirmed_at  : ${userState.user.email_confirmed_at ?? 'null'}`)
      console.log(`    last_sign_in_at     : ${userState.user.last_sign_in_at ?? 'null'}`)
    }
    console.log()
  }

  // ─── Print local_confirm_link (SSR, recomendado para pruebas) ─────────────
  console.log('  local_confirm_link (RECOMENDADO — usar este para probar):')
  console.log()
  if (localConfirmLink) {
    console.log(localConfirmLink)
  } else {
    console.log('  (no disponible — hashed_token ausente en la respuesta)')
  }
  console.log()

  // ─── Print action_link (referencia, va por supabase.co) ───────────────────
  console.log('  action_link (referencia — va por supabase.co/auth/v1/verify, puede mostrar otp_expired):')
  console.log()
  console.log(actionLink)
  console.log()
  console.log(HR)

  // ─── Save local_confirm_link (o action_link como fallback) a tmp/ ─────────
  const tmpDir      = path.resolve(__dirname, '..', 'tmp')
  const outFilePath = path.join(tmpDir, 'invite-link.txt')

  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(outFilePath, (localConfirmLink ?? actionLink) + '\n', 'utf8')

  console.log()
  console.log(`  Link guardado en: apps/web/tmp/invite-link.txt`)
  console.log(`  (guardado: ${localConfirmLink ? 'local_confirm_link' : 'action_link (fallback)'})`)

  // ─── Open in browser (Windows: `start`) ───────────────────────────────────
  const linkToOpen = localConfirmLink ?? actionLink
  if (openLink) {
    const { exec } = await import('child_process')
    exec(`start "" "${linkToOpen}"`, (err) => {
      if (err) console.error('  [open] No se pudo abrir el link:', err.message)
      else console.log('  Abriendo el local_confirm_link en el navegador...')
    })
  } else {
    console.log()
    console.log('  Para abrir automáticamente:')
    console.log('    pnpm --filter @orderflow/web dev:invite-link:open <email>')
    console.log()
    console.log('  Flujo esperado con local_confirm_link:')
    console.log('    1. /auth/confirm?token_hash=...&type=invite')
    console.log('    2. verifyOtp en servidor (sin pasar por supabase.co)')
    console.log('    3. Redirige a /auth/accept-invite')
    console.log('    4. Usuario setea contraseña → /dashboard')
    console.log()
  }
}

main().catch((err) => {
  console.error('\n  [invite-link] Fatal:', err)
  process.exitCode = 1
})
