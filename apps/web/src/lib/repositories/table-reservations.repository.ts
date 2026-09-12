import { createClient } from '@orderflow/supabase/server'

// Fase 3E-C2 — lectura de las reservas de mesa acordadas.
//
// Igual que property-visits.repository: el aislamiento por tenant lo hace RLS,
// no un .eq('tenant_id', …). createClient() usa la sesión del usuario y
// tenant_select_table_reservations solo deja ver las filas de su tenant.

export type TableReservationStatus = 'confirmed' | 'completed' | 'cancelled' | 'no_show'

export interface TableReservationListItem {
  id:                          string
  scheduled_for:               string
  timezone_snapshot:           string
  party_size:                  number
  status:                      TableReservationStatus
  cancellation_reason:         string | null
  completed_at:                string | null
  cancelled_at:                string | null
  no_show_at:                  string | null
  created_at:                  string
  source_operation_request_id: string
  contact: {
    id:    string
    name:  string | null
    phone: string | null
  } | null
  /** Quién la confirmó. */
  confirmer: {
    id:   string
    name: string | null
  } | null
  /** Lo que el cliente había pedido, para poder contrastarlo con lo acordado. */
  request: {
    id:               string
    requested_date:   string | null
    requested_time:   string | null
    payload_snapshot: Record<string, unknown>
  } | null
}

const LIST_COLUMNS = `
  id, scheduled_for, timezone_snapshot, party_size, status,
  cancellation_reason, completed_at, cancelled_at, no_show_at, created_at,
  source_operation_request_id,
  contact:contacts!table_reservations_contact_id_fkey ( id, name, phone ),
  confirmer:tenant_users!table_reservations_confirmed_by_fkey ( id, name ),
  request:operation_requests!table_reservations_source_operation_request_id_fkey (
    id, requested_date, requested_time, payload_snapshot
  )
`

export type TableReservationFilter =
  | 'upcoming' | 'confirmed' | 'completed' | 'cancelled' | 'no_show' | 'all'

export interface ListTableReservationsOptions {
  filter?: TableReservationFilter
  limit?:  number
}

export async function listTableReservations(
  options: ListTableReservationsOptions = {},
): Promise<TableReservationListItem[]> {
  const { filter = 'upcoming', limit = 200 } = options
  const supabase = await createClient()

  let query = supabase.from('table_reservations').select(LIST_COLUMNS).limit(limit)

  if (filter === 'upcoming') {
    // "Próximas" = confirmadas y todavía por delante. El corte va contra el
    // INSTANTE, así que compara bien sin importar la zona de quien mira.
    query = query
      .eq('status', 'confirmed')
      .gte('scheduled_for', new Date().toISOString())
      .order('scheduled_for', { ascending: true })
  } else if (filter === 'all') {
    query = query.order('scheduled_for', { ascending: false })
  } else {
    query = query.eq('status', filter).order('scheduled_for', { ascending: false })
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)

  return (data ?? []) as unknown as TableReservationListItem[]
}
