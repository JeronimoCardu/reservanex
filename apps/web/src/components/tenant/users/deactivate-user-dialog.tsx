'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { UserX } from 'lucide-react'
import type { TenantUserWithWorkspaceIds } from '@/lib/repositories/users.repository'
import { deactivateTenantUserAction } from '@/actions/users'
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

interface DeactivateUserDialogProps {
  user: TenantUserWithWorkspaceIds | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DeactivateUserDialog({ user, open, onOpenChange }: DeactivateUserDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  if (!user) return null

  function handleConfirm() {
    startTransition(async () => {
      const result = await deactivateTenantUserAction(user!.id)
      if (result.success) {
        toast.success(`Usuario "${user!.name}" desactivado`)
        onOpenChange(false)
        router.refresh()
      } else {
        toast.error(result.error)
        onOpenChange(false)
      }
    })
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <UserX className="h-5 w-5 text-destructive" />
            Desactivar usuario
          </AlertDialogTitle>
          <AlertDialogDescription>
            ¿Estás seguro que querés desactivar a{' '}
            <span className="font-medium text-foreground">&quot;{user.name}&quot;</span>?
            <br />
            <br />
            El usuario no podrá iniciar sesión. Esta acción puede revertirse desde el soporte.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isPending ? 'Desactivando...' : 'Desactivar'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
