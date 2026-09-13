import { notFound } from 'next/navigation'
import type { TenantVertical } from '@orderflow/validators'
import { routeAllowsVertical, verticalsForRoute } from '@/lib/dashboard/module-verticals'

// Fase 3E-C3A1 — guard de ruta por rubro, server-side.
//
// Esconder el link en el nav no es autorización: un tenant food_service que
// escribe /dashboard/properties a mano tiene que recibir un 404, no una
// pantalla inmobiliaria vacía.
//
// Se aplica en el layout.tsx de cada módulo con rubro, no en cada page.tsx. Así
// una subruta nueva (properties/[id]/edit, por ejemplo) queda cubierta sin que
// nadie tenga que acordarse, que es exactamente el modo en que este bug
// apareció la primera vez.
//
// notFound() y no redirect(): para ese tenant la ruta no EXISTE. Un redirect
// diría "no podés entrar acá", que es el mensaje de un problema de permisos, y
// esto no es un problema de permisos. Y notFound() no filtra qué módulos tienen
// otros rubros.

/**
 * Corta con 404 si el rubro del tenant no incluye esa ruta.
 *
 * El pathname se pasa literal para que el call site diga a qué módulo pertenece
 * y el mapa siga siendo la única fuente de verdad.
 */
export function requireRouteVertical(
  ctx: { vertical: TenantVertical },
  pathname: string,
): void {
  if (!routeAllowsVertical(pathname, ctx.vertical)) notFound()
}

/**
 * Variante para cuando hace falta decidir sin cortar (por ejemplo, para elegir
 * qué contar en un resumen transversal).
 */
export function tenantHasRoute(
  ctx: { vertical: TenantVertical },
  pathname: string,
): boolean {
  return routeAllowsVertical(pathname, ctx.vertical)
}

export { verticalsForRoute }
