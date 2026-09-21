import { notFound } from 'next/navigation'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { requireRouteVertical } from '@/lib/auth/require-tenant-vertical'

// Fase 3E-C3A1 — guard de rubro.
//
// Reservas de mesa: gastronómico. Su lógica, lifecycle y permisos no cambian — esto solo agrega el guard de rubro.
//
// Está en el layout, no en el page, para que cualquier subruta futura quede
// cubierta sin que nadie tenga que acordarse. El rubro sale de
// lib/dashboard/module-verticals.ts, el MISMO mapa que filtra el nav: un link
// visible cuya ruta después tira 404 sería peor que no mostrarlo.
//
// Esto NO es un chequeo de permisos: decide si el módulo EXISTE para el tenant.
// Quién puede modificarlo dentro del módulo lo siguen decidiendo los permisos.

export default async function TableReservationsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireTenantContext()
  requireRouteVertical(ctx, '/dashboard/table-reservations')

  // Y además la capacidad del local. El guard de rubro dice que el módulo
  // EXISTE para un gastronómico; esto dice que ESTE gastronómico lo tiene
  // encendido. Son dos ejes distintos y los dos son server-side: el nav ya no
  // muestra el link, pero escribir la URL tiene que fallar igual.
  //
  // Apagar la capacidad no borra nada: las reservas históricas siguen en la
  // base y su ciclo de vida no cambia. Lo único que deja de poder pasar es que
  // entren nuevas.
  if (!ctx.capabilities.tableReservations) notFound()

  return <>{children}</>
}
