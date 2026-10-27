import { describe, expect, it } from 'vitest'
import { NextResponse } from 'next/server'
import { localRedirect } from './local-redirect'

describe('localRedirect', () => {
  it.each([
    '/auth/confirm-email?error=invalid_link',
    '/auth/accept-invite',
    '/auth/reset-password',
    '/dashboard',
  ] as const)('%s → 307 con ese mismo Location relativo y sin cuerpo', async (path) => {
    const res = localRedirect(path)
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(path)
    expect(await res.text()).toBe('')
  })

  it.each([
    ['//evil.example/x', 'protocol-relative'],
    ['/\\evil.example/x', 'el navegador toma la barra invertida como /'],
    ['/\t/evil.example/x', 'el parser de URL descarta el tab y queda //'],
    ['/\n/evil.example/x', 'el parser de URL descarta el salto de línea y queda //'],
  ])('rechaza %j: %s', (path) => {
    expect(() => localRedirect(path as `/${string}`)).toThrow(/destino fuera del sitio/)
  })

  it.each(['https://evil.example/x', 'dashboard', '?error=invalid_link', ''])(
    'rechaza lo que no es una ruta de este sitio: %j',
    (path) => {
      expect(() => localRedirect(path as `/${string}`)).toThrow(/destino fuera del sitio/)
    },
  )

  it('NextResponse.redirect() sí exige una URL absoluta: por eso existe este helper', () => {
    expect(() => NextResponse.redirect('/dashboard')).toThrow(/absolute/)
  })
})
