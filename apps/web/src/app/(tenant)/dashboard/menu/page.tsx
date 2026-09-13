import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import {
  getTenantCurrency,
  listMenuCategories,
  listMenuItems,
} from '@/lib/repositories/menu.repository'
import { MenuClient } from './menu-client'

// Fase 3E-C3A1 — el catálogo gastronómico.
//
// El guard de rubro vive en layout.tsx: un tenant inmobiliario recibe 404 acá
// aunque escriba la URL a mano.
//
// Una sola página, con las categorías como secciones: la carta se edita
// mirándola entera, no saltando entre dos rutas.

export default async function MenuPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>
}) {
  const ctx    = await requireTenantContext()
  const params = await searchParams
  const view   = params.view === 'archived' ? 'archived' : 'catalog'

  // Los archivados se traen siempre, aunque la vista sea la carta: el contador
  // de la pestaña tiene que ser real, no una estimación.
  const [categories, items, archived, currency] = await Promise.all([
    listMenuCategories(ctx.tenantId),
    listMenuItems(ctx.tenantId),
    listMenuItems(ctx.tenantId, { archived: true }),
    getTenantCurrency(ctx.tenantId),
  ])

  // Administrar el catálogo es su propio permiso. Esto solo decide si se dibujan
  // los controles: las policies de RLS lo revalidan en cada escritura, y
  // cualquier miembro del tenant puede LEER la carta.
  const canManage = ctx.role === 'owner' || ctx.canManageMenu

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-4 sm:px-6">
        <h1 className="text-lg font-semibold">Menú</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {categories.length} categoría{categories.length !== 1 ? 's' : ''}
          {' · '}
          {items.length} producto{items.length !== 1 ? 's' : ''}
        </p>
      </div>

      <MenuClient
        categories={categories}
        items={items}
        archivedItems={archived}
        currency={currency}
        canManage={canManage}
        view={view}
      />
    </div>
  )
}
