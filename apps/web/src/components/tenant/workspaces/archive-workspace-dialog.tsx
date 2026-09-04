'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { ArchiveIcon } from 'lucide-react'
import type { WorkspaceRow } from '@orderflow/types'
import { archiveWorkspaceAction } from '@/actions/workspaces'
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

interface ArchiveWorkspaceDialogProps {
  workspace: WorkspaceRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ArchiveWorkspaceDialog({
  workspace,
  open,
  onOpenChange,
}: ArchiveWorkspaceDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  if (!workspace) return null

  function handleConfirm() {
    startTransition(async () => {
      const result = await archiveWorkspaceAction(workspace!.id)
      if (result.success) {
        toast.success(`Workspace "${workspace!.name}" archivado`)
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
            <ArchiveIcon className="h-5 w-5 text-destructive" />
            Archivar workspace
          </AlertDialogTitle>
          <AlertDialogDescription>
            ¿Estás seguro que querés archivar el workspace{' '}
            <span className="font-medium text-foreground">&quot;{workspace.name}&quot;</span>?
            <br />
            <br />
            Los receptionists asignados perderán acceso. Esta acción puede revertirse
            editando el workspace.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isPending ? 'Archivando...' : 'Archivar'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
