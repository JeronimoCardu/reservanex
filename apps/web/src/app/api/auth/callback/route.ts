import type { NextRequest } from 'next/server'
import { createClient } from '@orderflow/supabase/server'
import { localRedirect } from '@/lib/http/local-redirect'

// PKCE code exchange — kept for a future OAuth provider (Google, etc.), but
// NOT used by any current flow: this app has no OAuth sign-in, and every
// email flow (invite/recovery/magic link) was standardized on
// apps/web/src/lib/site-url.ts's getAuthRedirectTo(), which points at
// /auth/confirm's token_hash verification instead (see that file's doc
// comment for why mixing this route with the default Supabase email
// templates was the exact cause of a real "invalid invite link" bug —
// Fase 8 "invite flow" report). If an OAuth provider is added later, this
// route is where its redirectTo should point; it does not need any
// changes for that to keep working.
//
//   type=invite   → /auth/accept-invite   (user sets initial password)
//   type=recovery → /auth/reset-password  (user resets password)
//   (no type)     → /dashboard
//
// Redirects are relative, like /auth/confirm's (see lib/http/local-redirect.ts).
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const code = searchParams.get('code')
  const type = searchParams.get('type')

  if (!code) {
    console.error('[auth:callback] no code param in request', { type, path: request.nextUrl.pathname })
    return localRedirect('/auth/confirm-email?error=invalid_link')
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    console.error('[auth:callback] exchangeCodeForSession failed', {
      type,
      errorCode: error.code,
      errorMessage: error.message,
      errorStatus: error.status,
    })
    return localRedirect('/auth/confirm-email?error=invalid_link')
  }

  if (type === 'invite')   return localRedirect('/auth/accept-invite')
  if (type === 'recovery') return localRedirect('/auth/reset-password')
  return localRedirect('/dashboard')
}
