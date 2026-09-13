'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  ChefHatIcon,
  PlusIcon,
  PencilIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  EyeIcon,
  EyeOffIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  CircleSlashIcon,
  CircleCheckIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  createMenuCategoryAction,
  updateMenuCategoryAction,
  setMenuCategoryActiveAction,
  moveMenuCategoryAction,
  createMenuItemAction,
  updateMenuItemAction,
  setMenuItemPublishedAction,
  setMenuItemAvailableAction,
  setMenuItemArchivedAction,
  moveMenuItemAction,
} from '@/actions/menu'
import type { MenuCategory, MenuItem } from '@/lib/repositories/menu.repository'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// Mismo layout de acciones que las visitas y las reservas de mesa: en móvil
// apiladas al ancho completo, en desktop en fila y envolviendo si no entran.
// Button trae whitespace-nowrap, así que sin flex-wrap seis botones desbordarían.
const ACCIONES =
  'flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end sm:space-x-0'

/**
 * El precio, con la moneda del TENANT. No hay moneda por producto: el usuario
 * nunca la escribe y acá nunca se elige otra.
 */
function formatPrecio(valor: number, currency: string): string {
  const n = new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(valor)
  return `${currency} ${n}`
}

function Badge({ tone, children }: { tone: 'green' | 'zinc' | 'amber'; children: React.ReactNode }) {
  const clases = {
    green: 'bg-green-100 text-green-800 border-green-200',
    zinc:  'bg-zinc-100 text-zinc-700 border-zinc-200',
    amber: 'bg-amber-100 text-amber-800 border-amber-200',
  }[tone]
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${clases}`}>
      {children}
    </span>
  )
}

// ─── Vacío ───────────────────────────────────────────────────────────────────

function Vacio({ titulo, detalle }: { titulo: string; detalle: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <ChefHatIcon className="h-10 w-10 text-muted-foreground/30" />
      <p className="mt-3 text-sm font-medium">{titulo}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{detalle}</p>
    </div>
  )
}

// ─── Componente principal ────────────────────────────────────────────────────

export function MenuClient({
  categories,
  items,
  archivedItems,
  currency,
  canManage,
  view,
}: {
  categories:    MenuCategory[]
  items:         MenuItem[]
  archivedItems: MenuItem[]
  currency:      string
  canManage:     boolean
  view:          'catalog' | 'archived'
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Categorías
  const [catDialog, setCatDialog] = useState<{ mode: 'create' | 'edit'; cat: MenuCategory | null } | null>(null)
  const [catName, setCatName] = useState('')

  // Items
  const [itemDialog, setItemDialog] = useState<{ mode: 'create' | 'edit'; item: MenuItem | null; categoryId: string } | null>(null)
  const [itemName, setItemName]   = useState('')
  const [itemDesc, setItemDesc]   = useState('')
  const [itemPrice, setItemPrice] = useState('')
  const [itemCat, setItemCat]     = useState('')

  /** Ejecuta una action, avisa y refresca. El servidor es la autoridad. */
  function ejecutar(fn: () => Promise<{ success: boolean; error?: string }>, exito: string, alTerminar?: () => void) {
    startTransition(async () => {
      const res = await fn()
      if (res.success) {
        toast.success(exito)
        alTerminar?.()
        router.refresh()
      } else {
        toast.error(res.error ?? 'Algo salió mal.')
      }
    })
  }

  // ── Categorías ──
  function abrirCrearCategoria() {
    setCatName('')
    setCatDialog({ mode: 'create', cat: null })
  }
  function abrirEditarCategoria(cat: MenuCategory) {
    setCatName(cat.name)
    setCatDialog({ mode: 'edit', cat })
  }
  function guardarCategoria() {
    if (!catDialog) return
    const input = { name: catName }
    const esCrear = catDialog.mode === 'create'
    ejecutar(
      () => (esCrear
        ? createMenuCategoryAction(input)
        : updateMenuCategoryAction(catDialog.cat!.id, input)),
      esCrear ? 'Categoría creada.' : 'Categoría actualizada.',
      () => setCatDialog(null),
    )
  }

  // ── Items ──
  function abrirCrearItem(categoryId: string) {
    setItemName(''); setItemDesc(''); setItemPrice(''); setItemCat(categoryId)
    setItemDialog({ mode: 'create', item: null, categoryId })
  }
  function abrirEditarItem(item: MenuItem) {
    setItemName(item.name)
    setItemDesc(item.description ?? '')
    // toFixed(2) para que el campo muestre el valor tal como quedó persistido.
    setItemPrice(item.base_price.toFixed(2))
    setItemCat(item.category_id)
    setItemDialog({ mode: 'edit', item, categoryId: item.category_id })
  }
  function guardarItem() {
    if (!itemDialog) return
    const input = {
      category_id: itemCat,
      name:        itemName,
      description: itemDesc,
      base_price:  itemPrice,
    }
    const esCrear = itemDialog.mode === 'create'
    ejecutar(
      () => (esCrear
        ? createMenuItemAction(input)
        : updateMenuItemAction(itemDialog.item!.id, input)),
      esCrear ? 'Producto creado.' : 'Producto actualizado.',
      () => setItemDialog(null),
    )
  }

  const archivados = archivedItems.length
  const catsPorId  = new Map(categories.map((c) => [c.id, c]))

  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      {/* ── Pestañas + acción principal ── */}
      <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex gap-1 overflow-x-auto">
          {([
            { value: 'catalog',  label: 'Carta' },
            { value: 'archived', label: `Archivados${archivados > 0 ? ` (${archivados})` : ''}` },
          ] as const).map((t) => (
            <button
              key={t.value}
              onClick={() => router.push(t.value === 'catalog' ? '/dashboard/menu' : '/dashboard/menu?view=archived')}
              className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                view === t.value
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {canManage && view === 'catalog' && (
          <Button size="sm" onClick={abrirCrearCategoria} disabled={isPending} className="w-full sm:w-auto">
            <PlusIcon className="mr-1.5 h-4 w-4" />
            Nueva categoría
          </Button>
        )}
      </div>

      {/* ── Archivados ── */}
      {view === 'archived' && (
        archivados === 0 ? (
          <Vacio
            titulo="No hay productos archivados"
            detalle="Cuando archives un producto va a aparecer acá, y vas a poder restaurarlo."
          />
        ) : (
          <div className="divide-y">
            {archivedItems.map((item) => (
              <div key={item.id} className="px-4 py-3 sm:px-6">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 break-words text-sm font-medium">{item.name}</span>
                  <Badge tone="zinc">Archivado</Badge>
                  <span className="text-sm text-muted-foreground">
                    {formatPrecio(item.base_price, currency)}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {catsPorId.get(item.category_id)?.name ?? 'Categoría eliminada'}
                </p>
                {canManage && (
                  <div className={`mt-2 ${ACCIONES}`}>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isPending}
                      className="w-full sm:w-auto"
                      onClick={() => ejecutar(
                        () => setMenuItemArchivedAction(item.id, false),
                        'Producto restaurado.',
                      )}
                    >
                      <ArchiveRestoreIcon className="mr-1.5 h-4 w-4" />
                      Restaurar
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {/* ── Carta ── */}
      {view === 'catalog' && (
        categories.length === 0 ? (
          <Vacio
            titulo="Todavía no hay categorías"
            detalle={canManage
              ? 'Creá una categoría (Entradas, Pizzas, Bebidas) y después agregale productos.'
              : 'Cuando el dueño cargue la carta la vas a ver acá.'}
          />
        ) : (
          <div className="divide-y">
            {categories.map((cat, catIdx) => {
              const delGrupo = items.filter((i) => i.category_id === cat.id)
              return (
                <section key={cat.id} className="px-4 py-4 sm:px-6">
                  {/* Encabezado de categoría */}
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="min-w-0 break-words text-base font-semibold">{cat.name}</h2>
                      {cat.active
                        ? <Badge tone="green">Activa</Badge>
                        : <Badge tone="zinc">Inactiva</Badge>}
                      <span className="text-xs text-muted-foreground">
                        {delGrupo.length} producto{delGrupo.length !== 1 ? 's' : ''}
                      </span>
                    </div>

                    {canManage && (
                      <div className={ACCIONES}>
                        <Button
                          size="sm" variant="outline" className="w-full sm:w-auto"
                          disabled={isPending || catIdx === 0}
                          onClick={() => ejecutar(() => moveMenuCategoryAction(cat.id, 'up'), 'Orden actualizado.')}
                          aria-label={`Subir ${cat.name}`}
                        >
                          <ChevronUpIcon className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm" variant="outline" className="w-full sm:w-auto"
                          disabled={isPending || catIdx === categories.length - 1}
                          onClick={() => ejecutar(() => moveMenuCategoryAction(cat.id, 'down'), 'Orden actualizado.')}
                          aria-label={`Bajar ${cat.name}`}
                        >
                          <ChevronDownIcon className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm" variant="outline" className="w-full sm:w-auto"
                          disabled={isPending}
                          onClick={() => abrirEditarCategoria(cat)}
                        >
                          <PencilIcon className="mr-1.5 h-4 w-4" />
                          Renombrar
                        </Button>
                        <Button
                          size="sm" variant="outline" className="w-full sm:w-auto"
                          disabled={isPending}
                          onClick={() => ejecutar(
                            () => setMenuCategoryActiveAction(cat.id, !cat.active),
                            cat.active ? 'Categoría desactivada.' : 'Categoría activada.',
                          )}
                        >
                          {cat.active
                            ? <><CircleSlashIcon className="mr-1.5 h-4 w-4" />Desactivar</>
                            : <><CircleCheckIcon className="mr-1.5 h-4 w-4" />Activar</>}
                        </Button>
                        <Button
                          size="sm" className="w-full sm:w-auto"
                          disabled={isPending}
                          onClick={() => abrirCrearItem(cat.id)}
                        >
                          <PlusIcon className="mr-1.5 h-4 w-4" />
                          Producto
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Items */}
                  {delGrupo.length === 0 ? (
                    <p className="mt-3 text-sm text-muted-foreground">
                      Sin productos en esta categoría.
                    </p>
                  ) : (
                    <div className="mt-3 space-y-3">
                      {delGrupo.map((item, itemIdx) => (
                        <div key={item.id} className="rounded-lg border p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="min-w-0 break-words text-sm font-medium">{item.name}</span>
                            <span className="text-sm tabular-nums text-muted-foreground">
                              {formatPrecio(item.base_price, currency)}
                            </span>
                            {item.published
                              ? <Badge tone="green">Publicado</Badge>
                              : <Badge tone="zinc">Borrador</Badge>}
                            {item.available
                              ? <Badge tone="green">Disponible</Badge>
                              : <Badge tone="amber">No disponible</Badge>}
                          </div>

                          {item.description && (
                            <p className="mt-1 break-words text-sm text-muted-foreground">
                              {item.description}
                            </p>
                          )}

                          {canManage && (
                            <div className={`mt-2 ${ACCIONES}`}>
                              <Button
                                size="sm" variant="outline" className="w-full sm:w-auto"
                                disabled={isPending || itemIdx === 0}
                                onClick={() => ejecutar(() => moveMenuItemAction(item.id, 'up'), 'Orden actualizado.')}
                                aria-label={`Subir ${item.name}`}
                              >
                                <ChevronUpIcon className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm" variant="outline" className="w-full sm:w-auto"
                                disabled={isPending || itemIdx === delGrupo.length - 1}
                                onClick={() => ejecutar(() => moveMenuItemAction(item.id, 'down'), 'Orden actualizado.')}
                                aria-label={`Bajar ${item.name}`}
                              >
                                <ChevronDownIcon className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm" variant="outline" className="w-full sm:w-auto"
                                disabled={isPending}
                                onClick={() => abrirEditarItem(item)}
                              >
                                <PencilIcon className="mr-1.5 h-4 w-4" />
                                Editar
                              </Button>
                              <Button
                                size="sm" variant="outline" className="w-full sm:w-auto"
                                disabled={isPending}
                                onClick={() => ejecutar(
                                  () => setMenuItemPublishedAction(item.id, !item.published),
                                  item.published ? 'Producto despublicado.' : 'Producto publicado.',
                                )}
                              >
                                {item.published
                                  ? <><EyeOffIcon className="mr-1.5 h-4 w-4" />Despublicar</>
                                  : <><EyeIcon className="mr-1.5 h-4 w-4" />Publicar</>}
                              </Button>
                              <Button
                                size="sm" variant="outline" className="w-full sm:w-auto"
                                disabled={isPending}
                                onClick={() => ejecutar(
                                  () => setMenuItemAvailableAction(item.id, !item.available),
                                  item.available ? 'Marcado como no disponible.' : 'Marcado como disponible.',
                                )}
                              >
                                {item.available
                                  ? <><CircleSlashIcon className="mr-1.5 h-4 w-4" />No disponible</>
                                  : <><CircleCheckIcon className="mr-1.5 h-4 w-4" />Disponible</>}
                              </Button>
                              <Button
                                size="sm" variant="outline" className="w-full sm:w-auto"
                                disabled={isPending}
                                onClick={() => ejecutar(
                                  () => setMenuItemArchivedAction(item.id, true),
                                  'Producto archivado.',
                                )}
                              >
                                <ArchiveIcon className="mr-1.5 h-4 w-4" />
                                Archivar
                              </Button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        )
      )}

      {/* ── Diálogo de categoría ── */}
      <Dialog open={catDialog !== null} onOpenChange={(o) => !o && setCatDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {catDialog?.mode === 'create' ? 'Nueva categoría' : 'Renombrar categoría'}
            </DialogTitle>
            <DialogDescription>
              Las categorías agrupan la carta y definen en qué orden se lee.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="cat-name">Nombre</Label>
            <Input
              id="cat-name"
              value={catName}
              maxLength={60}
              placeholder="Entradas"
              onChange={(e) => setCatName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              No puede repetirse dentro de tu organización, sin distinguir mayúsculas ni espacios.
            </p>
          </div>

          <DialogFooter className={ACCIONES}>
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => setCatDialog(null)} disabled={isPending}>
              Cancelar
            </Button>
            <Button className="w-full sm:w-auto" onClick={guardarCategoria} disabled={isPending || catName.trim().length === 0}>
              {isPending ? 'Guardando…' : 'Guardar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Diálogo de producto ── */}
      <Dialog open={itemDialog !== null} onOpenChange={(o) => !o && setItemDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {itemDialog?.mode === 'create' ? 'Nuevo producto' : 'Editar producto'}
            </DialogTitle>
            <DialogDescription>
              {itemDialog?.mode === 'create'
                ? 'Nace como borrador y disponible: publicalo cuando esté listo.'
                : 'Publicado y disponible se cambian desde los botones de la fila.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="item-cat">Categoría</Label>
              <select
                id="item-cat"
                value={itemCat}
                onChange={(e) => setItemCat(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.active ? '' : ' (inactiva)'}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="item-name">Nombre</Label>
              <Input
                id="item-name"
                value={itemName}
                maxLength={120}
                placeholder="Pizza Muzzarella Chica"
                onChange={(e) => setItemName(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="item-desc">Descripción</Label>
              <Textarea
                id="item-desc"
                value={itemDesc}
                maxLength={1000}
                rows={3}
                placeholder="Salsa de tomate, muzzarella y orégano."
                onChange={(e) => setItemDesc(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="item-price">Precio</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="item-price"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={itemPrice}
                  placeholder="12000.00"
                  onChange={(e) => setItemPrice(e.target.value)}
                />
                {/* La moneda es del tenant y no se puede escribir acá. */}
                <span className="shrink-0 text-sm font-medium text-muted-foreground">{currency}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Hasta dos decimales. 0 significa gratis.
              </p>
            </div>
          </div>

          <DialogFooter className={ACCIONES}>
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => setItemDialog(null)} disabled={isPending}>
              Cancelar
            </Button>
            <Button
              className="w-full sm:w-auto"
              onClick={guardarItem}
              disabled={isPending || itemName.trim().length === 0 || itemPrice.trim().length === 0 || !itemCat}
            >
              {isPending ? 'Guardando…' : 'Guardar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
