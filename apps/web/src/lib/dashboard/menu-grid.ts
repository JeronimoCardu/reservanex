import { menuPriceSchema } from '@orderflow/validators'

// Refinamiento UX de 3E-C3A1 — la lógica de la grilla del menú, pura y sin React.
//
// Todo lo que decide QUÉ se ve y QUÉ cambió vive acá, sin hooks ni JSX, para que
// se pueda probar sin renderizar nada (el entorno de vitest es 'node', sin
// jsdom). El componente se queda con el estado y el marcado.
//
// Nada de esto toca el servidor: el catálogo completo llega en el primer render
// y filtrar es recorrer un array en memoria. Para una carta de ~300 items es
// instantáneo y evita un fetch por tecla.

// ── Fila de la grilla ───────────────────────────────────────────────────────
//
// Junta el item con los datos de su categoría que la grilla necesita mostrar y
// buscar. `price` es STRING a propósito: es lo que el usuario tiene tipeado, y
// tiene que sobrevivir tal cual hasta que el schema canónico lo valide. Si lo
// guardáramos como number, "1500.999" ya estaría redondeado antes de que nadie
// pueda rechazarlo.
export interface MenuGridRow {
  id:             string
  categoryId:     string
  categoryName:   string
  categoryActive: boolean
  name:           string
  description:    string
  price:          string
  published:      boolean
  available:      boolean
  archived:       boolean
}

/** Los campos que el usuario puede editar en la fila. */
export type MenuRowDraft = Pick<
  MenuGridRow,
  'categoryId' | 'name' | 'description' | 'price' | 'published' | 'available'
>

export function draftFromRow(row: MenuGridRow): MenuRowDraft {
  return {
    categoryId:  row.categoryId,
    name:        row.name,
    description: row.description,
    price:       row.price,
    published:   row.published,
    available:   row.available,
  }
}

// ── Vocabulario: tres dimensiones, tres pares de palabras ───────────────────
//
// Se separan acá, en un solo lugar, porque dos de ellas se confundían en
// pantalla: la columna de deleted_at decía "Activo" en verde, justo al lado de
// un toggle de disponibilidad apagado. "Activo" y "Disponible" se leían como lo
// mismo siendo cosas distintas.
//
//   Publicación     published    Publicado / Borrador          ¿se ve en la carta?
//   Disponibilidad  available    Disponible / No disponible    ¿se puede pedir hoy?
//   Registro        deleted_at   Vigente / Archivado           ¿la fila sigue en uso?
//
// "Activo" queda fuera del vocabulario de los productos. La palabra sobrevive
// solo para las CATEGORÍAS, donde sí corresponde a menu_categories.active.

export function publicacionLabel(published: boolean): 'Publicado' | 'Borrador' {
  return published ? 'Publicado' : 'Borrador'
}

export function disponibilidadLabel(available: boolean): 'Disponible' | 'No disponible' {
  return available ? 'Disponible' : 'No disponible'
}

export function registroLabel(archived: boolean): 'Vigente' | 'Archivado' {
  return archived ? 'Archivado' : 'Vigente'
}

/** Las tres etiquetas de una fila, cada una de SU columna. */
export function menuRowLabels(row: Pick<MenuGridRow, 'published' | 'available' | 'archived'>): {
  publicacion:    'Publicado' | 'Borrador'
  disponibilidad: 'Disponible' | 'No disponible'
  registro:       'Vigente' | 'Archivado'
} {
  return {
    publicacion:    publicacionLabel(row.published),
    disponibilidad: disponibilidadLabel(row.available),
    registro:       registroLabel(row.archived),
  }
}

/**
 * Los ids de las categorías inactivas.
 *
 * Solo sirve para AVISAR en la fila. Que la categoría de un producto esté
 * inactiva no cambia su published, su available ni su deleted_at: son datos del
 * producto y esto es presentación.
 */
export function inactiveCategoryIds(
  categories: readonly { id: string; active: boolean }[],
): Set<string> {
  return new Set(categories.filter((c) => !c.active).map((c) => c.id))
}

// ── Filtros ─────────────────────────────────────────────────────────────────

export type PublicationFilter  = 'all' | 'published' | 'draft'
export type AvailabilityFilter = 'all' | 'available' | 'unavailable'
export type StatusFilter       = 'active' | 'archived' | 'all'

export interface MenuFilters {
  query:        string
  categoryId:   string | 'all'
  publication:  PublicationFilter
  availability: AvailabilityFilter
  status:       StatusFilter
}

/**
 * El estado inicial. `status: 'active'` no es arbitrario: es el comportamiento
 * que ya tenía la pantalla anterior —la carta muestra lo vigente y los
 * archivados se buscan a propósito— así que no se considera un filtro activo.
 */
export const EMPTY_FILTERS: MenuFilters = {
  query:        '',
  categoryId:   'all',
  publication:  'all',
  availability: 'all',
  status:       'active',
}

/** Si hay algo que "Limpiar filtros" pueda limpiar. */
export function hasActiveFilters(f: MenuFilters): boolean {
  return (
    f.query.trim() !== '' ||
    f.categoryId !== EMPTY_FILTERS.categoryId ||
    f.publication !== EMPTY_FILTERS.publication ||
    f.availability !== EMPTY_FILTERS.availability ||
    f.status !== EMPTY_FILTERS.status
  )
}

/** Cuántos filtros distintos de búsqueda están activos, para el badge de móvil. */
export function activeFilterCount(f: MenuFilters): number {
  let n = 0
  if (f.categoryId !== EMPTY_FILTERS.categoryId) n++
  if (f.publication !== EMPTY_FILTERS.publication) n++
  if (f.availability !== EMPTY_FILTERS.availability) n++
  if (f.status !== EMPTY_FILTERS.status) n++
  return n
}

const normalizar = (s: string) => s.trim().toLowerCase()

/**
 * Aplica búsqueda y filtros. Devuelve un arreglo NUEVO y no toca el original:
 * el dataset del servidor es la única fuente de verdad de lo que existe, y
 * filtrar es una vista sobre él.
 *
 * La búsqueda mira nombre, descripción y nombre de la categoría, sin distinguir
 * mayúsculas y recortando espacios.
 */
export function filterMenuRows(
  rows: readonly MenuGridRow[],
  filters: MenuFilters,
): MenuGridRow[] {
  const q = normalizar(filters.query)

  return rows.filter((row) => {
    if (filters.status === 'active'   && row.archived) return false
    if (filters.status === 'archived' && !row.archived) return false

    if (filters.categoryId !== 'all' && row.categoryId !== filters.categoryId) return false

    if (filters.publication === 'published' && !row.published) return false
    if (filters.publication === 'draft'     &&  row.published) return false

    if (filters.availability === 'available'   && !row.available) return false
    if (filters.availability === 'unavailable' &&  row.available) return false

    if (q === '') return true
    return (
      normalizar(row.name).includes(q) ||
      normalizar(row.description).includes(q) ||
      normalizar(row.categoryName).includes(q)
    )
  })
}

// ── Cambios sin guardar ─────────────────────────────────────────────────────

/**
 * Si dos precios escritos significan lo mismo.
 *
 * Se comparan como NÚMEROS cuando los dos son válidos, para que escribir
 * "1500.5" sobre un "1500.50" no marque la fila como modificada: es el mismo
 * dinero y guardarlo no cambiaría nada en la base. Si alguno no parsea (el
 * usuario está a mitad de tipear, o escribió algo inválido), se comparan como
 * texto, así la fila queda marcada y el error se ve al guardar.
 *
 * Usa menuPriceSchema, el mismo y único parser de precios del producto.
 */
export function samePrice(a: string, b: string): boolean {
  const pa = menuPriceSchema.safeParse(a)
  const pb = menuPriceSchema.safeParse(b)
  if (pa.success && pb.success) return pa.data === pb.data
  return a.trim() === b.trim()
}

/** Si el borrador difiere de lo que hay guardado. */
export function isRowDirty(original: MenuGridRow, draft: MenuRowDraft): boolean {
  return (
    draft.categoryId !== original.categoryId ||
    draft.name.trim() !== original.name.trim() ||
    draft.description.trim() !== original.description.trim() ||
    draft.published !== original.published ||
    draft.available !== original.available ||
    !samePrice(draft.price, original.price)
  )
}

/**
 * Los ids de las filas modificadas.
 *
 * Se compara VALOR contra VALOR, no un flag de "alguien tocó esto": si el
 * usuario edita y después vuelve a mano al valor original, la fila deja de estar
 * modificada, que es lo que espera cualquiera que use una planilla.
 */
export function dirtyRowIds(
  rows: readonly MenuGridRow[],
  drafts: Readonly<Record<string, MenuRowDraft>>,
): string[] {
  return rows
    .filter((row) => {
      const d = drafts[row.id]
      return d !== undefined && isRowDirty(row, d)
    })
    .map((row) => row.id)
}

/** El patch que se manda al servidor por cada fila modificada. */
export interface MenuRowChange {
  id:          string
  category_id: string
  name:        string
  description: string
  base_price:  string
  published:   boolean
  available:   boolean
}

/**
 * Arma el lote a guardar: SOLO las filas modificadas.
 *
 * `base_price` viaja como string tal como se escribió. El servidor lo valida con
 * menuPriceSchema antes de persistir, así que "1500.999" se rechaza con mensaje
 * en vez de redondearse en silencio.
 */
export function buildChanges(
  rows: readonly MenuGridRow[],
  drafts: Readonly<Record<string, MenuRowDraft>>,
): MenuRowChange[] {
  const dirty = new Set(dirtyRowIds(rows, drafts))
  return rows
    .filter((row) => dirty.has(row.id))
    .map((row) => {
      const d = drafts[row.id]!
      return {
        id:          row.id,
        category_id: d.categoryId,
        name:        d.name.trim(),
        description: d.description.trim(),
        base_price:  d.price.trim(),
        published:   d.published,
        available:   d.available,
      }
    })
}

/** Todos los borradores, reseteados a lo que hay guardado. Para "Descartar". */
export function draftsFromRows(rows: readonly MenuGridRow[]): Record<string, MenuRowDraft> {
  const out: Record<string, MenuRowDraft> = {}
  for (const row of rows) out[row.id] = draftFromRow(row)
  return out
}
