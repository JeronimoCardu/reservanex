import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { parseAccessTokenClaims } from '@/lib/claims'

function redirectWithCookies(url: URL, supabaseResponse: NextResponse): NextResponse {
  const res = NextResponse.redirect(url)
  supabaseResponse.cookies.getAll().forEach((c) => res.cookies.set(c.name, c.value))
  return res
}

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // IMPORTANT: Do not add logic between createServerClient and getUser().
  const { data: { user } } = await supabase.auth.getUser()

  const pathname = request.nextUrl.pathname

  // Unauthenticated visitor trying to access a protected area → login
  if (!user) {
    if (pathname.startsWith('/dashboard') || pathname.startsWith('/platform')) {
      return redirectWithCookies(new URL('/login', request.url), supabaseResponse)
    }
    return supabaseResponse
  }

  // Authenticated but email not confirmed — block dashboard access.
  // /auth/confirm-email and /auth/accept-invite are whitelisted so the user
  // can confirm or set their password without being caught in a redirect loop.
  const emailConfirmed = Boolean(user.email_confirmed_at)
  const isAuthPage =
    pathname.startsWith('/auth/confirm-email') ||
    pathname.startsWith('/auth/accept-invite') ||
    pathname.startsWith('/auth/reset-password') ||
    pathname === '/login'

  if (!emailConfirmed && !isAuthPage) {
    if (pathname.startsWith('/dashboard') || pathname.startsWith('/platform')) {
      return redirectWithCookies(new URL('/auth/confirm-email', request.url), supabaseResponse)
    }
  }

  // Operator route guard — operators can only access /platform/setup.
  // Runs before the login-redirect block so it applies to all authenticated requests.
  if (pathname.startsWith('/platform') && !pathname.startsWith('/platform/setup')) {
    const { data: { session } } = await supabase.auth.getSession()
    const claims = parseAccessTokenClaims(session?.access_token)
    if (claims?.user_type === 'platform_user' && claims.role === 'operator') {
      return redirectWithCookies(new URL('/platform/setup', request.url), supabaseResponse)
    }
  }

  // Authenticated user on the login page — route to their dashboard based on claims.
  // Without this guard: requireTenantContext → redirect('/login') → here → redirect('/dashboard')
  // creates an infinite loop when the user has no valid tenant claims.
  if (pathname === '/login') {
    const { data: { session } } = await supabase.auth.getSession()
    const claims = parseAccessTokenClaims(session?.access_token)

    if (claims?.user_type === 'tenant_user') {
      return redirectWithCookies(new URL('/dashboard', request.url), supabaseResponse)
    }
    if (claims?.user_type === 'platform_user') {
      // Operators go directly to their setup list, not the SA/seller dashboard
      const dest = claims.role === 'operator' ? '/platform/setup' : '/platform'
      return redirectWithCookies(new URL(dest, request.url), supabaseResponse)
    }

    // Authenticated but no valid claims — stay on login so the user can sign out.
    return supabaseResponse
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api).*)'],
}
