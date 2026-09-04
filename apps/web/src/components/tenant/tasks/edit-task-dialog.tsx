'use client'

import { useTransition, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Pencil } from 'lucide-react'
import { updateTaskAction } from '@/actions/tasks'
import type { CreateTaskInput } from '@orderflow/validators'
import type { TaskRow, TenantUserRow } from '@orderflow/types'
import { TaskForm } from './task-form'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

interface EditTaskDialogProps {
  task:        TaskRow
  tenantUsers: TenantUserRow[]
}

export function EditTaskDialog({ task, tenantUsers }: EditTaskDialogProps) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function handleSubmit(values: CreateTaskInput) {
    return new Promise<void>((resolve) => {
      startTransition(async () => {
        const result = await updateTaskAction(task.id, values)
        if (result.success) {
          toast.success('Tarea actualizada')
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
        <Button variant="ghost" size="icon">
          <Pencil className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar tarea</DialogTitle>
        </DialogHeader>
        <TaskForm
          key={task.id}
          defaultValues={{
            title:       task.title,
            description: task.description ?? undefined,
            priority:    task.priority as CreateTaskInput['priority'],
            assigned_to: task.assigned_to ?? undefined,
            due_date:    task.due_date ?? undefined,
          }}
          tenantUsers={tenantUsers}
          onSubmit={handleSubmit}
          isPending={isPending}
          submitLabel="Guardar cambios"
          onCancel={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
