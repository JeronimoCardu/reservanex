import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createClient } from '@orderflow/supabase/server'

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
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const type = searchParams.get('type')

  if (!code) {
    console.error('[auth:callback] no code param in request', { type, url: request.url.split('?')[0] })
    return NextResponse.redirect(`${origin}/auth/confirm-email?error=invalid_link`)
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
    return NextResponse.redirect(`${origin}/auth/confirm-email?error=invalid_link`)
  }

  if (type === 'invite')   return NextResponse.redirect(`${origin}/auth/accept-invite`)
  if (type === 'recovery') return NextResponse.redirect(`${origin}/auth/reset-password`)
  return NextResponse.redirect(`${origin}/dashboard`)
}
