'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  ChefHatIcon,
  PlusIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  XIcon,
  MoreHorizontalIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  AlertCircleIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  createMenuItemAction,
  saveMenuItemsAction,
  setMenuItemArchivedAction,
  moveMenuItemAction,
} from '@/actions/menu'
import type { MenuCategory } from '@/lib/repositories/menu.repository'
import {
  EMPTY_FILTERS,
  activeFilterCount,
  buildChanges,
  dirtyRowIds,
  disponibilidadLabel,
  draftsFromRows,
  filterMenuRows,
  hasActiveFilters,
  inactiveCategoryIds,
  publicacionLabel,
  registroLabel,
  type MenuFilters,
  type MenuGridRow,
  type MenuRowDraft,
} from '@/lib/dashboard/menu-grid'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { MenuCategoriesDialog } from './menu-categories-dialog'

// Refinamiento UX de 3E-C3A1 — la carta como planilla.
//
// La pantalla anterior era categoría → tarjeta → diálogo → editar → cerrar →
// siguiente. Para una carta de decenas de productos eso es un diálogo por
// producto. Acá se edita en la fila y se guarda todo junto.
//
// ── UNA SOLA ESTRUCTURA PARA LOS DOS TAMAÑOS ────────────────────────────────
//
// No hay dos árboles de JSX (uno tabla, otro tarjetas). Cada fila es un
// contenedor que en md+ es un grid de columnas alineado con el encabezado, y en
// móvil se apila con etiquetas visibles. Duplicar el marcado habría significado
// duplicar también la lógica de edición y que las dos versiones se separaran a
// la primera corrección.
//
// ── TRES DIMENSIONES, TRES VOCABULARIOS ─────────────────────────────────────
//
// Se confundían dos de ellas, así que quedan separadas también en las palabras:
//
//   Publicación     published    Publicado / Borrador
//   Disponibilidad  available    Disponible / No disponible
//   Registro        deleted_at   Vigente / Archivado
//
// "Activo" se eliminó del vocabulario de los productos: era el rótulo de
// deleted_at y se leía como "disponible". La palabra "activa" sobrevive solo
// para las CATEGORÍAS, donde sí corresponde a menu_categories.active.
//
// ── QUÉ MIRAN LOS FILTROS ───────────────────────────────────────────────────
//
// Los filtros se aplican sobre los valores GUARDADOS, no sobre el borrador. Así
// una fila no se esfuma mientras la estás editando —si buscás "pizza" y le
// cambiás el nombre, sigue ahí hasta que guardes— y lo que ves filtrado siempre
// corresponde a lo que hay en la base.

const COLS =
  'md:grid md:grid-cols-[132px_minmax(0,1.15fr)_minmax(0,1.5fr)_118px_76px_86px_78px_52px] md:items-start md:gap-2'

const CAMPO = 'h-9 w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm ' +
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ' +
  'disabled:cursor-not-allowed disabled:opacity-60'

/** Etiqueta que solo se ve en móvil, donde la fila no tiene encabezado. */
function Etiqueta({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-0.5 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:hidden">
      {children}
    </span>
  )
}

/** Toggle accesible. Mismo patrón que el diálogo de permisos: sin dependencias. */
function Toggle({
  checked, onChange, disabled, label, title,
}: {
  checked: boolean; onChange: () => void; disabled: boolean; label: string; title?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      // El estado en palabras, al pasar el mouse. aria-checked ya lo comunica a
      // un lector de pantalla; esto es para quien ve el interruptor y duda.
      title={title}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        checked ? 'bg-primary' : 'bg-input',
      )}
    >
      <span
        className={cn(
          'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  )
}

function Select({
  value, onChange, disabled, ariaLabel, children, className,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  ariaLabel: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn(CAMPO, className)}
    >
      {children}
    </select>
  )
}

// ─── Componente ──────────────────────────────────────────────────────────────

export function MenuClient({
  rows,
  categories,
  currency,
  canManage,
}: {
  rows:       MenuGridRow[]
  categories: MenuCategory[]
  currency:   string
  canManage:  boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [filters, setFilters] = useState<MenuFilters>(EMPTY_FILTERS)
  const [filtrosAbiertos, setFiltrosAbiertos] = useState(false)
  const [categoriasAbiertas, setCategoriasAbiertas] = useState(false)

  // Filas que el último guardado NO pudo persistir. Sus borradores se conservan
  // para que el usuario no pierda lo que escribió.
  const [fallidas, setFallidas] = useState<Record<string, MenuRowDraft>>({})

  // ── Borradores, sincronizados con el servidor ──
  //
  // Cuando cambian los datos del servidor (guardar, archivar, reordenar, crear)
  // los borradores se rehacen desde las props. Es seguro porque todas esas
  // acciones están bloqueadas mientras hay cambios sin guardar: o no había nada
  // pendiente, o acabamos de guardarlo. Lo único que sobrevive al resync son las
  // filas que fallaron.
  const firma = useMemo(
    () => rows.map((r) =>
      `${r.id}|${r.categoryId}|${r.name}|${r.description}|${r.price}|${r.published}|${r.available}|${r.archived}`,
    ).join('§'),
    [rows],
  )
  const [firmaSync, setFirmaSync] = useState(firma)
  const [drafts, setDrafts] = useState<Record<string, MenuRowDraft>>(() => draftsFromRows(rows))

  if (firma !== firmaSync) {
    setFirmaSync(firma)
    setDrafts({ ...draftsFromRows(rows), ...fallidas })
  }

  const dirtyIds = useMemo(() => dirtyRowIds(rows, drafts), [rows, drafts])
  const dirtySet = useMemo(() => new Set(dirtyIds), [dirtyIds])
  const hayCambios = dirtyIds.length > 0

  const visibles = useMemo(() => filterMenuRows(rows, filters), [rows, filters])
  const filtrando = hasActiveFilters(filters)
  const nFiltros  = activeFilterCount(filters)

  // Mientras hay cambios sin guardar, las acciones que recargan datos del
  // servidor quedan bloqueadas: si no, el resync pisaría lo que el usuario está
  // editando. Es una regla explícita y no un efecto raro.
  const bloqueadoPorCambios = canManage && hayCambios
  const puedeEditar = canManage && !isPending

  const inactivas = useMemo(() => inactiveCategoryIds(categories), [categories])
  const categoriaInactiva = (id: string) => inactivas.has(id)

  function editar(id: string, patch: Partial<MenuRowDraft>) {
    setDrafts((d) => ({ ...d, [id]: { ...d[id]!, ...patch } }))
  }

  function ejecutar(
    fn: () => Promise<{ success: boolean; error?: string }>,
    exito: string,
  ) {
    startTransition(async () => {
      const res = await fn()
      if (res.success) { toast.success(exito); router.refresh() }
      else toast.error(res.error ?? 'Algo salió mal.')
    })
  }

  // ── Guardar ──
  function guardar() {
    const changes = buildChanges(rows, drafts)
    if (changes.length === 0) return

    startTransition(async () => {
      const res = await saveMenuItemsAction({ changes })
      if (!res.success) { toast.error(res.error); return }

      const failed = res.data?.failed ?? []
      if (failed.length === 0) {
        setFallidas({})
        toast.success(`${changes.length} producto${changes.length !== 1 ? 's' : ''} guardado${changes.length !== 1 ? 's' : ''}.`)
      } else {
        // Se conservan los borradores de las que fallaron: el usuario no tiene
        // por qué reescribir lo que el servidor rechazó.
        const conservar: Record<string, MenuRowDraft> = {}
        for (const f of failed) { const d = drafts[f.id]; if (d) conservar[f.id] = d }
        setFallidas(conservar)
        toast.error(
          `${failed.length} de ${changes.length} no se guardaron.`,
          { description: failed.map((f) => f.error).join(' · ') },
        )
      }
      router.refresh()
    })
  }

  function descartar() {
    setDrafts(draftsFromRows(rows))
    setFallidas({})
  }

  // ── Crear producto, inline ──
  const [nuevo, setNuevo] = useState({ categoryId: '', name: '', description: '', price: '' })
  const [creando, setCreando] = useState(false)

  function abrirNuevo() {
    setNuevo({ categoryId: categories[0]?.id ?? '', name: '', description: '', price: '' })
    setCreando(true)
  }

  function crear() {
    startTransition(async () => {
      const res = await createMenuItemAction({
        category_id: nuevo.categoryId,
        name:        nuevo.name,
        description: nuevo.description,
        base_price:  nuevo.price,
      })
      if (res.success) {
        toast.success('Producto creado.')
        setNuevo({ categoryId: nuevo.categoryId, name: '', description: '', price: '' })
        router.refresh()
      } else toast.error(res.error)
    })
  }

  const sinCategorias = categories.length === 0

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* ── Barra de herramientas ── */}
      <div className="space-y-3 border-b px-4 py-3 sm:px-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filters.query}
              onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
              placeholder="Buscar productos…"
              aria-label="Buscar productos"
              className="pl-8"
            />
          </div>

          {/* En móvil los filtros viven detrás de un botón; la búsqueda no. */}
          <Button
            variant="outline" size="sm"
            className="w-full sm:hidden"
            onClick={() => setFiltrosAbiertos((v) => !v)}
          >
            <SlidersHorizontalIcon className="mr-1.5 h-4 w-4" />
            Filtros{nFiltros > 0 ? ` (${nFiltros})` : ''}
          </Button>

          {canManage && (
            <div className="flex gap-2">
              <Button
                size="sm" variant="outline" className="flex-1 sm:flex-none"
                disabled={isPending || bloqueadoPorCambios}
                title={bloqueadoPorCambios ? 'Guardá o descartá los cambios primero' : undefined}
                onClick={() => setCategoriasAbiertas(true)}
              >
                Categorías
              </Button>
              <Button
                size="sm" className="flex-1 sm:flex-none"
                disabled={isPending || bloqueadoPorCambios || sinCategorias}
                title={
                  sinCategorias ? 'Creá una categoría primero'
                    : bloqueadoPorCambios ? 'Guardá o descartá los cambios primero' : undefined
                }
                onClick={abrirNuevo}
              >
                <PlusIcon className="mr-1.5 h-4 w-4" />
                Producto
              </Button>
            </div>
          )}
        </div>

        {/* Filtros: siempre visibles en sm+, plegables en móvil. */}
        <div className={cn('flex-col gap-2 sm:flex sm:flex-row sm:flex-wrap sm:items-center',
          filtrosAbiertos ? 'flex' : 'hidden sm:flex')}>
          <Select
            ariaLabel="Filtrar por categoría"
            value={filters.categoryId}
            onChange={(v) => setFilters((f) => ({ ...f, categoryId: v }))}
            className="sm:w-auto"
          >
            <option value="all">Todas las categorías</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.active ? '' : ' (inactiva)'}</option>
            ))}
          </Select>

          {/* Registro = la dimensión de deleted_at. NUNCA "Activos": eso se
              confundía con "Disponible", que es otra cosa y otra columna. */}
          <Select
            ariaLabel="Filtrar por registro"
            value={filters.status}
            onChange={(v) => setFilters((f) => ({ ...f, status: v as MenuFilters['status'] }))}
            className="sm:w-auto"
          >
            <option value="active">Vigentes</option>
            <option value="archived">Archivados</option>
            <option value="all">Todos los registros</option>
          </Select>

          <Select
            ariaLabel="Filtrar por publicación"
            value={filters.publication}
            onChange={(v) => setFilters((f) => ({ ...f, publication: v as MenuFilters['publication'] }))}
            className="sm:w-auto"
          >
            <option value="all">Publicación: todos</option>
            <option value="published">Publicados</option>
            <option value="draft">Borradores</option>
          </Select>

          <Select
            ariaLabel="Filtrar por disponibilidad"
            value={filters.availability}
            onChange={(v) => setFilters((f) => ({ ...f, availability: v as MenuFilters['availability'] }))}
            className="sm:w-auto"
          >
            <option value="all">Disponibilidad: todos</option>
            <option value="available">Disponibles</option>
            <option value="unavailable">No disponibles</option>
          </Select>

          {/* Solo aparece si hay algo que limpiar. */}
          {filtrando && (
            <Button variant="ghost" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
              <XIcon className="mr-1.5 h-4 w-4" />
              Limpiar filtros
            </Button>
          )}
        </div>

        {/* Contador */}
        <p className="text-xs text-muted-foreground">
          {rows.length} producto{rows.length !== 1 ? 's' : ''}
          {filtrando && <> · <span className="font-medium text-foreground">{visibles.length} visible{visibles.length !== 1 ? 's' : ''}</span></>}
        </p>
      </div>

      {/* ── Alta inline ── */}
      {canManage && creando && (
        <div className="border-b bg-muted/30 px-4 py-3 sm:px-6">
          <div className={cn('space-y-2 md:space-y-0', COLS)}>
            <div>
              <Etiqueta>Categoría</Etiqueta>
              <Select
                ariaLabel="Categoría del producto nuevo"
                value={nuevo.categoryId}
                onChange={(v) => setNuevo((n) => ({ ...n, categoryId: v }))}
                disabled={isPending}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.active ? '' : ' (inactiva)'}</option>
                ))}
              </Select>
            </div>
            <div>
              <Etiqueta>Producto</Etiqueta>
              <input
                className={CAMPO} maxLength={120} autoFocus
                aria-label="Nombre del producto nuevo"
                placeholder="Pizza Muzzarella Chica"
                value={nuevo.name} disabled={isPending}
                onChange={(e) => setNuevo((n) => ({ ...n, name: e.target.value }))}
              />
            </div>
            <div>
              <Etiqueta>Descripción</Etiqueta>
              <input
                className={CAMPO} maxLength={1000}
                aria-label="Descripción del producto nuevo"
                placeholder="Salsa, muzzarella y orégano"
                value={nuevo.description} disabled={isPending}
                onChange={(e) => setNuevo((n) => ({ ...n, description: e.target.value }))}
              />
            </div>
            <div>
              <Etiqueta>Precio ({currency})</Etiqueta>
              <input
                className={cn(CAMPO, 'tabular-nums')} inputMode="decimal"
                aria-label="Precio del producto nuevo"
                placeholder="12000.00"
                value={nuevo.price} disabled={isPending}
                onChange={(e) => setNuevo((n) => ({ ...n, price: e.target.value }))}
              />
            </div>
            <div className="md:col-span-4 md:flex md:items-center md:justify-end md:gap-2">
              <p className="mb-2 text-xs text-muted-foreground md:mb-0 md:mr-auto">
                Nace como borrador y disponible.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="flex-1 md:flex-none"
                  disabled={isPending} onClick={() => setCreando(false)}>
                  Cerrar
                </Button>
                <Button size="sm" className="flex-1 md:flex-none"
                  disabled={isPending || nuevo.name.trim() === '' || nuevo.price.trim() === '' || !nuevo.categoryId}
                  onClick={crear}>
                  {isPending ? 'Creando…' : 'Crear'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Encabezado de la grilla (solo md+) ── */}
      <div className={cn('hidden border-b bg-muted/40 px-4 py-2 sm:px-6 md:block', COLS)}>
        {['Categoría', 'Producto', 'Descripción', `Precio (${currency})`, 'Publicado', 'Disponible', 'Registro', ''].map((h, i) => (
          <span key={i} className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{h}</span>
        ))}
      </div>

      {/* ── Filas ── */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-24">
        {rows.length === 0 ? (
          <Vacio
            titulo="Todavía no hay productos"
            detalle={canManage
              ? sinCategorias
                ? 'Creá una categoría desde "Categorías" y después agregá productos.'
                : 'Usá "+ Producto" para cargar el primero.'
              : 'Cuando se cargue la carta la vas a ver acá.'}
          />
        ) : visibles.length === 0 ? (
          <Vacio
            titulo="Ningún producto coincide"
            detalle="Probá con otra búsqueda o limpiá los filtros."
          />
        ) : (
          <div className="divide-y">
            {visibles.map((row) => {
              const d = drafts[row.id]
              if (!d) return null
              const sucia  = dirtySet.has(row.id)
              const fallo  = fallidas[row.id] !== undefined
              // Solo se puede reordenar con la vista completa: con un filtro
              // activo el vecino puede estar oculto y el botón parecería no hacer
              // nada.
              const puedeOrdenar = puedeEditar && !bloqueadoPorCambios && !filtrando && !row.archived

              return (
                <div
                  key={row.id}
                  className={cn(
                    'space-y-2 px-4 py-3 sm:px-6 md:space-y-0',
                    COLS,
                    row.archived && 'bg-muted/20',
                    sucia && 'bg-amber-50/60',
                    fallo && 'bg-red-50/70',
                  )}
                >
                  <div>
                    <Etiqueta>Categoría</Etiqueta>
                    <Select
                      ariaLabel={`Categoría de ${row.name}`}
                      value={d.categoryId}
                      disabled={!puedeEditar}
                      onChange={(v) => editar(row.id, { categoryId: v })}
                    >
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}{c.active ? '' : ' (inactiva)'}</option>
                      ))}
                    </Select>
                    {/* Solo presentación: que la categoría esté inactiva no
                        cambia published, available ni deleted_at del producto.
                        Se mira la categoría del BORRADOR y no la guardada, así
                        el aviso aparece en el momento en que se mueve el item. */}
                    {categoriaInactiva(d.categoryId) && (
                      <span className="mt-1 block text-[11px] font-medium text-amber-700">
                        Categoría inactiva
                      </span>
                    )}
                  </div>

                  <div>
                    <Etiqueta>Producto</Etiqueta>
                    <input
                      className={CAMPO} maxLength={120}
                      aria-label={`Nombre de ${row.name}`}
                      value={d.name} disabled={!puedeEditar} readOnly={!canManage}
                      onChange={(e) => editar(row.id, { name: e.target.value })}
                    />
                  </div>

                  <div>
                    <Etiqueta>Descripción</Etiqueta>
                    <input
                      className={CAMPO} maxLength={1000}
                      aria-label={`Descripción de ${row.name}`}
                      placeholder="—"
                      value={d.description} disabled={!puedeEditar} readOnly={!canManage}
                      onChange={(e) => editar(row.id, { description: e.target.value })}
                    />
                  </div>

                  <div>
                    <Etiqueta>Precio ({currency})</Etiqueta>
                    <input
                      className={cn(CAMPO, 'tabular-nums')} inputMode="decimal"
                      aria-label={`Precio de ${row.name}`}
                      value={d.price} disabled={!puedeEditar} readOnly={!canManage}
                      onChange={(e) => editar(row.id, { price: e.target.value })}
                    />
                  </div>

                  <div className="flex items-center gap-2 md:h-9">
                    <Etiqueta>Publicado</Etiqueta>
                    <Toggle
                      checked={d.published} disabled={!puedeEditar}
                      label={`Publicado: ${row.name}`}
                      title={publicacionLabel(d.published)}
                      onChange={() => editar(row.id, { published: !d.published })}
                    />
                  </div>

                  <div className="flex items-center gap-2 md:h-9">
                    <Etiqueta>Disponible</Etiqueta>
                    <Toggle
                      checked={d.available} disabled={!puedeEditar}
                      title={disponibilidadLabel(d.available)}
                      label={`Disponible: ${row.name}`}
                      onChange={() => editar(row.id, { available: !d.available })}
                    />
                  </div>

                  {/* REGISTRO: existe o está archivado (deleted_at). Es una
                      dimensión distinta de Publicado y de Disponible, y por eso
                      no usa el verde de "disponible": un producto no disponible
                      mostraba "Activo" en verde justo al lado del toggle en
                      "No disponible", y las dos cosas se leían como la misma.
                      Vigente es el estado normal y va discreto; Archivado es el
                      excepcional y es el que tiene que saltar. */}
                  <div className="flex items-center gap-2 md:h-9">
                    <Etiqueta>Registro</Etiqueta>
                    <span className={cn(
                      'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                      row.archived
                        ? 'border-zinc-400 bg-zinc-200 text-zinc-800'
                        : 'border-zinc-200 bg-transparent text-muted-foreground',
                    )}>
                      {registroLabel(row.archived)}
                    </span>
                    {fallo && (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 md:hidden">
                        <AlertCircleIcon className="h-3.5 w-3.5" /> No se guardó
                      </span>
                    )}
                  </div>

                  {/* Acciones secundarias. Las frecuentes (publicado/disponible)
                      son toggles visibles; el resto vive acá. */}
                  <div className="flex items-center justify-end gap-1 md:h-9">
                    {canManage && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-8 w-8 p-0"
                            aria-label={`Acciones de ${row.name}`} disabled={isPending}>
                            <MoreHorizontalIcon className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            disabled={!puedeOrdenar}
                            onClick={() => ejecutar(() => moveMenuItemAction(row.id, 'up'), 'Orden actualizado.')}
                          >
                            <ChevronUpIcon className="mr-2 h-4 w-4" /> Subir
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={!puedeOrdenar}
                            onClick={() => ejecutar(() => moveMenuItemAction(row.id, 'down'), 'Orden actualizado.')}
                          >
                            <ChevronDownIcon className="mr-2 h-4 w-4" /> Bajar
                          </DropdownMenuItem>
                          {row.archived ? (
                            <DropdownMenuItem
                              disabled={isPending || bloqueadoPorCambios}
                              onClick={() => ejecutar(() => setMenuItemArchivedAction(row.id, false), 'Producto restaurado.')}
                            >
                              <ArchiveRestoreIcon className="mr-2 h-4 w-4" /> Restaurar
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              disabled={isPending || bloqueadoPorCambios}
                              onClick={() => ejecutar(() => setMenuItemArchivedAction(row.id, true), 'Producto archivado.')}
                            >
                              <ArchiveIcon className="mr-2 h-4 w-4" /> Archivar
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Barra de cambios sin guardar ── */}
      {canManage && hayCambios && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 py-3 shadow-lg backdrop-blur sm:px-6 lg:left-56">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-medium">
              {dirtyIds.length} cambio{dirtyIds.length !== 1 ? 's' : ''} sin guardar
              {Object.keys(fallidas).length > 0 && (
                <span className="ml-2 text-red-700">
                  · {Object.keys(fallidas).length} no se pudo guardar
                </span>
              )}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="flex-1 sm:flex-none"
                disabled={isPending} onClick={descartar}>
                Descartar
              </Button>
              <Button size="sm" className="flex-1 sm:flex-none"
                disabled={isPending} onClick={guardar}>
                {isPending ? 'Guardando…' : 'Guardar cambios'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <MenuCategoriesDialog
        open={categoriasAbiertas}
        onOpenChange={setCategoriasAbiertas}
        categories={categories}
        canManage={canManage}
      />
    </div>
  )
}

function Vacio({ titulo, detalle }: { titulo: string; detalle: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <ChefHatIcon className="h-10 w-10 text-muted-foreground/30" />
      <p className="mt-3 text-sm font-medium">{titulo}</p>
      <p className="mt-1 max-w-sm px-4 text-sm text-muted-foreground">{detalle}</p>
    </div>
  )
}
