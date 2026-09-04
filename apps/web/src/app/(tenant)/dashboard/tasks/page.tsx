import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { listTasks } from '@/lib/repositories/tasks.repository'
import { listActiveTenantUsers } from '@/lib/repositories/tenant-users.repository'
import { TaskList } from '@/components/tenant/tasks/task-list'
import { CreateTaskDialog } from '@/components/tenant/tasks/create-task-dialog'

export const metadata: Metadata = {
  title: 'Tareas — ReservaNex',
}

export default async function TasksPage() {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') redirect('/dashboard')

  const [tasks, tenantUsers] = await Promise.all([
    listTasks(ctx.tenantId),
    listActiveTenantUsers(ctx.tenantId),
  ])

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Tareas</h1>
          <p className="text-muted-foreground">
            {tasks.length} tarea{tasks.length !== 1 ? 's' : ''}
          </p>
        </div>
        <CreateTaskDialog tenantUsers={tenantUsers} triggerLabel="Nueva tarea" />
      </div>

      <TaskList
        tasks={tasks}
        tenantUsers={tenantUsers}
        currentRole={ctx.role}
        currentUserId={ctx.userId}
      />
    </div>
  )
}
