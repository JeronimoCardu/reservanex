import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { MessageCircleOff } from 'lucide-react'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { getContactById } from '@/lib/repositories/contacts.repository'
import { listConversations } from '@/lib/repositories/conversations.repository'
import { listNotes } from '@/lib/repositories/notes.repository'
import { listTasks } from '@/lib/repositories/tasks.repository'
import { listActiveTenantUsers } from '@/lib/repositories/tenant-users.repository'
import { EditContactDialog } from '@/components/tenant/contacts/edit-contact-dialog'
import { ArchiveContactDialog } from '@/components/tenant/contacts/archive-contact-dialog'
import { ContactSourceBadge } from '@/components/tenant/contacts/contact-source-badge'
import { ConversationList } from '@/components/tenant/conversations/conversation-list'
import { NoteList } from '@/components/tenant/notes/note-list'
import { AddNoteDialog } from '@/components/tenant/notes/add-note-dialog'
import { TaskList } from '@/components/tenant/tasks/task-list'
import { CreateTaskDialog } from '@/components/tenant/tasks/create-task-dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export const metadata: Metadata = { title: 'Contacto — ReservaNex' }

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx    = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') redirect('/dashboard')
  const { id } = await params

  const contact = await getContactById(ctx.tenantId, id)
  if (!contact) notFound()

  const [conversations, tenantUsers, notes, tasks] = await Promise.all([
    listConversations(ctx.tenantId, { contactId: id }),
    listActiveTenantUsers(ctx.tenantId),
    listNotes(ctx.tenantId, { contactId: id }),
    listTasks(ctx.tenantId, { contactId: id }),
  ])

  const displayName = contact.name ?? contact.email ?? contact.phone ?? 'Contacto'

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{displayName}</h1>
          <div className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
            {contact.email && <span>{contact.email}</span>}
            {contact.phone && <span>{contact.phone}</span>}
            <ContactSourceBadge source={contact.source} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <EditContactDialog contact={contact} />
          {ctx.role === 'owner' && (
            <ArchiveContactDialog contact={contact} redirectAfter />
          )}
        </div>
      </div>

      <Tabs defaultValue="conversations">
        <TabsList>
          <TabsTrigger value="conversations">
            Conversaciones ({conversations.length})
          </TabsTrigger>
          <TabsTrigger value="notes">
            Notas ({notes.length})
          </TabsTrigger>
          <TabsTrigger value="tasks">
            Tareas ({tasks.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="conversations" className="mt-4">
          {conversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
              <MessageCircleOff className="mb-3 h-8 w-8 text-muted-foreground opacity-40" />
              <p className="text-sm font-medium text-muted-foreground">
                Este contacto todavía no inició una conversación por WhatsApp.
              </p>
            </div>
          ) : (
            <ConversationList
              conversations={conversations}
              currentUserId={ctx.userId}
              tenantUsers={tenantUsers}
            />
          )}
        </TabsContent>

        <TabsContent value="notes" className="mt-4 space-y-4">
          <div className="flex justify-end">
            <AddNoteDialog contactId={id} />
          </div>
          <NoteList notes={notes} />
        </TabsContent>

        <TabsContent value="tasks" className="mt-4 space-y-4">
          <div className="flex justify-end">
            <CreateTaskDialog
              tenantUsers={tenantUsers}
              contactId={id}
              triggerLabel="Nueva tarea"
            />
          </div>
          <TaskList
            tasks={tasks}
            tenantUsers={tenantUsers}
            currentRole={ctx.role}
            currentUserId={ctx.userId}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
