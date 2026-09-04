'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { updateTaskStatusAction } from '@/actions/tasks'
import type { TaskStatus } from '@orderflow/validators'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const statusLabels: Record<TaskStatus, string> = {
  pending:     'Pendiente',
  in_progress: 'En progreso',
  completed:   'Completada',
  cancelled:   'Cancelada',
}

interface TaskStatusSelectProps {
  taskId: string
  value:  TaskStatus
}

export function TaskStatusSelect({ taskId, value }: TaskStatusSelectProps) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function handleChange(status: string) {
    startTransition(async () => {
      const result = await updateTaskStatusAction(taskId, { status })
      if (result.success) {
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <Select value={value} onValueChange={handleChange} disabled={isPending}>
      <SelectTrigger className="h-7 w-[140px] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(statusLabels) as TaskStatus[]).map((s) => (
          <SelectItem key={s} value={s} className="text-xs">
            {statusLabels[s]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
