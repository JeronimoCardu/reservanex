import { describe, expect, it } from 'vitest'
import {
  foodCapabilitiesFromTenant,
  isFoodService,
  identityLine,
  buildFoodDomainSection,
  foodNameRule,
  foodLinksRule,
} from './food-domain'

// ════════════════════════════════════════════════════════════════════════════
// El dominio gastronómico del responder, derivado de las capacidades reales.
//
// El bug: a "¿hacen delivery?" el bot contestaba "gestionamos exclusivamente
// consultas sobre propiedades… no ofrecemos delivery" a un restaurante con
// delivery_enabled = true, porque el prompt era inmobiliario sin mirar el
// vertical. Y después, con 0 productos publicados, ofrecía "la carta con todos
// los platos y precios". Estos tests fijan lo que el prompt le dice al modelo
// en cada combinación — sin LLM, sin red.
// ════════════════════════════════════════════════════════════════════════════

const food = (d: boolean, t: boolean, r: boolean) => ({
  vertical: 'food_service', delivery_enabled: d, takeaway_enabled: t, table_reservations_enabled: r,
})
const URL = 'https://reservanex.com/site/restaurante-prueba'

/** Con carta publicada (5 productos) salvo que se diga otra cosa. */
const seccion = (d: boolean, t: boolean, r: boolean, links = true, productos = 5, url: string | null = URL) =>
  buildFoodDomainSection({
    caps: foodCapabilitiesFromTenant(food(d, t, r)), publicCatalogUrl: url, canSendLinks: links,
    publishedMenuItemCount: productos,
  })

const INMOBILIARIO = /propiedad|inmobiliaria|alquiler|venta|estad[ií]a|visita/i

describe('capacidades desde la fila del tenant', () => {
  it('un tenant food_service lee sus tres capacidades', () => {
    expect(foodCapabilitiesFromTenant(food(true, false, true))).toEqual({ delivery: true, takeaway: false, tableReservations: true })
    expect(isFoodService(food(true, true, true))).toBe(true)
  })

  it('un tenant real_estate NO es gastronómico y tiene todo en false: no hay fallback cruzado', () => {
    const inmo = { vertical: 'real_estate', delivery_enabled: true, takeaway_enabled: true, table_reservations_enabled: true }
    expect(isFoodService(inmo)).toBe(false)
    expect(foodCapabilitiesFromTenant(inmo)).toEqual({ delivery: false, takeaway: false, tableReservations: false })
  })

  it('sin vertical (fila vacía) NO se asume gastronomía', () => {
    expect(isFoodService({})).toBe(false)
    expect(isFoodService({ vertical: null })).toBe(false)
  })
})

describe('identidad', () => {
  it('gastronomía: atiende el WhatsApp de un negocio gastronómico, no representa a una inmobiliaria', () => {
    const l = identityLine('Asistente', 'Restaurante Prueba', true)
    expect(l).toContain('negocio gastronómico "Restaurante Prueba"')
    expect(l).not.toMatch(/inmobiliaria/i)
  })

  it('7. real_estate conserva la identidad inmobiliaria exacta de siempre', () => {
    expect(identityLine('Asistente', 'Inmo X', false))
      .toBe('Tu nombre es Asistente. Representás a la inmobiliaria "Inmo X".')
  })
})

describe('delivery / retiro', () => {
  it('delivery=true — "¿hacen delivery?": el prompt afirma que SÍ hay delivery', () => {
    const s = seccion(true, true, true)
    expect(s).toMatch(/PEDIDOS: SÍ/)
    expect(s).toMatch(/Si preguntan por delivery: confirmá que SÍ hay delivery/)
  })

  it('y prohíbe hablar de propiedades, venta o alquiler', () => {
    const s = seccion(true, true, true)
    expect(s).toMatch(/NO es una inmobiliaria/)
    const sinProhibicion = s.replace(/NO es una inmobiliaria[^\n]*\n/, '')
    expect(sinProhibicion).not.toMatch(INMOBILIARIO)
  })

  it('delivery=false con retiro: NO hay delivery, ofrece retiro', () => {
    const s = seccion(false, true, true)
    expect(s).toMatch(/Si preguntan por delivery: NO hay delivery\. Ofrecé retiro en el local/)
    expect(s).not.toMatch(/confirmá que SÍ hay delivery/)
  })

  it('sin delivery ni retiro: no se toman pedidos, pero la carta sigue', () => {
    const s = seccion(false, false, true)
    expect(s).toMatch(/PEDIDOS: NO\. Este local no toma pedidos por este canal/)
    expect(s).toMatch(/ofrecé la carta para consultar/)
  })

  it('takeaway=true — "¿puedo retirar?": afirma que se puede', () => {
    expect(seccion(true, true, true)).toMatch(/Si preguntan por retirar[^\n]*confirmá que SÍ se puede retirar/)
  })

  it('takeaway=false con delivery: NO hay retiro, ofrece delivery', () => {
    expect(seccion(true, false, true)).toMatch(/Si preguntan por retirar: NO hay retiro en el local\. Ofrecé delivery/)
  })
})

// ── 1 y 2. La carta: sólo si existe ─────────────────────────────────────────

describe('1 y 2. menú vacío vs. carta publicada', () => {
  it('1. con 0 productos: NO afirma que haya platos ni precios y NO ofrece la carta', () => {
    const s = seccion(true, true, true, true, 0)
    expect(s).toMatch(/la carta TODAVÍA NO TIENE productos publicados/)
    expect(s).toMatch(/NUNCA digas que hay platos, productos o precios disponibles/)
    expect(s).toMatch(/NO llames send_public_catalog_link: no hay nada que mostrar/)
    expect(s).not.toContain(`send_public_catalog_link (${URL})`)
    expect(s).toMatch(/derivar a una persona/)
  })

  it('2. con carta publicada y links: manda a la carta real para menú y precios', () => {
    const s = seccion(true, true, true, true, 5)
    expect(s).toMatch(/la carta tiene 5 productos publicados/)
    expect(s).toContain(`send_public_catalog_link (${URL})`)
  })

  it('2. singular correcto', () => {
    expect(seccion(true, true, true, true, 1)).toMatch(/la carta tiene 1 producto publicado,/)
  })

  it('con carta pero sin URL alcanzable: no manda link, deriva — nunca localhost', () => {
    const s = seccion(true, true, true, true, 5, null)
    expect(s).toMatch(/No podés mandar la carta ahora/)
    expect(s).not.toContain('send_public_catalog_link (')
    expect(s).not.toMatch(/localhost/)
  })

  it('en ningún caso inventa: la prohibición está siempre', () => {
    for (const n of [0, 1, 5]) {
      expect(seccion(true, true, true, true, n), `n=${n}`).toMatch(/NUNCA inventes productos, platos, promociones ni precios|NUNCA digas que hay platos/)
    }
    expect(seccion(true, true, true)).toMatch(/horarios, zonas de entrega, costos de envío, tiempos de demora y medios de pago no están cargados/)
  })
})

// ── 5 y 6. Reserva de mesa: por formulario, la confirma el negocio ──────────

describe('5 y 6. reserva de mesa', () => {
  it('5. R=true: por formulario con el tool específico, sin tomar datos por chat', () => {
    const s = seccion(true, true, true)
    expect(s).toMatch(/RESERVAS DE MESA: SÍ, por formulario/)
    expect(s).toMatch(/NO tomás fecha, hora ni personas por este chat/)
    expect(s).toMatch(/llamá send_table_reservation_link/)
    expect(s).toMatch(/No pidas los datos vos/)
  })

  it('6. confirmación del cliente ≠ confirmación del negocio', () => {
    const s = seccion(true, true, true)
    expect(s).toMatch(/NUNCA digas que la reserva está confirmada, tomada ni asegurada/)
    expect(s).toMatch(/La confirma el local después/)
    expect(s).toMatch(/SUB-XXXXXX[^\n]*el sistema la resume y le pide confirmar/)
  })

  it('R=true sin links: no manda formulario, deriva a persona', () => {
    const s = seccion(true, true, true, false)
    expect(s).toMatch(/No podés mandar el formulario ahora: derivá a una persona/)
    expect(s).not.toMatch(/send_table_reservation_link/)
  })

  it('8. R=false: no ofrece reserva ni el tool', () => {
    const s = seccion(true, true, false)
    expect(s).toMatch(/RESERVAS DE MESA: NO/)
    expect(s).not.toMatch(/send_table_reservation_link/)
  })
})

describe('las 8 combinaciones D/T/R producen un bloque coherente', () => {
  it.each([
    [true,  true,  true ], [true,  false, true ], [false, true,  true ], [false, false, true ],
    [true,  true,  false], [true,  false, false], [false, true,  false], [false, false, false],
  ])('D=%s T=%s R=%s', (d, t, r) => {
    const s = seccion(d, t, r)
    expect(s).toMatch(d || t ? /PEDIDOS: SÍ/ : /PEDIDOS: NO/)
    expect(s).toMatch(r ? /RESERVAS DE MESA: SÍ/ : /RESERVAS DE MESA: NO/)
    expect(s).toMatch(/NO es una inmobiliaria/)
  })
})

// ── 3. Nombre y links ───────────────────────────────────────────────────────

describe('3. captura de nombre — sólo para operaciones con seguimiento', () => {
  it('pide el nombre para pedido, reserva o contacto; NO por una consulta genérica', () => {
    const r = foodNameRule()
    expect(r).toMatch(/quiere hacer un pedido, quiere reservar mesa, o pide que alguien lo contacte/)
    expect(r).toMatch(/NO pidas el nombre por una consulta genérica \(qué platos hay, si hacen delivery/)
    expect(r).not.toMatch(/pide la carta/)
    expect(r).not.toMatch(INMOBILIARIO)
    expect(r).toMatch(/save_contact_name/)
  })

  it('la regla de links sólo conoce la carta', () => {
    const r = foodLinksRule(true, URL)
    expect(r).toContain(`send_public_catalog_link: envía la carta del local (${URL})`)
    expect(r).not.toMatch(/send_property_link|propiedad/)
    expect(foodLinksRule(false, URL)).toMatch(/No podés enviar links/)
  })
})
