'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { Trash2 } from 'lucide-react'
import type { PropertyListItem } from '@/lib/repositories/properties.repository'
import { deletePropertyAction } from '@/actions/properties'
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

interface ArchivePropertyDialogProps {
  property:        PropertyListItem | null
  open:            boolean
  onOpenChange:    (open: boolean) => void
  redirectAfter?:  boolean
}

export function ArchivePropertyDialog({
  property,
  open,
  onOpenChange,
  redirectAfter = false,
}: ArchivePropertyDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  if (!property) return null

  function handleConfirm() {
    startTransition(async () => {
      const result = await deletePropertyAction(property!.id)
      if (result.success) {
        toast.success(`Propiedad "${property!.title}" eliminada`)
        onOpenChange(false)
        if (redirectAfter) {
          router.push('/dashboard/properties')
        } else {
          router.refresh()
        }
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5 text-destructive" />
            Eliminar propiedad
          </AlertDialogTitle>
          <AlertDialogDescription>
            ¿Estás seguro que querés eliminar{' '}
            <span className="font-medium text-foreground">&quot;{property.title}&quot;</span>?
            <br />
            <br />
            La propiedad dejará de estar visible. No se borrará el historial asociado.
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
