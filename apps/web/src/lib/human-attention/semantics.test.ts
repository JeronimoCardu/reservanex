import { describe, expect, it } from 'vitest'
import {
  HUMAN_ATTENTION_REMINDER_DELAY_MS,
  humanAttentionReasonLabel,
  isHumanAttentionPending,
  isHumanAttentionReminderDue,
  tenantReceivesReminders,
} from './semantics'

// ════════════════════════════════════════════════════════════════════════════
// Atención humana V2 — la semántica del ciclo, fijada sin base.
//
// La regla vive en la columna generada human_attention_pending; esta copia
// pura es la que usan los tests y el cron. El validator físico comprueba que
// las dos coincidan sobre filas reales.
// ════════════════════════════════════════════════════════════════════════════

const T0 = Date.parse('2026-09-21T10:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const H = 60 * 60 * 1000

const row = (o: Partial<Parameters<typeof isHumanAttentionPending>[0]> = {}) => ({
  status: 'open',
  human_attention_requested_at: iso(T0),
  human_attention_resolved_at: null,
  human_attention_email_sent_at: null,
  ...o,
})

describe('1-3. pendiente ≡ open ∧ requested ∧ no resuelto después', () => {
  it('handoff (requested, sin resolved) → pendiente', () => {
    expect(isHumanAttentionPending(row())).toBe(true)
  })

  it('sin requested_at nunca es pendiente, aunque needs_human_attention lo hubiera puesto el trigger', () => {
    expect(isHumanAttentionPending(row({ human_attention_requested_at: null }))).toBe(false)
  })

  it('resuelto DESPUÉS del pedido → no pendiente', () => {
    expect(isHumanAttentionPending(row({ human_attention_resolved_at: iso(T0 + 5 * 60_000) }))).toBe(false)
  })

  it('resuelto ANTES del pedido (ciclo anterior) → pendiente otra vez, sin limpiar nada', () => {
    expect(isHumanAttentionPending(row({
      human_attention_requested_at: iso(T0 + H),
      human_attention_resolved_at:  iso(T0),
    }))).toBe(true)
  })

  it('cerrada → no pendiente aunque el ciclo no se haya resuelto', () => {
    expect(isHumanAttentionPending(row({ status: 'closed' }))).toBe(false)
  })

  it('no depende de ai_mode: la fila no lo tiene y la función no lo pide', () => {
    // La reactivación automática (human_until vencido) cambia ai_mode y
    // needs_human_attention, pero NO resolved_at: el pedido sigue pendiente.
    const reactivadaPorExpiracion = { ...row(), ai_mode: 'autonomous', needs_human_attention: false }
    expect(isHumanAttentionPending(reactivadaPorExpiracion)).toBe(true)
  })
})

describe('10-14. el recordatorio de las 2 h', () => {
  it('constante: 2 horas', () => {
    expect(HUMAN_ATTENTION_REMINDER_DELAY_MS).toBe(2 * H)
  })

  it('10. < 2 h → no', () => {
    expect(isHumanAttentionReminderDue(row(), T0 + 2 * H - 1)).toBe(false)
    expect(isHumanAttentionReminderDue(row(), T0 + 119 * 60_000)).toBe(false)
  })

  it('11. ≥ 2 h y pendiente → sí', () => {
    expect(isHumanAttentionReminderDue(row(), T0 + 2 * H)).toBe(true)
    expect(isHumanAttentionReminderDue(row(), T0 + 9 * H)).toBe(true)
  })

  it('12. mismo ciclo ya emailado → no (sent_at ≥ requested_at)', () => {
    expect(isHumanAttentionReminderDue(row({ human_attention_email_sent_at: iso(T0 + 2 * H) }), T0 + 5 * H)).toBe(false)
  })

  it('13. resuelto antes de las 2 h → no', () => {
    expect(isHumanAttentionReminderDue(row({ human_attention_resolved_at: iso(T0 + 90 * 60_000) }), T0 + 3 * H)).toBe(false)
  })

  it('14. segundo handoff (requested_at nuevo > sent_at viejo) → elegible otra vez', () => {
    const segundo = row({
      human_attention_requested_at:  iso(T0 + 24 * H),
      human_attention_resolved_at:   iso(T0 + 3 * H),
      human_attention_email_sent_at: iso(T0 + 2 * H),
    })
    expect(isHumanAttentionReminderDue(segundo, T0 + 24 * H + H)).toBe(false)     // todavía no pasaron 2 h del nuevo
    expect(isHumanAttentionReminderDue(segundo, T0 + 24 * H + 2 * H)).toBe(true)  // sí
  })

  it('la IA reactivada por expiración NO cancela el recordatorio', () => {
    // Misma fila: sólo cambian los campos del gate de IA, que acá no existen.
    const r = { ...row(), ai_mode: 'autonomous', human_until: null, needs_human_attention: false }
    expect(isHumanAttentionReminderDue(r, T0 + 2 * H)).toBe(true)
  })

  it('requested_at inválido → no (fail-closed, no se manda por error de dato)', () => {
    expect(isHumanAttentionReminderDue(row({ human_attention_requested_at: 'no-es-fecha' }), T0 + 5 * H)).toBe(false)
  })
})

describe('17. tenants que reciben el email', () => {
  it('trial y active sí; suspended / cancelled / churned / null no', () => {
    expect(tenantReceivesReminders('trial')).toBe(true)
    expect(tenantReceivesReminders('active')).toBe(true)
    for (const s of ['suspended', 'cancelled', 'churned', null, undefined, '']) {
      expect(tenantReceivesReminders(s), String(s)).toBe(false)
    }
  })
})

describe('motivo', () => {
  it('mapea los handoff_reason conocidos y tiene un default honesto para null', () => {
    expect(humanAttentionReasonLabel('human_requested')).toBe('Pidió hablar con una persona')
    expect(humanAttentionReasonLabel('auto_reply_limit')).toBe('El asistente llegó al límite de respuestas')
    expect(humanAttentionReasonLabel('manual_takeover')).toBe('Tomado manualmente desde ReservaNex')
    expect(humanAttentionReasonLabel(null)).toBe('Derivado por el asistente')
    expect(humanAttentionReasonLabel('algo_desconocido')).toBe('Derivado por el asistente')
  })
})
