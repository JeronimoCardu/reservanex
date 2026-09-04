-- Backfill: create one initial event for every reservation that has no event yet.
-- Uses reservation.created_at so the timeline looks correct in the drawer.
INSERT INTO public.reservation_events (
  id,
  tenant_id,
  reservation_id,
  actor_id,
  event_type,
  metadata,
  created_at
)
SELECT
  gen_random_uuid(),
  r.tenant_id,
  r.id,
  null,
  CASE WHEN r.source = 'ai' THEN 'ai_created' ELSE 'manual_created' END,
  jsonb_build_object(
    'source',         r.source,
    'start_date',     r.start_date,
    'end_date',       r.end_date,
    'guests',         r.guests,
    'total_amount',   r.total_amount,
    'price_currency', COALESCE(r.price_currency, r.currency, 'ARS'),
    'backfill',       true
  ),
  r.created_at
FROM public.reservations r
WHERE r.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM   public.reservation_events e
    WHERE  e.reservation_id = r.id
  );
