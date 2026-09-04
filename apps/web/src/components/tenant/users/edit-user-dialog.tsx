'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import type { TenantUserWithWorkspaceIds } from '@/lib/repositories/users.repository'
import { updateTenantUserAction } from '@/actions/users'
import { EditUserForm } from './user-form'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface EditUserDialogProps {
  user: TenantUserWithWorkspaceIds | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function EditUserDialog({ user, open, onOpenChange }: EditUserDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  if (!user) return null

  async function handleSubmit(values: {
    name: string
    role: 'owner' | 'receptionist'
  }): Promise<void> {
    return new Promise((resolve) => {
      startTransition(async () => {
        const result = await updateTenantUserAction(user!.id, values)
        if (result.success) {
          toast.success('Usuario actualizado correctamente')
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
          <DialogTitle>Editar Usuario</DialogTitle>
          <DialogDescription>
            Modificá los datos de &quot;{user.name}&quot;.
          </DialogDescription>
        </DialogHeader>
        <EditUserForm
          defaultValues={{ name: user.name, role: user.role }}
          onSubmit={handleSubmit}
          isPending={isPending}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
