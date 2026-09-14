import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  REQUEST_FILTERS,
  emptyRequestsCopy,
  parseRequestFilter,
  requestFilterHref,
  type RequestFilter,
} from './filters'
import { ORDER_FILTERS, orderFilterHref, parseOrderFilter, emptyOrdersCopy } from '@/lib/orders/presentation'
import { ACTIVE_ORDER_STATUSES } from '@/lib/repositories/orders.repository'

// ════════════════════════════════════════════════════════════════════════════
// Fase 3E-C3C (pulido UX) — los filtros de las dos bandejas.
//
// El repo no tiene entorno DOM (vitest en 'node'), así que lo que se puede
// hacer puro se prueba puro, y lo que es de React se fija con aserciones
// estructurales sobre el fuente.
// ════════════════════════════════════════════════════════════════════════════

const SRC  = path.resolve(import.meta.dirname, '..', '..')
const leer = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8')

function soloCodigo(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

// ── Solicitudes ────────────────────────────────────────────────────────────

describe('filtros de Solicitudes', () => {
  it('el orden es Todas → Pendientes → Aprobadas → Rechazadas', () => {
    expect(REQUEST_FILTERS.map((f) => f.value)).toEqual(['all', 'pending', 'confirmed', 'rejected'])
  })

  it('el copy es el del producto, sin renombrar los estados internos', () => {
    expect(REQUEST_FILTERS.map((f) => f.label)).toEqual(['Todas', 'Pendientes', 'Aprobadas', 'Rechazadas'])
    // Los `value` siguen siendo los status REALES de operation_requests.
    expect(REQUEST_FILTERS.find((f) => f.label === 'Pendientes')!.value).toBe('pending')
    expect(REQUEST_FILTERS.find((f) => f.label === 'Aprobadas')!.value).toBe('confirmed')
    expect(REQUEST_FILTERS.find((f) => f.label === 'Rechazadas')!.value).toBe('rejected')
  })

  it('un estado desconocido cae al default seguro', () => {
    expect(parseRequestFilter(undefined)).toBe('pending')
    expect(parseRequestFilter('')).toBe('pending')
    expect(parseRequestFilter('cualquier_cosa')).toBe('pending')
    expect(parseRequestFilter('DROP TABLE')).toBe('pending')
    expect(parseRequestFilter('APROBADAS')).toBe('pending')
  })

  it('un filtro válido se respeta', () => {
    for (const f of REQUEST_FILTERS) expect(parseRequestFilter(f.value)).toBe(f.value)
    // 'cancelled' no tiene pill pero la URL lo sigue aceptando: un link viejo
    // no se rompe.
    expect(parseRequestFilter('cancelled')).toBe('cancelled')
  })

  it('el href del default deja la URL limpia', () => {
    expect(requestFilterHref('pending')).toBe('/dashboard/requests')
    expect(requestFilterHref('all')).toBe('/dashboard/requests?status=all')
    expect(requestFilterHref('confirmed')).toBe('/dashboard/requests?status=confirmed')
    expect(requestFilterHref('rejected')).toBe('/dashboard/requests?status=rejected')
  })

  it('ida y vuelta: el href de un filtro se parsea de nuevo al mismo filtro', () => {
    for (const f of REQUEST_FILTERS) {
      const href = requestFilterHref(f.value)
      const raw  = href.includes('?') ? href.split('status=')[1] : undefined
      expect(parseRequestFilter(raw), f.value).toBe(f.value)
    }
  })

  it('cada filtro tiene copy propio para el vacío', () => {
    const vistos = new Set<string>()
    for (const f of REQUEST_FILTERS) {
      const { title } = emptyRequestsCopy(f.value as RequestFilter)
      expect(title.length).toBeGreaterThan(0)
      expect(vistos.has(title), `${f.value} repite copy`).toBe(false)
      vistos.add(title)
    }
    expect(emptyRequestsCopy('pending').title).toBe('No hay solicitudes pendientes.')
    expect(emptyRequestsCopy('confirmed').title).toBe('No hay solicitudes aprobadas.')
    expect(emptyRequestsCopy('rejected').title).toBe('No hay solicitudes rechazadas.')
  })

  it('el énfasis semántico existe pero NO es la única señal', () => {
    // Pendientes lleva tono porque es el trabajo por hacer; "Todas" no lo lleva
    // porque no es un estado. Y todas tienen etiqueta de texto.
    expect(REQUEST_FILTERS.find((f) => f.value === 'pending')!.tone).toBe('pending')
    expect(REQUEST_FILTERS.find((f) => f.value === 'all')!.tone).toBeUndefined()
    for (const f of REQUEST_FILTERS) expect(f.label.trim().length).toBeGreaterThan(0)
  })
})

// ── Pedidos ────────────────────────────────────────────────────────────────

describe('filtros de Pedidos', () => {
  it('el orden y el copy son los pedidos', () => {
    expect(ORDER_FILTERS.map((f) => f.label)).toEqual([
      'Activos', 'Confirmados', 'Preparando', 'Listos', 'Completados', 'Cancelados', 'Todos',
    ])
  })

  it('Activos = confirmed + preparing + ready', () => {
    expect([...ACTIVE_ORDER_STATUSES]).toEqual(['confirmed', 'preparing', 'ready'])
    expect(ORDER_FILTERS[0]!.value).toBe('active')
  })

  it('un estado desconocido cae al default seguro', () => {
    expect(parseOrderFilter(undefined)).toBe('active')
    expect(parseOrderFilter('cualquier_cosa')).toBe('active')
    expect(parseOrderFilter('Activos')).toBe('active')
  })

  it('el href del default deja la URL limpia', () => {
    expect(orderFilterHref('active')).toBe('/dashboard/orders')
    expect(orderFilterHref('preparing')).toBe('/dashboard/orders?status=preparing')
  })

  it('ida y vuelta: el href de un filtro se parsea de nuevo al mismo filtro', () => {
    for (const f of ORDER_FILTERS) {
      const href = orderFilterHref(f.value)
      const raw  = href.includes('?') ? href.split('status=')[1] : undefined
      expect(parseOrderFilter(raw), f.value).toBe(f.value)
    }
  })

  it('cada filtro tiene copy propio para el vacío', () => {
    const vistos = new Set<string>()
    for (const f of ORDER_FILTERS) {
      const { title } = emptyOrdersCopy(f.value)
      expect(title.length).toBeGreaterThan(0)
      expect(vistos.has(title), `${f.value} repite copy`).toBe(false)
      vistos.add(title)
    }
    expect(emptyOrdersCopy('preparing').title).toBe('No hay pedidos preparando.')
    expect(emptyOrdersCopy('ready').title).toBe('No hay pedidos listos.')
  })

  it('el copy de cancelados distingue cancelar de rechazar', () => {
    expect(emptyOrdersCopy('cancelled').hint).toContain('rechazar una solicitud')
  })
})

// ── El componente compartido ───────────────────────────────────────────────

describe('StatusFilterTabs', () => {
  const fuente = leer('components', 'tenant', 'shared', 'status-filter-tabs.tsx')
  const codigo = soloCodigo(fuente)

  it('las dos bandejas usan el MISMO componente', () => {
    for (const archivo of [
      leer('app', '(tenant)', 'dashboard', 'orders', 'orders-client.tsx'),
      leer('app', '(tenant)', 'dashboard', 'requests', 'requests-client.tsx'),
    ]) {
      expect(archivo).toContain('<StatusFilterTabs')
    }
  })

  it('navega con links, no con botones: back/forward y "abrir en pestaña" funcionan', () => {
    expect(codigo).toContain('<Link')
    expect(codigo).toContain("from 'next/link'")
    expect(codigo).not.toContain('router.push')
    expect(codigo).not.toContain('<button')
  })

  it('el estado activo NO depende solo del color', () => {
    // Fondo sólido + peso tipográfico, más aria-current para lectores.
    expect(codigo).toContain('aria-current')
    expect(codigo).toContain('bg-zinc-900 font-medium text-white')
  })

  it('mantiene el foco visible para teclado', () => {
    expect(codigo).toContain('focus-visible:ring-2')
  })

  it('mobile: una sola fila que se desliza, sin wrap', () => {
    expect(codigo).toContain('flex-nowrap')
    expect(codigo).toContain('overflow-x-auto')
    expect(codigo).toContain('shrink-0')
    expect(codigo).toContain('whitespace-nowrap')
    // NO se convierte en un <select> en pantallas chicas.
    expect(codigo).not.toContain('<select')
    // Y no hay una variante mobile-only escondida.
    expect(codigo).not.toContain('sm:hidden')
  })

  it('el punto de tono es decorativo y va oculto para lectores de pantalla', () => {
    expect(codigo).toContain('aria-hidden="true"')
    expect(codigo).toContain('h-1.5 w-1.5 rounded-full')
  })

  it('los counts son opcionales: si no vienen, no se renderiza nada', () => {
    expect(codigo).toContain('o.count !== undefined')
  })

  it('es una nav etiquetada', () => {
    expect(codigo).toContain('<nav')
    expect(codigo).toContain('aria-label={ariaLabel}')
  })
})

// ── Lo que NO se tocó ──────────────────────────────────────────────────────

describe('el pulido de UX no tocó la lógica', () => {
  it('el ciclo de vida del pedido sigue con las mismas seis transiciones', () => {
    const codigo = soloCodigo(leer('lib', 'orders', 'presentation.ts'))
    expect(codigo).toContain("confirmed: ['preparing', 'cancelled'],")
    expect(codigo).toContain("preparing: ['ready', 'cancelled'],")
    expect(codigo).toContain("ready:     ['completed', 'cancelled'],")
    expect(codigo).toContain('completed: [],')
    expect(codigo).toContain('cancelled: [],')
  })

  it('/dashboard/orders sigue siendo solo de food_service', () => {
    const mapa = soloCodigo(leer('lib', 'dashboard', 'module-verticals.ts'))
    expect(mapa).toContain("'/dashboard/orders':             ['food_service'],")

    // Y el guard server-side sigue en el layout: un real_estate recibe 404.
    const layout = leer('app', '(tenant)', 'dashboard', 'orders', 'layout.tsx')
    expect(layout).toContain("requireRouteVertical(ctx, '/dashboard/orders')")
  })

  it('la query del listado sigue filtrando por los mismos estados', () => {
    const repo = soloCodigo(leer('lib', 'repositories', 'orders.repository.ts'))
    expect(repo).toContain("ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = ['confirmed', 'preparing', 'ready']")
    expect(repo).toContain("if (status === 'active')")
  })
})
