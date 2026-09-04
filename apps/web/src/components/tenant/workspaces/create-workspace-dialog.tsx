'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import type { CreateWorkspaceInput } from '@orderflow/validators'
import { createWorkspaceAction } from '@/actions/workspaces'
import { WorkspaceForm } from './workspace-form'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface CreateWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateWorkspaceDialog({ open, onOpenChange }: CreateWorkspaceDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  async function handleSubmit(values: CreateWorkspaceInput): Promise<void> {
    return new Promise((resolve) => {
      startTransition(async () => {
        const result = await createWorkspaceAction(values)
        if (result.success) {
          toast.success('Workspace creado correctamente')
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
          <DialogTitle>Nuevo Workspace</DialogTitle>
          <DialogDescription>
            Creá un nuevo espacio de trabajo para tu organización.
          </DialogDescription>
        </DialogHeader>
        <WorkspaceForm
          onSubmit={handleSubmit}
          isPending={isPending}
          submitLabel="Crear Workspace"
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
