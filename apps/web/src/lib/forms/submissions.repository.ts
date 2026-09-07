// Fase 3A — creación de submissions.
//
// Todo lo de acá corre server-side con el admin client: el visitante del sitio
// público es anónimo y form_submissions no tiene policy de INSERT para nadie
// más que el service role (ver la migración). El tenant NUNCA llega desde el
// browser: se resuelve del slug público server-side.

import { createAdminClient } from '@orderflow/supabase/admin'
import type { FormIntent, FormSource } from '@orderflow/validators'
import { generateSubmissionReference } from './submission-reference'

// §18 — una submission vive 24 horas. Centralizado acá: es el único lugar que
// decide la ventana, y Fase 3B lo va a leer para saber si todavía puede
// confirmarse por WhatsApp. No hay cron: la expiración se evalúa de forma
// lazy al recuperarla (ver isSubmissionExpired), porque una fila vencida no
// hace daño mientras nadie la lea, y un cron sería infra nueva para nada.
export const SUBMISSION_TTL_MS = 24 * 60 * 60 * 1000

// Cuántas veces reintentamos ante colisión del código público. Con 32^6
// combinaciones, dos colisiones seguidas ya son astronómicamente improbables;
// 5 es holgura, no una expectativa.
const MAX_REFERENCE_ATTEMPTS = 5

export interface CreateSubmissionParams {
  tenantId:        string
  intent:          FormIntent
  source:          FormSource
  payload:         Record<string, unknown>
  idempotencyKey:  string
  publicationRef?: string | null
  entityType?:     'property' | null
  entityId?:       string | null
}

export interface SubmissionRecord {
  id:         string
  reference:  string
  intent:     string
  status:     string
  created_at: string
  expires_at: string
}

export type CreateSubmissionResult =
  | { ok: true;  submission: SubmissionRecord; deduplicated: boolean }
  | { ok: false; reason: 'reference_collision' | 'insert_failed' }

// Lazy expiry (§18): una fila con expires_at pasado sigue existiendo en la DB
// pero se considera vencida al leerla. Fase 3B debe llamar a esto antes de
// dejar que un WhatsApp confirme una submission.
export function isSubmissionExpired(submission: { expires_at: string }, nowMs = Date.now()): boolean {
  return new Date(submission.expires_at).getTime() <= nowMs
}

export async function createSubmission(params: CreateSubmissionParams): Promise<CreateSubmissionResult> {
  const admin = createAdminClient()

  // §19 — idempotencia server-side, no solo "deshabilitar el botón". El
  // cliente manda una clave por instancia de formulario; si el doble tap
  // (o un retry de red, o el usuario volviendo atrás) llega dos veces,
  // devolvemos la MISMA submission en vez de crear otra. Se chequea antes de
  // insertar y además el UNIQUE (tenant_id, idempotency_key) lo garantiza si
  // dos requests corren en paralelo.
  const { data: existing } = await admin
    .from('form_submissions')
    .select('id, reference, intent, status, created_at, expires_at')
    .eq('tenant_id', params.tenantId)
    .eq('idempotency_key', params.idempotencyKey)
    .maybeSingle()

  if (existing) {
    return { ok: true, submission: existing as SubmissionRecord, deduplicated: true }
  }

  const expiresAt = new Date(Date.now() + SUBMISSION_TTL_MS).toISOString()

  for (let attempt = 0; attempt < MAX_REFERENCE_ATTEMPTS; attempt++) {
    const reference = generateSubmissionReference()

    const { data, error } = await admin
      .from('form_submissions')
      .insert({
        tenant_id:       params.tenantId,
        reference,
        intent:          params.intent,
        status:          'submitted',
        source:          params.source,
        publication_ref: params.publicationRef ?? null,
        entity_type:     params.entityType ?? null,
        entity_id:       params.entityId ?? null,
        payload:         params.payload as never,
        idempotency_key: params.idempotencyKey,
        expires_at:      expiresAt,
      })
      .select('id, reference, intent, status, created_at, expires_at')
      .single()

    if (!error && data) {
      return { ok: true, submission: data as SubmissionRecord, deduplicated: false }
    }

    if (error?.code === '23505') {
      // Violación de UNIQUE. Puede ser el código público (reintentamos con
      // otro) o la clave de idempotencia (dos requests en paralelo: la otra
      // ganó, devolvemos la suya).
      const { data: raced } = await admin
        .from('form_submissions')
        .select('id, reference, intent, status, created_at, expires_at')
        .eq('tenant_id', params.tenantId)
        .eq('idempotency_key', params.idempotencyKey)
        .maybeSingle()

      if (raced) {
        return { ok: true, submission: raced as SubmissionRecord, deduplicated: true }
      }
      continue // fue colisión de reference: probamos otro código
    }

    console.error('[forms] submission insert failed', { code: error?.code })
    return { ok: false, reason: 'insert_failed' }
  }

  console.error('[forms] could not generate a unique submission reference', {
    attempts: MAX_REFERENCE_ATTEMPTS,
  })
  return { ok: false, reason: 'reference_collision' }
}

// Resuelve la publicación que originó el formulario. public_code es único
// apenas POR TENANT y además nullable, así que se busca siempre scopeado al
// tenant y se tolera que no exista: un formulario sin contexto sigue siendo
// válido.
export async function resolvePublicationContext(
  tenantId:       string,
  publicationRef: string | undefined,
): Promise<{ publicationRef: string | null; entityType: 'property' | null; entityId: string | null }> {
  if (!publicationRef) {
    return { publicationRef: null, entityType: null, entityId: null }
  }

  const normalized = publicationRef.trim().toUpperCase()
  const admin = createAdminClient()

  const { data } = await admin
    .from('properties')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('public_code', normalized)
    .is('deleted_at', null)
    .maybeSingle()

  // Guardamos el código que vio el visitante aunque no resuelva a nada: es
  // información real de dónde salió el formulario, y perderla haría más
  // difícil diagnosticar un link viejo o un código mal tipeado.
  return {
    publicationRef: normalized,
    entityType:     data ? 'property' : null,
    entityId:       data?.id ?? null,
  }
}
