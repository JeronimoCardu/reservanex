'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { Trash2 } from 'lucide-react'
import type { UnitRow } from '@orderflow/types'
import { archiveUnitAction } from '@/actions/units'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

interface DeleteUnitDialogProps {
  unit:         UnitRow | null
  open:         boolean
  onOpenChange: (open: boolean) => void
}

export function DeleteUnitDialog({ unit, open, onOpenChange }: DeleteUnitDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  if (!unit) return null

  function handleConfirm() {
    startTransition(async () => {
      const result = await archiveUnitAction(unit!.id)
      if (result.success) {
        toast.success(`Unidad "${unit!.name}" eliminada`)
        onOpenChange(false)
        router.refresh()
      } else {
        toast.error(result.error)
        // Keep dialog open so user can read the blocking reason before dismissing
      }
    })
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5 text-destructive" />
            Eliminar unidad
          </AlertDialogTitle>
          <AlertDialogDescription>
            ¿Estás seguro que querés eliminar{' '}
            <span className="font-medium text-foreground">&quot;{unit.name}&quot;</span>?
            <br />
            <br />
            Esta acción es irreversible. La unidad dejará de estar disponible para nuevas reservas.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isPending ? 'Eliminando...' : 'Eliminar'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
