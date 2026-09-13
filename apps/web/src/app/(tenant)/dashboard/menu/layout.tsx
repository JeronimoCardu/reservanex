import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { requireRouteVertical } from '@/lib/auth/require-tenant-vertical'

// Fase 3E-C3A1 — guard de rubro.
//
// El catálogo gastronómico.
//
// Está en el layout, no en el page, para que cualquier subruta futura quede
// cubierta sin que nadie tenga que acordarse. El rubro sale de
// lib/dashboard/module-verticals.ts, el MISMO mapa que filtra el nav: un link
// visible cuya ruta después tira 404 sería peor que no mostrarlo.
//
// Esto NO es un chequeo de permisos: decide si el módulo EXISTE para el tenant.
// Quién puede modificarlo dentro del módulo lo siguen decidiendo los permisos.

export default async function MenuLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireTenantContext()
  requireRouteVertical(ctx, '/dashboard/menu')
  return <>{children}</>
}
