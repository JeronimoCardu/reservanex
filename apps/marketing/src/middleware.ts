import createMiddleware from 'next-intl/middleware'
import { routing } from './i18n/routing'

export default createMiddleware(routing)

export const config = {
  // `icon` and `apple-icon` are root-level metadata routes (src/app/icon.tsx,
  // apple-icon.tsx) with no file extension in their URL, so the generic
  // "has a dot" file exclusion below doesn't catch them — without this,
  // the middleware redirects /icon to the (nonexistent) /es/icon and the
  // favicon 404s.
  matcher: ['/((?!api|_next|_vercel|icon|apple-icon|.*\\..*).*)'],
}
