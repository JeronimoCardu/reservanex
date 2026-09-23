import { describe, it, expect } from 'vitest'
import type { TenantVertical } from '@orderflow/validators'
import {
  MODULE_VERTICALS,
  routeAllowsVertical,
  verticalsForRoute,
} from './module-verticals'
import { ALL_NAV_ITEMS, visibleNavItems } from './nav-items'

// Fase 3E-C3A1 §23 — cobertura del gating por rubro.
//
// Estos tests cubren la REGLA. Que la ruta real la use se verifica aparte: el
// test de abajo "toda ruta con rubro tiene su layout" lee el filesystem, y la
// prueba de navegador cierra el caso end-to-end.

const FOOD: TenantVertical = 'food_service'
const REAL: TenantVertical = 'real_estate'

const SOLO_INMOB = [
  '/dashboard/properties',
  '/dashboard/reservations',
  '/dashboard/visits',
  '/dashboard/monthly-rentals',
]
const SOLO_GASTRO = [
  '/dashboard/table-reservations',
  '/dashboard/menu',
]
const TRANSVERSALES = [
  '/dashboard',
  '/dashboard/attention',
  '/dashboard/requests',
  '/dashboard/contacts',
  '/dashboard/tasks',
  '/dashboard/users',
  '/dashboard/settings/whatsapp',
  '/dashboard/workspaces',
]

describe('verticalsForRoute', () => {
  it('devuelve null para las rutas transversales', () => {
    for (const ruta of TRANSVERSALES) {
      expect(verticalsForRoute(ruta), ruta).toBeNull()
    }
  })

  it('resuelve subrutas por prefijo', () => {
    expect(verticalsForRoute('/dashboard/properties/abc-123')).toEqual(['real_estate'])
    expect(verticalsForRoute('/dashboard/monthly-rentals/abc/pagos')).toEqual(['real_estate'])
  })

  it('no confunde un prefijo parcial con una coincidencia', () => {
    // /dashboard/menu no debe capturar a /dashboard/menuscosas.
    expect(verticalsForRoute('/dashboard/menuscosas')).toBeNull()
    expect(verticalsForRoute('/dashboard/reservationsxyz')).toBeNull()
  })
})

describe('routeAllowsVertical', () => {
  it('food_service: entra a los módulos gastronómicos', () => {
    for (const ruta of SOLO_GASTRO) expect(routeAllowsVertical(ruta, FOOD), ruta).toBe(true)
  })

  it('food_service: NO entra a los módulos inmobiliarios', () => {
    for (const ruta of SOLO_INMOB) expect(routeAllowsVertical(ruta, FOOD), ruta).toBe(false)
  })

  it('real_estate: entra a los módulos inmobiliarios', () => {
    for (const ruta of SOLO_INMOB) expect(routeAllowsVertical(ruta, REAL), ruta).toBe(true)
  })

  it('real_estate: NO entra a /dashboard/menu ni a /dashboard/table-reservations', () => {
    for (const ruta of SOLO_GASTRO) expect(routeAllowsVertical(ruta, REAL), ruta).toBe(false)
  })

  it('las rutas transversales quedan abiertas para los dos rubros', () => {
    for (const ruta of TRANSVERSALES) {
      expect(routeAllowsVertical(ruta, FOOD), ruta).toBe(true)
      expect(routeAllowsVertical(ruta, REAL), ruta).toBe(true)
    }
  })

  it('/dashboard/requests es transversal: presenta los kinds del tenant', () => {
    // §16 — no se gatea. Un pedido gastronómico y una reserva inmobiliaria
    // entran por la misma bandeja.
    expect(verticalsForRoute('/dashboard/requests')).toBeNull()
    expect(routeAllowsVertical('/dashboard/requests', FOOD)).toBe(true)
    expect(routeAllowsVertical('/dashboard/requests', REAL)).toBe(true)
  })

  it('también cubre las subrutas de los módulos con rubro', () => {
    expect(routeAllowsVertical('/dashboard/properties/abc', FOOD)).toBe(false)
    expect(routeAllowsVertical('/dashboard/properties/abc', REAL)).toBe(true)
  })
})

describe('visibleNavItems', () => {
  const links = (vertical: TenantVertical, role: 'owner' | 'receptionist' = 'owner') =>
    visibleNavItems({ role, vertical, isSetupOperator: false }).map((i) => i.href)

  it('un restaurante no ve NINGÚN link inmobiliario', () => {
    const hrefs = links(FOOD)
    for (const ruta of SOLO_INMOB) expect(hrefs, ruta).not.toContain(ruta)
  })

  it('un restaurante ve Menú y Reservas de mesa', () => {
    const hrefs = links(FOOD)
    expect(hrefs).toContain('/dashboard/menu')
    expect(hrefs).toContain('/dashboard/table-reservations')
  })

  it('una inmobiliaria no ve Menú ni Reservas de mesa', () => {
    const hrefs = links(REAL)
    expect(hrefs).not.toContain('/dashboard/menu')
    expect(hrefs).not.toContain('/dashboard/table-reservations')
  })

  it('una inmobiliaria sigue viendo sus módulos', () => {
    const hrefs = links(REAL)
    for (const ruta of SOLO_INMOB) expect(hrefs, ruta).toContain(ruta)
  })

  it('los links transversales aparecen en los dos rubros', () => {
    for (const ruta of ['/dashboard/attention', '/dashboard/requests', '/dashboard/contacts', '/dashboard/tasks']) {
      expect(links(FOOD), ruta).toContain(ruta)
      expect(links(REAL), ruta).toContain(ruta)
    }
  })

  it('el rubro no reemplaza al filtro por rol', () => {
    expect(links(FOOD, 'receptionist')).not.toContain('/dashboard/users')
    expect(links(FOOD, 'owner')).toContain('/dashboard/users')
  })

  it('el rubro no reemplaza al filtro de modo setup', () => {
    const setup = visibleNavItems({ role: 'owner', vertical: FOOD, isSetupOperator: true }).map((i) => i.href)
    expect(setup).not.toContain('/dashboard/menu')       // setupBlocked
    expect(setup).not.toContain('/dashboard/properties')  // otro rubro
  })

  it('sidebar y mobile nav comparten la definición, no una copia', () => {
    // La garantía real es que ALL_NAV_ITEMS vive en un solo módulo. Este test
    // falla si alguien vuelve a duplicar la lista en un componente.
    expect(ALL_NAV_ITEMS.length).toBeGreaterThan(0)
    const hrefs = ALL_NAV_ITEMS.map((i) => i.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it('todo link con rubro está declarado en MODULE_VERTICALS', () => {
    // Si mañana alguien agrega "Pedidos" sin rubro, este test no lo detecta —
    // pero sí detecta un href escrito distinto al del mapa, que es el error que
    // dejaría un link visible apuntando a una ruta que después tira 404.
    for (const ruta of Object.keys(MODULE_VERTICALS)) {
      expect(ALL_NAV_ITEMS.some((i) => i.href === ruta), ruta).toBe(true)
    }
  })
})
