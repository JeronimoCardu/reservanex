import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { getCustomerSiteBaseUrl, customerSiteUrl, isCustomerReachable, PUBLIC_PATHS } from './customer-site-url'

// ════════════════════════════════════════════════════════════════════════════
// Seguridad de URL en mensajes al cliente.
//
// Un cliente real recibió por WhatsApp http://localhost:3001/site/... porque
// el worker armaba links con NEXT_PUBLIC_SITE_URL — el origen del navegador
// de quien desarrolla. Este módulo es el único que decide la base de un link
// que sale hacia un cliente, y su regla dura es: localhost NUNCA.
// ════════════════════════════════════════════════════════════════════════════

const env = (o: Record<string, string | undefined>) => o as NodeJS.ProcessEnv

describe('isCustomerReachable', () => {
  it('rechaza loopback en todas sus formas', () => {
    for (const u of [
      'http://localhost:3001', 'https://localhost', 'http://127.0.0.1:3001', 'http://0.0.0.0:3001',
      'http://[::1]:3001', 'http://miapp.local', 'http://dev.localhost:3001',
    ]) expect(isCustomerReachable(u), u).toBe(false)
  })

  it('acepta http(s) públicos', () => {
    for (const u of ['https://reservanex.com', 'https://abc.ngrok-free.app', 'http://192.168.0.10:3001']) {
      expect(isCustomerReachable(u), u).toBe(true)
    }
  })

  it('rechaza lo que no es una URL http(s)', () => {
    for (const u of ['', 'reservanex.com', 'ftp://x', 'javascript:alert(1)']) expect(isCustomerReachable(u), u).toBe(false)
  })
})

describe('4. producción', () => {
  it('sin nada configurado → https://reservanex.com', () => {
    expect(getCustomerSiteBaseUrl(env({}))).toBe('https://reservanex.com')
    expect(customerSiteUrl(PUBLIC_PATHS.site('resto'), env({}))).toBe('https://reservanex.com/site/resto')
  })

  it('con SITE_URL de producción → esa', () => {
    expect(getCustomerSiteBaseUrl(env({ SITE_URL: 'https://reservanex.com/' }))).toBe('https://reservanex.com')
  })
})

describe('3. desarrollo físico', () => {
  it('NEXT_PUBLIC_SITE_URL=localhost (el caso real) → NO HAY LINK, no localhost', () => {
    const e = env({ NEXT_PUBLIC_SITE_URL: 'http://localhost:3001' })
    expect(getCustomerSiteBaseUrl(e)).toBeNull()
    expect(customerSiteUrl(PUBLIC_PATHS.site('resto'), e)).toBeNull()
  })

  it('CUSTOMER_SITE_BASE_URL con el túnel gana sobre NEXT_PUBLIC_SITE_URL=localhost', () => {
    const e = env({
      NEXT_PUBLIC_SITE_URL: 'http://localhost:3001',
      CUSTOMER_SITE_BASE_URL: 'https://abc123.ngrok-free.app/',
    })
    expect(getCustomerSiteBaseUrl(e)).toBe('https://abc123.ngrok-free.app')
    expect(customerSiteUrl(PUBLIC_PATHS.tableReservation('resto'), e))
      .toBe('https://abc123.ngrok-free.app/site/resto/formulario/table_reservation')
  })

  it('CUSTOMER_SITE_BASE_URL mal configurada en localhost tampoco pasa', () => {
    expect(getCustomerSiteBaseUrl(env({ CUSTOMER_SITE_BASE_URL: 'http://localhost:3001' }))).toBeNull()
  })

  it('la base del webhook Android NO se reutiliza implícitamente', () => {
    // Son orígenes distintos: si sólo está configurada la del webhook, los
    // links al cliente siguen sin base — hay que declararla explícita.
    const e = env({ NEXT_PUBLIC_SITE_URL: 'http://localhost:3001', AUTORESPONDER_PUBLIC_BASE_URL: 'https://tunel.ngrok-free.app' })
    expect(getCustomerSiteBaseUrl(e)).toBeNull()
  })
})

describe('rutas públicas', () => {
  it('son las mismas que sirve la app web', () => {
    expect(PUBLIC_PATHS.site('r')).toBe('/site/r')
    expect(PUBLIC_PATHS.property('r', 'p')).toBe('/site/r/properties/p')
    expect(PUBLIC_PATHS.tableReservation('r')).toBe('/site/r/formulario/table_reservation')
  })

  it('el formulario de mesa existe en la app web', () => {
    const page = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'web', 'src', 'app', 'site', '[tenantSlug]', 'formulario', '[intent]', 'page.tsx'), 'utf8')
    expect(page).toContain("'table_reservation'")
  })
})

describe('7. ningún link outbound se arma fuera de este módulo', () => {
  const src = path.resolve(import.meta.dirname, '..')
  const archivos = ['context/responder.ts', 'tools/send-property-link.ts', 'tools/send-public-catalog-link.ts', 'tools/send-table-reservation-link.ts']

  it.each(archivos)('%s no lee NEXT_PUBLIC_SITE_URL ni SITE_URL directamente', (f) => {
    const codigo = fs.readFileSync(path.join(src, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(codigo).not.toMatch(/process\.env\.(NEXT_PUBLIC_SITE_URL|SITE_URL)/)
    expect(codigo).toMatch(/customerSiteUrl|customer-site-url/)
  })
})
