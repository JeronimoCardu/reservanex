import type { TaskRow, TaskStatus } from '@orderflow/types'
import type { CreateTaskInput, UpdateTaskInput } from '@orderflow/validators'
import { createClient } from '@orderflow/supabase/server'

export type TaskWithDetails = TaskRow & {
  assignee: { id: string; name: string } | null
  author:   { id: string; name: string }
}

export async function listTasks(
  tenantId: string,
  opts?: {
    status?:           TaskStatus
    assignedTo?:       string
    contactId?:        string
    conversationId?:   string
    includeCompleted?: boolean
    limit?:            number
  },
): Promise<TaskWithDetails[]> {
  const supabase = await createClient()

  let query = supabase
    .from('tasks')
    .select(`
      *,
      assignee:tenant_users!tasks_assigned_to_fkey(id, name),
      author:tenant_users!tasks_created_by_fkey(id, name)
    `)
    .eq('tenant_id', tenantId)
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(opts?.limit ?? 200)

  if (opts?.status) {
    query = query.eq('status', opts.status)
  } else if (!opts?.includeCompleted) {
    query = query.not('status', 'in', '("completed","cancelled")')
  }

  if (opts?.assignedTo)     query = query.eq('assigned_to', opts.assignedTo)
  if (opts?.contactId)      query = query.eq('contact_id', opts.contactId)
  if (opts?.conversationId) query = query.eq('conversation_id', opts.conversationId)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data ?? []) as TaskWithDetails[]
}

export async function getTaskById(
  tenantId: string,
  id: string,
): Promise<TaskRow | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return data
}

export async function createTask(
  tenantId: string,
  createdBy: string,
  workspaceId: string | null,
  input: CreateTaskInput,
): Promise<TaskRow> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('tasks')
    .insert({
      tenant_id:       tenantId,
      created_by:      createdBy,
      workspace_id:    workspaceId,
      title:           input.title,
      description:     input.description     ?? null,
      due_date:        input.due_date         ?? null,
      assigned_to:     input.assigned_to      ?? null,
      contact_id:      input.contact_id       ?? null,
      conversation_id: input.conversation_id  ?? null,
      priority:        input.priority        ?? 'medium',
      status:          'pending',
    })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function updateTask(
  tenantId: string,
  id: string,
  input: UpdateTaskInput,
): Promise<TaskRow> {
  const supabase = await createClient()

  const patch: {
    title?:           string
    description?:     string | null
    priority?:        string
    due_date?:        string | null
    assigned_to?:     string | null
    contact_id?:      string | null
    conversation_id?: string | null
  } = {}

  if ('title' in input)           patch.title           = input.title
  if ('description' in input)     patch.description     = input.description     ?? null
  if ('priority' in input)        patch.priority        = input.priority
  if ('due_date' in input)        patch.due_date        = input.due_date        ?? null
  if ('assigned_to' in input)     patch.assigned_to     = input.assigned_to     ?? null
  if ('contact_id' in input)      patch.contact_id      = input.contact_id      ?? null
  if ('conversation_id' in input) patch.conversation_id = input.conversation_id ?? null

  const { data, error } = await supabase
    .from('tasks')
    .update(patch)
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function updateTaskStatus(
  tenantId: string,
  id: string,
  status: TaskStatus,
): Promise<TaskRow> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('tasks')
    .update({
      status,
      completed_at: status === 'completed' ? new Date().toISOString() : null,
    })
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data
}

export async function deleteTask(
  tenantId: string,
  id: string,
): Promise<void> {
  const supabase = await createClient()

  const { error } = await supabase
    .from('tasks')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('id', id)

  if (error) throw new Error(error.message)
}
