import { createClient } from '@orderflow/supabase/server'
import { createAdminClient } from '@orderflow/supabase/admin'
import type {
  CreateMenuCategoryInput,
  UpdateMenuCategoryInput,
  CreateMenuItemInput,
  UpdateMenuItemInput,
} from '@orderflow/validators'
import { computeReorder, type Ordenable } from '@/lib/dashboard/reorder'

// Fase 3E-C3A1 — el catálogo gastronómico.
//
// Escribe con el cliente del USUARIO (createClient), no con el admin: la
// autoridad es RLS. Las policies tenant_insert/update_menu_* exigen tenant
// propio Y (owner OR can_manage_menu), así que un bug en una action no puede
// abrir una escritura que la base no autorice. Es el patrón de properties, con
// los grants endurecidos que a properties le faltan.
//
// La única excepción es la moneda: tenants.currency se lee con el admin porque
// las policies de tenants no le dan SELECT al usuario sobre su propia fila en
// todos los caminos, y es un dato de presentación, no una decisión.

export type MenuCategory = {
  id:         string
  name:       string
  sort_order: number
  active:     boolean
}

export type MenuItem = {
  id:          string
  category_id: string
  name:        string
  description: string | null
  /** NUMERIC(14,2) — supabase-js lo entrega como number. */
  base_price:  number
  published:   boolean
  available:   boolean
  sort_order:  number
  deleted_at:  string | null
}

const CATEGORY_COLS = 'id, name, sort_order, active'
const ITEM_COLS =
  'id, category_id, name, description, base_price, published, available, sort_order, deleted_at'

/** Error de unicidad de Postgres. La lanza el índice normalizado de categorías. */
export const UNIQUE_VIOLATION = '23505'
/** La tira guard_menu_item_tenant() cuando la categoría es de otro tenant. */
export const FK_VIOLATION = '23503'

export class MenuRepositoryError extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message)
    this.name = 'MenuRepositoryError'
  }
}

function fail(error: { message: string; code?: string }): never {
  throw new MenuRepositoryError(error.message, error.code ?? null)
}

// ── Lectura ───────────────────────────────────────────────────────────────────

/**
 * La moneda del tenant. Es la ÚNICA fuente: menu_items no tiene currency, y el
 * usuario no puede escribirla desde ningún formulario.
 */
export async function getTenantCurrency(tenantId: string): Promise<string> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('tenants')
    .select('currency')
    .eq('id', tenantId)
    .maybeSingle()

  // El default de la columna es 'ARS' y es NOT NULL, así que esto solo cubre el
  // caso de que la fila no se pueda leer. No se inventa otra moneda.
  return data?.currency ?? 'ARS'
}

/** Todas las categorías del tenant, activas e inactivas, en su orden. */
export async function listMenuCategories(tenantId: string): Promise<MenuCategory[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('menu_categories')
    .select(CATEGORY_COLS)
    .eq('tenant_id', tenantId)
    .order('sort_order', { ascending: true })
    // Desempate estable: sin esto, dos categorías con el mismo sort_order
    // podrían alternar de posición entre renders.
    .order('created_at', { ascending: true })

  if (error) fail(error)
  return (data ?? []) as MenuCategory[]
}

/**
 * Los items del tenant. `archived: false` (default) trae los vigentes;
 * `archived: true`, solo los archivados.
 */
export async function listMenuItems(
  tenantId: string,
  { archived = false }: { archived?: boolean } = {},
): Promise<MenuItem[]> {
  const supabase = await createClient()
  let query = supabase
    .from('menu_items')
    .select(ITEM_COLS)
    .eq('tenant_id', tenantId)

  query = archived ? query.not('deleted_at', 'is', null) : query.is('deleted_at', null)

  const { data, error } = await query
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) fail(error)
  return (data ?? []) as MenuItem[]
}

// ── Categorías: escritura ─────────────────────────────────────────────────────

/**
 * El sort_order de una fila nueva: al final de su grupo.
 *
 * Se calcula con max+1 en vez de count() para no colisionar cuando hay huecos
 * (archivar y reordenar dejan huecos a propósito: sort_order NO tiene que ser
 * contiguo).
 */
function siguiente(data: { sort_order: number }[] | null): number {
  const max = data?.[0]?.sort_order
  return typeof max === 'number' ? max + 1 : 0
}

async function nextCategorySortOrder(tenantId: string): Promise<number> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('menu_categories')
    .select('sort_order')
    .eq('tenant_id', tenantId)
    .order('sort_order', { ascending: false })
    .limit(1)
  return siguiente(data)
}

/** El grupo de orden de un item es su CATEGORÍA, no el tenant. */
async function nextItemSortOrder(tenantId: string, categoryId: string): Promise<number> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('menu_items')
    .select('sort_order')
    .eq('tenant_id', tenantId)
    .eq('category_id', categoryId)
    .order('sort_order', { ascending: false })
    .limit(1)
  return siguiente(data)
}

export async function createMenuCategory(
  tenantId: string,
  input: CreateMenuCategoryInput,
): Promise<MenuCategory> {
  const supabase = await createClient()
  const sortOrder = await nextCategorySortOrder(tenantId)

  const { data, error } = await supabase
    .from('menu_categories')
    .insert({ tenant_id: tenantId, name: input.name, sort_order: sortOrder })
    .select(CATEGORY_COLS)
    .single()

  if (error) fail(error)
  return data as MenuCategory
}

export async function updateMenuCategory(
  tenantId: string,
  id: string,
  input: UpdateMenuCategoryInput,
): Promise<void> {
  const supabase = await createClient()
  const { error } = await supabase
    .from('menu_categories')
    .update({ name: input.name })
    .eq('id', id)
    .eq('tenant_id', tenantId)

  if (error) fail(error)
}

/**
 * Activar/desactivar. Deliberadamente NO toca los items: conservan su
 * category_id, su published y su available. Es totalmente reversible.
 */
export async function setMenuCategoryActive(
  tenantId: string,
  id: string,
  active: boolean,
): Promise<void> {
  const supabase = await createClient()
  const { error } = await supabase
    .from('menu_categories')
    .update({ active })
    .eq('id', id)
    .eq('tenant_id', tenantId)

  if (error) fail(error)
}

// ── Items: escritura ──────────────────────────────────────────────────────────

export async function createMenuItem(
  tenantId: string,
  input: CreateMenuItemInput,
): Promise<MenuItem> {
  const supabase = await createClient()
  const sortOrder = await nextItemSortOrder(tenantId, input.category_id)

  const { data, error } = await supabase
    .from('menu_items')
    .insert({
      tenant_id:   tenantId,
      category_id: input.category_id,
      name:        input.name,
      description: input.description ?? null,
      base_price:  input.base_price,
      // Defaults explícitos: lo mismo que la columna, escrito para que se lea.
      published:   false,
      available:   true,
      sort_order:  sortOrder,
    })
    .select(ITEM_COLS)
    .single()

  if (error) fail(error)
  return data as MenuItem
}

export async function updateMenuItem(
  tenantId: string,
  id: string,
  input: UpdateMenuItemInput,
): Promise<void> {
  const supabase = await createClient()

  // La categoría actual se LEE, no se recibe del cliente. Solo decide dónde cae
  // el item en el orden, pero un dato que el servidor puede resolver no tiene
  // por qué viajar en el request.
  const { data: actual, error: readError } = await supabase
    .from('menu_items')
    .select('category_id')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (readError) fail(readError)
  if (!actual) throw new MenuRepositoryError('Producto no encontrado.', null)

  const patch: {
    category_id: string
    name:        string
    description: string | null
    base_price:  number
    sort_order?: number
  } = {
    category_id: input.category_id,
    name:        input.name,
    description: input.description ?? null,
    base_price:  input.base_price,
  }

  // Mover un item a otra categoría lo manda al final de la nueva: si conservara
  // su sort_order viejo aparecería en un lugar arbitrario del destino. El guard
  // de la base revalida que la categoría nueva sea del mismo tenant.
  if (input.category_id !== actual.category_id) {
    patch.sort_order = await nextItemSortOrder(tenantId, input.category_id)
  }

  const { error } = await supabase
    .from('menu_items')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', tenantId)

  if (error) fail(error)
}

export async function setMenuItemFlag(
  tenantId: string,
  id: string,
  flag: 'published' | 'available',
  value: boolean,
): Promise<void> {
  const supabase = await createClient()
  // Explícito y no { [flag]: value }: una clave computada le da a supabase-js un
  // patch de tipo abierto, y con eso el tipo generado deja de verificar que la
  // columna exista. Dos ramas cuestan dos líneas y conservan la verificación.
  const patch = flag === 'published' ? { published: value } : { available: value }

  const { error } = await supabase
    .from('menu_items')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', tenantId)

  if (error) fail(error)
}

/**
 * Archivar / restaurar. Nunca DELETE: el día que existan order_items su FK con
 * ON DELETE RESTRICT necesita que la fila siga existiendo.
 *
 * Restaurar NO toca published: el item vuelve exactamente como estaba. Si estaba
 * publicado cuando se archivó, vuelve publicado — es lo que el dueño había
 * decidido, y forzarlo a borrador le haría perder ese estado sin avisar.
 */
export async function setMenuItemArchived(
  tenantId: string,
  id: string,
  archived: boolean,
): Promise<void> {
  const supabase = await createClient()
  const { error } = await supabase
    .from('menu_items')
    .update({ deleted_at: archived ? new Date().toISOString() : null })
    .eq('id', id)
    .eq('tenant_id', tenantId)

  if (error) fail(error)
}

// ── Orden ─────────────────────────────────────────────────────────────────────

/**
 * Aplica las escrituras que calcula computeReorder(). El CÁLCULO es puro y vive
 * en lib/dashboard/reorder.ts, con sus propios tests: acá solo queda el I/O.
 *
 * Las escrituras no son atómicas entre sí. Es aceptable: sort_order no tiene
 * constraint, así que lo peor que puede pasar con dos reordenadas simultáneas es
 * un orden raro que la siguiente acción corrige. No hay estado inválido posible.
 */
async function aplicarOrden(
  table: 'menu_categories' | 'menu_items',
  tenantId: string,
  filas: readonly Ordenable[],
  id: string,
  direction: 'up' | 'down',
): Promise<void> {
  const escrituras = computeReorder(filas, id, direction)
  if (escrituras.length === 0) return

  const supabase = await createClient()
  for (const e of escrituras) {
    const { error } = await supabase
      .from(table)
      .update({ sort_order: e.sort_order })
      .eq('id', e.id)
      .eq('tenant_id', tenantId)
    if (error) fail(error)
  }
}

export async function moveMenuCategory(
  tenantId: string,
  id: string,
  direction: 'up' | 'down',
): Promise<void> {
  const categorias = await listMenuCategories(tenantId)
  await aplicarOrden('menu_categories', tenantId, categorias, id, direction)
}

/**
 * Mueve un item dentro de SU categoría. El grupo es la categoría, no el tenant:
 * subir el primer item de "Pizzas" no lo pasa a "Entradas".
 *
 * Solo considera items vigentes: un archivado no ocupa lugar en el orden.
 */
export async function moveMenuItem(
  tenantId: string,
  id: string,
  direction: 'up' | 'down',
): Promise<void> {
  const items = await listMenuItems(tenantId)
  const item = items.find((i) => i.id === id)
  if (!item) return

  const delGrupo = items.filter((i) => i.category_id === item.category_id)
  await aplicarOrden('menu_items', tenantId, delGrupo, id, direction)
}
