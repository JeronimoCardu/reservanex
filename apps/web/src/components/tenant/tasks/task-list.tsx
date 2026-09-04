'use client'

import type { TaskRow, TenantUserRow, TenantRole } from '@orderflow/types'
import type { TaskStatus } from '@orderflow/validators'
import { TaskStatusSelect } from './task-status-select'
import { EditTaskDialog } from './edit-task-dialog'
import { DeleteTaskDialog } from './delete-task-dialog'
import { Badge } from '@/components/ui/badge'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import { ClipboardListIcon } from 'lucide-react'

const priorityConfig: Record<string, { label: string; className: string }> = {
  low:    { label: 'Baja',  className: 'bg-gray-100 text-gray-700' },
  medium: { label: 'Media', className: 'bg-yellow-100 text-yellow-800' },
  high:   { label: 'Alta',  className: 'bg-red-100 text-red-700' },
}

interface TaskListProps {
  tasks:         TaskRow[]
  tenantUsers:   TenantUserRow[]
  currentRole:   TenantRole
  currentUserId: string
}

export function TaskList({ tasks, tenantUsers, currentRole, currentUserId }: TaskListProps) {
  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center py-8 text-muted-foreground">
        <ClipboardListIcon className="mb-2 h-8 w-8 opacity-40" />
        <p className="text-sm">No hay tareas</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {tasks.map((task) => {
        const priority = priorityConfig[task.priority ?? 'medium']
        const assignee = tenantUsers.find((u) => u.id === task.assigned_to)
        const canDelete = currentRole === 'owner' || task.created_by === currentUserId

        return (
          <div
            key={task.id}
            className="flex items-start justify-between rounded-lg border bg-card p-3 gap-4"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm">{task.title}</span>
                <Badge
                  variant="outline"
                  className={`text-xs ${priority?.className}`}
                >
                  {priority?.label}
                </Badge>
              </div>
              {task.description && (
                <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                  {task.description}
                </p>
              )}
              <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                {assignee && <span>Asignada a {assignee.name}</span>}
                {task.due_date && (
                  <span>
                    Vence {format(new Date(task.due_date), 'd MMM yyyy', { locale: es })}
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <TaskStatusSelect taskId={task.id} value={task.status as TaskStatus} />
              <EditTaskDialog task={task} tenantUsers={tenantUsers} />
              {canDelete && <DeleteTaskDialog task={task} />}
            </div>
          </div>
        )
      })}
    </div>
  )
}
