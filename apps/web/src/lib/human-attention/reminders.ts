import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@orderflow/types'
import type { EmailSender } from '@/lib/email/send-email'
import { renderHumanAttentionEmail } from '@/lib/email/human-attention-email'
import { buildContactWhatsAppHref } from './contact-whatsapp-href'
import {
  HUMAN_ATTENTION_REMINDER_DELAY_MS,
  REMINDER_TENANT_STATUSES,
  isHumanAttentionReminderDue,
  tenantReceivesReminders,
} from './semantics'

// ════════════════════════════════════════════════════════════════════════════
// El recordatorio de las 2 horas.
//
// Regla: si un ciclo de atención humana sigue PENDIENTE 2 h después de
// human_attention_requested_at y todavía no recibió su email, avisar a los
// owners activos del tenant. No depende de ai_mode: que la IA haya vuelto sola
// no significa que una persona haya atendido.
//
// Idempotencia (§13): el claim es UN UPDATE condicional sobre
// human_attention_email_sent_at. Dos ejecuciones concurrentes leen el mismo
// candidato; el UPDATE de una matchea y el de la otra no. Mismo ciclo ⇒ como
// máximo un email. Ciclo nuevo (requested_at > sent_at) ⇒ elegible otra vez.
//
// Fallo del proveedor DESPUÉS del claim: se libera (sent_at = NULL) sólo si
// todavía vale exactamente lo que este intento escribió, así el próximo tick
// reintenta sin pisar un claim ajeno.
//
// Orden de operaciones por candidato:
//   1. re-chequeo en memoria (isHumanAttentionReminderDue)
//   2. destinatarios — 0 owners activos ⇒ NO se claimea, se loguea, se
//      reintenta en el próximo tick (no se pierde el recordatorio)
//   3. claim
//   4. render + send
//   5. release si el send falló
//
// Todo lo que toca la base recibe el cliente y el reloj por parámetro: el
// validator físico inyecta un sender que registra en vez de mandar, y un `now`
// fijo. Ningún test automático puede disparar un email real.
// ════════════════════════════════════════════════════════════════════════════

export interface ReminderRunDeps {
  admin:        SupabaseClient<Database>
  sender:       EmailSender
  /** `${siteUrl}/dashboard/attention` — el CTA "Ver en ReservaNex". */
  attentionUrl: string
  now?:         Date
  /** Máximo de candidatos por tick. */
  limit?:       number
  /** Acotar a un tenant (validators). */
  tenantId?:    string
}

export type ReminderSkipReason =
  | 'not_due'          // el re-chequeo en memoria no lo confirmó
  | 'tenant_inactive'  // suspended / cancelled / churned
  | 'no_recipient'     // 0 owners activos — no se claimea
  | 'lost_claim'       // otra ejecución ganó, o el ciclo cambió entre lectura y claim

export interface ReminderRunReport {
  scanned: number
  sent:    { conversationId: string; tenantId: string; recipients: number }[]
  skipped: { conversationId: string; tenantId: string; reason: ReminderSkipReason }[]
  failed:  { conversationId: string; tenantId: string; reason: string; released: boolean }[]
}

interface CandidateRow {
  id:                            string
  tenant_id:                     string
  contact_id:                    string
  channel:                       string
  status:                        string
  ai_handoff_reason:             string | null
  human_attention_requested_at:  string | null
  human_attention_resolved_at:   string | null
  human_attention_email_sent_at: string | null
  last_message_content:          string | null
  last_message_sender_type:      string | null
  contacts:                      { name: string | null; phone: string | null } | null
  tenants:                       { id: string; name: string; status: string } | null
}

const CANDIDATE_COLUMNS =
  'id, tenant_id, contact_id, channel, status, ai_handoff_reason, ' +
  'human_attention_requested_at, human_attention_resolved_at, human_attention_email_sent_at, ' +
  'last_message_content, last_message_sender_type, ' +
  'contacts(name, phone), tenants!inner(id, name, status)'

export async function runHumanAttentionReminders(deps: ReminderRunDeps): Promise<ReminderRunReport> {
  const now    = deps.now ?? new Date()
  const nowMs  = now.getTime()
  const cutoff = new Date(nowMs - HUMAN_ATTENTION_REMINDER_DELAY_MS).toISOString()
  const limit  = deps.limit ?? 50

  const report: ReminderRunReport = { scanned: 0, sent: [], skipped: [], failed: [] }

  // ── 1. Candidatos ─────────────────────────────────────────────────────────
  // human_attention_pending es la columna generada (open ∧ requested ∧ no
  // resuelto después). El filtro de email_sent_at < requested_at no se puede
  // expresar en PostgREST (compara dos columnas): se hace en memoria y, lo que
  // importa, en el WHERE del claim.
  let query = deps.admin
    .from('conversations')
    .select(CANDIDATE_COLUMNS)
    .eq('human_attention_pending', true)
    .lte('human_attention_requested_at', cutoff)
    .in('tenants.status', [...REMINDER_TENANT_STATUSES])
    .order('human_attention_requested_at', { ascending: true })
    .limit(limit)
  if (deps.tenantId) query = query.eq('tenant_id', deps.tenantId)

  const { data, error } = await query
  if (error) throw new Error(`[attention:reminders] candidates query failed: ${error.message}`)

  const candidates = (data ?? []) as unknown as CandidateRow[]
  report.scanned = candidates.length

  for (const row of candidates) {
    const base = { conversationId: row.id, tenantId: row.tenant_id }

    // ── 2. Re-chequeo en memoria ────────────────────────────────────────────
    if (!isHumanAttentionReminderDue(row, nowMs)) {
      report.skipped.push({ ...base, reason: 'not_due' })
      continue
    }
    if (!tenantReceivesReminders(row.tenants?.status)) {
      report.skipped.push({ ...base, reason: 'tenant_inactive' })
      continue
    }

    // ── 3. Destinatarios: owners ACTIVOS de ESTE tenant ─────────────────────
    // tenant_users es la fuente; primary_owner_email es el prospecto del
    // onboarding y no se usa. Si no hay nadie a quién avisar, no se claimea:
    // el recordatorio queda vivo para cuando exista un owner.
    const { data: owners, error: ownersErr } = await deps.admin
      .from('tenant_users')
      .select('email')
      .eq('tenant_id', row.tenant_id)
      .eq('role', 'owner')
      .eq('active', true)
    if (ownersErr) {
      report.failed.push({ ...base, reason: `owners query: ${ownersErr.message}`, released: false })
      continue
    }
    const recipients = [...new Set((owners ?? []).map((o) => o.email.trim().toLowerCase()).filter(Boolean))]
    if (recipients.length === 0) {
      console.warn('[attention:reminders] no_recipient — tenant sin owner activo, se reintenta en el próximo tick', base)
      report.skipped.push({ ...base, reason: 'no_recipient' })
      continue
    }

    // ── 4. Claim atómico ────────────────────────────────────────────────────
    // Un solo UPDATE con TODA la condición en el WHERE. requested_at se compara
    // con el valor crudo que devolvió PostgREST (precisión de microsegundos):
    // si el ciclo cambió entre la lectura y acá, no matchea y se reintenta
    // cuando ese ciclo nuevo cumpla sus 2 h.
    const requestedRaw = row.human_attention_requested_at!
    const { data: claimed, error: claimErr } = await deps.admin
      .from('conversations')
      .update({ human_attention_email_sent_at: now.toISOString() })
      .eq('id', row.id)
      .eq('tenant_id', row.tenant_id)
      .eq('human_attention_pending', true)
      .eq('human_attention_requested_at', requestedRaw)
      .or(`human_attention_email_sent_at.is.null,human_attention_email_sent_at.lt.${requestedRaw}`)
      .select('human_attention_email_sent_at')
    if (claimErr) {
      report.failed.push({ ...base, reason: `claim: ${claimErr.message}`, released: false })
      continue
    }
    const claimedRaw = claimed?.[0]?.human_attention_email_sent_at ?? null
    if (!claimedRaw) {
      report.skipped.push({ ...base, reason: 'lost_claim' })
      continue
    }

    // ── 5. Render + send ────────────────────────────────────────────────────
    const email = renderHumanAttentionEmail({
      tenantName:    row.tenants?.name ?? 'ReservaNex',
      contactName:   row.contacts?.name ?? null,
      contactPhone:  row.contacts?.phone ?? null,
      channel:       row.channel,
      requestedAt:   requestedRaw,
      handoffReason: row.ai_handoff_reason,
      lastMessage:   row.last_message_content,
      lastMessageBy: row.last_message_sender_type,
      whatsappHref:  buildContactWhatsAppHref(row.contacts?.phone),
      attentionUrl:  deps.attentionUrl,
      now,
    })

    const result = await deps.sender.send({ to: recipients, subject: email.subject, html: email.html, text: email.text })

    if (result.ok) {
      console.log('[attention:reminders] sent', { ...base, recipients: recipients.length, providerId: result.id })
      report.sent.push({ ...base, recipients: recipients.length })
      continue
    }

    // ── 6. Release seguro ───────────────────────────────────────────────────
    // Sólo si sent_at todavía es EXACTAMENTE lo que este intento escribió.
    const { data: released, error: releaseErr } = await deps.admin
      .from('conversations')
      .update({ human_attention_email_sent_at: null })
      .eq('id', row.id)
      .eq('tenant_id', row.tenant_id)
      .eq('human_attention_email_sent_at', claimedRaw)
      .select('id')
    const wasReleased = !releaseErr && (released?.length ?? 0) > 0
    console.error('[attention:reminders] send failed', {
      ...base, reason: result.reason, detail: result.detail, released: wasReleased,
      releaseError: releaseErr?.message,
    })
    report.failed.push({ ...base, reason: `${result.reason}${result.detail ? `: ${result.detail}` : ''}`, released: wasReleased })
  }

  return report
}
