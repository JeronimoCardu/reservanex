'use client'

import { useTransition, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { PlusIcon } from 'lucide-react'
import { createTaskAction } from '@/actions/tasks'
import type { CreateTaskInput } from '@orderflow/validators'
import type { TenantUserRow } from '@orderflow/types'
import { TaskForm } from './task-form'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

interface CreateTaskDialogProps {
  tenantUsers:     TenantUserRow[]
  contactId?:      string
  conversationId?: string
  triggerLabel?:   string
}

export function CreateTaskDialog({
  tenantUsers,
  contactId,
  conversationId,
  triggerLabel = 'Nueva tarea',
}: CreateTaskDialogProps) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function handleSubmit(values: CreateTaskInput) {
    return new Promise<void>((resolve) => {
      startTransition(async () => {
        const result = await createTaskAction({
          ...values,
          contact_id:      contactId,
          conversation_id: conversationId,
        })
        if (result.success) {
          toast.success('Tarea creada')
          setOpen(false)
          router.refresh()
        } else {
          toast.error(result.error)
        }
        resolve()
      })
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <PlusIcon className="mr-2 h-4 w-4" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nueva tarea</DialogTitle>
        </DialogHeader>
        <TaskForm
          tenantUsers={tenantUsers}
          onSubmit={handleSubmit}
          isPending={isPending}
          onCancel={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
