# 24 — Phase 4: CRM Core — Architecture Blueprint
## Revisión v2 — Decisiones de negocio B1–B8 aplicadas (2026-06-24)

---

## 1. Scope completo

### In scope
- CRUD de `contacts` (crear, editar, archivar — solo soft delete; B6)
- CRUD de `conversations` (crear manualmente, asignar, cambiar status)
- `ai_mode` de conversaciones — display para receptionist, modificación solo para owner (B8)
- `messages` — listado y envío de mensajes manuales por agentes (read + send; escritura IA es externa)
- `notes` — solo INSERT y lectura; append-only, sin UPDATE ni DELETE para usuarios autenticados (B4)
- `tasks` — CRUD completo con assignee, due_date, status lifecycle; ambos roles pueden crear (B5)
- `notifications` — lectura in_app del usuario autenticado + marcar como leída via `read_at` (B7)
- Workspace scoping para `conversations` (mismo patrón que `properties`)
- Contacts son tenant-wide; receptionists ven todos los contactos pero solo acceden a conversaciones/mensajes/tareas/notas de sus workspaces (B1)
- Navegación: `/dashboard/contacts`, `/dashboard/conversations`, `/dashboard/tasks`

### Out of scope (Fase 4 explícitamente excluye)
- `reservations` — gestión de reservas (Fase 5)
- `availability_blocks` — calendario (Fase 5)
- `documents` — archivos adjuntos (Fase 5+)
- Mensajes entrantes por WhatsApp (webhook externo de IA)
- Delivery de `notifications` por email/WhatsApp (infraestructura — Fase 6)
- Creación de notificaciones por acciones de usuario (son system-generated)
- `ai_usage_log`, `message_queue`, `ai_settings` (Fase 6)
- Búsqueda full-text; paginación cursor-based (Fase 6)

### Migraciones de schema requeridas antes de implementar
- `notifications.read_at TIMESTAMPTZ NULL` — nueva columna (B7)
- `ai_mode` enum renombrado: `'auto'|'human'|'disabled'` → `'manual'|'assisted'|'autonomous'` (B8)
  - Requiere `ALTER TYPE ai_mode RENAME TO ai_mode_old` + `CREATE TYPE ai_mode AS ENUM(...)` + `UPDATE conversations SET ai_mode = 'manual' WHERE ai_mode = 'human'` + `DROP TYPE ai_mode_old`
  - Risk: medium — la tabla `conversations` existe pero no tiene datos de producción en Fase 4

---

## 2. Arquitectura por capas

```
┌────────────────────────────────────────────────────────────────────────┐
│  Pages (Server Components)                                              │
│  /contacts         /contacts/[id]                                       │
│  /conversations    /conversations/[id]                                  │
│  /tasks                                                                 │
│     └── requireTenantContext() en todas                                 │
├────────────────────────────────────────────────────────────────────────┤
│  Client Components (islands de interactividad)                          │
│  ContactTable  ConversationList  MessageList  SendMessageForm           │
│  NoteList(read-only buttons)  TaskList  NotificationBell               │
├────────────────────────────────────────────────────────────────────────┤
│  Server Actions  ('use server')                                         │
│  actions/contacts.ts        actions/conversations.ts                    │
│  actions/messages.ts        actions/notes.ts (solo createNote)         │
│  actions/tasks.ts           actions/notifications.ts (markRead)        │
│     └── requireTenantContext() en todas                                 │
│     └── checks de rol inline según permission matrix                    │
├────────────────────────────────────────────────────────────────────────┤
│  Repositories                                                           │
│  contacts.repository.ts       conversations.repository.ts               │
│  messages.repository.ts       notes.repository.ts                       │
│  tasks.repository.ts          notifications.repository.ts               │
│     └── siempre .eq('tenant_id', tenantId)                              │
│     └── siempre .is('deleted_at', null) en contacts                     │
│     └── workspace filter para conversations                             │
├────────────────────────────────────────────────────────────────────────┤
│  Supabase SSR Client (RLS enforced)                                     │
│  createClient() — anon key, respeta RLS                                 │
└────────────────────────────────────────────────────────────────────────┘
```

### Invariantes de arquitectura (heredadas de Fases 1–3)
- Todo query incluye `.eq('tenant_id', tenantId)` explícito (defense-in-depth sobre RLS)
- `requireTenantContext()` es la única fuente de verdad para `tenantId`, `role`, `workspaceIds`, `userId`
- Server Actions NO aceptan `tenantId` como parámetro del cliente
- `workspaceIds = null` → owner; `workspaceIds = []` → retornar vacío temprano; `workspaceIds = [A,B]` → `.in('workspace_id', [A,B])`

### Invariantes CRM (nuevas en Fase 4)
- `contacts` son tenant-wide. Sin `workspace_id`. Ambos roles ven todos los contactos en la lista.
- `conversations` tienen `workspace_id`. Receptionists solo ven conversaciones de sus workspaces; `workspace_id = null` → solo owner.
- `messages` — access derivado de la conversación padre. Si no podés ver la conversación, no ves sus mensajes.
- `notes` — append-only. No existe UPDATE ni DELETE en ningún endpoint de usuario autenticado (B4).
- `notes` con `conversation_id`: visibles si el user puede acceder a esa conversación. `notes` con solo `contact_id` (sin `conversation_id`): visibles para todos los roles del tenant.
- `tasks` — tenant-wide para listado y creación; acceso via conversación para workspace-scoping en contexto de conversation detail.
- `ai_mode`: owner lee y escribe. Receptionist solo lee (B8).

---

## 3. Árbol de archivos

```
packages/validators/src/
  contacts.ts                     # createContactSchema, updateContactSchema
  conversations.ts                # createConversationSchema, updateConversationSchema,
                                  # assignConversationSchema, setAiModeSchema
  messages.ts                     # sendMessageSchema
  notes.ts                        # createNoteSchema  (solo INSERT — B4)
  tasks.ts                        # createTaskSchema, updateTaskSchema, updateTaskStatusSchema
  index.ts                        # re-export todo (MODIFICAR)

apps/web/src/
  lib/
    action-result.ts              # ActionResult<T> — extraído de properties.ts (compartido)
    repositories/
      contacts.repository.ts      # listContacts, getContactById, createContact,
                                  # updateContact, archiveContact, hasActiveConversations
      conversations.repository.ts # listConversations, getConversationById, createConversation,
                                  # updateConversation, assignConversation,
                                  # closeConversation, reopenConversation,
                                  # validateContactInTenant, validateAssigneeInTenant
      messages.repository.ts      # listMessages, createMessage
      notes.repository.ts         # listNotes, createNote  (sin update/delete — B4)
      tasks.repository.ts         # listTasks, getTaskById, createTask, updateTask,
                                  # updateTaskStatus, deleteTask
      notifications.repository.ts # listMyNotifications, countUnread, markNotificationRead
    auth/
      require-tenant-context.ts   # YA EXISTE — sin cambios

  actions/
    contacts.ts                   # createContactAction, updateContactAction, archiveContactAction
    conversations.ts              # createConversationAction, updateConversationAction,
                                  # assignConversationAction, closeConversationAction,
                                  # reopenConversationAction, setAiModeAction
    messages.ts                   # sendMessageAction
    notes.ts                      # createNoteAction  (solo — B4)
    tasks.ts                      # createTaskAction, updateTaskAction, updateTaskStatusAction,
                                  # deleteTaskAction
    notifications.ts              # markNotificationReadAction

  components/tenant/
    contacts/
      contact-table.tsx           # tabla principal con dialogs (client)
      contact-form.tsx            # form compartido create/edit (client)
      create-contact-dialog.tsx   # (client)
      edit-contact-dialog.tsx     # (client)
      archive-contact-dialog.tsx  # AlertDialog (client)
      contact-source-badge.tsx    # badge visual para source (client)
    conversations/
      conversation-list.tsx           # lista filtrable (client)
      conversation-filters.tsx        # filtros status/workspace/assignee (client)
      conversation-detail-header.tsx  # header con metadata y acciones (client)
      ai-mode-display.tsx             # display del ai_mode + toggle solo para owner (client)
      assign-conversation-dialog.tsx  # lógica condicional por rol (client)
      close-conversation-dialog.tsx   # AlertDialog (client)
      conversation-status-badge.tsx   # badge open/waiting/closed (client)
    messages/
      message-list.tsx            # lista cronológica (client)
      message-bubble.tsx          # burbuja individual con metadatos (client)
      send-message-form.tsx       # textarea + submit (client)
    notes/
      note-list.tsx               # lista de notas solo lectura — sin edit/delete (B4) (client)
      add-note-dialog.tsx         # dialog con textarea para crear nota (client)
    tasks/
      task-list.tsx               # tabla de tasks con filtros y acciones (client)
      task-form.tsx               # form create/edit con assignee y due_date (client)
      create-task-dialog.tsx      # (client)
      edit-task-dialog.tsx        # (client)
      task-status-select.tsx      # inline dropdown para cambiar status (client)
      delete-task-dialog.tsx      # AlertDialog, condicional por rol/autoría (client)
    shared/
      notification-bell.tsx       # icono con badge y dropdown (client)
      notification-item.tsx       # item con markRead onClick (client)

  app/(tenant)/dashboard/
    contacts/
      page.tsx                    # server component — listado de contactos
      [id]/
        page.tsx                  # server component — detalle + tabs workspace-filtered
    conversations/
      page.tsx                    # server component — inbox con filtros
      [id]/
        page.tsx                  # server component — detalle (messages + sidebar)
    tasks/
      page.tsx                    # server component — listado global de tasks
```

**Archivos eliminados respecto a v1** (por B4 — notes append-only):
- `notes/note-form.tsx` → reemplazado por textarea inline en `add-note-dialog.tsx`
- `notes/edit-note-dialog.tsx` → eliminado
- `notes/delete-note-dialog.tsx` → eliminado

---

## 4. Validators requeridos

### packages/validators/src/contacts.ts

```typescript
createContactSchema    // name?, email?, phone?, source?
updateContactSchema    // todos opcionales
```

**Reglas:**
- `name`: opcional, max 200
- `email`: opcional, formato email válido, max 200
- `phone`: opcional, max 50 (admite formatos internacionales; sin normalización en Fase 4)
- `source`: enum `'whatsapp' | 'website' | 'manual'`, default `'manual'`
- Refinement: al menos uno de `name`, `email`, `phone` debe estar presente (B8 — contacto mínimo identificable)

### packages/validators/src/conversations.ts

```typescript
createConversationSchema    // contact_id, workspace_id?, channel?, source?, ai_mode?
updateConversationSchema    // workspace_id?  (solo owner puede reasignar workspace)
assignConversationSchema    // assigned_user_id: string uuid | null
setAiModeSchema             // mode: 'manual' | 'assisted' | 'autonomous'
```

**Reglas:**
- `contact_id`: required, string uuid — existencia validada en la action
- `workspace_id`: opcional, uuid — receptionists required (validado en action)
- `channel`: enum `'whatsapp' | 'manual'`, default `'manual'`
- `source`: enum `'whatsapp_direct' | 'website_button' | 'manual'`, default `'manual'`
- `ai_mode`: enum `'manual' | 'assisted' | 'autonomous'` (B8 — valores nuevos; requiere migración de schema)
  - `manual` — IA silenciada, agente humano responde
  - `assisted` — IA sugiere respuestas pero agente debe aprobar
  - `autonomous` — IA responde automáticamente sin intervención humana
  - Default en createConversation: `'manual'`
- `assigned_user_id` en `assignConversationSchema`: `z.string().uuid().nullable()` — permite desasignar

### packages/validators/src/messages.ts

```typescript
sendMessageSchema    // content, content_type?
```

**Reglas:**
- `content`: required, min 1, max 4000
- `content_type`: enum `'text' | 'image' | 'document' | 'audio' | 'video'`, default `'text'`
- En Fase 4 la UI solo permite `content_type: 'text'`; otros tipos son para mensajes entrantes de WhatsApp

### packages/validators/src/notes.ts

```typescript
createNoteSchema    // content, contact_id?, conversation_id?, reservation_id?
```

**Reglas:**
- `content`: required, min 1, max 5000
- `contact_id`, `conversation_id`, `reservation_id`: todos opcionales, uuid
- Refinement: al menos uno de los tres debe estar presente
- **No existe `updateNoteSchema` ni schema de delete** — B4: notes son append-only

### packages/validators/src/tasks.ts

```typescript
createTaskSchema          // title, description?, due_date?, assigned_to?, contact_id?, conversation_id?
updateTaskSchema          // todos opcionales
updateTaskStatusSchema    // status: TaskStatus
```

**Reglas:**
- `title`: required, min 1, max 300
- `description`: opcional, max 2000
- `due_date`: opcional, `z.string().datetime().optional()` — ISO 8601
- `assigned_to`: opcional, uuid — validado en action
- `contact_id`, `conversation_id`: opcional, uuid
- `status`: enum `'pending' | 'in_progress' | 'completed' | 'cancelled'`

---

## 5. Repositories requeridos

### contacts.repository.ts

```typescript
type ContactRow = Tables<'contacts'>

listContacts(
  tenantId: string,
  opts?: { search?: string; source?: ContactSource; limit?: number }
): Promise<ContactRow[]>
// .is('deleted_at', null), .eq('tenant_id'), ilike por name/email/phone si search

getContactById(tenantId: string, id: string): Promise<ContactRow | null>
// .is('deleted_at', null) — contacto archivado = null

createContact(tenantId: string, input: CreateContactInput): Promise<ContactRow>

updateContact(tenantId: string, id: string, input: UpdateContactInput): Promise<ContactRow>

archiveContact(tenantId: string, id: string): Promise<void>
// soft delete: .update({ deleted_at: now() }).eq('id').is('deleted_at', null)
// .is('deleted_at', null) en el WHERE previene re-archivar (B6)

hasActiveConversations(tenantId: string, contactId: string): Promise<boolean>
// conversations WHERE contact_id = contactId AND status IN ('open', 'waiting')
```

### conversations.repository.ts

```typescript
type ConversationRow = Tables<'conversations'>
type ConversationWithContact = ConversationRow & { contact: ContactRow }

listConversations(
  tenantId: string,
  workspaceIds: string[] | null,
  opts?: { status?: ConversationStatus; assignedUserId?: string | null; contactId?: string; limit?: number; offset?: number }
): Promise<ConversationWithContact[]>
// workspace filter igual que listProperties
// JOIN contacts para nombre en lista
// Order: updated_at DESC

getConversationById(
  tenantId: string,
  id: string,
  workspaceIds: string[] | null
): Promise<ConversationRow | null>

createConversation(tenantId: string, input: CreateConversationInput): Promise<ConversationRow>

updateConversation(
  tenantId: string,
  id: string,
  patch: { workspace_id?: string | null }    // solo owner cambia workspace_id
): Promise<ConversationRow>

assignConversation(
  tenantId: string,
  id: string,
  assignedUserId: string | null
): Promise<ConversationRow>

setAiMode(
  tenantId: string,
  id: string,
  mode: AiMode                               // AiMode = 'manual' | 'assisted' | 'autonomous'
): Promise<ConversationRow>

closeConversation(tenantId: string, id: string): Promise<ConversationRow>
// .update({ status: 'closed', closed_at: now() })

reopenConversation(tenantId: string, id: string): Promise<ConversationRow>
// .update({ status: 'open', closed_at: null })

validateContactInTenant(tenantId: string, contactId: string): Promise<boolean>
// contacts WHERE id = contactId AND tenant_id = tenantId AND deleted_at IS NULL

validateAssigneeInTenant(tenantId: string, userId: string): Promise<boolean>
// tenant_users WHERE id = userId AND tenant_id = tenantId AND active = true
```

### messages.repository.ts

```typescript
type MessageRow = Tables<'messages'>

listMessages(
  tenantId: string,
  conversationId: string,
  opts?: { limit?: number; before?: string }
): Promise<MessageRow[]>
// Order: created_at ASC (cronológico)
// Limit default 50; before para paginación futura
// Mensajes son inmutables — no hay update/delete

createMessage(
  tenantId: string,
  conversationId: string,
  input: {
    content: string
    content_type: MessageContentType
    sender_type: 'human'               // siempre 'human' desde UI de agente
    sender_id: string                  // tenant_user_id del agente
  }
): Promise<MessageRow>
```

### notes.repository.ts

```typescript
type NoteRow = Tables<'notes'>
type NoteWithAuthor = NoteRow & { author: { id: string; name: string } }

listNotes(
  tenantId: string,
  opts: {
    contactId?: string
    conversationId?: string
    conversationIds?: string[]   // para contact detail con receptionist (múltiples convs accesibles)
    reservationId?: string
  }
): Promise<NoteWithAuthor[]>
// JOIN tenant_users para nombre del autor
// Order: created_at DESC
// Notas NO tienen deleted_at — son permanentes una vez creadas (B4)
// Si conversationIds = [] → excluir notas con conversation_id; mostrar solo las de contactId directo

createNote(
  tenantId: string,
  createdBy: string,             // tenant_user_id del actor
  input: CreateNoteInput
): Promise<NoteRow>

// NO existe updateNote — B4
// NO existe deleteNote — B4
// NO existe getNoteById — no se necesita si no hay update/delete
```

### tasks.repository.ts

```typescript
type TaskRow = Tables<'tasks'>
type TaskWithDetails = TaskRow & {
  assignee?: { id: string; name: string } | null
  author:    { id: string; name: string }
}

listTasks(
  tenantId: string,
  opts?: { status?: TaskStatus; assignedTo?: string; contactId?: string; conversationId?: string; includeCompleted?: boolean; limit?: number }
): Promise<TaskWithDetails[]>
// JOIN tenant_users ×2 (assignee + created_by)
// Order: due_date ASC NULLS LAST, created_at DESC
// Tasks NO tienen deleted_at — deleteTask es hard delete

getTaskById(tenantId: string, id: string): Promise<TaskRow | null>

createTask(tenantId: string, createdBy: string, input: CreateTaskInput): Promise<TaskRow>

updateTask(tenantId: string, id: string, input: UpdateTaskInput): Promise<TaskRow>

updateTaskStatus(tenantId: string, id: string, status: TaskStatus): Promise<TaskRow>
// status = 'completed' → completed_at = now()
// status != 'completed' → completed_at = null

deleteTask(tenantId: string, id: string): Promise<void>
// hard delete — tasks no tienen deleted_at
```

### notifications.repository.ts

```typescript
type NotificationRow = Tables<'notifications'>
// Nota: notifications.read_at TIMESTAMPTZ NULL debe existir antes de implementar (migración B7)

listMyNotifications(
  tenantId: string,
  recipientId: string,                 // tenant_user_id del usuario autenticado
  opts?: { channel?: 'in_app'; onlyUnread?: boolean; limit?: number }
): Promise<NotificationRow[]>
// Filtra: recipient_id, channel = 'in_app', tenant_id
// onlyUnread = true → .is('read_at', null)
// Order: created_at DESC, limit default 20

countUnread(tenantId: string, recipientId: string): Promise<number>
// WHERE recipient_id = ? AND channel = 'in_app' AND tenant_id = ? AND read_at IS NULL

markNotificationRead(
  tenantId: string,
  notificationId: string,
  recipientId: string              // seguridad: solo puede marcar la propia
): Promise<void>
// .update({ read_at: now() })
//   .eq('id', notificationId)
//   .eq('recipient_id', recipientId)
//   .eq('tenant_id', tenantId)
//   .is('read_at', null)         // idempotente — no re-marca
```

---

## 6. Server Actions requeridas

### actions/contacts.ts

| Action | Guard | Lógica clave |
|--------|-------|--------------|
| `createContactAction(input)` | `requireTenantContext()` | Ambos roles. Parsear + createContact. |
| `updateContactAction(id, input)` | `requireTenantContext()` | Ambos roles. Verificar contacto existe + no archivado. |
| `archiveContactAction(id)` | `requireTenantContext()` + `role === 'owner'` | Verificar `hasActiveConversations`. Si true → error. Soft delete. |

**archiveContactAction paso a paso:**
1. `role !== 'owner'` → error: `CONTACT_ARCHIVE_FORBIDDEN`
2. `getContactById(tenantId, id)` → null → error: `CONTACT_NOT_FOUND`
3. `hasActiveConversations(tenantId, id)` → true → error: `CONTACT_HAS_OPEN_CONVERSATIONS`
4. `archiveContact(tenantId, id)`
5. `revalidatePath('/dashboard/contacts')` + `revalidatePath('/dashboard/contacts/' + id)`

### actions/conversations.ts

| Action | Guard | Lógica clave |
|--------|-------|--------------|
| `createConversationAction(input)` | `requireTenantContext()` | Receptionist: workspace_id required + en su lista. Validar contact en tenant. |
| `updateConversationAction(id, patch)` | `requireTenantContext()` + `role === 'owner'` | Solo owner cambia workspace_id. |
| `assignConversationAction(id, assignedUserId)` | `requireTenantContext()` | B3: ver lógica compleja abajo. |
| `closeConversationAction(id)` | `requireTenantContext()` | Ambos roles (en su workspace). (B2) |
| `reopenConversationAction(id)` | `requireTenantContext()` | Ambos roles (en su workspace). |
| `setAiModeAction(id, mode)` | `requireTenantContext()` + `role === 'owner'` | Solo owner modifica ai_mode. (B8) |

**assignConversationAction paso a paso (B3):**
1. `getConversationById(tenantId, id, workspaceIds)` → null → error: `CONVERSATION_NOT_FOUND`
2. Si `role === 'receptionist'`:
   - Permitido solo si:
     a. `assignedUserId === ctx.userId` (se auto-asigna) Y la conversación está sin asignar (`conversation.assigned_user_id === null`) — toma una conversación disponible
     b. `assignedUserId === null` Y `conversation.assigned_user_id === ctx.userId` — se desasigna a sí mismo
   - Cualquier otro caso → error: `CONVERSATION_ASSIGN_FORBIDDEN`
3. Si `role === 'owner'`:
   - Si `assignedUserId` no es null → `validateAssigneeInTenant(tenantId, assignedUserId)`
4. `assignConversation(tenantId, id, assignedUserId)`
5. `revalidatePath('/dashboard/conversations')` + `revalidatePath('/dashboard/conversations/' + id)`

**setAiModeAction — owner only:**
- `role !== 'owner'` → error: `AI_MODE_FORBIDDEN`
- `getConversationById` sin workspace filter (null) — owner accede a todas
- Parsear con `setAiModeSchema`
- `setAiMode(tenantId, id, mode)`

**Nota conceptual sobre ai_mode (B8):**
- `manual` → agente humano responde; IA silenciada
- `assisted` → IA sugiere pero agente aprueba antes de enviar (integración IA — Fase 6)
- `autonomous` → IA responde sola sin intervención

### actions/messages.ts

| Action | Guard | Lógica clave |
|--------|-------|--------------|
| `sendMessageAction(conversationId, input)` | `requireTenantContext()` | Ambos roles. Verifica acceso a conversación. Bloquea si `status === 'closed'`. |

**sendMessageAction paso a paso:**
1. `getConversationById(tenantId, conversationId, workspaceIds)` → null → error: `CONVERSATION_NOT_FOUND`
2. `conversation.status === 'closed'` → error: `CONVERSATION_CLOSED_NO_SEND`
3. `sendMessageSchema.safeParse(input)`
4. `createMessage(tenantId, conversationId, { ...input, sender_type: 'human', sender_id: ctx.userId })`
5. `revalidatePath('/dashboard/conversations/' + conversationId)`

### actions/notes.ts

| Action | Guard | Lógica clave |
|--------|-------|--------------|
| `createNoteAction(input)` | `requireTenantContext()` | Ambos roles. Si tiene conversation_id → verificar acceso workspace. |

**createNoteAction paso a paso:**
1. `createNoteSchema.safeParse(input)` — refinement verifica contexto presente
2. Si `input.conversation_id`:
   - `getConversationById(tenantId, input.conversation_id, workspaceIds)` → null → error: `CONVERSATION_NOT_FOUND`
3. Si `input.contact_id`: `getContactById(tenantId, input.contact_id)` → null → error: `CONTACT_NOT_FOUND`
4. `createNote(tenantId, ctx.userId, input)`
5. Revalidar el path apropiado (conversation detail o contact detail)

**No existen `updateNoteAction` ni `deleteNoteAction` — B4.**

### actions/tasks.ts

| Action | Guard | Lógica clave |
|--------|-------|--------------|
| `createTaskAction(input)` | `requireTenantContext()` | Ambos roles. Validar assignee + acceso a conversation si se proporciona. |
| `updateTaskAction(id, input)` | `requireTenantContext()` | Ambos roles. |
| `updateTaskStatusAction(id, status)` | `requireTenantContext()` | Ambos roles. |
| `deleteTaskAction(id)` | `requireTenantContext()` | Owner: cualquier task. Receptionist: solo si `task.created_by === ctx.userId`. |

**deleteTaskAction paso a paso:**
1. `getTaskById(tenantId, id)` → null → error: `TASK_NOT_FOUND`
2. Si `role === 'receptionist'` y `task.created_by !== ctx.userId` → error: `TASK_DELETE_FORBIDDEN`
3. `deleteTask(tenantId, id)`
4. Revalidar path apropiado

### actions/notifications.ts

| Action | Guard | Lógica clave |
|--------|-------|--------------|
| `markNotificationReadAction(notificationId)` | `requireTenantContext()` | `markNotificationRead(tenantId, notificationId, ctx.userId)` |

**Tipo de retorno unificado** — extraído a `@/lib/action-result.ts`:
```typescript
export type ActionResult<T = undefined> =
  | { success: true; data?: T }
  | { success: false; error: string }
```

---

## 7. Componentes React requeridos

### contacts/contact-table.tsx (client)
**Props**: `contacts: ContactRow[]`, `currentRole: TenantRole`

**Columnas**: Nombre, Email, Teléfono, Fuente (badge), Creado, Acciones

**Acciones por fila:**
- Ver detalle → link `/dashboard/contacts/[id]`
- Editar (ambos roles)
- Archivar (owner only, disabled con tooltip para receptionist)

**Barra superior**: botón "Nuevo contacto" + buscador client-side por name/email/phone

### contacts/contact-form.tsx (client)
**Props**: `defaultValues?`, `onSubmit`, `isPending`, `onCancel?`

**Campos:** `name`, `email` (type email), `phone` (type tel), `source` (Select)

### conversations/conversation-list.tsx (client)
**Props**: `conversations: ConversationWithContact[]`, `workspaces: WorkspaceRow[]`, `tenantUsers: TenantUserRow[]`, `currentRole: TenantRole`, `currentUserId: string`

**Columnas**: Contacto, Status (badge), Workspace, Asignado, ai_mode, Actualizado, Acciones

**Filtros client-side**: status, workspace, assignee

**Acciones por fila:**
- Ver → link `/dashboard/conversations/[id]`
- Cerrar (ambos roles — B2)
- Asignar: owner → assign-conversation-dialog con todos los users; receptionist → solo "Tomar" (auto-asignarse) si está sin asignar

### conversations/ai-mode-display.tsx (client)
**Props**: `conversation: ConversationRow`, `currentRole: TenantRole`

**Owner**: muestra mode actual + botón para cambiar (invoca setAiModeAction via useTransition)

**Receptionist**: muestra mode actual como badge de solo lectura; sin botón de acción

**Estados visuales**: `manual` = gris, `assisted` = amarillo, `autonomous` = verde

### conversations/assign-conversation-dialog.tsx (client)
**Props**: `conversation: ConversationRow`, `tenantUsers: TenantUserRow[]`, `currentRole: TenantRole`, `currentUserId: string`

**Owner**: Select con todos los usuarios activos del tenant + opción "Sin asignar"

**Receptionist**: Solo muestra si `conversation.assigned_user_id === null` (sin asignar). Botón "Tomar conversación" que auto-asigna a `currentUserId`. O si ya está asignado a `currentUserId`: botón "Desasignar" que la pone en null.

### messages/message-list.tsx (client)
**Props**: `messages: MessageRow[]`, `currentUserId: string`

**Render**: burbujas cronológicas. `sender_type: 'customer'` → izquierda; `'human'` o `'ai'` → derecha con nombre del agente.

### messages/send-message-form.tsx (client)
**Props**: `conversationId: string`, `disabled?: boolean`

**Comportamiento**: Enter envía, Shift+Enter nueva línea. Cuando `disabled = true` (conversación cerrada): textarea readonly + mensaje explicativo.

### notes/note-list.tsx (client)
**Props**: `notes: NoteWithAuthor[]`

**Render**: lista cronológica de notas con autor y fecha. Sin botones de editar ni eliminar — B4. Solo "+" para agregar nota nueva.

### notes/add-note-dialog.tsx (client)
**Props**: `onSubmit: (content: string) => Promise<void>`, `isPending: boolean`, `contextLabel?: string`

**Render**: Dialog con Textarea simple. El caller proporciona el contexto (contact_id o conversation_id) y lo pasa a `createNoteAction` en su `onSubmit`.

### tasks/task-list.tsx (client)
**Props**: `tasks: TaskWithDetails[]`, `tenantUsers: TenantUserRow[]`, `currentRole: TenantRole`, `currentUserId: string`

**Columnas**: Título, Asignado, Vencimiento, Status (select inline), Acciones

**Acciones:**
- Editar (ambos roles)
- Eliminar: owner → siempre; receptionist → solo si `task.created_by === currentUserId`

### tasks/task-status-select.tsx (client)
**Props**: `taskId: string`, `currentStatus: TaskStatus`

Llama `updateTaskStatusAction` via `useTransition`. Todos los roles pueden usar.

### shared/notification-bell.tsx (client)
**Props**: `initialCount: number`, `recipientId: string`

**Render**: icono campana + badge count. Dropdown con últimas N notificaciones. Al hacer click en una → `markNotificationReadAction(id)`. Badge count se decrementa localmente.

**Actualización**: En Fase 4 el count se re-fetcha en cada `router.refresh()`. Realtime subscriptions en Fase 6.

---

## 8. Páginas requeridas

### /dashboard/contacts/page.tsx (Server Component)

```typescript
export default async function ContactsPage() {
  const ctx = await requireTenantContext()
  const contacts = await listContacts(ctx.tenantId)
  return (
    <div className="container mx-auto max-w-5xl px-4 py-8">
      <ContactTable contacts={contacts} currentRole={ctx.role} />
    </div>
  )
}
```

### /dashboard/contacts/[id]/page.tsx (Server Component)

```typescript
export default async function ContactDetailPage({ params }) {
  const ctx = await requireTenantContext()
  const { id } = await params

  const contact = await getContactById(ctx.tenantId, id)
  if (!contact) notFound()

  // Conversations: workspace-filtered (B1 — receptionist ve solo su workspace)
  const conversations = await listConversations(ctx.tenantId, ctx.workspaceIds, { contactId: id })

  // Notes: directas al contacto (siempre visibles) + las de conversaciones accesibles (B1)
  const accessibleConversationIds = conversations.map((c) => c.id)
  const notes = await listNotes(ctx.tenantId, {
    contactId: id,
    conversationIds: accessibleConversationIds,  // owner: pasar null (sin filtro)
  })

  // Tasks: ancladas al contacto o a sus conversaciones accesibles
  const tasks = await listTasks(ctx.tenantId, { contactId: id })

  const tenantUsers = await listTenantUsers(ctx.tenantId)

  return (
    // Layout: header con datos + tabs (Conversaciones, Notas, Tareas)
    <ContactDetailLayout
      contact={contact}
      conversations={conversations}
      notes={notes}
      tasks={tasks}
      tenantUsers={tenantUsers}
      currentRole={ctx.role}
      currentUserId={ctx.userId}
    />
  )
}
```

**Nota sobre `listNotes` en contact detail (B1):**
- Owner: `conversationIds = null` (todos); receptor: `conversationIds = accessibleConversationIds`
- El repositorio incluye siempre notas con `conversation_id IS NULL AND contact_id = ?`
- El repositorio agrega notas con `conversation_id IN (accessibleConversationIds)` solo si la lista no está vacía

### /dashboard/conversations/page.tsx (Server Component)

```typescript
export default async function ConversationsPage() {
  const ctx = await requireTenantContext()
  const [conversations, workspaces, tenantUsers] = await Promise.all([
    listConversations(ctx.tenantId, ctx.workspaceIds, { limit: 50 }),
    listWorkspaces(ctx.tenantId),
    listTenantUsers(ctx.tenantId),
  ])
  const accessibleWorkspaces = ctx.workspaceIds === null
    ? workspaces
    : workspaces.filter((w) => ctx.workspaceIds!.includes(w.id))
  return (
    <ConversationList
      conversations={conversations}
      workspaces={accessibleWorkspaces}
      tenantUsers={tenantUsers}
      currentRole={ctx.role}
      currentUserId={ctx.userId}
    />
  )
}
```

### /dashboard/conversations/[id]/page.tsx (Server Component)

```typescript
export default async function ConversationDetailPage({ params }) {
  const ctx = await requireTenantContext()
  const { id } = await params

  const conversation = await getConversationById(ctx.tenantId, id, ctx.workspaceIds)
  if (!conversation) notFound()

  const [contact, messages, notes, tasks, tenantUsers] = await Promise.all([
    getContactById(ctx.tenantId, conversation.contact_id),
    listMessages(ctx.tenantId, id),
    listNotes(ctx.tenantId, { conversationId: id }),
    listTasks(ctx.tenantId, { conversationId: id }),
    listTenantUsers(ctx.tenantId),
  ])

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      {/* Panel principal */}
      <div className="flex flex-1 flex-col">
        <ConversationDetailHeader
          conversation={conversation}
          contact={contact!}
          tenantUsers={tenantUsers}
          currentRole={ctx.role}
          currentUserId={ctx.userId}
        />
        <MessageList messages={messages} currentUserId={ctx.userId} />
        <SendMessageForm
          conversationId={id}
          disabled={conversation.status === 'closed'}
        />
      </div>
      {/* Sidebar */}
      <aside className="w-80 border-l overflow-y-auto p-4 space-y-6">
        <AiModeDisplay conversation={conversation} currentRole={ctx.role} />
        <NoteList notes={notes} />
        <AddNoteDialog conversationId={id} />
        <TaskList
          tasks={tasks}
          tenantUsers={tenantUsers}
          currentRole={ctx.role}
          currentUserId={ctx.userId}
        />
        <CreateTaskDialog conversationId={id} tenantUsers={tenantUsers} />
      </aside>
    </div>
  )
}
```

### /dashboard/tasks/page.tsx (Server Component)

```typescript
export default async function TasksPage() {
  const ctx = await requireTenantContext()
  const [tasks, tenantUsers] = await Promise.all([
    listTasks(ctx.tenantId, { limit: 100 }),
    listTenantUsers(ctx.tenantId),
  ])
  return (
    <div className="container mx-auto max-w-5xl px-4 py-8">
      <TaskList tasks={tasks} tenantUsers={tenantUsers} currentRole={ctx.role} currentUserId={ctx.userId} />
    </div>
  )
}
```

---

## 9. Casos de uso

| CU | Actor | Precondición | Flujo |
|----|-------|--------------|-------|
| CU-C01 | Owner | Logueado | Crea contacto solo con nombre → source='manual' |
| CU-C02 | Receptionist | Logueado | Crea contacto con email → visible para todo el tenant |
| CU-C03 | Owner | Contacto sin conversaciones abiertas | Archiva contacto → deleted_at set (B6 soft delete) |
| CU-C04 | Owner | Contacto con conversación open | Intenta archivar → error controlado |
| CU-C05 | Receptionist | — | Intenta archivar contacto → error de permisos |
| CU-C06 | Receptionist | — | Lista contactos → ve todos los del tenant (B1) |
| CU-V01 | Owner | Logueado | Crea conversación sin workspace → workspace_id = null, solo owner la ve |
| CU-V02 | Receptionist | Workspace Y | Crea conversación → workspace Y requerido; se valida que Y esté en sus workspaceIds |
| CU-V03 | Owner | Conversación abierta | Asigna conversación a receptionist R → R puede verla y tomar control |
| CU-V04 | Receptionist | Conv. sin asignar en su workspace | Toma conversación (auto-asigna) → assigned_user_id = suyo |
| CU-V05 | Receptionist | Conv. asignada a otro | Intenta reasignar → error: CONVERSATION_ASSIGN_FORBIDDEN |
| CU-V06 | Owner | Conversación abierta | Cambia ai_mode a 'manual' → IA silenciada |
| CU-V07 | Receptionist | Conversación | Intenta cambiar ai_mode → error: AI_MODE_FORBIDDEN (B8) |
| CU-V08 | Owner | Conv. abierta | Cierra conversación → status='closed', closed_at=now() |
| CU-V09 | Receptionist | Conv. de su workspace | Cierra conversación → permitido (B2) |
| CU-V10 | Owner | Conv. cerrada | Reabre → status='open', closed_at=null |
| CU-M01 | Owner/Receptionist | Conv. abierta o waiting | Envía mensaje → sender_type='human', sender_id=userId |
| CU-M02 | Owner/Receptionist | Conv. cerrada | Intenta enviar → error: CONVERSATION_CLOSED_NO_SEND |
| CU-N01 | Owner/Receptionist | Conv. accesible | Crea nota anclada → nota permanente, sin edición posible (B4) |
| CU-N02 | Owner/Receptionist | — | Intenta editar nota → no existe endpoint/botón (B4) |
| CU-N03 | Owner/Receptionist | Contact visible | Crea nota directa en contacto → visible para ambos roles |
| CU-T01 | Owner/Receptionist | Logueado | Crea task con due_date y assignee (B5) |
| CU-T02 | Owner/Receptionist | Task propia o asignada | Cambia status a completed → completed_at=now() |
| CU-T03 | Owner | Task de cualquier usuario | Elimina task → hard delete |
| CU-T04 | Receptionist | Task ajena | Intenta eliminar → error: TASK_DELETE_FORBIDDEN |
| CU-NT01 | Owner/Receptionist | Notificaciones in_app | Abre bell dropdown → ve sus notificaciones no leídas |
| CU-NT02 | Owner/Receptionist | Notificación visible | Hace click → read_at = now(), badge count −1 (B7) |

---

## 10. Permission Matrix

### Contacts

| Operación | Owner | Receptionist |
|-----------|-------|--------------|
| `listContacts` | ✓ (todos) | ✓ (todos — tenant-wide, B1) |
| `getContactById` | ✓ | ✓ |
| `createContact` | ✓ | ✓ |
| `updateContact` | ✓ | ✓ |
| `archiveContact` | ✓ | ✗ |

### Conversations

| Operación | Owner | Receptionist |
|-----------|-------|--------------|
| `listConversations` (todas) | ✓ | ✗ (solo su workspace) |
| `listConversations` (su workspace) | ✓ | ✓ |
| `getConversationById` | ✓ | ✓ (su workspace) |
| `createConversation` (su workspace) | ✓ | ✓ |
| `createConversation` (sin workspace) | ✓ | ✗ |
| `assignConversation` (a cualquier user) | ✓ | ✗ |
| `assignConversation` (auto-asignar, conv. sin asignar) | ✓ | ✓ |
| `assignConversation` (desasignarse a sí mismo) | ✓ | ✓ |
| `closeConversation` | ✓ | ✓ (su workspace, B2) |
| `reopenConversation` | ✓ | ✓ (su workspace) |
| `setAiMode` | ✓ | ✗ (solo lectura, B8) |
| `updateConversation` (workspace_id) | ✓ | ✗ |

### Messages

| Operación | Owner | Receptionist |
|-----------|-------|--------------|
| `listMessages` (conv. accesible) | ✓ | ✓ |
| `sendMessage` (conv. open/waiting) | ✓ | ✓ (su workspace) |
| `sendMessage` (conv. closed) | ✗ | ✗ |
| Editar/eliminar mensaje | ✗ | ✗ (inmutables) |

### Notes

| Operación | Owner | Receptionist |
|-----------|-------|--------------|
| `listNotes` (directas a contacto) | ✓ | ✓ |
| `listNotes` (de conv. accesible) | ✓ | ✓ (su workspace) |
| `createNote` (conv. accesible) | ✓ | ✓ |
| `createNote` (directa en contacto) | ✓ | ✓ |
| `updateNote` | ✗ | ✗ (B4 — append-only) |
| `deleteNote` | ✗ | ✗ (B4 — append-only) |

### Tasks

| Operación | Owner | Receptionist |
|-----------|-------|--------------|
| `listTasks` | ✓ (todas) | ✓ (todas) |
| `createTask` | ✓ | ✓ (B5) |
| `updateTask` | ✓ | ✓ |
| `updateTaskStatus` | ✓ | ✓ |
| `deleteTask` (propia) | ✓ | ✓ |
| `deleteTask` (ajena) | ✓ | ✗ |

### Notifications

| Operación | Owner | Receptionist |
|-----------|-------|--------------|
| `listMyNotifications` (propias) | ✓ | ✓ |
| `markNotificationRead` (propia) | ✓ | ✓ |
| Ver notificaciones ajenas | ✗ | ✗ |
| Crear notificaciones | ✗ (sistema) | ✗ (sistema) |

---

## 11. Workspace scoping rules

### Regla fundamental

```
Owner        → workspaceIds = null      → ve TODAS las conversaciones
Receptionist → workspaceIds = []        → ve NINGUNA conversación (early return)
Receptionist → workspaceIds = ['A','B'] → ve solo conv. donde workspace_id IN (A, B)
```

### Entidades y su regla de workspace

| Entidad | Workspace filter | Motivo |
|---------|-----------------|--------|
| `contacts` | NINGUNO — tenant-wide | B1: contacto existe una sola vez por tenant |
| `conversations` | Igual que properties | B1: receptionists aislados por workspace |
| `messages` | Heredado de conversation | Si accedés a la conv., accedés a sus messages |
| `notes` con conversation_id | Heredado de conversation | La conv. ya fue verificada antes de listar notas |
| `notes` sin conversation_id | NINGUNO — tenant-wide | Ancladas solo a contacto = dato compartido |
| `tasks` | NINGUNO — tenant-wide | Tasks son colaborativas; scoping por conv. en context |
| `notifications` | Por recipient_id | Cada user solo ve las suyas |

### Conversaciones con workspace_id = null

Visibles solo para owners. Un receptionist nunca las ve aunque tenga workspaces asignados (`.in('workspace_id', workspaceIds)` excluye NULLs en SQL).

### Filtro en conversations.repository.ts

```typescript
if (workspaceIds !== null && workspaceIds.length === 0) return []

let query = supabase
  .from('conversations')
  .select('*, contact:contacts(*)')
  .eq('tenant_id', tenantId)

if (workspaceIds !== null) {
  query = query.in('workspace_id', workspaceIds)
}
```

### Contact detail page — workspace scoping de entidades hijas (B1)

```typescript
// En /dashboard/contacts/[id]/page.tsx
const conversations = await listConversations(tenantId, workspaceIds, { contactId: id })
const accessibleIds  = conversations.map(c => c.id)

// Owner: conversationIds = null → sin filtro
// Receptionist: conversationIds = accessibleIds → incluye notas de esas convs + directas
const notes = await listNotes(tenantId, {
  contactId: id,
  conversationIds: ctx.workspaceIds === null ? null : accessibleIds,
})
```

### Asignación vs workspace scoping

Son dimensiones independientes:
- `workspace_id`: controla visibilidad (quién puede VER la conversación)
- `assigned_user_id`: indica responsable operativo (quién DEBE atenderla)
- Una conversación puede ser visible para N receptionists pero asignada a solo uno

---

## 12. Contact lifecycle (B6 — solo soft delete)

```
         createContact()
              │
              ▼
    ┌─────────────────────┐
    │       ACTIVE        │  deleted_at = null
    │  (visible en CRM)   │◄── updateContact()
    └──────────┬──────────┘
               │
               │ archiveContact() ── BLOQUEADO si tiene conversations open/waiting
               │ (solo owner)
               ▼
    ┌─────────────────────┐
    │      ARCHIVED       │  deleted_at = now()
    │  (invisible en CRM) │
    │  (hard delete: ✗)   │
    └─────────────────────┘
```

**No existe hard delete de contactos en ningún endpoint** — B6.

**Regla de cascada al archivar:**
- Conversaciones `closed`: permanecen en DB (historial)
- Notas y tasks: permanecen en DB (historial)
- Conversaciones `open/waiting`: bloquean el archivado; deben cerrarse primero

---

## 13. Conversation lifecycle

```
    createConversation() / inbound WhatsApp
              │
              ▼  ai_mode: manual (default)
    ┌─────────────────────┐
    │        OPEN         │  status='open', closed_at=null
    └────────┬───┬────────┘
    mensajes │   │ closeConversation()
    entrantes│   │ (ambos roles — B2)
             │   ▼
    ┌────────┴────────────┐
    │       WAITING       │◄──── nuevo mensaje del contacto (via webhook externo)
    └──────────┬──────────┘
               │ closeConversation() (ambos roles — B2)
               ▼
    ┌─────────────────────┐
    │       CLOSED        │  status='closed', closed_at=now()
    │  (solo lectura —    │
    │   no se envían msgs)│
    └──────────┬──────────┘
               │ reopenConversation() (ambos roles)
               └──────────► OPEN
```

**ai_mode transitions:**
- `manual` ↔ `assisted` ↔ `autonomous` — solo owner puede cambiar (B8)
- Estado inicial al crear conversación manualmente: `manual`
- Receptionist ve el mode actual como badge, sin control de cambio

---

## 14. Task lifecycle

```
    createTask()
        │   status='pending', completed_at=null
        ▼
    ┌──────────┐  updateTaskStatus('in_progress')   ┌─────────────┐
    │  PENDING │────────────────────────────────────►│ IN_PROGRESS │
    └──────────┘                                     └──────┬──────┘
         │                                                  │
         │           updateTaskStatus('completed')          │
         └─────────────────────────────────────────────────►│
                                                            ▼
                                                    ┌─────────────┐
                                                    │  COMPLETED  │ completed_at=now()
                                                    └─────────────┘

    (desde cualquier estado)
    updateTaskStatus('cancelled') → CANCELLED
    (retroceder de COMPLETED → PENDING/IN_PROGRESS: completed_at=null — permitido)
```

**Hard delete** (no hay soft delete en tasks):
- Owner: puede borrar cualquier task
- Receptionist: solo puede borrar tasks donde `created_by === ctx.userId`

---

## 15. Error catalog

| Código | Trigger | Mensaje al usuario |
|--------|---------|-------------------|
| `CONTACT_NOT_FOUND` | `getContactById` retorna null o archived | "Contacto no encontrado." |
| `CONTACT_ARCHIVED` | Operación sobre contacto con deleted_at set | "Este contacto está archivado." |
| `CONTACT_HAS_OPEN_CONVERSATIONS` | `hasActiveConversations` = true al archivar | "El contacto tiene conversaciones abiertas. Cerralaas antes de archivarlo." |
| `CONTACT_ARCHIVE_FORBIDDEN` | Receptionist intenta archivar | "Solo los owners pueden archivar contactos." |
| `CONVERSATION_NOT_FOUND` | `getConversationById` retorna null | "Conversación no encontrada." |
| `CONVERSATION_WORKSPACE_FORBIDDEN` | Workspace del user no incluye el de la conversación | "No tenés acceso a esta conversación." |
| `CONVERSATION_WORKSPACE_REQUIRED` | Receptionist crea conversación sin workspace_id | "Debés asignar un workspace a la conversación." |
| `CONVERSATION_WORKSPACE_NOT_ASSIGNED` | Receptionist asigna workspace que no tiene | "No tenés acceso a ese workspace." |
| `CONVERSATION_ASSIGN_FORBIDDEN` | Receptionist intenta reasignar conversación no propia/no vacía | "Solo podés tomar conversaciones sin asignar o desasignarte de las tuyas." |
| `CONVERSATION_CLOSED_NO_SEND` | Envío de mensaje a conversación cerrada | "No podés enviar mensajes a una conversación cerrada." |
| `CONVERSATION_ASSIGNEE_NOT_IN_TENANT` | `assigned_user_id` no en el tenant | "El usuario asignado no existe en tu organización." |
| `CONTACT_NOT_IN_TENANT` | `contact_id` no en el tenant | "El contacto no existe en tu organización." |
| `AI_MODE_FORBIDDEN` | Receptionist intenta setAiMode | "Solo los owners pueden cambiar el modo de IA." |
| `MESSAGE_CONTENT_EMPTY` | content vacío o solo espacios | "El mensaje no puede estar vacío." |
| `NOTE_CONTEXT_REQUIRED` | Nota sin contact_id ni conversation_id ni reservation_id | "La nota necesita estar anclada a un contacto, conversación o reserva." |
| `TASK_NOT_FOUND` | `getTaskById` retorna null | "Tarea no encontrada." |
| `TASK_DELETE_FORBIDDEN` | Receptionist borra task ajena | "Solo podés eliminar tus propias tareas." |
| `TASK_ASSIGNEE_NOT_IN_TENANT` | `assigned_to` no en el tenant | "El usuario asignado no existe en tu organización." |

**Errores eliminados respecto a v1** (B4 — notes append-only):
- ~~`NOTE_NOT_FOUND`~~ — no se consultan notas por ID
- ~~`NOTE_EDIT_FORBIDDEN`~~ — endpoint no existe
- ~~`NOTE_DELETE_FORBIDDEN`~~ — endpoint no existe

---

## 16. Flujos de datos

### Flujo 1: Receptionist toma una conversación sin asignar

```
Receptionist abre /dashboard/conversations
  → ConversationList muestra conv. sin assignee (assigned_user_id = null)
  → Click en "Tomar" → AssignConversationDialog (modo receptionist)
  → assignConversationAction(convId, ctx.userId)
      ├─ getConversationById(tenantId, convId, workspaceIds)   // workspace check
      ├─ role = 'receptionist'
      ├─ assignedUserId = ctx.userId (auto-asignación)
      ├─ conversation.assigned_user_id === null ✓  // condición permitida B3
      ├─ assignConversation(tenantId, convId, ctx.userId)
      └─ revalidatePath → lista + detalle actualizados
```

### Flujo 2: Owner cambia ai_mode a autonomous

```
Owner abre /dashboard/conversations/[id]
  → AiModeDisplay muestra botón de cambio (solo para owner)
  → Click → setAiModeAction(convId, 'autonomous')
      ├─ requireTenantContext() → role = 'owner' ✓
      ├─ getConversationById(tenantId, convId, null)  // null = owner ve todo
      ├─ setAiModeSchema.safeParse({ mode: 'autonomous' })
      ├─ setAiMode(tenantId, convId, 'autonomous')
      └─ revalidatePath → AiModeDisplay actualiza badge a 'autonomous' (verde)
```

### Flujo 3: Receptionist ve contact detail (B1 filtering)

```
GET /dashboard/contacts/[id]   (receptionist, workspaceIds = ['ws-A'])
  │
  ├─ getContactById(tenantId, id)  → contact (tenant-wide, siempre accesible)
  │
  ├─ listConversations(tenantId, ['ws-A'], { contactId: id })
  │   → returns only conversations where workspace_id = 'ws-A'
  │   → accessibleIds = ['conv-1', 'conv-3']  (conv-2 es de ws-B, invisible)
  │
  ├─ listNotes(tenantId, { contactId: id, conversationIds: ['conv-1', 'conv-3'] })
  │   → notes WHERE (contact_id = id AND conversation_id IS NULL)   ← siempre visible
  │     OR (conversation_id IN ('conv-1', 'conv-3'))                 ← workspace-filtered
  │
  └─ render: receptionist ve el contacto + solo sus conversaciones + notas filtradas
```

### Flujo 4: Marcar notificación como leída

```
NotificationBell dropdown abierto
  → usuario hace click en notificación
  → markNotificationReadAction(notificationId)
      ├─ requireTenantContext() → { tenantId, userId }
      ├─ markNotificationRead(tenantId, notificationId, userId)
      │   .update({ read_at: now() })
      │   .eq('id', notificationId)
      │   .eq('recipient_id', userId)   // seguridad: solo la propia
      │   .is('read_at', null)          // idempotente
      └─ NotificationBell decrementa badge count localmente (optimistic UI)
```

---

## 17. Test scenarios

### Contacts

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| T-C01 | Owner crea contacto solo con nombre | `{ name: 'Juan' }` | 201, source='manual' |
| T-C02 | Nadie puede crear contacto sin campos identificadores | `{}` | error refinement: al menos name/email/phone |
| T-C03 | Receptionist crea contacto con email | `{ email: 'a@b.com' }` | 201 — tenant-wide |
| T-C04 | Receptionist lista contactos | — | ✓ todos los del tenant (B1) |
| T-C05 | Owner archiva contacto sin conversaciones | — | deleted_at set (soft delete, B6) |
| T-C06 | Owner archiva contacto con conv. open | — | error: `CONTACT_HAS_OPEN_CONVERSATIONS` |
| T-C07 | Receptionist archiva contacto | — | error: `CONTACT_ARCHIVE_FORBIDDEN` |
| T-C08 | Cross-tenant: contact de otro tenant | `getContactById(otherTenantId, id)` | null |

### Conversations — Assign (B3)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| T-V01 | Owner asigna conv. a cualquier user | `assignConversationAction(id, userId)` | éxito |
| T-V02 | Receptionist toma conv. sin asignar | `assignConversationAction(id, ctx.userId)` | éxito — auto-asignación |
| T-V03 | Receptionist se desasigna | `assignConversationAction(id, null)` donde `conv.assigned = ctx.userId` | éxito |
| T-V04 | Receptionist intenta asignar a otro user | `assignConversationAction(id, otherUserId)` | error: `CONVERSATION_ASSIGN_FORBIDDEN` |
| T-V05 | Receptionist intenta tomar conv. ya asignada a otro | `assignConversationAction(id, ctx.userId)` donde `conv.assigned = otherUser` | error: `CONVERSATION_ASSIGN_FORBIDDEN` |

### Conversations — ai_mode (B8)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| T-A01 | Owner cambia ai_mode a autonomous | `setAiModeAction(id, 'autonomous')` | ai_mode='autonomous' |
| T-A02 | Owner cambia ai_mode a assisted | `setAiModeAction(id, 'assisted')` | ai_mode='assisted' |
| T-A03 | Receptionist intenta cambiar ai_mode | `setAiModeAction(id, 'manual')` | error: `AI_MODE_FORBIDDEN` |
| T-A04 | Enum inválido | `setAiModeAction(id, 'auto')` | error de validación Zod (valor viejo) |

### Conversations — Close (B2)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| T-V06 | Owner cierra conversación | `closeConversationAction(id)` | status='closed', closed_at set |
| T-V07 | Receptionist cierra conv. de su workspace | `closeConversationAction(id)` | éxito (B2) |
| T-V08 | Receptionist cierra conv. de otro workspace | — | error: `CONVERSATION_NOT_FOUND` (notFound) |

### Notes — Append-only (B4)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| T-N01 | Owner crea nota anclada a conversación | `{ content: 'Seguimiento', conversation_id }` | nota creada, created_by=actor |
| T-N02 | Receptionist crea nota en conv. de su workspace | `{ content: '...', conversation_id }` | éxito |
| T-N03 | Receptionist crea nota en conv. de otro workspace | — | error: `CONVERSATION_NOT_FOUND` |
| T-N04 | Nota sin contexto | `{ content: 'Nota' }` | error: `NOTE_CONTEXT_REQUIRED` |
| T-N05 | Intento de edit/delete (no existe endpoint) | — | 404 / endpoint no existente |
| T-N06 | Nota directa en contacto | `{ content: '...', contact_id }` | visible para ambos roles |

### Notifications — read_at (B7)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| T-NT01 | User ve sus notificaciones in_app | `listMyNotifications` | solo propias, channel='in_app' |
| T-NT02 | User marca notificación como leída | `markNotificationReadAction(id)` | read_at=now() set |
| T-NT03 | Marcar ya leída (idempotente) | `markNotificationReadAction(id)` ×2 | sin error, read_at no cambia |
| T-NT04 | User intenta marcar notificación ajena | `markNotificationReadAction(ajenoId)` | silencioso — .eq('recipient_id') impide el update |
| T-NT05 | Count unread | `countUnread(tenantId, userId)` | solo notifs con read_at IS NULL |

---

## 18. Checklist pre-implementación

### Migraciones de schema (deben aplicarse ANTES de implementar)

- [ ] **MIG-1**: `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ NULL;` (B7)
- [ ] **MIG-2**: Migración de enum `ai_mode` — valores viejos: `'auto'|'human'|'disabled'`; valores nuevos: `'manual'|'assisted'|'autonomous'` (B8)
  - Secuencia en PostgreSQL:
    ```sql
    -- 1. Añadir columna temporal con tipo text
    ALTER TABLE conversations ADD COLUMN ai_mode_new TEXT;
    -- 2. Mapear valores existentes
    UPDATE conversations SET ai_mode_new = CASE
      WHEN ai_mode = 'auto'     THEN 'autonomous'
      WHEN ai_mode = 'human'    THEN 'manual'
      WHEN ai_mode = 'disabled' THEN 'manual'
    END;
    -- 3. Drop columna vieja, recrear con nuevo enum
    ALTER TABLE conversations DROP COLUMN ai_mode;
    ALTER TYPE ai_mode RENAME TO ai_mode_deprecated;
    CREATE TYPE ai_mode AS ENUM ('manual', 'assisted', 'autonomous');
    ALTER TABLE conversations ADD COLUMN ai_mode ai_mode NOT NULL DEFAULT 'manual';
    UPDATE conversations SET ai_mode = ai_mode_new::ai_mode;
    ALTER TABLE conversations DROP COLUMN ai_mode_new;
    DROP TYPE ai_mode_deprecated;
    ```
  - Regenerar `packages/types/src/database.ts` después

### Decisiones de negocio confirmadas

- [x] **B1**: Contacts tenant-wide. Receptionists ven todos los contactos pero filtran conversations/notes/tasks por workspace.
- [x] **B2**: Owner Y receptionist pueden cerrar conversaciones.
- [x] **B3**: Owner reasigna cualquier conversación. Receptionist: solo auto-asignarse (sin asignar) o desasignarse.
- [x] **B4**: Notes append-only. Sin UPDATE ni DELETE para usuarios autenticados.
- [x] **B5**: Ambos roles pueden crear tasks.
- [x] **B6**: Contacts solo soft delete. No hard delete.
- [x] **B7**: Notifications usan `read_at TIMESTAMPTZ NULL`. Sin boolean `is_read`.
- [x] **B8**: ai_mode = `manual | assisted | autonomous`. Solo owner puede modificar.

### Verificaciones técnicas antes de codear

- [ ] Confirmar que `requireTenantContext()` expone `ctx.userId` (tenant_user_id del autenticado) — necesario para `sendMessageAction`, `createNoteAction`, `createTaskAction`, `markNotificationReadAction`
- [ ] Confirmar que `listTenantUsers(tenantId)` existe o crearlo en nuevo repositorio `tenant-users.repository.ts`
- [ ] Aplicar MIG-1 y MIG-2 y regenerar `database.ts` antes de escribir código
- [ ] Confirmar layout `/dashboard/conversations/[id]` compatible con `h-[calc(100vh-4rem)]` y layout global
- [ ] Confirmar que `notes` no tienen `deleted_at` → confirmed (database.ts): son permanentes (B4)
- [ ] Confirmar que `tasks` no tienen `deleted_at` → confirmed (database.ts): deleteTask es hard delete
- [ ] Confirmar que `messages` son append-only → confirmed (database.ts): no hay update endpoint
- [ ] Mover `ActionResult<T>` a `@/lib/action-result.ts` antes de implementar las actions

### Archivos a crear/modificar

**Validators (5 nuevos + 1 actualización):**
- [ ] `packages/validators/src/contacts.ts` — NUEVO
- [ ] `packages/validators/src/conversations.ts` — NUEVO
- [ ] `packages/validators/src/messages.ts` — NUEVO
- [ ] `packages/validators/src/notes.ts` — NUEVO (solo createNoteSchema — B4)
- [ ] `packages/validators/src/tasks.ts` — NUEVO
- [ ] `packages/validators/src/index.ts` — MODIFICAR

**Shared (1 nuevo):**
- [ ] `apps/web/src/lib/action-result.ts` — NUEVO

**Repositories (6 nuevos):**
- [ ] `contacts.repository.ts`
- [ ] `conversations.repository.ts`
- [ ] `messages.repository.ts`
- [ ] `notes.repository.ts` (sin update/delete — B4)
- [ ] `tasks.repository.ts`
- [ ] `notifications.repository.ts`

**Actions (6 nuevos):**
- [ ] `contacts.ts`
- [ ] `conversations.ts`
- [ ] `messages.ts`
- [ ] `notes.ts` (solo createNoteAction — B4)
- [ ] `tasks.ts`
- [ ] `notifications.ts` (solo markNotificationReadAction)

**Components (23 nuevos):**
- [ ] `contacts/`: 5 archivos
- [ ] `conversations/`: 7 archivos
- [ ] `messages/`: 3 archivos
- [ ] `notes/`: 2 archivos (sin edit-note-dialog ni delete-note-dialog — B4)
- [ ] `tasks/`: 6 archivos (incluyendo task-status-select)
- [ ] `shared/`: 2 archivos (notification-bell + notification-item)

**Pages (5 nuevas):**
- [ ] `/dashboard/contacts/page.tsx`
- [ ] `/dashboard/contacts/[id]/page.tsx`
- [ ] `/dashboard/conversations/page.tsx`
- [ ] `/dashboard/conversations/[id]/page.tsx`
- [ ] `/dashboard/tasks/page.tsx`

**Total: 47 archivos** (vs 35 en v1 por granularidad correcta)

### Orden de implementación

```
1.  Migraciones de schema (MIG-1 + MIG-2) + regenerar database.ts
2.  apps/web/src/lib/action-result.ts

3.  packages/validators/src/contacts.ts
4.  packages/validators/src/conversations.ts
5.  packages/validators/src/messages.ts
6.  packages/validators/src/notes.ts
7.  packages/validators/src/tasks.ts
8.  packages/validators/src/index.ts

9.  contacts.repository.ts
10. conversations.repository.ts
11. messages.repository.ts
12. notes.repository.ts
13. tasks.repository.ts
14. notifications.repository.ts

15. actions/contacts.ts
16. actions/conversations.ts
17. actions/messages.ts
18. actions/notes.ts
19. actions/tasks.ts
20. actions/notifications.ts

21. components/contacts/*  (form → source-badge → dialogs → table)
22. components/conversations/*  (status-badge → ai-mode-display → detail-header → filters → assign-dialog → close-dialog → list)
23. components/messages/*  (bubble → list → send-form)
24. components/notes/*  (add-note-dialog → note-list)
25. components/tasks/*  (form → status-select → dialogs → task-list)
26. components/shared/*  (notification-item → notification-bell)

27. /dashboard/contacts/page.tsx
28. /dashboard/contacts/[id]/page.tsx
29. /dashboard/conversations/page.tsx
30. /dashboard/conversations/[id]/page.tsx
31. /dashboard/tasks/page.tsx

32. tsc --noEmit + next lint → corregir todos los issues
```

### Open questions (no bloquean implementación)

- **OQ1**: ¿Los receptionists pueden ver y actualizar tasks de otros receptionists? (este blueprint asume: sí, pueden ver y actualizar todas las tasks del tenant — solo no pueden borrar las ajenas)
- **OQ2**: ¿El conversation detail page muestra el historial completo de mensajes o paginado? (este blueprint asume: últimos 50 con "cargar más" como OQ; en Fase 4 sin paginación UI)
- **OQ3**: ¿`ai_mode = 'assisted'` tiene comportamiento diferente en Fase 4 o se trata como 'manual'? (recomendado: tratar como 'manual' en Fase 4; la lógica de suggestions se implementa en Fase 6 junto con AI infrastructure)
- **OQ4**: ¿Las tasks en `/dashboard/tasks` incluyen las tasks completadas o solo las pendientes/en curso? (recomendado: tab o toggle "Mostrar completadas", ocultas por defecto)
- **OQ5**: ¿`listTenantUsers` necesita un repositorio separado o puede ir como función helper en `conversations.repository.ts`?
