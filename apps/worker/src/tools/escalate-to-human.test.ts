// MVP P0-B.1 — el handoff automático del bot es OTRA semántica que la toma
// manual del CRM ("Pausar IA" / setAiMode('manual'), que escribe human_until
// NULL desde apps/web). Acá se fija lo que escribe el bot, para que un cambio
// en la toma manual no lo arrastre:
//
//   · 'temporary' (AutoResponder): ventana de 1 h desde ahora; la IA vuelve
//     sola si el cliente se queda callado.
//   · 'permanent' (Meta, y el default): sin ventana, como antes de Fase 2B.
//   · el motivo es el del bot, nunca 'manual_takeover'.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const updates = vi.hoisted(() => [] as { payload: Record<string, unknown>; filters: [string, unknown][] }[])

vi.mock('../lib/supabase', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table !== 'conversations') throw new Error(`unexpected table ${table}`)
      return {
        update: (payload: Record<string, unknown>) => {
          const call = { payload, filters: [] as [string, unknown][] }
          updates.push(call)
          const chain = {
            eq: (column: string, value: unknown) => {
              call.filters.push([column, value])
              return chain
            },
            then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
          }
          return chain
        },
      }
    },
  }),
}))

const { executeEscalateToHuman } = await import('./escalate-to-human')
const { DEFAULT_HUMAN_HANDOFF_TIMEOUT_MS, decideHumanMode } = await import('../lib/human-handoff')

const NOW = Date.parse('2026-10-13T12:00:00.000Z')

beforeEach(() => {
  updates.length = 0
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubEnv('HUMAN_HANDOFF_TIMEOUT_MS', '') // vacío = el default de producción
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('executeEscalateToHuman — handoff automático', () => {
  it("'temporary' (AutoResponder): human_until = ahora + 1 h y motivo del bot", async () => {
    await executeEscalateToHuman('t1', 'c1', 'human_requested', 'temporary')
    expect(updates).toHaveLength(1)
    expect(updates[0]!.payload).toEqual({
      ai_mode:                      'manual',
      needs_human_attention:        true,
      human_attention_requested_at: '2026-10-13T12:00:00.000Z',
      ai_handoff_reason:            'human_requested',
      ai_handoff_at:                '2026-10-13T12:00:00.000Z',
      human_until:                  new Date(NOW + DEFAULT_HUMAN_HANDOFF_TIMEOUT_MS).toISOString(),
    })
    expect(DEFAULT_HUMAN_HANDOFF_TIMEOUT_MS).toBe(3_600_000)
    expect(updates[0]!.filters).toEqual([['id', 'c1'], ['tenant_id', 't1']])
  })

  it("'temporary' vuelve sola: activa dentro de la hora, vencida después", async () => {
    await executeEscalateToHuman('t1', 'c1', 'human_requested', 'temporary')
    const state = { ai_mode: 'manual', human_until: updates[0]!.payload.human_until as string }
    expect(decideHumanMode(state, NOW + 30 * 60_000).mode).toBe('human_active')
    expect(decideHumanMode(state, NOW + DEFAULT_HUMAN_HANDOFF_TIMEOUT_MS + 1).mode).toBe('human_expired')
  })

  it("'permanent' (Meta, y el default): sin ventana", async () => {
    await executeEscalateToHuman('t1', 'c1')
    expect(updates[0]!.payload).toMatchObject({ ai_mode: 'manual', human_until: null, ai_handoff_reason: 'human_requested' })
  })

  it.each(['human_requested', 'error', 'negotiation', 'reservation_ready'] as const)(
    "motivo '%s' se conserva; nunca 'manual_takeover' (ese es del CRM)",
    async (reason) => {
      await executeEscalateToHuman('t1', 'c1', reason, 'temporary')
      expect(updates[0]!.payload.ai_handoff_reason).toBe(reason)
    },
  )
})
