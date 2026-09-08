-- ════════════════════════════════════════════════════════════════════════════
-- Fase 3C — verificación posterior a la prueba física
-- ════════════════════════════════════════════════════════════════════════════
--
-- SOLO LECTURA. No escribe nada.
--
-- CÓMO CORRERLO
--   supabase db query --linked -f supabase/31-verify-3c-physical-test.sql
--
-- Es UNA sola sentencia a propósito: `supabase db query` va contra la
-- Management API, que solo devuelve el resultado de la ÚLTIMA sentencia del
-- archivo. Con varios SELECT sueltos se pierden todos menos uno (y sin \echo,
-- que es meta-comando de psql y tampoco se acepta). Por eso todo se arma como
-- un único jsonb con secciones.
--
-- OJO con una trampa: en la base ya vive SUB-2AN6JL, la submission de la
-- prueba física de la Fase 3B. Está confirmed pero NO tiene operation_request,
-- porque se confirmó antes de que 3C existiera. Todo acá se ancla en la
-- submission MÁS RECIENTE; la sección "0_submissions" las lista a todas para
-- que se vea cuál es cuál.
--
-- LO ESPERADO DESPUÉS DE LA PRUEBA
--   1. status=confirmed · confirmed_at con hora · contact_id = tu teléfono
--   2. kind=reservation_request · intent=temporary_rental · status=pending
--      decided_at y decided_by en null (nadie decidió todavía)
--   3. operaciones_para_esa_submission = 1   (exactamente una)
--   4. reservations = 0                      (3C NO crea reservas)
--   5. availability_blocks = 0               (PENDING no bloquea fechas)
--   6. property_availability_blocks = 0
--   7. conversaciones_con_pendiente = 0      (se limpia al confirmar)
--   8. messaging_outbox = 0
--   9. las cuatro banderas de coherencia en true
-- ════════════════════════════════════════════════════════════════════════════

WITH ultima AS (
  SELECT * FROM public.form_submissions ORDER BY created_at DESC LIMIT 1
)
SELECT jsonb_pretty(jsonb_build_object(

  '0_submissions', (
    SELECT jsonb_agg(jsonb_build_object(
      'reference',    fs.reference,
      'intent',       fs.intent,
      'status',       fs.status,
      'created_at',   fs.created_at,
      'confirmed_at', fs.confirmed_at,
      'operaciones',  (SELECT count(*) FROM public.operation_requests o
                        WHERE o.source_submission_id = fs.id)
    ) ORDER BY fs.created_at DESC)
    FROM public.form_submissions fs
  ),

  '1_ultima_submission', (
    SELECT jsonb_build_object(
      'reference',         u.reference,
      'status',            u.status,
      'confirmed_at',      u.confirmed_at,
      'contact_id',        u.contact_id,
      'contacto_telefono', (SELECT c.phone FROM public.contacts c WHERE c.id = u.contact_id),
      'payload',           u.payload
    ) FROM ultima u
  ),

  '2_operacion', (
    SELECT jsonb_build_object(
      'id',                    o.id,
      'source_submission_id',  o.source_submission_id,
      'kind',                  o.kind,
      'intent',                o.intent,
      'status',                o.status,
      'customer_confirmed_at', o.customer_confirmed_at,
      'contact_id',            o.contact_id,
      'requested_date',        o.requested_date,
      'requested_end_date',    o.requested_end_date,
      'decided_at',            o.decided_at,
      'decided_by',            o.decided_by,
      'payload_snapshot',      o.payload_snapshot
    )
    FROM public.operation_requests o, ultima u
    WHERE o.source_submission_id = u.id
  ),

  '3_operaciones_para_esa_submission',
    (SELECT count(*) FROM public.operation_requests o, ultima u
      WHERE o.source_submission_id = u.id),

  '4_reservations',                 (SELECT count(*) FROM public.reservations),
  '5_availability_blocks',          (SELECT count(*) FROM public.availability_blocks),
  '6_property_availability_blocks', (SELECT count(*) FROM public.property_availability_blocks),

  '7_conversaciones_con_pendiente',
    (SELECT count(*) FROM public.conversations WHERE pending_submission_id IS NOT NULL),

  '7b_conversacion_del_contacto', (
    SELECT jsonb_agg(jsonb_build_object(
      'conversation_id',       cv.id,
      'pending_submission_id', cv.pending_submission_id,
      'ai_mode',               cv.ai_mode,
      'human_until',           cv.human_until
    ))
    FROM public.conversations cv, ultima u
    WHERE cv.contact_id = u.contact_id
  ),

  '8_messaging_outbox', (SELECT count(*) FROM public.messaging_outbox),

  '9_coherencia', (
    SELECT jsonb_build_object(
      'reference',                u.reference,
      'submission_status',        u.status,
      'operacion_status',         o.status,
      'confirmaciones_coinciden', (u.confirmed_at = o.customer_confirmed_at),
      'contactos_coinciden',      (u.contact_id   = o.contact_id),
      'intents_coinciden',        (u.intent       = o.intent),
      'snapshot_es_fiel',         (u.payload      = o.payload_snapshot)
    )
    FROM ultima u
    JOIN public.operation_requests o ON o.source_submission_id = u.id
  )

)) AS verificacion_3c;
