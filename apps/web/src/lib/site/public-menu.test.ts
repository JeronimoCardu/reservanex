import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { formatPublicPrice, publicSiteTitle, publicSiteDescription } from './public-menu'

// Fase 3E-C3A2 — sitio público gastronómico.
//
// Acá va lo PURO (copy, precio) y el CABLEADO leído del fuente. Lo que toca la
// base —qué filas devuelve listPublicMenu— se prueba contra la DB real en
// validate:menu-catalog, no con mocks.

describe('Z. precio público', () => {
  it('0 se muestra como "Gratis"', () => {
    expect(formatPublicPrice(0, 'ARS')).toBe('Gratis')
  })

  it('cualquier otro monto lleva la moneda del tenant', () => {
    expect(formatPublicPrice(1500.5, 'ARS')).toBe('ARS 1.500,50')
    expect(formatPublicPrice(10000, 'ARS')).toBe('ARS 10.000,00')
  })

  it('Y. respeta la moneda que se le pase, no una fija', () => {
    expect(formatPublicPrice(1200, 'USD')).toBe('USD 1.200,00')
    expect(formatPublicPrice(1200, 'BRL')).toBe('BRL 1.200,00')
  })

  it('siempre dos decimales', () => {
    expect(formatPublicPrice(1500, 'ARS')).toBe('ARS 1.500,00')
    expect(formatPublicPrice(0.5, 'ARS')).toBe('ARS 0,50')
  })

  it('un precio distinto de 0 nunca dice "Gratis"', () => {
    expect(formatPublicPrice(0.01, 'ARS')).not.toBe('Gratis')
  })
})

describe('AC. título y descripción por rubro', () => {
  it('un restaurante NO dice "Propiedades"', () => {
    const t = publicSiteTitle('Gastronomía QA', 'food_service')
    expect(t).toBe('Gastronomía QA | Menú')
    expect(t).not.toContain('Propiedades')
  })

  it('una inmobiliaria conserva el título de siempre', () => {
    expect(publicSiteTitle('AutoResponder QA', 'real_estate')).toBe('AutoResponder QA | Propiedades')
  })

  it('la descripción por defecto también cambia por rubro', () => {
    expect(publicSiteDescription('X', 'food_service')).toBe('Carta de X')
    expect(publicSiteDescription('X', 'real_estate')).toBe('Propiedades de X')
  })
})

// ─── Cableado ────────────────────────────────────────────────────────────────

const SRC  = path.resolve(import.meta.dirname, '..', '..')
const leer = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8')

/**
 * El fuente sin comentarios.
 *
 * Varias de estas comprobaciones son "X no aparece", y los comentarios del
 * código dicen exactamente por qué X no se usa — o sea que contienen la palabra.
 * Mirar solo el código evita que documentar bien rompa el test.
 */
const soloCodigo = (fuente: string) =>
  fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const PAGE = () => leer('app', 'site', '[tenantSlug]', 'page.tsx')
const REPO = () => leer('lib', 'repositories', 'public-site.repository.ts')

describe('O/P. el sitio público ramifica por rubro', () => {
  it('P. food_service renderiza el menú', () => {
    const page = PAGE()
    expect(page).toContain("verticalDe(tenant.vertical) === 'food_service'")
    expect(page).toContain('<PublicMenuClient')
    expect(page).toContain('listPublicMenu(tenant.id)')
  })

  it('O. real_estate conserva EXACTAMENTE el catálogo anterior', () => {
    const page = PAGE()
    expect(page).toContain('<CatalogClient')
    expect(page).toContain('listPublicProperties(tenant.id)')
    // Los mismos cuatro props con los que se renderizaba antes.
    for (const prop of ['tenant={tenant}', 'properties={properties}', 'waPhone={waPhone}', 'tenantSlug={tenantSlug}']) {
      expect(page, prop).toContain(prop)
    }
  })

  it('el rubro se resuelve server-side desde tenants.vertical', () => {
    const page = soloCodigo(PAGE())
    expect(page).toContain('tenantVerticalSchema.safeParse')
    // El guard del dashboard NO se usa acá: no hay sesión en el sitio público.
    expect(page).not.toContain('requireRouteVertical')
    expect(page).not.toContain('requireTenantContext')
  })

  it('AB. public_site_enabled sigue siendo la misma puerta para los dos rubros', () => {
    const page = PAGE()
    // Una sola vez en el render y una en la metadata, ANTES de mirar el rubro.
    expect(page).toContain('if (!tenant || !tenant.public_site_enabled) notFound()')
    expect(page).toContain('if (!tenant || !tenant.public_site_enabled) return {}')
    const render = page.slice(page.indexOf('export default async function'))
    expect(render.indexOf('public_site_enabled')).toBeLessThan(render.indexOf("=== 'food_service'"))
  })

  it('AC. la metadata usa los helpers, no un título hardcodeado', () => {
    const page = PAGE()
    expect(page).toContain('publicSiteTitle(displayName, vertical)')
    expect(page).toContain('publicSiteDescription(displayName, vertical)')
  })
})

describe('AA. solo columnas públicas salen del repositorio', () => {
  const bloque = () => {
    const repo = REPO()
    return repo.slice(repo.indexOf('export async function listPublicMenu'))
  }

  it('el select de items es una lista literal, nunca *', () => {
    const b = bloque()
    expect(b).toContain("select('id, category_id, name, description, base_price, image_url, available, sort_order')")
    expect(b).not.toContain("select('*')")
  })

  it('image_storage_path NUNCA sale', () => {
    const b = soloCodigo(bloque())
    expect(b).not.toContain('image_storage_path')
    // Y el tipo público tampoco lo declara.
    const repo = REPO()
    const tipo = soloCodigo(repo.slice(repo.indexOf('export type PublicMenuItem'), repo.indexOf('export type PublicMenuCategory')))
    expect(tipo).not.toContain('storage_path')
    expect(tipo).toContain('image_url')
  })

  it('no salen campos internos ni de auditoría', () => {
    const repo  = REPO()
    // Solo las DECLARACIONES de los dos tipos públicos, sin la documentación de
    // listPublicMenu que nombra los filtros.
    const tipos = soloCodigo(
      repo.slice(repo.indexOf('export type PublicMenuItem'), repo.indexOf('export async function listPublicMenu')),
    )
    for (const interno of ['deleted_at', 'published', 'tenant_id', 'created_at', 'updated_at', 'sort_order']) {
      expect(tipos, interno).not.toContain(interno)
    }
  })

  it('la categoría solo expone id y nombre', () => {
    const repo = REPO()
    const tipo = soloCodigo(repo.slice(repo.indexOf('export type PublicMenuCategory'), repo.indexOf('export async function listPublicMenu')))
    expect(tipo).toContain('id')
    expect(tipo).toContain('name')
    expect(tipo).not.toContain('active')
    expect(tipo).not.toContain('tenant_id')
  })

  it('lee con el cliente admin en el servidor, sin abrir las tablas a anon', () => {
    const b = bloque()
    expect(b).toContain('createAdminClient()')
  })
})

describe('aislamiento multi-tenant de la lectura pública', () => {
  const bloque = () => {
    const repo = REPO()
    return soloCodigo(repo.slice(repo.indexOf('export async function listPublicMenu'),
      repo.indexOf('export async function getPublicTenantCurrency')))
  }

  // service_role SALTEA RLS. En esta función el aislamiento no lo garantiza la
  // base: lo garantizan estas dos líneas. Un test que las fije evita que alguien
  // borre una "por redundante" — que es exactamente lo que parece hasta que deja
  // de estar.
  it('las DOS consultas filtran por tenant_id', () => {
    const b = bloque()
    const filtros = b.match(/\.eq\('tenant_id', tenantId\)/g) ?? []
    expect(filtros.length, 'una por cada tabla: menu_categories y menu_items').toBe(2)
  })

  it('el filtro por categoría NO reemplaza al de tenant en los items', () => {
    const b = bloque()
    const items = b.slice(b.indexOf(".from('menu_items')"))
    // Las dos condiciones sobre la misma consulta: cualquiera sola alcanzaría,
    // y por eso justamente conviene que estén las dos.
    expect(items).toContain(".eq('tenant_id', tenantId)")
    expect(items).toContain(".in('category_id', cats.map((c) => c.id))")
  })

  it('la lista de categorías con la que se filtran los items ya viene scopeada', () => {
    const b = bloque()
    const cats = b.slice(b.indexOf(".from('menu_categories')"), b.indexOf(".from('menu_items')"))
    expect(cats).toContain(".eq('tenant_id', tenantId)")
    expect(cats).toContain(".eq('active', true)")
  })

  it('el agrupado final solo lee las categorías del tenant pedido', () => {
    const b = bloque()
    // Se recorre `cats` (ya scopeada) y se buscan sus items; un item ajeno no
    // tendría dónde caer aunque llegara. Es la tercera capa, por construcción.
    expect(b).toContain('porCategoria.get(c.id)')
    expect(b).toContain('return cats')
  })

  it('la moneda se consulta por el id del tenant pedido', () => {
    const repo = REPO()
    const moneda = soloCodigo(repo.slice(repo.indexOf('export async function getPublicTenantCurrency')))
    expect(moneda).toContain(".eq('id', tenantId)")
    expect(moneda).toContain('maybeSingle()')
  })
})

describe('Q–X. los filtros de la carta pública están en el repositorio', () => {
  const bloque = () => {
    const repo = REPO()
    return repo.slice(repo.indexOf('export async function listPublicMenu'))
  }

  it('R. categoría inactiva no se consulta', () => {
    expect(bloque()).toContain(".eq('active', true)")
  })

  it('S. borradores no se consultan', () => {
    expect(bloque()).toContain(".eq('published', true)")
  })

  it('T. archivados no se consultan', () => {
    expect(bloque()).toContain(".is('deleted_at', null)")
  })

  it('U. available NO se filtra: los no disponibles se muestran', () => {
    const b = soloCodigo(bloque())
    expect(b).not.toContain(".eq('available', true)")
    expect(b).not.toContain(".eq('available', false)")
  })

  it('V/W. el orden es category.sort_order → item.sort_order', () => {
    const b = bloque()
    const ordenes = b.match(/\.order\('sort_order', \{ ascending: true \}\)/g) ?? []
    expect(ordenes.length).toBe(2)
  })

  it('X. las categorías sin items visibles no se devuelven', () => {
    expect(bloque()).toContain('.filter((c) => c.items.length > 0)')
  })
})

describe('la carta pública no adelanta el carrito', () => {
  it('no hay cantidades ni botón de agregar', () => {
    const client = soloCodigo(leer('components', 'site', 'public-menu-client.tsx')).toLowerCase()
    for (const prohibido of ['agregar', 'carrito', 'cantidad', 'quantity', 'addtocart']) {
      expect(client, prohibido).not.toContain(prohibido)
    }
  })

  it('U. un item no disponible se muestra atenuado y con su precio', () => {
    const client = leer('components', 'site', 'public-menu-client.tsx')
    expect(client).toContain("item.available ? '' : 'opacity-60'")
    expect(client).toContain('No disponible')
    // El precio se renderiza sin condicionar por disponibilidad.
    expect(client).toContain('{formatPublicPrice(item.base_price, currency)}')
  })

  it('las imágenes declaran sizes y proporción fija', () => {
    const client = leer('components', 'site', 'public-menu-client.tsx')
    expect(client).toContain('sizes=')
    expect(client).toContain('object-cover')
    // El placeholder usa el mismo marco, así no hay salto de layout.
    expect(client).toContain('const marco =')
  })
})
