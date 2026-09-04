'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import type { WorkspaceRow } from '@orderflow/types'
import { createTenantUserAction } from '@/actions/users'
import { CreateUserForm } from './user-form'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface CreateUserDialogProps {
  workspaces: WorkspaceRow[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateUserDialog({ workspaces, open, onOpenChange }: CreateUserDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  async function handleSubmit(values: {
    name: string
    email: string
    role: 'owner' | 'receptionist'
    workspaceIds: string[]
  }): Promise<void> {
    return new Promise((resolve) => {
      startTransition(async () => {
        const result = await createTenantUserAction(values)
        if (result.success) {
          toast.success('Invitación enviada. El usuario recibirá un email para activar su cuenta.')
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
          <DialogTitle>Invitar usuario</DialogTitle>
          <DialogDescription>
            El usuario recibirá un email para activar su cuenta y definir su contraseña.
          </DialogDescription>
        </DialogHeader>
        <CreateUserForm
          workspaces={workspaces}
          onSubmit={handleSubmit}
          isPending={isPending}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
