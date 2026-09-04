# 24a — Phase 4: CRM Core — Final Architecture Audit
## Fecha: 2026-06-24 | Decisiones B1–B8 aplicadas

---

## Metodología

Este audit recorre el blueprint v2 sección por sección verificando:
1. Consistencia interna (una decisión no contradice a otra en otra sección)
2. Propagación completa de las decisiones B1–B8
3. Conflictos con el schema de DB real (`database.ts`)
4. Gaps de implementación (algo necesario que falta en el blueprint)
5. Riesgos técnicos y de negocio

Calificaciones por hallazgo: **C** (crítico — bloquea implementación), **A** (alto — introduce bugs), **M** (medio — degradación UX), **B** (bajo — deuda técnica)

---

## 1. Aplicación de decisiones B1–B8

### B1 — Contacts tenant-wide, CRM data workspace-filtered

| Check | §Referencia | Estado |
|-------|-------------|--------|
| Contact list: ambos roles ven todos | §10 contacts | ✓ |
| Contact list: sin workspace filter en repository | §5 contacts.repository | ✓ |
| Contact detail: conversations workspace-filtered para receptionist | §8 contact detail page | ✓ |
| Contact detail: notes filtradas por conversaciones accesibles + directas | §8 + §11 + §16 Flujo 3 | ✓ |
| Contact detail: tasks tenant-wide (no filtradas) | §10 tasks + §11 tabla | ✓ |
| `listNotes` acepta `conversationIds?: string[]` para multi-conv filter | §5 notes.repository | ✓ |
| Permission matrix contacts: receptionist puede todo excepto archivar | §10 contacts | ✓ |

**Hallazgo B1-1 (M)**: El blueprint describe `listNotes` con `conversationIds?: string[]` pero no especifica cómo la función maneja el caso `conversationIds = []` (receptionist con workspaces asignados pero sin conversaciones accesibles en ese contacto). El comportamiento esperado: devolver SOLO las notas con `conversation_id IS NULL AND contact_id = ?` (notas directas). Esto debe quedar explícito en el repositorio.

**Resolución**: Agregar a la implementación del repositorio:
```typescript
// conversationIds = null → sin filtro (owner)
// conversationIds = [] → solo notas directas (sin conversation_id)
// conversationIds = ['a','b'] → notas directas + notas de esas convs
```

### B2 — Owner y Receptionist cierran conversaciones

| Check | §Referencia | Estado |
|-------|-------------|--------|
| closeConversationAction: sin guard de rol | §6 conversations actions | ✓ |
| Permission matrix: ambos roles pueden close | §10 conversations | ✓ |
| Test T-V07: receptionist cierra conv. de su workspace | §17 | ✓ |
| Test T-V08: receptionist cierra conv. de otro workspace → error | §17 | ✓ |
| reopenConversation: misma regla (ambos roles) | §10 | ✓ |

**Sin hallazgos. B2 correctamente propagada.**

### B3 — Assign: Owner = cualquier conversación; Receptionist = solo propia o vacía

| Check | §Referencia | Estado |
|-------|-------------|--------|
| Lógica de 3 casos en assignConversationAction | §6 | ✓ |
| Caso A: receptionist auto-asigna conv. sin asignar | §6 + §9 CU-V04 | ✓ |
| Caso B: receptionist se desasigna (→ null) | §6 + §9 CU-V09 | ✓ |
| Caso C: receptionist intenta asignar a otro → error | §6 + §9 CU-V05 | ✓ |
| Error `CONVERSATION_ASSIGN_FORBIDDEN` en catalog | §15 | ✓ |
| Test T-V04: receptionist asigna a otro → error | §17 | ✓ |
| Test T-V05: receptionist toma conv. ya asignada → error | §17 | ✓ |

**Hallazgo B3-1 (A)**: El blueprint describe el caso "Receptionist intenta tomar conv. ya asignada a otro" pero hay un edge case no cubierto: **¿Qué pasa si la conversación está asignada al mismo receptionist que intenta re-asignársela a sí mismo?** (`assignedUserId === ctx.userId` Y `conv.assigned_user_id === ctx.userId`). Actualmente la condición A dice "asignado a sí mismo AND conversación sin asignar" — si ya está asignado a él, falla la condición `conv.assigned_user_id === null`. Esto bloquea la operación innecesariamente.

**Resolución**: Ampliar el caso A de assignConversationAction:
```typescript
// Caso A: auto-asignación permitida si:
//   (a) conv está sin asignar (null), O
//   (b) conv ya está asignada a este mismo user (re-asignarse = noop permitido)
const isSelfAssign = assignedUserId === ctx.userId
const convIsUnassigned = conversation.assigned_user_id === null
const convIsAlreadyMine = conversation.assigned_user_id === ctx.userId

if (isSelfAssign && (convIsUnassigned || convIsAlreadyMine)) {
  // permitido
} else if (assignedUserId === null && convIsAlreadyMine) {
  // Caso B: desasignarse — permitido
} else {
  return error CONVERSATION_ASSIGN_FORBIDDEN
}
```

### B4 — Notes append-only

| Check | §Referencia | Estado |
|-------|-------------|--------|
| `updateNoteSchema` eliminado | §4 validators | ✓ |
| `updateNote`, `deleteNote`, `getNoteById` eliminados del repo | §5 | ✓ |
| `updateNoteAction`, `deleteNoteAction` eliminados | §6 | ✓ |
| `edit-note-dialog.tsx` y `delete-note-dialog.tsx` eliminados del árbol | §3 | ✓ |
| `note-list.tsx` sin botones edit/delete | §7 | ✓ |
| Permission matrix notes: update=✗, delete=✗ para ambos roles | §10 | ✓ |
| Error catalog: `NOTE_EDIT_FORBIDDEN` y `NOTE_DELETE_FORBIDDEN` eliminados | §15 | ✓ |
| Test scenarios: T-N05 documenta que endpoint no existe | §17 | ✓ |
| Scope §1 actualizado: solo INSERT y lectura | §1 | ✓ |

**Sin hallazgos. B4 consistentemente propagada en todas las secciones.**

### B5 — Ambos roles crean tasks

| Check | §Referencia | Estado |
|-------|-------------|--------|
| `createTaskAction` sin guard de rol | §6 | ✓ |
| Permission matrix: createTask = ✓ para ambos | §10 | ✓ |
| CU-T01: ambos roles crean task | §9 | ✓ |

**Sin hallazgos. B5 correctamente aplicada.**

### B6 — Contacts solo soft delete

| Check | §Referencia | Estado |
|-------|-------------|--------|
| `archiveContact` usa `.update({ deleted_at: now() })` | §5 | ✓ |
| `.is('deleted_at', null)` en WHERE de archiveContact (anti-rearchivado) | §5 | ✓ |
| Contact lifecycle §12: "No hard delete" explícito | §12 | ✓ |
| `getContactById` filtra `.is('deleted_at', null)` | §5 | ✓ |
| `hasActiveConversations` checks en DB antes de archivar | §5 | ✓ |

**Hallazgo B6-1 (B)**: El `updateContactAction` en §6 dice "verificar contacto existe + no archivado" pero el repositorio `getContactById` ya filtra `.is('deleted_at', null)` — devuelve null si está archivado. Por consistencia, si `updateContactAction` recibe null de `getContactById`, debe retornar `CONTACT_ARCHIVED` (o `CONTACT_NOT_FOUND` — ambos son aceptables). El error catalog tiene `CONTACT_ARCHIVED` pero la action en §6 no especifica cuál usar. Mencionarlo en la implementación.

**Resolución**: `updateContactAction` retorna `CONTACT_NOT_FOUND` cuando getContactById devuelve null (incluye archivados). El error `CONTACT_ARCHIVED` queda reservado para cuando se intenta operar explícitamente sobre un ID conocido de un contacto archivado (edge case de API directa).

### B7 — Notifications con read_at

| Check | §Referencia | Estado |
|-------|-------------|--------|
| `read_at TIMESTAMPTZ NULL` documentado en §1 Migraciones | §1 | ✓ |
| `markNotificationRead` en repo con `.is('read_at', null)` idempotente | §5 | ✓ |
| `countUnread` filtra `read_at IS NULL` | §5 | ✓ |
| `listMyNotifications` acepta `onlyUnread?: boolean` | §5 | ✓ |
| `markNotificationReadAction` en actions/notifications.ts | §6 | ✓ |
| `NotificationBell` decrementa badge localmente (optimistic) | §7 | ✓ |
| MIG-1 en checklist §18 | §18 | ✓ |
| Test T-NT02 a T-NT05 cubren casos de read_at | §17 | ✓ |

**Hallazgo B7-1 (A)**: El `database.ts` actual NO tiene el campo `read_at` en `notifications`. Si se escribe código que usa `notifications.read_at` sin aplicar MIG-1 primero, TypeScript no dará error (Supabase types son generados) pero las queries fallarán en runtime. El blueprint lista MIG-1 como paso 1 del orden de implementación — esto es correcto. Agregar una nota explícita: "No escribir código que reference `read_at` hasta que `database.ts` haya sido regenerado post-MIG-1".

### B8 — ai_mode = manual|assisted|autonomous, owner-only

| Check | §Referencia | Estado |
|-------|-------------|--------|
| Enum actualizado en validators §4 | §4 | ✓ |
| Valores anteriores documentados como deprecados | §1 Migraciones | ✓ |
| `setAiModeAction` guard `role === 'owner'` | §6 | ✓ |
| Permission matrix: setAiMode owner=✓, receptionist=✗ | §10 | ✓ |
| `ai-mode-display.tsx` (antes `ai-mode-toggle.tsx`) read-only para receptionist | §7 | ✓ |
| Error `AI_MODE_FORBIDDEN` en catalog | §15 | ✓ |
| MIG-2 con SQL de migración completo | §18 | ✓ |
| Test T-A01 a T-A04 cubren los casos | §17 | ✓ |
| `AiMode` type en database.ts a actualizar post-migración | §5 (implícito) | ✓ |

**Hallazgo B8-1 (C)**: El blueprint referencia `AiMode` como tipo importado de `@orderflow/types`. Sin embargo, el `database.ts` actual define `ai_mode: 'auto' | 'human' | 'disabled'`. Si el código de implementación importa `AiMode` antes de aplicar MIG-2 y regenerar `database.ts`, los tipos serán `'auto' | 'human' | 'disabled'`, incompatibles con los nuevos schemas (`'manual' | 'assisted' | 'autonomous'`). **Esto causaría errores de TypeScript en toda la capa de conversations.**

**Resolución crítica**: El orden de implementación debe ser:
1. Aplicar MIG-1 + MIG-2 en Supabase
2. Regenerar `packages/types/src/database.ts` (via `npx supabase gen types typescript`)
3. Solo entonces comenzar a escribir validators, repositories y actions

Esto ya está documentado en §18 paso 1, pero debe marcarse con alerta clara en la implementación.

**Hallazgo B8-2 (M)**: La componente se renombró de `ai-mode-toggle.tsx` (v1) a `ai-mode-display.tsx` (v2). Correcto semánticamente, pero el checklist §18 debe actualizar el nombre del archivo correspondiente (el checklist en v2 dice "7 archivos en conversations" que ya incluye `ai-mode-display.tsx`). ✓ — sin acción adicional.

---

## 2. Consistencia interna entre secciones

### Cross-check §4 Validators vs §5 Repositories vs §6 Actions

| Validator | Repository | Action | Consistente |
|-----------|-----------|--------|-------------|
| `createContactSchema` | `createContact()` | `createContactAction()` | ✓ |
| `updateContactSchema` | `updateContact()` | `updateContactAction()` | ✓ |
| — (no existe) | — | `archiveContactAction()` | ✓ (no necesita schema) |
| `createConversationSchema` | `createConversation()` | `createConversationAction()` | ✓ |
| `assignConversationSchema` | `assignConversation()` | `assignConversationAction()` | ✓ |
| `setAiModeSchema` | `setAiMode()` | `setAiModeAction()` | ✓ |
| `sendMessageSchema` | `createMessage()` | `sendMessageAction()` | ✓ |
| `createNoteSchema` | `createNote()` | `createNoteAction()` | ✓ |
| ~~`updateNoteSchema`~~ | ~~`updateNote`~~ | ~~`updateNoteAction`~~ | ✓ (B4 — eliminados) |
| `createTaskSchema` | `createTask()` | `createTaskAction()` | ✓ |
| `updateTaskSchema` | `updateTask()` | `updateTaskAction()` | ✓ |
| `updateTaskStatusSchema` | `updateTaskStatus()` | `updateTaskStatusAction()` | ✓ |
| — | `markNotificationRead()` | `markNotificationReadAction()` | ✓ (no necesita schema) |

**Sin inconsistencias.** Todos los validators tienen su repository y action correspondiente. Las eliminaciones por B4 son simétricas en las tres capas.

### Cross-check §9 Casos de Uso vs §10 Permission Matrix

| CU | Operación | Matrix dice | Consistente |
|----|-----------|-------------|-------------|
| CU-C06 | Receptionist lista contactos | ✓ | ✓ |
| CU-V06 | Owner cambia ai_mode | Owner=✓ | ✓ |
| CU-V07 | Receptionist cambia ai_mode | Receptionist=✗ | ✓ |
| CU-V08/09 | Ambos cierran conv. | Ambos=✓ (B2) | ✓ |
| CU-N02 | Nadie edita nota | Update=✗ para ambos | ✓ |
| CU-T03/04 | Delete task propia vs ajena | Owner=cualquiera, Rec.=solo propia | ✓ |

**Sin inconsistencias.**

### Cross-check §3 Árbol de archivos vs §18 Archivos a crear

| Archivo en §3 | En checklist §18 | Estado |
|---------------|-----------------|--------|
| `notes/note-form.tsx` | No listado (eliminado B4) | ✓ — correcto eliminarlo |
| `notes/edit-note-dialog.tsx` | No listado | ✓ |
| `notes/delete-note-dialog.tsx` | No listado | ✓ |
| `notes/add-note-dialog.tsx` | En "notes/ 2 archivos" | ✓ |
| `notes/note-list.tsx` | En "notes/ 2 archivos" | ✓ |
| `ai-mode-display.tsx` | En "conversations/ 7 archivos" | ✓ |
| `action-result.ts` | En "Shared 1 nuevo" | ✓ |
| `notifications.ts` (action) | En "Actions 6 nuevos" | ✓ |

**Sin inconsistencias en árbol vs checklist.**

---

## 3. Conflictos con schema real (database.ts)

| Campo en blueprint | En database.ts | Conflicto |
|--------------------|---------------|-----------|
| `conversations.ai_mode: 'manual'|'assisted'|'autonomous'` | `ai_mode: 'auto'|'human'|'disabled'` | **MIG-2 requerida** (documentada) |
| `notifications.read_at TIMESTAMPTZ NULL` | Campo no existe | **MIG-1 requerida** (documentada) |
| `contacts.deleted_at` | Existe: `string | null` | ✓ |
| `conversations.workspace_id` | Existe: `string | null` | ✓ |
| `conversations.assigned_user_id` | Existe: `string | null` | ✓ |
| `conversations.closed_at` | Existe: `string | null` | ✓ |
| `messages.sender_type` | Existe: enum `'customer'|'ai'|'human'` | ✓ |
| `messages.sender_id` | Existe: `string | null` | ✓ |
| `notes.created_by` | Existe: `string` (not null) | ✓ — actions pasan ctx.userId |
| `tasks.created_by` | Existe: `string` (not null) | ✓ |
| `tasks.completed_at` | Existe: `string | null` | ✓ |
| `notifications.recipient_id` | Existe: `string` | ✓ |
| `notifications.recipient_type` | Existe: `string` (no enum) | ✓ — se filtra por 'tenant_user' |
| `AiMode` type alias en database.ts | Exportado como `Enums<'ai_mode'>` | ✓ — se actualiza con MIG-2 |

**2 conflictos documentados y resueltos mediante migraciones pre-implementación.**

---

## 4. Gaps de implementación

### Gap 1 (A): `listTenantUsers` — repositorio no definido

El blueprint referencia `listTenantUsers(ctx.tenantId)` en múltiples páginas (conversations page, conversations detail, tasks page, contact detail) pero no define en qué repositorio vive.

**Resolución**: Crear `tenant-users.repository.ts` con:
```typescript
listTenantUsers(tenantId: string): Promise<Pick<TenantUserRow, 'id' | 'name' | 'email' | 'role'>[]>
// .eq('tenant_id').eq('active', true).order('name')
```

Agregar a §3 árbol de archivos y §18 checklist. Este es un gap real que debe cubrirse.

### Gap 2 (M): `ContactDetailLayout` no definido en §7 Components

La página `/dashboard/contacts/[id]` renderiza `<ContactDetailLayout>` pero este componente no aparece en el árbol de archivos ni en §7.

**Resolución**: Implementar inline en la página como estructura de tabs (usando shadcn/ui Tabs component) o agregar `contacts/contact-detail-layout.tsx` al árbol. Recomendado: inline en la página Server Component, no un componente separado.

### Gap 3 (M): `ctx.workspaceIds` en `listNotes` para contact detail

En §8 se pasa `conversationIds: ctx.workspaceIds === null ? null : accessibleIds` pero `listNotes` en §5 define `conversationIds?: string[]` (no acepta null). Hay un mismatch de tipos.

**Resolución**: Definir en repositorio que `conversationIds = undefined` significa "sin filtro" (owner):
```typescript
listNotes(
  tenantId: string,
  opts: {
    contactId?: string
    conversationId?: string
    conversationIds?: string[] | null   // null = owner (sin filtro), [] = solo directas
    reservationId?: string
  }
): Promise<NoteWithAuthor[]>
```

Actualizar el código de la página:
```typescript
conversationIds: ctx.workspaceIds === null ? null : accessibleConversationIds
```

### Gap 4 (B): `updateConversation` solo para owner, pero sin guard explícito en action table

§6 tabla dice "`updateConversationAction(id, patch)` — `requireTenantContext()` + `role === 'owner'`" pero el texto de la acción no tiene un paso a paso detallado como las demás. Suficiente para implementar, pero podría generar confusión.

**Resolución**: Agregar nota en implementación: updateConversationAction es actualmente solo para reasignar workspace_id; receptionist nunca debería llegar a llamarla desde la UI (no hay botón de editar workspace).

### Gap 5 (B): Notificaciones con `recipient_type`

El schema tiene `notifications.recipient_type: string` (no enum). El blueprint no especifica qué valor usar al filtrar. Para `in_app` notifs dirigidas a `tenant_users`, el `recipient_type` debería ser `'tenant_user'`.

**Resolución**: Agregar al repositorio:
```typescript
// En listMyNotifications y countUnread:
.eq('recipient_type', 'tenant_user')
.eq('recipient_id', recipientId)
```

---

## 5. Riesgos técnicos

### Riesgo 1 — MIG-2 ai_mode (Severidad: Alta)

PostgreSQL no permite hacer `ALTER TYPE ... RENAME VALUE`. La estrategia propuesta (columna temporal + drop + recrear) es correcta pero operativamente riesgosa si hay constraints, views o funciones que dependan del tipo `ai_mode`. 

**Mitigación**: Antes de aplicar, ejecutar:
```sql
SELECT pg_typeof(ai_mode), * FROM conversations LIMIT 5;  -- verificar datos actuales
SELECT count(*) FROM conversations WHERE ai_mode = 'auto';
SELECT count(*) FROM conversations WHERE ai_mode = 'human';
SELECT count(*) FROM conversations WHERE ai_mode = 'disabled';
```

Si hay 0 rows: simplificar la migración (DROP y recrear sin UPDATE).

### Riesgo 2 — Notes sin soft delete (Severidad: Media)

Notes son permanentes (sin `deleted_at`). Una nota errónea solo puede ser eliminada por acceso directo a DB (no hay endpoint). Este es el comportamiento requerido por B4, pero el soporte debe estar preparado para borrado manual. Documentar en manual de operaciones.

### Riesgo 3 — Conversaciones con workspace_id = null (Severidad: Baja)

El webhook de WhatsApp puede crear conversaciones sin workspace_id asignado. Estas quedan "ciegas" para todos los receptionists hasta que un owner las asigne. Si el equipo opera principalmente con receptionists, el inbox puede acumular conversaciones invisibles para ellos.

**Mitigación**: En la página `/dashboard/conversations` para owner, mostrar un contador/badge de "conversaciones sin workspace". Puede hacerse en Fase 4 como filtro "Sin workspace" en conversation-filters.tsx.

### Riesgo 4 — Hard delete de Tasks (Severidad: Baja)

Tasks se borran definitivamente. No hay papelera ni historial de tasks eliminadas. Si un receptionist elimina una task importante por error, no hay recovery. Aceptado como trade-off de simplicidad en Fase 4.

---

## 6. Resumen de hallazgos

| ID | Severidad | Descripción | Acción |
|----|-----------|-------------|--------|
| B1-1 | M | `listNotes` caso `conversationIds = []` no especificado | Documentar en implementación del repositorio |
| B3-1 | A | Edge case: receptionist re-asignándose a sí mismo cuando ya está asignado | Fix en `assignConversationAction` lógica de condiciones |
| B6-1 | B | Error a retornar cuando updateContact recibe null de getContactById | Claridad: usar `CONTACT_NOT_FOUND` |
| B7-1 | A | `read_at` no existe en database.ts actual → runtime errors si se usa antes de MIG-1 | Orden de implementación: MIG-1 antes que cualquier código |
| B8-1 | C | Tipos de ai_mode incompatibles si se codea antes de MIG-2 | Orden de implementación: MIG-2 antes que cualquier código |
| B8-2 | M | Componente renombrado en árbol | ✓ Resuelto en blueprint v2 |
| Gap-1 | A | `listTenantUsers` repositorio no definido | Crear `tenant-users.repository.ts` |
| Gap-2 | M | `ContactDetailLayout` no definido | Implementar inline en página |
| Gap-3 | M | Mismatch de tipos en `conversationIds: null vs undefined` | Definir `conversationIds?: string[] | null` en repositorio |
| Gap-4 | B | `updateConversationAction` sin paso a paso | Nota en implementación |
| Gap-5 | B | `recipient_type` no especificado en notification queries | Agregar `.eq('recipient_type', 'tenant_user')` |
| Risk-1 | Alta | MIG-2 operativamente riesgosa en producción | Verificar row counts antes de migrar |
| Risk-2 | Media | Notes sin recovery si se crean por error | Documentar en ops manual |
| Risk-3 | Baja | Conversaciones WhatsApp sin workspace → ciegas para receptionists | Filtro "Sin workspace" en owner inbox |
| Risk-4 | Baja | Hard delete de Tasks sin recovery | Aceptado como trade-off |

---

## 7. Veredicto final

### Rating: **A — Implementación autorizada**

**Justificación:**

El blueprint v2 es arquitecturalmente sólido. Las 8 decisiones de negocio están consistentemente propagadas a través de las 18 secciones. Los 3 hallazgos de severidad A/C tienen resoluciones claras y no requieren cambios de diseño — son detalles de implementación que deben tenerse en cuenta al escribir el código.

**Condiciones para mantener el rating A:**

1. **Las migraciones MIG-1 y MIG-2 son el paso 0 absoluto.** Ningún código de la Fase 4 se escribe sin que `database.ts` esté regenerado y refleje los nuevos tipos.

2. **Fix B3-1 en assignConversationAction**: La condición de re-asignación propia debe contemplar el caso `convIsAlreadyMine`.

3. **Gap-1**: Crear `tenant-users.repository.ts` como parte del árbol de archivos (agregar al paso 9 del orden de implementación).

4. **Gap-3**: `listNotes` acepta `conversationIds?: string[] | null` en lugar de `string[]`.

**Lo que el blueprint hace correctamente:**

- Workspace scoping de conversations idéntico a properties (patrón probado en Fase 3)
- B4 (notes append-only) propagado limpiamente en las 3 capas sin excepciones
- B8 (ai_mode owner-only) con componente read-only diferenciado por rol
- B3 (assign) con 3 casos bien delimitados para receptionist
- Migraciones documentadas con SQL exacto antes de comenzar implementación
- Diagrama de flujos que demuestra que la lógica multi-entidad (contact detail con workspace filter B1) está correctamente pensada
- 32 archivos nuevos con responsabilidades bien separadas

---

## 8. Plan definitivo de implementación

### Pre-requisito absoluto (fuera del orden de archivos)

```
PASO 0-A: Aplicar MIG-1 (notifications.read_at)
PASO 0-B: Aplicar MIG-2 (ai_mode enum rename)
PASO 0-C: npx supabase gen types typescript --project-id <id> > packages/types/src/database.ts
PASO 0-D: Verificar en database.ts:
          - ai_mode: 'manual' | 'assisted' | 'autonomous'   ← aparece en conversations.Row
          - notifications.Row.read_at: string | null          ← aparece en notifications.Row
          Si no aparecen, no continuar.
```

### Fase de foundations (pasos 1-2)

```
1. apps/web/src/lib/action-result.ts
   - Extraer ActionResult<T> de properties.ts y units.ts
   - Actualizar imports en actions/properties.ts y actions/units.ts

2. apps/web/src/lib/repositories/tenant-users.repository.ts  ← NUEVO (Gap-1)
   - listTenantUsers(tenantId): Promise<TenantUserRow[]>
   - filtro: .eq('active', true), order('name')
```

### Fase de validators (pasos 3-8)

```
3. packages/validators/src/contacts.ts
4. packages/validators/src/conversations.ts   ← ai_mode enum: 'manual'|'assisted'|'autonomous'
5. packages/validators/src/messages.ts
6. packages/validators/src/notes.ts           ← SOLO createNoteSchema
7. packages/validators/src/tasks.ts
8. packages/validators/src/index.ts           ← agregar exports
```

### Fase de repositories (pasos 9-14)

```
9.  contacts.repository.ts
10. conversations.repository.ts               ← incluye setAiMode(), assignConversation() con B3
11. messages.repository.ts
12. notes.repository.ts                       ← conversationIds?: string[] | null (Gap-3)
13. tasks.repository.ts
14. notifications.repository.ts              ← read_at, countUnread, markNotificationRead
```

### Fase de actions (pasos 15-20)

```
15. actions/contacts.ts
16. actions/conversations.ts                  ← assignConversationAction con fix B3-1
17. actions/messages.ts
18. actions/notes.ts                          ← SOLO createNoteAction
19. actions/tasks.ts
20. actions/notifications.ts                  ← markNotificationReadAction
```

### Fase de components (pasos 21-26)

```
21. contacts/
    → contact-source-badge.tsx
    → contact-form.tsx
    → create-contact-dialog.tsx, edit-contact-dialog.tsx, archive-contact-dialog.tsx
    → contact-table.tsx

22. conversations/
    → conversation-status-badge.tsx
    → ai-mode-display.tsx            ← read-only para receptionist (B8)
    → conversation-detail-header.tsx
    → conversation-filters.tsx
    → assign-conversation-dialog.tsx ← lógica B3 por rol
    → close-conversation-dialog.tsx
    → conversation-list.tsx

23. messages/
    → message-bubble.tsx
    → message-list.tsx
    → send-message-form.tsx

24. notes/
    → add-note-dialog.tsx
    → note-list.tsx                  ← sin edit/delete (B4)

25. tasks/
    → task-form.tsx
    → task-status-select.tsx
    → create-task-dialog.tsx, edit-task-dialog.tsx, delete-task-dialog.tsx
    → task-list.tsx

26. shared/
    → notification-item.tsx
    → notification-bell.tsx
```

### Fase de pages (pasos 27-31)

```
27. /dashboard/contacts/page.tsx
28. /dashboard/contacts/[id]/page.tsx        ← workspace-filtered entities B1
29. /dashboard/conversations/page.tsx
30. /dashboard/conversations/[id]/page.tsx   ← 2-col layout + sidebar
31. /dashboard/tasks/page.tsx
```

### Fase de quality (paso 32)

```
32. pnpm --filter @orderflow/web exec tsc --noEmit
    pnpm --filter @orderflow/web exec next lint
    → corregir TODOS los issues antes de declarar Fase 4 completa
```

### Tiempo estimado de implementación

| Fase | Archivos | Estimado |
|------|---------|----------|
| Pre-requisito (migraciones) | 2 SQL + regen | 30 min |
| Foundations | 2 | 20 min |
| Validators | 6 | 45 min |
| Repositories | 7 | 90 min |
| Actions | 6 | 60 min |
| Components | 24 | 180 min |
| Pages | 5 | 60 min |
| Quality (tsc + lint) | — | 30 min |
| **Total** | **48 archivos** | **~8 horas** |

---

*Audit completado. Rating A. Comenzar implementación con PASO 0-A.*
