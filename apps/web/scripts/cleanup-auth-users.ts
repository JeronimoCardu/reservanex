import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { assertSafeSupabaseTarget } from './assert-safe-target'

dotenv.config({ path: '.env.local' })

// Fase 10 security audit — this script deletes essentially every auth user
// in whatever project SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL points to
// (keeping only KEEP_EMAIL). Every other admin-client script in this repo
// already calls assertSafeSupabaseTarget() before touching data; this one
// was missing it — a wrong/stale .env.local could otherwise point this at
// any project, including the original ReservaNex one, with zero warning.
assertSafeSupabaseTarget()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const KEEP_EMAIL = 'jeronimocardu29@gmail.com'

if (!SUPABASE_URL) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL')
}

if (!SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')
}

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

async function listAllUsers() {
  const users = []
  let page = 1
  const perPage = 1000

  while (true) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage,
    })

    if (error) throw error

    users.push(...data.users)

    if (data.users.length < perPage) break

    page += 1
  }

  return users
}

async function main() {
  console.log('──────────────────────────────────────────────')
  console.log('ReservaNex — Cleanup Auth Users DEV ONLY')
  console.log('──────────────────────────────────────────────')
  console.log(`Keeping: ${KEEP_EMAIL}`)

  const users = await listAllUsers()

  const usersToDelete = users.filter((user) => {
    return user.email?.toLowerCase() !== KEEP_EMAIL.toLowerCase()
  })

  console.log(`Total auth users: ${users.length}`)
  console.log(`Users to delete: ${usersToDelete.length}`)

  for (const user of usersToDelete) {
    console.log(`Deleting ${user.email ?? '(no email)'} — ${user.id}`)

    const { error } = await supabaseAdmin.auth.admin.deleteUser(user.id)

    if (error) {
      console.error(`Failed deleting ${user.email ?? user.id}:`, error)
      continue
    }

    console.log(`Deleted ${user.email ?? user.id}`)
  }

  console.log('Done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})