import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { listPropertyVisits, type VisitFilter } from '@/lib/repositories/property-visits.repository'
import { VisitsClient } from './visits-client'

// Fase 3E-B2 — la agenda de visitas.
//
// Existe porque ahora hay una entidad operacional que gestionar: una cita con
// fecha, hora, propiedad, contacto y ciclo de vida. Antes de esta fase habría
// sido una pantalla vacía.

const VALID: ReadonlySet<string> = new Set(['upcoming', 'scheduled', 'completed', 'cancelled', 'all'])

export default async function VisitsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  const ctx = await requireTenantContext()
  const params = await searchParams
  const raw = params.filter
  // Por defecto las próximas: son las que hay que ir a hacer.
  const filter = (raw && VALID.has(raw) ? raw : 'upcoming') as VisitFilter

  const visits = await listPropertyVisits({ filter })

  // Gestionar visitas es su propio permiso desde 3E-B2. Las RPC lo revalidan
  // igual — esto solo decide si se dibujan los botones.
  const canManage = ctx.role === 'owner' || ctx.canManageVisits

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-4 sm:px-6">
        <h1 className="text-lg font-semibold">Visitas</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {visits.length} visita{visits.length !== 1 ? 's' : ''}
          {filter === 'upcoming' ? ' próxima' + (visits.length !== 1 ? 's' : '') : ''}
        </p>
      </div>

      <VisitsClient visits={visits} canManage={canManage} activeFilter={filter} />
    </div>
  )
}
