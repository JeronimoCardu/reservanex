import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  formIntentSchema,
  intentsForVertical,
  isIntentAllowedForVertical,
} from '@orderflow/validators'

// ════════════════════════════════════════════════════════════════════════════
// Cierre food_service — las puertas de entrada del sitio público.
//
// La auditoría transversal encontró tres cosas en esta superficie:
//
//   · /formulario/food_order renderizaba un formulario que fallaba con 422
//     SIEMPRE (DynamicForm no puede producir `items`), y el error caía bajo una
//     clave que no era un campo dibujado: "Revisá los campos marcados" sin nada
//     marcado;
//   · table_reservation y general_inquiry no tenían NINGÚN link entrante —dos
//     de los tres intents del rubro sólo eran alcanzables tecleando la URL—;
//   · el header decía "Propiedades" y apuntaba a #properties también en la
//     carta de un restaurante, donde esa ancla no existe.
//
// El repo no tiene entorno DOM (vitest en 'node'), así que lo que es puro se
// prueba puro y lo que es de React se fija con aserciones estructurales sobre
// el fuente — el mismo criterio que filters.test.ts.
// ════════════════════════════════════════════════════════════════════════════

const SRC  = path.resolve(import.meta.dirname, '..', '..')
const RAIZ = path.resolve(SRC, '..', '..', '..')
const leer = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8')

/** El fuente sin comentarios: que una regla esté EXPLICADA no la implementa. */
function soloCodigo(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

const PAGINA_FORM = ['app', 'site', '[tenantSlug]', 'formulario', '[intent]', 'page.tsx'] as const
const MENU_PUB    = ['components', 'site', 'public-menu-client.tsx'] as const
const HEADER      = ['components', 'site', 'public-site-header.tsx'] as const

// ── El formulario genérico ──────────────────────────────────────────────────

describe('/site/[slug]/formulario/[intent]', () => {
  const fuente = leer(...PAGINA_FORM)
  const codigo = soloCodigo(fuente)

  it('1. food_order redirige al catálogo en vez de renderizar un formulario', () => {
    expect(codigo).toContain("if (parsedIntent.data === 'food_order') redirect(`/site/${tenantSlug}`)")
    expect(codigo).toContain("import { notFound, redirect } from 'next/navigation'")
  })

  it('1b. el redirect es SERVER-SIDE: no hay router del cliente en esta página', () => {
    expect(fuente).not.toContain("'use client'")
    expect(codigo).not.toContain('useRouter')
    expect(codigo).not.toContain('router.replace')
  })

  it('1c. es temporal, no permanente: un 308 se cachea para siempre', () => {
    expect(codigo).not.toContain('permanentRedirect')
  })

  it('2. food_order nunca llega a DynamicForm', () => {
    // El redirect tiene que estar ANTES del render, si no no sirve de nada.
    const posRedirect = codigo.indexOf("=== 'food_order'")
    const posForm     = codigo.indexOf('<DynamicForm')
    expect(posRedirect).toBeGreaterThan(-1)
    expect(posForm).toBeGreaterThan(-1)
    expect(posRedirect).toBeLessThan(posForm)
  })

  it('2b. y llega DESPUÉS del guard de vertical: food_order en una inmobiliaria sigue siendo 404', () => {
    // Si el redirect se adelantara al guard, /formulario/food_order en un
    // tenant real_estate mandaría al visitante a un catálogo de propiedades
    // como si el pedido fuera posible. Falla cerrado: 404.
    const posGuard    = codigo.indexOf('isIntentAllowedForVertical')
    const posRedirect = codigo.indexOf("=== 'food_order'")
    expect(posGuard).toBeGreaterThan(-1)
    expect(posGuard).toBeLessThan(posRedirect)
    expect(isIntentAllowedForVertical('food_order', 'real_estate')).toBe(false)
  })

  it('3 y 4. table_reservation y general_inquiry siguen renderizables', () => {
    // Los dos siguen terminando en <DynamicForm>.
    //
    // Lo que cambió con el onboarding multi-tipo: table_reservation ahora
    // TAMBIÉN puede cerrarse, cuando el local apagó las reservas de mesa. Eso
    // no lo vuelve irrenderizable — lo vuelve condicional, y la condición es
    // una capacidad del tenant, no del intent.
    for (const intent of ['table_reservation', 'general_inquiry'] as const) {
      expect(formIntentSchema.safeParse(intent).success).toBe(true)
      expect(isIntentAllowedForVertical(intent, 'food_service')).toBe(true)
    }

    // general_inquiry no tiene NINGUNA condición: siempre se renderiza.
    expect(codigo).not.toContain("=== 'general_inquiry'")

    // table_reservation sólo puede cerrarse por capacidad, nunca redirigir.
    expect(codigo).toContain("parsedIntent.data === 'table_reservation' && !caps.tableReservations) notFound()")
    expect(codigo).not.toMatch(/table_reservation[^\n]*redirect\(/)

    expect(codigo).toContain('<DynamicForm')
  })

  it('4b. food_order es el único que REDIRIGE; table_reservation sólo se cierra', () => {
    // Dos tratamientos especiales, y son de naturaleza distinta: uno manda a
    // otro lado porque el pedido SÍ se puede hacer (por el carrito), el otro
    // devuelve 404 porque ese trámite no existe en este local.
    const especiales = [...codigo.matchAll(/parsedIntent\.data === '(\w+)'/g)].map((m) => m[1])
    expect(especiales).toEqual(['food_order', 'table_reservation'])

    // Y el orden importa: primero el redirect del pedido, después la capacidad.
    expect(codigo.indexOf("=== 'food_order'"))
      .toBeLessThan(codigo.indexOf("=== 'table_reservation'"))
  })

  it('4c. real_estate no cambió: sus cuatro intents siguen permitidos', () => {
    const inmo = intentsForVertical('real_estate')
    expect(inmo.length).toBe(4)
    for (const i of inmo) expect(isIntentAllowedForVertical(i, 'real_estate')).toBe(true)
  })
})

// ── Las entradas del sitio gastronómico ─────────────────────────────────────

describe('carta pública', () => {
  const fuente = leer(...MENU_PUB)
  const codigo = soloCodigo(fuente)

  it('5. ofrece "Reservar mesa", y apunta al formulario real', () => {
    expect(codigo).toContain('Reservar mesa')
    expect(codigo).toContain('`/site/${tenantSlug}/formulario/table_reservation`')
  })

  it('6. ofrece "Hacer una consulta", y apunta al formulario real', () => {
    expect(codigo).toContain('Hacer una consulta')
    expect(codigo).toContain('`/site/${tenantSlug}/formulario/general_inquiry`')
  })

  it('6b. son links de verdad: abrir en pestaña nueva y back funcionan', () => {
    expect(codigo).toContain("import Link from 'next/link'")
    // Y no se navega a mano desde un onClick.
    expect(codigo).not.toContain('router.push')
  })

  it('6c. mantienen el foco visible para teclado', () => {
    expect(codigo).toContain('focus-visible:ring-2')
  })

  it('6d. no compiten con el carrito: van en la portada, no en la barra inferior', () => {
    const posCta     = codigo.indexOf('Reservar mesa')
    const posCarrito = codigo.indexOf('sticky bottom-0')
    expect(posCta).toBeGreaterThan(-1)
    expect(posCarrito).toBeGreaterThan(-1)
    expect(posCta).toBeLessThan(posCarrito)
  })

  it('10. existe el ancla #menu a la que enlaza el header', () => {
    expect(codigo).toContain('id="menu"')
  })
})

// ── Ningún camino público hacia el formulario de pedido ─────────────────────

describe('7. nada apunta a /formulario/food_order', () => {
  it('ni un link, ni un CTA, ni una redirección, en todo el código productivo', () => {
    // Búsqueda global sobre lo VERSIONADO, no sólo sobre los archivos que este
    // test ya conoce: si mañana alguien agrega el link en otro componente, o en
    // el worker, o en el marketing, esto lo tiene que ver igual.
    const versionados = execFileSync('git', ['ls-files'], { cwd: RAIZ, encoding: 'utf8' })
      .split('\n')
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => !f.endsWith('public-entrypoints.test.ts'))

    // Sobre el CÓDIGO, no sobre la prosa: varios comentarios nombran esa ruta
    // justamente para explicar por qué NO se enlaza. Un comentario no navega a
    // ningún lado; lo que se busca es un href, un redirect o un string vivo.
    const culpables: string[] = []
    for (const archivo of versionados) {
      const texto = soloCodigo(fs.readFileSync(path.join(RAIZ, archivo), 'utf8'))
      if (texto.includes('formulario/food_order')) culpables.push(archivo)
    }
    expect(culpables, `apuntan al formulario de pedido: ${culpables.join(', ')}`).toEqual([])
  })
})

// ── El header, que es de los dos rubros ─────────────────────────────────────

describe('PublicSiteHeader', () => {
  const codigo = soloCodigo(leer(...HEADER))

  it('8. en food_service no dice "Propiedades" ni enlaza #properties', () => {
    // Las dos palabras existen en el archivo —es un componente compartido— pero
    // SÓLO dentro del ternario que las elige por rubro. Lo que se prueba es que
    // no haya ninguna suelta fuera de esa decisión.
    expect(codigo).toContain("const esGastronomico = tenant.vertical === 'food_service'")
    expect(codigo).toContain("esGastronomico ? 'Menú'  : 'Propiedades'")
    expect(codigo).toContain("esGastronomico ? '#menu' : '#properties'")

    // Ni una ocurrencia fuera del ternario: ni en JSX, ni en un href literal.
    expect(codigo).not.toContain('>Propiedades<')
    expect(codigo).not.toContain('href="#properties"')
    expect(codigo.match(/Propiedades/g) ?? []).toHaveLength(1)
  })

  it('8b. el texto de WhatsApp tampoco ofrece propiedades a quien mira una carta', () => {
    // Éste era el segundo escape de copy inmobiliario, en el CTA verde.
    expect(codigo).toContain('Hola, quiero hacer una consulta sobre ${name}.')
    expect(codigo).toContain('esGastronomico')
    const posTernario = codigo.indexOf('esGastronomico')
    const posTexto    = codigo.indexOf('información de propiedades')
    expect(posTexto).toBeGreaterThan(posTernario)
  })

  it('9. real_estate conserva "Propiedades" y su ancla', () => {
    expect(codigo).toContain("'Propiedades'")
    expect(codigo).toContain("'#properties'")
  })

  it('9b. el catálogo inmobiliario sigue teniendo el ancla #properties', () => {
    expect(soloCodigo(leer('components', 'site', 'catalog-client.tsx'))).toContain('id="properties"')
  })

  it('10b. las dos mitades del contrato nav↔ancla existen', () => {
    // El header promete dos destinos; los dos tienen que existir del otro lado.
    const destinos = [
      { ancla: 'id="menu"',       archivo: leer(...MENU_PUB) },
      { ancla: 'id="properties"', archivo: leer('components', 'site', 'catalog-client.tsx') },
    ]
    for (const d of destinos) expect(soloCodigo(d.archivo)).toContain(d.ancla)
  })

  it('no hace falta tocar a los llamadores: el rubro ya viaja en el tenant', () => {
    // PublicTenant.vertical ya se seleccionaba en getPublicTenant. Si alguien
    // lo convierte en una prop nueva, los tres llamadores tienen que pasarla y
    // este test avisa antes de que uno quede sin pasarla y vuelva al default.
    expect(codigo).toContain('tenant.vertical')
    expect(codigo).not.toContain('vertical:    TenantVertical')
  })
})
