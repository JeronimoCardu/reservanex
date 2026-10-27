import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ════════════════════════════════════════════════════════════════════════════
// PROD-HOSTINGER-D3 — ningún route handler arma un origin a partir del request.
//
// Detrás del proxy de Hostinger request.url llega como https://0.0.0.0:3000/...
// (ver local-redirect.ts). Un test de unidad sólo cubre el handler que prueba;
// esto lee el código de TODOS los route.ts de src/app, incluidos los futuros.
//
// El middleware queda afuera a propósito: Next relativiza el Location de sus
// redirects (router-utils/resolve-routes), así que ahí new URL('/login',
// request.url) es correcto.
// ════════════════════════════════════════════════════════════════════════════

const WEB = path.resolve(import.meta.dirname, '..', '..', '..')
const leer = (rel: string) => soloCodigo(fs.readFileSync(path.join(WEB, rel), 'utf8'))

function soloCodigo(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

function routeHandlers(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return routeHandlers(p)
    return /^route\.[cm]?[jt]sx?$/.test(e.name) ? [path.relative(WEB, p).replace(/\\/g, '/')] : []
  })
}

const HANDLERS = routeHandlers(path.join(WEB, 'src', 'app'))
const AUTH_HANDLERS = ['src/app/(auth)/auth/confirm/route.ts', 'src/app/api/auth/callback/route.ts']

// Las formas de sacar del request un origin o una URL absoluta propia.
const ORIGEN_DEL_REQUEST: [string, RegExp][] = [
  ['.origin',                                  /\.origin\b/],
  ['{ origin } = …',                           /\{[^}]*\borigin\b[^}]*\}\s*=/],
  ['new URL(x, request.url)',                  /new URL\([^)]*,\s*\w+\.(?:url|nextUrl)\b/],
  ['nextUrl.clone()',                          /\bnextUrl\.clone\(\)/],
  // Exige URL absoluta, y en un route handler la única que Next ofrece es request.url.
  ['NextResponse.redirect / Response.redirect', /(?:Next)?Response\.redirect\(/],
]

describe('route handlers: ningún redirect sale de un origin del request', () => {
  it('encuentra los route handlers (la guarda no pasa en vacío)', () => {
    for (const rel of AUTH_HANDLERS) expect(HANDLERS).toContain(rel)
    expect(HANDLERS.length).toBeGreaterThanOrEqual(12)
  })

  it.each(HANDLERS)('%s', (rel) => {
    const src = leer(rel)
    for (const [forma, re] of ORIGEN_DEL_REQUEST) expect(src, `${rel} usa ${forma}`).not.toMatch(re)
  })
})

describe('/auth/confirm y /api/auth/callback', () => {
  it.each(AUTH_HANDLERS)('%s no lee request.url y redirige sólo con localRedirect a rutas literales', (rel) => {
    const src = leer(rel)
    expect(src).not.toContain('request.url')
    expect(src).not.toContain('new URL(')
    expect(src).not.toMatch(/\blocation\b/i)
    const llamadas = src.match(/localRedirect\([^)]*\)/g) ?? []
    expect(llamadas.length).toBeGreaterThan(0)
    for (const llamada of llamadas) expect(llamada).toMatch(/^localRedirect\('\/[\w-][^']*'\)$/)
  })
})

describe('la guarda', () => {
  it.each([
    // Las dos líneas de main@5fec947 que mandaban a https://0.0.0.0:3000.
    'const { searchParams, origin } = new URL(request.url)',
    'return NextResponse.redirect(`${origin}/auth/confirm-email?error=invalid_link`)',
    "return NextResponse.redirect(new URL('/dashboard', request.url))",
    "const url = request.nextUrl.clone(); url.pathname = '/login'",
    'headers: { Location: `${request.nextUrl.origin}/dashboard` }',
  ])('detecta: %s', (linea) => {
    expect(ORIGEN_DEL_REQUEST.some(([, re]) => re.test(linea))).toBe(true)
  })

  it.each([
    'const { searchParams } = request.nextUrl',
    "return localRedirect('/auth/confirm-email?error=invalid_link')",
    "const origin = request.headers.get('origin')",
    'const { searchParams } = new URL(request.url)',
  ])('deja pasar: %s', (linea) => {
    expect(ORIGEN_DEL_REQUEST.some(([, re]) => re.test(linea))).toBe(false)
  })
})
