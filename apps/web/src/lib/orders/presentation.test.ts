import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  ORDER_FILTERS,
  ORDER_STATUS_LABELS,
  ORDER_TRANSITIONS,
  actionsForStatus,
  canTransition,
  formatOrderMoney,
  fulfillmentLabel,
  isTerminal,
  orderLineLabel,
  orderStatusLabel,
  orderStatusTone,
  parseOrderFilter,
  paymentLabel,
} from './presentation'
import { ACTIVE_ORDER_STATUSES, type OrderStatus } from '@/lib/repositories/orders.repository'

// ════════════════════════════════════════════════════════════════════════════
// Fase 3E-C3C — la máquina de estados del pedido y su presentación.
//
// La autoridad es transition_order_status; esto solo decide qué botones se
// dibujan. Pero si divergen, el usuario ve acciones que el servidor rechaza —
// así que la lista de transiciones se fija acá Y se compara contra el fuente de
// la migración, que es donde vive la versión que manda.
// ════════════════════════════════════════════════════════════════════════════

const TODOS: OrderStatus[] = ['confirmed', 'preparing', 'ready', 'completed', 'cancelled']

describe('§14 — las transiciones permitidas', () => {
  it('son exactamente SEIS', () => {
    const total = TODOS.reduce((n, s) => n + ORDER_TRANSITIONS[s].length, 0)
    expect(total).toBe(6)
  })

  it('T/U/V — el camino feliz', () => {
    expect(canTransition('confirmed', 'preparing')).toBe(true)
    expect(canTransition('preparing', 'ready')).toBe(true)
    expect(canTransition('ready', 'completed')).toBe(true)
  })

  it('W/X/Y — se puede cancelar desde los tres estados vivos', () => {
    expect(canTransition('confirmed', 'cancelled')).toBe(true)
    expect(canTransition('preparing', 'cancelled')).toBe(true)
    expect(canTransition('ready', 'cancelled')).toBe(true)
  })

  it('Z/AA — completed y cancelled son terminales', () => {
    expect(isTerminal('completed')).toBe(true)
    expect(isTerminal('cancelled')).toBe(true)
    for (const destino of TODOS) {
      expect(canTransition('completed', destino), `completed→${destino}`).toBe(false)
      expect(canTransition('cancelled', destino), `cancelled→${destino}`).toBe(false)
    }
  })

  it('AB — los saltos hacia adelante están prohibidos', () => {
    expect(canTransition('confirmed', 'ready')).toBe(false)
    expect(canTransition('confirmed', 'completed')).toBe(false)
    expect(canTransition('preparing', 'completed')).toBe(false)
  })

  it('AB — y los retrocesos también', () => {
    expect(canTransition('ready', 'preparing')).toBe(false)
    expect(canTransition('preparing', 'confirmed')).toBe(false)
    expect(canTransition('ready', 'confirmed')).toBe(false)
  })

  it('nadie puede volver a confirmed: un pedido se acepta una sola vez', () => {
    for (const desde of TODOS) {
      expect(canTransition(desde, 'confirmed'), desde).toBe(false)
    }
  })

  it('un estado desconocido no habilita nada', () => {
    expect(canTransition('lo_que_sea', 'preparing')).toBe(false)
    expect(canTransition('confirmed', 'lo_que_sea')).toBe(false)
    expect(isTerminal('lo_que_sea')).toBe(false)
  })

  it('la máquina coincide con la de la RPC', () => {
    // La versión que manda vive en la migración. Si alguien cambia una y no la
    // otra, el usuario ve un botón que el servidor rechaza.
    const raiz = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..')
    const sql = fs.readFileSync(
      path.join(raiz, 'supabase', 'migrations', '20260920000002_materialize_order.sql'),
      'utf8',
    )
    expect(sql).toContain("(v_order.status = 'confirmed' AND p_status IN ('preparing', 'cancelled'))")
    expect(sql).toContain("(v_order.status = 'preparing' AND p_status IN ('ready',     'cancelled'))")
    expect(sql).toContain("(v_order.status = 'ready'     AND p_status IN ('completed', 'cancelled'))")
    // Y que la RPC no acepte 'confirmed' como destino: nace confirmado.
    expect(sql).toContain("p_status NOT IN ('preparing', 'ready', 'completed', 'cancelled')")
  })
})

describe('§21 — las acciones que se ofrecen', () => {
  it('AN — dependen del estado', () => {
    expect(actionsForStatus('confirmed').map((a) => a.target)).toEqual(['preparing', 'cancelled'])
    expect(actionsForStatus('preparing').map((a) => a.target)).toEqual(['ready', 'cancelled'])
    expect(actionsForStatus('ready').map((a) => a.target)).toEqual(['completed', 'cancelled'])
  })

  it('AN — un estado terminal no ofrece ninguna', () => {
    expect(actionsForStatus('completed')).toEqual([])
    expect(actionsForStatus('cancelled')).toEqual([])
  })

  it('cada acción ofrecida es una transición REAL', () => {
    for (const estado of TODOS) {
      for (const accion of actionsForStatus(estado)) {
        expect(canTransition(estado, accion.target), `${estado}→${accion.target}`).toBe(true)
      }
    }
  })

  it('y no falta ninguna transición por ofrecer', () => {
    for (const estado of TODOS) {
      const ofrecidas = actionsForStatus(estado).map((a) => a.target).sort()
      expect(ofrecidas, estado).toEqual([...ORDER_TRANSITIONS[estado]].sort())
    }
  })

  it('siempre hay exactamente una acción primaria cuando hay acciones', () => {
    for (const estado of ['confirmed', 'preparing', 'ready']) {
      const primarias = actionsForStatus(estado).filter((a) => a.primary)
      expect(primarias, estado).toHaveLength(1)
      // Cancelar nunca es la acción primaria.
      expect(primarias[0]!.target).not.toBe('cancelled')
    }
  })

  it('los textos son los del producto', () => {
    expect(actionsForStatus('confirmed')[0]!.label).toBe('Comenzar preparación')
    expect(actionsForStatus('preparing')[0]!.label).toBe('Marcar como listo')
    expect(actionsForStatus('ready')[0]!.label).toBe('Marcar como completado')
  })
})

describe('etiquetas y tonos', () => {
  it('los cinco estados tienen etiqueta', () => {
    expect(Object.keys(ORDER_STATUS_LABELS).sort()).toEqual([...TODOS].sort())
    expect(orderStatusLabel('preparing')).toBe('En preparación')
    expect(orderStatusLabel('cancelled')).toBe('Cancelado')
  })

  it('un estado desconocido se muestra crudo en vez de romper', () => {
    expect(orderStatusLabel('raro')).toBe('raro')
    expect(orderStatusTone('raro')).toBe('muted')
  })

  it('entrega y pago usan las etiquetas del formulario', () => {
    expect(fulfillmentLabel('delivery')).toBe('Delivery')
    expect(fulfillmentLabel('takeaway')).toBe('Retiro en el local')
    expect(paymentLabel('cash')).toBe('Efectivo')
    expect(paymentLabel('transfer')).toBe('Transferencia')
    expect(paymentLabel('card')).toBe('Tarjeta')
  })
})

describe('§19 — filtros del listado', () => {
  it('"Activos" son confirmed + preparing + ready', () => {
    expect([...ACTIVE_ORDER_STATUSES]).toEqual(['confirmed', 'preparing', 'ready'])
    // Y son exactamente los NO terminales.
    expect([...ACTIVE_ORDER_STATUSES]).toEqual(TODOS.filter((s) => !isTerminal(s)))
  })

  it('están los siete filtros pedidos', () => {
    expect(ORDER_FILTERS.map((f) => f.value)).toEqual([
      'active', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled', 'all',
    ])
  })

  it('el filtro por defecto es Activos', () => {
    expect(parseOrderFilter(undefined)).toBe('active')
    expect(parseOrderFilter('')).toBe('active')
    expect(parseOrderFilter('cualquier_cosa')).toBe('active')
    expect(parseOrderFilter('DROP TABLE')).toBe('active')
  })

  it('un filtro válido se respeta', () => {
    expect(parseOrderFilter('ready')).toBe('ready')
    expect(parseOrderFilter('all')).toBe('all')
  })
})

describe('plata', () => {
  it('se lee igual que en el carrito y en WhatsApp', () => {
    expect(formatOrderMoney(20000, 'ARS')).toBe('ARS 20.000,00')
    expect(formatOrderMoney(12500.5, 'ARS')).toBe('ARS 12.500,50')
    expect(formatOrderMoney(0, 'ARS')).toBe('ARS 0,00')
    expect(formatOrderMoney(2000.1, 'USD')).toBe('USD 2.000,10')
  })

  it('el number de la base se redondea al centavo, sin derivar', () => {
    // supabase-js devuelve NUMERIC como number; 0.29 * 100 no cae en 29.
    expect(formatOrderMoney(0.29, 'ARS')).toBe('ARS 0,29')
    expect(formatOrderMoney(0.07, 'ARS')).toBe('ARS 0,07')
    expect(formatOrderMoney(18000.9, 'ARS')).toBe('ARS 18.000,90')
  })

  it('la línea se lee como una comanda', () => {
    expect(orderLineLabel(2, 'Muzzarella')).toBe('2 × Muzzarella')
    expect(orderLineLabel(1, 'Agua 500ml')).toBe('1 × Agua 500ml')
  })
})
