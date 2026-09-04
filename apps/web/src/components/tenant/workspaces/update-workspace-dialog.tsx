'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import type { WorkspaceRow } from '@orderflow/types'
import type { CreateWorkspaceInput } from '@orderflow/validators'
import { updateWorkspaceAction } from '@/actions/workspaces'
import { WorkspaceForm } from './workspace-form'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface UpdateWorkspaceDialogProps {
  workspace: WorkspaceRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function UpdateWorkspaceDialog({
  workspace,
  open,
  onOpenChange,
}: UpdateWorkspaceDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  if (!workspace) return null

  async function handleSubmit(values: CreateWorkspaceInput): Promise<void> {
    return new Promise((resolve) => {
      startTransition(async () => {
        const result = await updateWorkspaceAction(workspace!.id, values)
        if (result.success) {
          toast.success('Workspace actualizado correctamente')
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Editar Workspace</DialogTitle>
          <DialogDescription>
            Modificá los datos del workspace &quot;{workspace.name}&quot;.
          </DialogDescription>
        </DialogHeader>
        <WorkspaceForm
          defaultValues={{
            name: workspace.name,
            type: workspace.type,
            city: workspace.city ?? '',
            address: workspace.address ?? '',
            phone: workspace.phone ?? '',
            email: workspace.email ?? '',
          }}
          onSubmit={handleSubmit}
          isPending={isPending}
          submitLabel="Guardar cambios"
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
