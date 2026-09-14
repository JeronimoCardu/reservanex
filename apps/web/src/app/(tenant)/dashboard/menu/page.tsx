import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import {
  getTenantCurrency,
  listMenuCategories,
  listMenuItems,
} from '@/lib/repositories/menu.repository'
import type { MenuGridRow } from '@/lib/dashboard/menu-grid'
import { MenuClient } from './menu-client'

// Fase 3E-C3A1 — el catálogo gastronómico, como planilla.
//
// El guard de rubro vive en layout.tsx: un tenant inmobiliario recibe 404 acá
// aunque escriba la URL a mano.
//
// Se trae el catálogo COMPLETO —vigentes y archivados— en un solo render.
// Buscar y filtrar después es recorrer un array en memoria: para una carta de
// unos cientos de items es instantáneo, y evita una consulta por tecla y otra
// por cada cambio de filtro. El día que una carta sea tan grande que esto no
// alcance, el corte natural es paginar en el servidor, no partir el dataset a la
// mitad ahora.

export default async function MenuPage() {
  const ctx = await requireTenantContext()

  const [categories, items, currency] = await Promise.all([
    listMenuCategories(ctx.tenantId),
    listMenuItems(ctx.tenantId, { archived: 'all' }),
    getTenantCurrency(ctx.tenantId),
  ])

  // El orden es el del producto: categoría y después item, los dos por
  // sort_order. Se resuelve acá, del lado del servidor, y la grilla lo respeta:
  // buscar o filtrar oculta filas, nunca las reordena.
  const posicionCategoria = new Map(categories.map((c, i) => [c.id, i]))
  const porCategoria = new Map(categories.map((c) => [c.id, c]))

  const rows: MenuGridRow[] = items
    .slice()
    .sort((a, b) => {
      const ca = posicionCategoria.get(a.category_id) ?? Number.MAX_SAFE_INTEGER
      const cb = posicionCategoria.get(b.category_id) ?? Number.MAX_SAFE_INTEGER
      if (ca !== cb) return ca - cb
      return a.sort_order - b.sort_order
    })
    .map((item) => {
      const cat = porCategoria.get(item.category_id)
      return {
        id:             item.id,
        categoryId:     item.category_id,
        categoryName:   cat?.name ?? 'Sin categoría',
        categoryActive: cat?.active ?? true,
        name:           item.name,
        description:    item.description ?? '',
        // toFixed(2) para que lo que se ve en el campo sea exactamente lo que
        // quedó persistido en NUMERIC(14,2), sin sorpresas de redondeo.
        price:          item.base_price.toFixed(2),
        published:      item.published,
        available:      item.available,
        archived:       item.deleted_at !== null,
        // Solo la URL. image_storage_path se queda en el servidor: es interno y
        // no tiene por qué viajar al browser, tampoco al del dashboard.
        imageUrl:       item.image_url,
      }
    })

  // Administrar el catálogo es su propio permiso. Esto solo decide si la grilla
  // es editable: las policies de RLS lo revalidan en cada escritura, y cualquier
  // miembro del tenant puede LEER la carta.
  const canManage = ctx.role === 'owner' || ctx.canManageMenu

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-4 sm:px-6">
        <h1 className="text-lg font-semibold">Menú</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {categories.length} categoría{categories.length !== 1 ? 's' : ''}
          {' · '}
          {rows.filter((r) => !r.archived).length} producto
          {rows.filter((r) => !r.archived).length !== 1 ? 's' : ''}
        </p>
      </div>

      <MenuClient
        rows={rows}
        categories={categories}
        currency={currency}
        canManage={canManage}
      />
    </div>
  )
}
