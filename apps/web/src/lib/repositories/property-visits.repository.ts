import { createClient } from '@orderflow/supabase/server'

// Fase 3E-B2 — lectura de las visitas agendadas.
//
// Igual que operation-requests.repository: el aislamiento por tenant NO se hace
// con un .eq('tenant_id', …), lo hace RLS. createClient() usa la sesión del
// usuario y tenant_select_property_visits solo deja ver las filas del tenant.
// Filtrar además acá daría la falsa impresión de que la seguridad vive en el
// TypeScript.

export type VisitStatus = 'scheduled' | 'completed' | 'cancelled'

export interface PropertyVisitListItem {
  id:                          string
  scheduled_for:               string
  timezone_snapshot:           string
  status:                      VisitStatus
  cancellation_reason:         string | null
  completed_at:                string | null
  cancelled_at:                string | null
  created_at:                  string
  source_operation_request_id: string
  contact: {
    id:    string
    name:  string | null
    phone: string | null
  } | null
  property: {
    id:    string
    title: string
  } | null
  /** Quién la agendó. Sirve para saber a quién preguntarle. */
  scheduler: {
    id:   string
    name: string | null
  } | null
  /** Lo que el cliente había pedido, para poder compararlo con lo agendado. */
  request: {
    id:               string
    requested_date:   string | null
    payload_snapshot: Record<string, unknown>
  } | null
}

const LIST_COLUMNS = `
  id, scheduled_for, timezone_snapshot, status,
  cancellation_reason, completed_at, cancelled_at, created_at,
  source_operation_request_id,
  contact:contacts!property_visits_contact_id_fkey ( id, name, phone ),
  property:properties!property_visits_property_id_fkey ( id, title ),
  scheduler:tenant_users!property_visits_scheduled_by_fkey ( id, name ),
  request:operation_requests!property_visits_source_operation_request_id_fkey (
    id, requested_date, payload_snapshot
  )
`

export type VisitFilter = 'upcoming' | 'scheduled' | 'completed' | 'cancelled' | 'all'

export interface ListPropertyVisitsOptions {
  /** Por defecto las próximas: son las que hay que ir a hacer. */
  filter?: VisitFilter
  limit?:  number
}

export async function listPropertyVisits(
  options: ListPropertyVisitsOptions = {},
): Promise<PropertyVisitListItem[]> {
  const { filter = 'upcoming', limit = 200 } = options
  const supabase = await createClient()

  let query = supabase.from('property_visits').select(LIST_COLUMNS).limit(limit)

  if (filter === 'upcoming') {
    // "Próximas" = agendadas y todavía por delante. El corte se hace contra el
    // INSTANTE (scheduled_for es timestamptz), así que compara bien sin importar
    // la zona de quien mira.
    query = query
      .eq('status', 'scheduled')
      .gte('scheduled_for', new Date().toISOString())
      .order('scheduled_for', { ascending: true })
  } else if (filter === 'all') {
    query = query.order('scheduled_for', { ascending: false })
  } else {
    query = query.eq('status', filter).order('scheduled_for', { ascending: false })
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)

  return (data ?? []) as unknown as PropertyVisitListItem[]
}

export async function countUpcomingVisits(): Promise<number> {
  const supabase = await createClient()
  const { count } = await supabase
    .from('property_visits')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'scheduled')
    .gte('scheduled_for', new Date().toISOString())
  return count ?? 0
}
