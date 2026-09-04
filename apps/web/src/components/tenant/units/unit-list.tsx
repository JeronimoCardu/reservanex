'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Pencil, Trash2, Power, PowerOff } from 'lucide-react'
import type { UnitRow, TenantRole } from '@orderflow/types'
import { toggleUnitActiveAction } from '@/actions/units'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CreateUnitDialog } from './create-unit-dialog'
import { EditUnitDialog } from './edit-unit-dialog'
import { DeleteUnitDialog } from './delete-unit-dialog'

function formatPrice(price: number | null, currency: string): string {
  if (price == null) return '—'
  return new Intl.NumberFormat('es-AR', { minimumFractionDigits: 0 }).format(price) +
    ' ' + currency
}

interface UnitListProps {
  units:       UnitRow[]
  propertyId:  string
  currentRole: TenantRole
}

export function UnitList({ units, propertyId, currentRole }: UnitListProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<UnitRow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<UnitRow | null>(null)

  function handleToggleActive(unit: UnitRow) {
    startTransition(async () => {
      const result = await toggleUnitActiveAction(unit.id)
      if (result.success) {
        toast.success(unit.active ? 'Unidad desactivada' : 'Unidad activada')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Unidades</h2>
          <p className="text-sm text-muted-foreground">
            {units.length} unidad{units.length !== 1 ? 'es' : ''}
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 h-4 w-4" />
          Nueva Unidad
        </Button>
      </div>

      {units.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-10 text-center">
          <p className="text-sm font-medium">No hay unidades</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Agregá unidades para habilitar reservas en esta propiedad.
          </p>
          <Button className="mt-3" size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            Agregar Unidad
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead className="text-center">Capacidad</TableHead>
                <TableHead>Precio</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="w-[130px] text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {units.map((unit) => (
                <TableRow key={unit.id} className={!unit.active ? 'opacity-60' : undefined}>
                  <TableCell className="font-medium">{unit.name}</TableCell>
                  <TableCell className="text-center text-muted-foreground">
                    {unit.capacity}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatPrice(unit.price, unit.currency)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={unit.active ? 'default' : 'secondary'}>
                      {unit.active ? 'Activa' : 'Inactiva'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Editar"
                        onClick={() => setEditTarget(unit)}
                      >
                        <Pencil className="h-4 w-4" />
                        <span className="sr-only">Editar</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title={unit.active ? 'Desactivar' : 'Activar'}
                        disabled={isPending}
                        onClick={() => handleToggleActive(unit)}
                      >
                        {unit.active ? (
                          <PowerOff className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <Power className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span className="sr-only">{unit.active ? 'Desactivar' : 'Activar'}</span>
                      </Button>
                      {currentRole === 'owner' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Eliminar"
                          onClick={() => setDeleteTarget(unit)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                          <span className="sr-only">Eliminar</span>
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateUnitDialog
        propertyId={propertyId}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />

      <EditUnitDialog
        unit={editTarget}
        open={!!editTarget}
        onOpenChange={(open) => { if (!open) setEditTarget(null) }}
      />

      <DeleteUnitDialog
        unit={deleteTarget}
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
      />
    </div>
  )
}
