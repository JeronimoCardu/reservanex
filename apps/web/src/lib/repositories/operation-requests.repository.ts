import { createClient } from '@orderflow/supabase/server'

// Fase 3C — lectura de las solicitudes que esperan decisión de la empresa.
//
// §17 pide preparar la query correcta, NO construir el dashboard. Esto es
// justamente eso: lo mínimo para que la próxima fase tenga de dónde leer.
//
// El aislamiento por tenant NO se hace acá con un .eq('tenant_id', ...): lo
// hace RLS. createClient() de @orderflow/supabase/server usa la sesión del
// usuario, y tenant_select_operation_requests solo deja ver las filas donde
// tenant_id = auth_tenant_id(). Filtrar además en la query sería redundante y,
// peor, daría la impresión de que la seguridad vive en el TypeScript.

export type OperationRequestStatus = 'pending' | 'confirmed' | 'rejected' | 'cancelled'

export type OperationRequestKind =
  | 'reservation_request'
  | 'visit_request'
  | 'table_request'
  | 'order_request'
  | 'inquiry'

export interface OperationRequestListItem {
  id:                    string
  kind:                  OperationRequestKind
  intent:                string
  status:                OperationRequestStatus
  requested_date:        string | null
  requested_end_date:    string | null
  requested_time:        string | null
  entity_title_snapshot: string | null
  publication_ref:       string | null
  payload_snapshot:      Record<string, unknown>
  customer_confirmed_at: string
  created_at:            string
  decided_at:            string | null
  decision_notes:        string | null
  decided_by:            string | null
  contact: {
    id:    string
    name:  string | null
    phone: string | null
  } | null
  // Fase 3D — quién decidió. null mientras esté pending.
  decider: {
    id:    string
    name:  string | null
    email: string | null
  } | null
  // Fase 3E-B2 — si la solicitud es una visita ya agendada, la cita que salió
  // de ella. Se trae por el vínculo real (source_operation_request_id), sin
  // recalcular ni duplicar nada: la fila de la bandeja puede decir "Agendada
  // para el 14/11 a las 17:30" sin que el componente sepa de timezones.
  visit: {
    id:                string
    scheduled_for:     string
    timezone_snapshot: string
    status:            string
  } | null
  // Fase 3E-C2 — si la solicitud es una mesa ya confirmada, lo ACORDADO.
  // Se trae por el vínculo real; la fila puede decir "Reservada para el 20/11
  // a las 21:00 · 5 personas" sin que el componente sepa de timezones.
  table_reservation: {
    id:                string
    scheduled_for:     string
    timezone_snapshot: string
    party_size:        number
    status:            string
  } | null
}

const LIST_COLUMNS = `
  id, kind, intent, status,
  requested_date, requested_end_date, requested_time,
  entity_title_snapshot, publication_ref,
  payload_snapshot, customer_confirmed_at, created_at,
  decided_at, decision_notes, decided_by,
  contact:contacts!operation_requests_contact_id_fkey ( id, name, phone ),
  decider:tenant_users!operation_requests_decided_by_fkey ( id, name, email ),
  visit:property_visits!property_visits_source_operation_request_id_fkey (
    id, scheduled_for, timezone_snapshot, status
  ),
  table_reservation:table_reservations!table_reservations_source_operation_request_id_fkey (
    id, scheduled_for, timezone_snapshot, party_size, status
  )
`

export interface ListOperationRequestsOptions {
  /** Por defecto solo las pendientes: son las que requieren acción. */
  status?: OperationRequestStatus | 'all'
  limit?:  number
}

export async function listOperationRequests(
  options: ListOperationRequestsOptions = {},
): Promise<OperationRequestListItem[]> {
  const { status = 'pending', limit = 50 } = options
  const supabase = await createClient()

  let query = supabase
    .from('operation_requests')
    .select(LIST_COLUMNS)
    // Lo más reciente primero: una solicitud vieja sin atender es justamente
    // lo que hay que poder ver de un vistazo.
    .order('created_at', { ascending: false })
    .limit(limit)

  if (status !== 'all') query = query.eq('status', status)

  const { data, error } = await query
  if (error) {
    console.error('[operation-requests] listado falló', { error: error.message })
    return []
  }

  return (data ?? []) as unknown as OperationRequestListItem[]
}

export async function countPendingOperationRequests(): Promise<number> {
  const supabase = await createClient()
  const { count, error } = await supabase
    .from('operation_requests')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')

  if (error) {
    console.error('[operation-requests] conteo falló', { error: error.message })
    return 0
  }
  return count ?? 0
}

export async function getOperationRequestById(
  id: string,
): Promise<OperationRequestListItem | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('operation_requests')
    .select(LIST_COLUMNS)
    .eq('id', id)
    .maybeSingle()

  if (error) {
    console.error('[operation-requests] lectura falló', { id, error: error.message })
    return null
  }
  return (data as unknown as OperationRequestListItem) ?? null
}
