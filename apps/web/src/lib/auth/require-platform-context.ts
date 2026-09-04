import { redirect } from 'next/navigation'
import { createClient } from '@orderflow/supabase/server'
import { parseAccessTokenClaims } from '@/lib/claims'
import type { PlatformRole } from '@orderflow/types'

export type PlatformContext = {
  userId: string
  role:   PlatformRole
  email:  string
  isSuperAdmin: boolean
  isSeller:     boolean
  isOperator:   boolean
}

export async function requirePlatformContext(): Promise<PlatformContext> {
  const supabase = await createClient()

  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) redirect('/login')

  const { data: { session } } = await supabase.auth.getSession()
  const claims = parseAccessTokenClaims(session?.access_token)

  if (!claims || claims.user_type !== 'platform_user') redirect('/login')

  return {
    userId:       user.id,
    role:         claims.role,
    email:        user.email ?? '',
    isSuperAdmin: claims.role === 'super_admin',
    isSeller:     claims.role === 'seller',
    isOperator:   claims.role === 'operator',
  }
}

export async function requireSuperAdmin(): Promise<PlatformContext> {
  const ctx = await requirePlatformContext()
  if (!ctx.isSuperAdmin) redirect('/platform')
  return ctx
}

export async function requireOperator(): Promise<PlatformContext> {
  const ctx = await requirePlatformContext()
  if (!ctx.isOperator && !ctx.isSuperAdmin) redirect('/platform')
  return ctx
}
