import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createClient } from '@orderflow/supabase/server'

// SSR OTP verification for email-based auth flows (invite, recovery, signup).
//
// REQUIRED Dashboard config (Authentication → Email Templates) — each
// template's body must link here using {{ .RedirectTo }}, NOT
// {{ .ConfirmationURL }} (Supabase's default, which routes through
// /auth/v1/verify and — depending on the project's flow type — can produce
// a #fragment no server route ever sees, or a PKCE ?code= this route
// doesn't accept either). {{ .RedirectTo }} reflects exactly the redirectTo
// value the app passed when generating the link (see
// apps/web/src/lib/site-url.ts's getAuthRedirectTo(), which already equals
// this route's own URL) — so it resolves correctly in dev and production
// without editing the template per environment:
//
//   Invite template:        {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite
//   Reset Password template: {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery
//   Magic Link template:     {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=magiclink
//
// This route verifies the OTP directly via verifyOtp — errors are readable
// server-side, no #hash fragment problem, no PKCE code exchange needed (see
// apps/web/src/app/api/auth/callback/route.ts's own comment for why that
// route is NOT used by any current flow).
//
//   type=invite   → /auth/accept-invite   (set initial password)
//   type=recovery → /auth/reset-password  (reset password)
//   type=email    → /dashboard            (email change confirmation)
//   type=signup   → /dashboard            (signup email confirmation)

type AllowedOtpType = 'invite' | 'recovery' | 'email' | 'signup' | 'magiclink'

const ALLOWED_TYPES = new Set<AllowedOtpType>([
  'invite', 'recovery', 'email', 'signup', 'magiclink',
])

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const tokenHash = searchParams.get('token_hash')
  const type      = searchParams.get('type')

  if (!tokenHash || !type || !ALLOWED_TYPES.has(type as AllowedOtpType)) {
    console.error('[auth:confirm] missing or invalid params', {
      hasToken: Boolean(tokenHash),
      type: type ?? '(none)',
    })
    return NextResponse.redirect(`${origin}/auth/confirm-email?error=invalid_link`)
  }

  const supabase = await createClient()

  const { error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: type as AllowedOtpType,
  })

  if (error) {
    console.error('[auth:confirm] verifyOtp failed', {
      type,
      errorCode:    error.code,
      errorMessage: error.message,
      errorStatus:  error.status,
    })
    return NextResponse.redirect(`${origin}/auth/confirm-email?error=invalid_link`)
  }

  if (type === 'invite')   return NextResponse.redirect(`${origin}/auth/accept-invite`)
  if (type === 'recovery') return NextResponse.redirect(`${origin}/auth/reset-password`)
  return NextResponse.redirect(`${origin}/dashboard`)
}
