'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  PlusIcon, PencilIcon, CheckIcon, XIcon,
  ChevronUpIcon, ChevronDownIcon, CircleSlashIcon, CircleCheckIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  createMenuCategoryAction,
  updateMenuCategoryAction,
  setMenuCategoryActiveAction,
  moveMenuCategoryAction,
} from '@/actions/menu'
import type { MenuCategory } from '@/lib/repositories/menu.repository'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

// Refinamiento UX de 3E-C3A1 — administración de categorías, aparte de la grilla.
//
// Las categorías son pocas y se tocan poco: convertirlas también en planilla
// habría agregado complejidad sin ahorrar tiempo. Acá van en una lista compacta
// con las cuatro operaciones que ya existían — crear, renombrar,
// activar/desactivar y ordenar— sin cambiar ninguna action ni regla.
//
// No hay borrado, y es deliberado: menu_items.category_id es ON DELETE RESTRICT
// y `active = false` es el mecanismo de desactivación, reversible y sin tocar los
// productos.

export function MenuCategoriesDialog({
  open, onOpenChange, categories, canManage,
}: {
  open:         boolean
  onOpenChange: (v: boolean) => void
  categories:   MenuCategory[]
  canManage:    boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [nueva, setNueva] = useState('')
  const [editandoId, setEditandoId] = useState<string | null>(null)
  const [nombreEditado, setNombreEditado] = useState('')

  function ejecutar(
    fn: () => Promise<{ success: boolean; error?: string }>,
    exito: string,
    alTerminar?: () => void,
  ) {
    startTransition(async () => {
      const res = await fn()
      if (res.success) { toast.success(exito); alTerminar?.(); router.refresh() }
      else toast.error(res.error ?? 'Algo salió mal.')
    })
  }

  function crear() {
    const name = nueva.trim()
    if (name === '') return
    ejecutar(() => createMenuCategoryAction({ name }), 'Categoría creada.', () => setNueva(''))
  }

  function guardarNombre(id: string) {
    ejecutar(
      () => updateMenuCategoryAction(id, { name: nombreEditado }),
      'Categoría actualizada.',
      () => setEditandoId(null),
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Categorías</DialogTitle>
          <DialogDescription>
            Agrupan la carta y definen en qué orden se lee. Desactivar una categoría
            no toca sus productos.
          </DialogDescription>
        </DialogHeader>

        {canManage && (
          <div className="flex gap-2">
            <Input
              value={nueva}
              maxLength={60}
              placeholder="Nueva categoría (Entradas, Pizzas…)"
              aria-label="Nombre de la categoría nueva"
              disabled={isPending}
              onChange={(e) => setNueva(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); crear() } }}
            />
            <Button size="sm" disabled={isPending || nueva.trim() === ''} onClick={crear}>
              <PlusIcon className="mr-1.5 h-4 w-4" />
              Crear
            </Button>
          </div>
        )}

        {canManage && (
          <p className="-mt-1 text-xs text-muted-foreground">
            No puede repetirse dentro de tu organización, sin distinguir mayúsculas ni espacios.
          </p>
        )}

        <div className="max-h-[50vh] space-y-1 overflow-y-auto">
          {categories.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Todavía no hay categorías.
            </p>
          ) : categories.map((cat, i) => (
            <div
              key={cat.id}
              className={cn(
                'flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2',
                !cat.active && 'bg-muted/40',
              )}
            >
              {editandoId === cat.id ? (
                <>
                  <Input
                    value={nombreEditado}
                    maxLength={60}
                    autoFocus
                    aria-label={`Nuevo nombre de ${cat.name}`}
                    disabled={isPending}
                    className="h-8 min-w-0 flex-1"
                    onChange={(e) => setNombreEditado(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); guardarNombre(cat.id) }
                      if (e.key === 'Escape') setEditandoId(null)
                    }}
                  />
                  <Button size="sm" variant="ghost" className="h-8 w-8 p-0"
                    aria-label="Guardar nombre"
                    disabled={isPending || nombreEditado.trim() === ''}
                    onClick={() => guardarNombre(cat.id)}>
                    <CheckIcon className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8 w-8 p-0"
                    aria-label="Cancelar" disabled={isPending}
                    onClick={() => setEditandoId(null)}>
                    <XIcon className="h-4 w-4" />
                  </Button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 break-words text-sm font-medium">{cat.name}</span>
                  <span className={cn(
                    'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                    cat.active
                      ? 'border-green-200 bg-green-100 text-green-800'
                      : 'border-zinc-200 bg-zinc-100 text-zinc-700',
                  )}>
                    {cat.active ? 'Activa' : 'Inactiva'}
                  </span>

                  {canManage && (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button size="sm" variant="ghost" className="h-8 w-8 p-0"
                        aria-label={`Subir ${cat.name}`}
                        disabled={isPending || i === 0}
                        onClick={() => ejecutar(() => moveMenuCategoryAction(cat.id, 'up'), 'Orden actualizado.')}>
                        <ChevronUpIcon className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-8 w-8 p-0"
                        aria-label={`Bajar ${cat.name}`}
                        disabled={isPending || i === categories.length - 1}
                        onClick={() => ejecutar(() => moveMenuCategoryAction(cat.id, 'down'), 'Orden actualizado.')}>
                        <ChevronDownIcon className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-8 w-8 p-0"
                        aria-label={`Renombrar ${cat.name}`}
                        disabled={isPending}
                        onClick={() => { setEditandoId(cat.id); setNombreEditado(cat.name) }}>
                        <PencilIcon className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-8 w-8 p-0"
                        aria-label={cat.active ? `Desactivar ${cat.name}` : `Activar ${cat.name}`}
                        disabled={isPending}
                        onClick={() => ejecutar(
                          () => setMenuCategoryActiveAction(cat.id, !cat.active),
                          cat.active ? 'Categoría desactivada.' : 'Categoría activada.',
                        )}>
                        {cat.active
                          ? <CircleSlashIcon className="h-4 w-4" />
                          : <CircleCheckIcon className="h-4 w-4" />}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
