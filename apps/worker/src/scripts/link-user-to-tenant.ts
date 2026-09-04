/**
 * Dev script: links a Supabase Auth user to the demo tenant as owner.
 *
 * Run this once after creating your Supabase auth account if the CRM shows
 * no conversations because the custom_access_token_hook can't find a row
 * in tenant_users for your auth user UUID.
 *
 * Usage:  pnpm link:user
 * Env:    DEMO_TENANT_ID              (required)
 *         USER_EMAIL                  (required — your login email)
 *         USER_NAME                   (optional — display name, default = email)
 *         USER_ROLE                   (optional — 'owner' | 'receptionist', default = 'owner')
 *         SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL  (required)
 *         SUPABASE_SERVICE_ROLE_KEY   (required)
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '../../../../.env.local') })

import { createClient } from '@supabase/supabase-js'
import { assertSafeSupabaseTarget } from '../lib/assert-safe-target'
import type { Database } from '@orderflow/types'

const HR = '─'.repeat(64)

async function main(): Promise<void> {
  console.log(HR)
  console.log('  ReservaNex — Link User to Tenant')
  console.log(HR)

  assertSafeSupabaseTarget()

  const tenantId     = process.env.DEMO_TENANT_ID                          ?? ''
  const userEmail    = process.env.USER_EMAIL                               ?? ''
  const userName     = process.env.USER_NAME                                || userEmail
  const userRole     = (process.env.USER_ROLE ?? 'owner') as 'owner' | 'receptionist'
  const supabaseUrl  = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY              ?? ''

  const missing: string[] = []
  if (!tenantId)      missing.push('DEMO_TENANT_ID')
  if (!userEmail)     missing.push('USER_EMAIL')
  if (!supabaseUrl)   missing.push('SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)')
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY')

  if (missing.length > 0) {
    console.error('\n  [link] Missing required env vars:\n    ', missing.join('\n    '))
    process.exitCode = 1
    return
  }

  if (userRole !== 'owner' && userRole !== 'receptionist') {
    console.error('\n  [link] USER_ROLE must be "owner" or "receptionist"')
    process.exitCode = 1
    return
  }

  const supabase = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Resolve auth user by email using the admin API.
  const { data: usersPage, error: listErr } = await supabase.auth.admin.listUsers({
    perPage: 1000,
  })

  if (listErr) {
    console.error('\n  [link] Could not list auth users:', listErr.message)
    process.exitCode = 1
    return
  }

  const authUser = usersPage.users.find(
    (u) => u.email?.toLowerCase() === userEmail.toLowerCase(),
  )

  if (!authUser) {
    console.error(`\n  [link] No auth user found with email: ${userEmail}`)
    console.error('  Create the user in the Supabase dashboard or via sign-up first.')
    process.exitCode = 1
    return
  }

  console.log(`\n  Auth user found: ${authUser.id}`)

  // Check if already linked.
  const { data: existing } = await supabase
    .from('tenant_users')
    .select('id, tenant_id, role, active')
    .eq('id', authUser.id)
    .maybeSingle()

  if (existing) {
    const sameConfig =
      existing.tenant_id === tenantId &&
      existing.role       === userRole &&
      existing.active     === true

    if (sameConfig) {
      console.log(`\n  User already linked correctly.`)
      console.log(`  id        : ${existing.id}`)
      console.log(`  tenant_id : ${existing.tenant_id}`)
      console.log(`  role      : ${existing.role}`)
      console.log(`  active    : ${existing.active}`)
      console.log(HR)
      return
    }

    // Update the existing row.
    const { error: updateErr } = await supabase
      .from('tenant_users')
      .update({
        tenant_id: tenantId,
        role:      userRole,
        active:    true,
        email:     userEmail,
        name:      userName,
      })
      .eq('id', authUser.id)

    if (updateErr) {
      console.error('\n  [link] Update failed:', updateErr.message)
      process.exitCode = 1
      return
    }

    console.log(`\n  tenant_users row updated.`)
  } else {
    // Insert new row.
    const { error: insertErr } = await supabase
      .from('tenant_users')
      .insert({
        id:        authUser.id,
        tenant_id: tenantId,
        role:      userRole,
        email:     userEmail,
        name:      userName,
        active:    true,
      })

    if (insertErr) {
      console.error('\n  [link] Insert failed:', insertErr.message)
      process.exitCode = 1
      return
    }

    console.log(`\n  tenant_users row created.`)
  }

  console.log()
  console.log(`  auth user id : ${authUser.id}`)
  console.log(`  email        : ${userEmail}`)
  console.log(`  name         : ${userName}`)
  console.log(`  tenant_id    : ${tenantId}`)
  console.log(`  role         : ${userRole}`)
  console.log()
  console.log('  Next step:')
  console.log('    Sign out and sign back in so a new JWT is issued with the updated claims.')
  console.log(HR)
}

main().catch((err) => {
  console.error('\n  [link] Fatal:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
