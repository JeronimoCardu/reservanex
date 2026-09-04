'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import type { CreateUnitInput } from '@orderflow/validators'
import { createUnitAction } from '@/actions/units'
import { UnitForm } from './unit-form'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface CreateUnitDialogProps {
  propertyId:   string
  open:         boolean
  onOpenChange: (open: boolean) => void
}

export function CreateUnitDialog({ propertyId, open, onOpenChange }: CreateUnitDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  async function handleSubmit(values: CreateUnitInput): Promise<void> {
    return new Promise((resolve) => {
      startTransition(async () => {
        const result = await createUnitAction(propertyId, values)
        if (result.success) {
          toast.success('Unidad creada correctamente')
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
          <DialogTitle>Nueva Unidad</DialogTitle>
          <DialogDescription>Agregá una unidad a esta propiedad.</DialogDescription>
        </DialogHeader>
        <UnitForm
          onSubmit={handleSubmit}
          isPending={isPending}
          submitLabel="Crear Unidad"
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
