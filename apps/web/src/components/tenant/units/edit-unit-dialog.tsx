'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import type { UnitRow } from '@orderflow/types'
import type { CreateUnitInput } from '@orderflow/validators'
import { updateUnitAction } from '@/actions/units'
import { UnitForm } from './unit-form'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface EditUnitDialogProps {
  unit:         UnitRow | null
  open:         boolean
  onOpenChange: (open: boolean) => void
}

export function EditUnitDialog({ unit, open, onOpenChange }: EditUnitDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  if (!unit) return null

  const defaultValues = {
    name:     unit.name,
    capacity: String(unit.capacity),
    price:    unit.price != null ? String(unit.price) : '',
    currency: (unit.currency as 'ARS' | 'USD' | 'EUR' | 'BRL') ?? 'ARS',
  }

  async function handleSubmit(values: CreateUnitInput): Promise<void> {
    return new Promise((resolve) => {
      startTransition(async () => {
        const result = await updateUnitAction(unit!.id, values)
        if (result.success) {
          toast.success('Unidad actualizada correctamente')
          onOpenChange(false)
          router.refresh()
        } else {
          toast.error(result.error)
        }
        resolve()
      })
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar Unidad</DialogTitle>
          <DialogDescription>Actualizá los datos de la unidad.</DialogDescription>
        </DialogHeader>
        <UnitForm
          key={unit.id}
          defaultValues={defaultValues}
          onSubmit={handleSubmit}
          isPending={isPending}
          submitLabel="Guardar Cambios"
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
