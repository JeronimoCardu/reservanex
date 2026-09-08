// Fase 3B — formulario → WhatsApp → recuperación → confirmación.
//
// Este módulo decide, para UN inbound de texto, si la conversación está
// hablando de una submission. Devuelve el texto de respuesta ya armado, o
// dice que no le corresponde y el pipeline de IA normal sigue como siempre
// (§21).
//
// NO llama al LLM. Todo lo que responde es determinístico (§12): más barato,
// más rápido, y sin ninguna posibilidad de que el modelo altere los datos que
// el cliente tiene que verificar (§10).
//
// La referencia SUB-XXXXXX es CORRELACIÓN, no AUTORIZACIÓN (§3). Todo lo de
// acá corre server-side, dentro del worker, después de un inbound ya
// autenticado por el device token de AutoResponder. No existe —ni debe
// existir— ningún endpoint público que traduzca una referencia a un payload.

import { createClient } from '../lib/supabase'
import type { MessageContext } from '../context/builder'
import { extractSubmissionReference } from '../lib/submission-reference'
import { classifyConfirmation } from '../lib/confirmation-classifier'
import {
  buildSummaryLines,
  isSummaryIntent,
} from '../lib/submission-summary'
import {
  getSubmissionMessages,
  renderSummaryMessage,
  resolveMessageLanguage,
  type MessageLanguage,
} from '../lib/submission-messages'

// 'skip' → no es un mensaje de submission; seguir con la IA normal.
// 'reply' → responder ESTO y no llamar al LLM.
export type SubmissionFlowResult =
  | { kind: 'skip' }
  | { kind: 'reply'; text: string }

interface SubmissionRow {
  id:         string
  tenant_id:  string
  contact_id: string | null
  intent:     string
  status:     string
  payload:    unknown
  expires_at: string
}

const SUBMISSION_COLUMNS = 'id, tenant_id, contact_id, intent, status, payload, expires_at'

// Lazy expiry (§7): no hay cron. Una fila vencida sigue existiendo; se
// evalúa al leerla, y recién ahí se la marca.
function isExpired(submission: { expires_at: string }, nowMs: number): boolean {
  return new Date(submission.expires_at).getTime() <= nowMs
}

async function resolveLanguage(tenantId: string): Promise<MessageLanguage> {
  const supabase = createClient()
  const { data } = await supabase
    .from('tenants')
    .select('language')
    .eq('id', tenantId)
    .maybeSingle()
  return resolveMessageLanguage(data?.language)
}

// Marca vencida una submission que ya pasó su ventana. Condicional: solo
// toca filas todavía abiertas, así que nunca "resucita" ni pisa un estado
// terminal (§19).
async function markExpired(submissionId: string, tenantId: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase
    .from('form_submissions')
    .update({ status: 'expired' })
    .eq('id', submissionId)
    .eq('tenant_id', tenantId)
    .in('status', ['draft', 'submitted'])

  if (error) {
    // No es fatal: la respuesta al cliente ya es la correcta ("venció").
    console.warn('[submissions] no se pudo marcar la submission como expirada', {
      submissionId, error: error.message,
    })
  }
}

async function setPendingSubmission(
  ctx:          MessageContext,
  submissionId: string | null,
): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase
    .from('conversations')
    .update({ pending_submission_id: submissionId })
    .eq('id', ctx.conversationId)
    .eq('tenant_id', ctx.tenantId)

  if (error) {
    console.warn('[submissions] no se pudo actualizar pending_submission_id', {
      conversationId: ctx.conversationId, error: error.message,
    })
  }
}

// ── Camino 1: llegó una referencia ──────────────────────────────────────────
async function handleReference(
  ctx:       MessageContext,
  reference: string,
): Promise<SubmissionFlowResult> {
  const supabase = createClient()
  const language = await resolveLanguage(ctx.tenantId)
  const msg      = getSubmissionMessages(language)

  // La referencia es única GLOBAL, así que esta búsqueda no lleva tenant en
  // el WHERE — y por eso el chequeo de tenant de abajo es obligatorio, no
  // decorativo.
  const { data: submission, error } = await supabase
    .from('form_submissions')
    .select(SUBMISSION_COLUMNS)
    .eq('reference', reference)
    .maybeSingle<SubmissionRow>()

  if (error) {
    console.error('[submissions] error buscando la referencia', { error: error.message })
    return { kind: 'reply', text: msg.notFound }
  }

  // ── No disclosure (§6, §8) ────────────────────────────────────────────────
  // Estos tres casos responden EXACTAMENTE lo mismo, a propósito:
  //   · la referencia no existe;
  //   · existe pero es de otro tenant;
  //   · existe, es de este tenant, pero está vinculada a otro contacto.
  // Diferenciarlos convertiría la referencia en un oráculo: alguien podría
  // probar códigos y aprender cuáles existen o a qué tenant pertenecen.
  if (!submission) {
    console.log('[submissions] referencia inexistente', { reference, tenantId: ctx.tenantId })
    return { kind: 'reply', text: msg.notFound }
  }

  if (submission.tenant_id !== ctx.tenantId) {
    console.warn('[submissions] referencia de OTRO tenant — respuesta genérica', {
      reference, inboundTenantId: ctx.tenantId,
    })
    return { kind: 'reply', text: msg.notFound }
  }

  // ── Contact binding (§8) ─────────────────────────────────────────────────
  // Primera vez: se vincula. El UPDATE lleva `contact_id IS NULL` en el WHERE,
  // así que si dos mensajes de teléfonos distintos entran a la vez, solo uno
  // gana — la atomicidad la da la DB, no un chequeo previo.
  if (submission.contact_id === null) {
    const { data: bound } = await supabase
      .from('form_submissions')
      .update({ contact_id: ctx.contactId })
      .eq('id', submission.id)
      .eq('tenant_id', ctx.tenantId)
      .is('contact_id', null)
      .select('id')
      .maybeSingle()

    if (!bound) {
      // Perdimos la carrera: otro contacto la tomó entremedio. Se relee para
      // decidir con el estado real, sin reasignar nada.
      const { data: fresh } = await supabase
        .from('form_submissions')
        .select('contact_id')
        .eq('id', submission.id)
        .eq('tenant_id', ctx.tenantId)
        .maybeSingle()

      if (fresh?.contact_id !== ctx.contactId) {
        console.warn('[submissions] carrera de binding perdida — respuesta genérica', {
          reference, submissionId: submission.id,
        })
        return { kind: 'reply', text: msg.notFound }
      }
    }
    submission.contact_id = ctx.contactId
  } else if (submission.contact_id !== ctx.contactId) {
    // Reenviada a otro teléfono. NO se entrega el payload y NO se reasigna.
    // Esto reduce el riesgo del reenvío, pero la referencia sigue sin ser
    // autenticación: es una defensa más, no la única.
    console.warn('[submissions] referencia vinculada a OTRO contacto — respuesta genérica', {
      reference, submissionId: submission.id,
    })
    return { kind: 'reply', text: msg.notFound }
  }

  // ── Estado (§18, §19) ────────────────────────────────────────────────────
  // Se evalúa DESPUÉS del binding para no filtrar el estado de una submission
  // ajena, y ANTES de la expiración porque un estado terminal manda sobre el
  // reloj.
  if (submission.status === 'confirmed') {
    await setPendingSubmission(ctx, null)
    return { kind: 'reply', text: msg.alreadyConfirmed }
  }

  if (submission.status === 'cancelled') {
    return { kind: 'reply', text: msg.cancelled }
  }

  // ── Expiración (§7) ──────────────────────────────────────────────────────
  if (submission.status === 'expired' || isExpired(submission, Date.now())) {
    await markExpired(submission.id, ctx.tenantId)
    return { kind: 'reply', text: msg.expired }
  }

  // ── Resumen exacto (§10) ─────────────────────────────────────────────────
  if (!isSummaryIntent(submission.intent)) {
    // Un intent que la DB acepta pero esta copia no conoce. No inventamos un
    // resumen a medias: respondemos genérico y queda en el log.
    console.error('[submissions] intent sin definición de resumen en el worker', {
      intent: submission.intent, submissionId: submission.id,
    })
    return { kind: 'reply', text: msg.notFound }
  }

  const payload = (submission.payload ?? {}) as Record<string, unknown>
  const lines   = buildSummaryLines(submission.intent, payload)

  if (lines.length === 0) {
    console.error('[submissions] resumen vacío — no se pide confirmación', {
      submissionId: submission.id, intent: submission.intent,
    })
    return { kind: 'reply', text: msg.notFound }
  }

  // Una referencia explícita SIEMPRE gana sobre la pendiente anterior (§20).
  // La anterior queda en submitted; no se cancela nada automáticamente.
  await setPendingSubmission(ctx, submission.id)

  console.log('[submissions] resumen enviado, esperando confirmación', {
    reference, submissionId: submission.id, intent: submission.intent, lines: lines.length,
  })

  return { kind: 'reply', text: renderSummaryMessage(language, lines) }
}

// ── Camino 2: hay una confirmación pendiente ────────────────────────────────
async function handlePending(
  ctx:          MessageContext,
  submissionId: string,
): Promise<SubmissionFlowResult> {
  const supabase = createClient()
  const language = await resolveLanguage(ctx.tenantId)
  const msg      = getSubmissionMessages(language)

  const { data: submission } = await supabase
    .from('form_submissions')
    .select(SUBMISSION_COLUMNS)
    .eq('id', submissionId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle<SubmissionRow>()

  if (!submission) {
    // La pendiente desapareció (borrada, o de otro tenant tras algún cambio).
    // Se limpia y se sigue con la IA normal en vez de responder algo raro.
    await setPendingSubmission(ctx, null)
    return { kind: 'skip' }
  }

  // El contacto tiene que seguir siendo el mismo (§14).
  if (submission.contact_id !== null && submission.contact_id !== ctx.contactId) {
    await setPendingSubmission(ctx, null)
    return { kind: 'reply', text: msg.notFound }
  }

  const verdict = classifyConfirmation(ctx.messageText)

  // Ambigua: NO se confirma, se vuelve a preguntar y la pendiente se mantiene
  // (§17). Se evalúa antes que el estado/expiración para no cambiar nada por
  // un mensaje que ni siquiera era una respuesta.
  if (verdict === 'ambiguous') {
    return { kind: 'reply', text: msg.ambiguous }
  }

  if (submission.status === 'confirmed') {
    await setPendingSubmission(ctx, null)
    return { kind: 'reply', text: msg.alreadyConfirmed }
  }

  if (submission.status === 'cancelled') {
    await setPendingSubmission(ctx, null)
    return { kind: 'reply', text: msg.cancelled }
  }

  if (submission.status === 'expired' || isExpired(submission, Date.now())) {
    await markExpired(submission.id, ctx.tenantId)
    await setPendingSubmission(ctx, null)
    return { kind: 'reply', text: msg.expired }
  }

  // ── REJECT (§16) ─────────────────────────────────────────────────────────
  // La submission NO se marca confirmed y NO se cancela: queda en submitted.
  // Se limpia la pendiente para que el próximo mensaje sea una conversación
  // normal y no otro "¿es correcto?". No se abre edición del payload por
  // chat: eso está explícitamente fuera de esta fase.
  if (verdict === 'reject') {
    await setPendingSubmission(ctx, null)
    console.log('[submissions] el cliente rechazó los datos', { submissionId: submission.id })
    return { kind: 'reply', text: msg.rejected }
  }

  // ── CONFIRM (Fase 3B §14 + Fase 3C §15) ──────────────────────────────────
  //
  // Antes de 3C esto eran dos escrituras sueltas desde el worker: marcar la
  // submission confirmed y (nuevo en 3C) crear la operación. Entre las dos
  // había una ventana real — si el proceso muere o falla el segundo INSERT,
  // el cliente ya escuchó "confirmé tus datos" y no queda nada que la empresa
  // pueda atender. Una submission "confirmada pero perdida".
  //
  // Ahora las dos escrituras viven en UNA transacción de Postgres
  // (confirm_submission_and_create_operation). O pasan las dos, o no pasa
  // ninguna. La RPC además revalida tenant, contacto, estado y expiración con
  // la fila LOCKEADA, así que no depende de lo que leímos más arriba.
  const { data: rpcData, error: rpcError } = await supabase.rpc(
    'confirm_submission_and_create_operation',
    {
      p_submission_id:   submission.id,
      p_tenant_id:       ctx.tenantId,
      p_contact_id:      ctx.contactId,
      p_conversation_id: ctx.conversationId,
    },
  )

  // ── Fail-safe (§22) ──────────────────────────────────────────────────────
  // Si la RPC falla, la transacción ya revirtió: la submission sigue en
  // submitted. Lo que NO hay que hacer es decirle al cliente que quedó todo
  // bien ni limpiar la pendiente — si la borráramos, su próximo "sí" no
  // sabría qué confirmar y la solicitud quedaría huérfana. Se mantiene la
  // pendiente y se le pide que reintente: el reintento es idempotente.
  if (rpcError) {
    console.error('[submissions] la confirmación transaccional falló — submission intacta', {
      submissionId: submission.id, code: rpcError.code, error: rpcError.message,
    })
    return { kind: 'reply', text: msg.confirmationFailed }
  }

  const outcome = (rpcData as { outcome?: string } | null)?.outcome ?? 'unknown'

  // Estos desenlaces cierran el tema: se limpia la pendiente.
  if (outcome === 'expired') {
    await setPendingSubmission(ctx, null)
    return { kind: 'reply', text: msg.expired }
  }
  if (outcome === 'cancelled') {
    await setPendingSubmission(ctx, null)
    return { kind: 'reply', text: msg.cancelled }
  }
  if (outcome === 'wrong_contact' || outcome === 'not_found') {
    await setPendingSubmission(ctx, null)
    return { kind: 'reply', text: msg.notFound }
  }
  if (outcome === 'already_confirmed') {
    await setPendingSubmission(ctx, null)
    return { kind: 'reply', text: msg.alreadyConfirmed }
  }

  if (outcome !== 'confirmed') {
    // Desenlace inesperado: mismo criterio fail-safe que un error duro.
    console.error('[submissions] outcome inesperado de la RPC', { submissionId: submission.id, outcome })
    return { kind: 'reply', text: msg.confirmationFailed }
  }

  // Éxito: recién ACÁ se limpia la pendiente (§25 Q).
  await setPendingSubmission(ctx, null)

  const result = rpcData as { operation_id?: string; operation_kind?: string }
  console.log('[submissions] submission confirmada y operación pendiente creada', {
    submissionId:  submission.id,
    contactId:     ctx.contactId,
    operationId:   result.operation_id,
    operationKind: result.operation_kind,
  })

  // OJO con el vocabulario: se confirmaron los DATOS del formulario y quedó
  // una solicitud PENDIENTE de aprobación. NO hay reserva ni pedido aceptado,
  // y el mensaje al cliente no menciona ids ni dice lo contrario (§16).
  return { kind: 'reply', text: msg.confirmed }
}

// ── Punto de entrada ────────────────────────────────────────────────────────
// Se llama solo cuando la IA puede atender: applyHumanHandoffGate() ya
// devolvió 'continue' (§5). Durante HUMAN esto no se ejecuta nunca, así que
// una referencia mandada mientras atiende una persona no toca la submission
// ni rompe el silencio de la Fase 2B.
export async function runSubmissionFlow(ctx: MessageContext): Promise<SubmissionFlowResult> {
  // Solo AutoResponder (§22). Meta conserva exactamente su semántica anterior:
  // no se lo adapta a replies[] ni se le cambia el pipeline.
  if (ctx.provider !== 'autoresponder') return { kind: 'skip' }

  const reference = extractSubmissionReference(ctx.messageText)
  if (reference) {
    return handleReference(ctx, reference)
  }

  const supabase = createClient()
  const { data: conv } = await supabase
    .from('conversations')
    .select('pending_submission_id')
    .eq('id', ctx.conversationId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  if (conv?.pending_submission_id) {
    return handlePending(ctx, conv.pending_submission_id)
  }

  // Ni referencia ni pendiente: no es asunto de este módulo (§21).
  return { kind: 'skip' }
}
