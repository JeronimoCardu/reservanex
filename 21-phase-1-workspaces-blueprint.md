# OrderFlow — Phase 1: Workspaces Blueprint

**Fecha:** 2026-06-23  
**Estado:** Ready to implement  
**Prerequisito:** Fase 0 completada y validada. `database.ts` generado. Validators publicados.

---

## 1. Scope

### En scope
- CRUD de workspaces (scoped al tenant del usuario autenticado)
- Gestión de asignaciones receptionist ↔ workspace
- Listado de receptionists disponibles para asignar
- Páginas de UI: list, detail, create, edit
- API Route Handlers (contratos de `12-api-spec.md`)
- Server Actions para mutaciones desde UI

### Fuera de scope (fases posteriores)
- Propiedades (usan `workspace_id` pero se gestionan en Phase 2)
- Usuarios del tenant (Phase 1b)
- Integración WhatsApp (Phase N)
- Gestión de tenants desde plataforma

### Constraints heredados de la arquitectura
- `tenant_id` siempre se lee del JWT, nunca del body o path (ver `12-api-spec.md`)
- El workspace `type: 'general'` no puede ser eliminado ni desactivado (regla de negocio)
- RLS maneja el aislamiento — no filtrar por `tenant_id` en código de aplicación
- Owner: acceso total a todos los workspaces del tenant
- Receptionist con 0 asignaciones: acceso total (default)
- Receptionist con N asignaciones: solo esos N workspaces

---

## 2. Arquitectura de Capas

```
Request (Browser)
    │
    ▼
Next.js Page (Server Component)
    │  reads session, calls repository directly
    ▼
Repository (server-side, Supabase client + RLS)
    │  typed DB queries
    ▼
Supabase (RLS enforces tenant + workspace isolation)
    │
    ▼
PostgreSQL
```

**Para mutaciones desde UI:**
```
Client Component
    │  calls Server Action
    ▼
Server Action ('use server')
    │  auth guard → requireOwner()
    │  validate → Zod schema
    │  call → repository function
    │  revalidatePath
    ▼
Repository → Supabase → PostgreSQL
```

**Para API externa:**
```
HTTP Client
    │
    ▼
Route Handler (apps/web/src/app/api/v1/workspaces/)
    │  validate JWT via createClient().auth.getUser()
    │  extract claims → parseAccessTokenClaims()
    │  authorize by role
    │  call → repository function
    ▼
Repository → Supabase → PostgreSQL
```

---

## 3. File Tree Completo

```
apps/web/src/
│
├── lib/
│   └── auth.ts                              ← NEW: auth guards reutilizables
│
├── modules/
│   └── workspaces/
│       ├── repository.ts                    ← NEW: todas las queries DB
│       ├── actions.ts                       ← NEW: Server Actions ('use server')
│       └── types.ts                         ← NEW: tipos internos del módulo
│
├── components/
│   └── tenant/
│       └── workspaces/
│           ├── workspace-list.tsx           ← NEW: tabla/grid de workspaces
│           ├── workspace-card.tsx           ← NEW: card individual
│           ├── workspace-form.tsx           ← NEW: formulario create/edit (client)
│           ├── workspace-badge.tsx          ← NEW: badge por workspace_type
│           ├── workspace-actions-menu.tsx   ← NEW: dropdown edit/deactivate (client)
│           ├── assignments-panel.tsx        ← NEW: panel de asignaciones (server)
│           └── assign-receptionist-dialog.tsx ← NEW: modal agregar asignación (client)
│
└── app/
    ├── api/v1/workspaces/
    │   ├── route.ts                         ← NEW: GET list + POST create
    │   └── [id]/
    │       ├── route.ts                     ← NEW: GET + PUT + DELETE
    │       └── assignments/
    │           ├── route.ts                 ← NEW: GET list + POST add
    │           └── [userId]/
    │               └── route.ts             ← NEW: DELETE remove
    │
    └── (tenant)/
        └── workspaces/
            ├── page.tsx                     ← NEW: list page (server)
            ├── new/
            │   └── page.tsx                 ← NEW: create page (server shell)
            └── [id]/
                ├── page.tsx                 ← NEW: detail + assignments (server)
                └── edit/
                    └── page.tsx             ← NEW: edit page (server shell)

packages/validators/src/
└── workspaces.ts                            ← DONE: Zod schemas
```

---

## 4. Capa 1 — Validators

**Archivo:** `packages/validators/src/workspaces.ts` ✅ (ya generado)

### Schemas exportados

| Schema | Uso | Campos requeridos |
|--------|-----|-------------------|
| `createWorkspaceSchema` | Crear workspace | `name`, `type` |
| `updateWorkspaceSchema` | Editar workspace | todos opcionales |
| `assignReceptionistSchema` | Asignar receptionist | `user_id` (UUID) |
| `workspaceQuerySchema` | Query params en GET list | todos opcionales |

### Tipos exportados

```typescript
type CreateWorkspaceInput   // z.infer<typeof createWorkspaceSchema>
type UpdateWorkspaceInput   // z.infer<typeof updateWorkspaceSchema>
type AssignReceptionistInput // z.infer<typeof assignReceptionistSchema>
type WorkspaceQuery         // z.infer<typeof workspaceQuerySchema>
```

---

## 5. Capa 2 — Tipos del módulo

**Archivo:** `apps/web/src/modules/workspaces/types.ts`

### Tipos a definir

```typescript
// Base types from database
import type { WorkspaceRow, TenantUserRow, UserWorkspaceAssignment } from '@orderflow/types'

// Workspace with joined assignments count
type WorkspaceWithStats = WorkspaceRow & {
  assignment_count: number
}

// Assignment with receptionist details (JOIN result)
type AssignmentWithUser = UserWorkspaceAssignment & {
  tenant_users: Pick<TenantUserRow, 'id' | 'name' | 'email'>
}

// Receptionist (lightweight, for assignment form)
type ReceptionistOption = Pick<TenantUserRow, 'id' | 'name' | 'email'>

// Server Action return type
type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string; fieldErrors?: Record<string, string[]> }
```

---

## 6. Capa 3 — Auth Helpers

**Archivo:** `apps/web/src/lib/auth.ts` ← NUEVO, reemplaza el pattern ad-hoc en dashboard/page.tsx

### Funciones a implementar

```typescript
// Retorna { userId, claims } o redirige a /login
// Combina getUser() (validación server) + getSession() (claims del JWT)
async function getAuthContext(): Promise<{
  userId: string
  claims: AppClaims
}>

// Requiere tenant_user de cualquier rol
// Redirige a /login si no es tenant_user
async function requireTenantUser(): Promise<{
  userId: string
  claims: TenantUserClaims
}>

// Requiere owner
// Redirige a /workspaces si no es owner (no mostrar 403 genérico)
async function requireOwner(): Promise<{
  userId: string
  claims: TenantUserClaims & { role: 'owner' }
}>
```

### Notas de implementación

- Llamar siempre `getUser()` primero (valida JWT con servidor, previene replay de tokens expirados)
- `getSession()` solo para leer `access_token` y decodificar claims del hook
- Los redireccionamientos de `requireOwner()` van a `/workspaces` (no `/login`) porque el usuario está autenticado, solo sin permisos

---

## 7. Capa 4 — Repository

**Archivo:** `apps/web/src/modules/workspaces/repository.ts`

Todas las funciones reciben `supabase: SupabaseClient<Database>` como primer parámetro.
RLS maneja el filtrado por tenant. El código de aplicación NO filtra por `tenant_id`.

### Funciones a implementar

```typescript
// Lista workspaces visibles para el usuario actual (RLS aplica)
// Owner: todos. Receptionist: los asignados (o todos si sin asignaciones).
async function listWorkspaces(
  supabase: SupabaseClient<Database>,
  filter?: { active?: boolean; type?: WorkspaceType }
): Promise<WorkspaceRow[]>

// Obtiene un workspace por id — null si no existe o no tiene acceso
async function getWorkspaceById(
  supabase: SupabaseClient<Database>,
  id: string
): Promise<WorkspaceRow | null>

// Crea workspace — tenant_id desde los claims (no desde el body)
async function createWorkspace(
  supabase: SupabaseClient<Database>,
  tenantId: string,
  input: CreateWorkspaceInput
): Promise<WorkspaceRow>

// Actualiza workspace
async function updateWorkspace(
  supabase: SupabaseClient<Database>,
  id: string,
  input: UpdateWorkspaceInput
): Promise<WorkspaceRow>

// Desactiva workspace (soft delete — active = false)
// La regla de negocio de "no desactivar General" se valida en la Action, no aquí
async function deactivateWorkspace(
  supabase: SupabaseClient<Database>,
  id: string
): Promise<void>

// Lista asignaciones de un workspace con datos del receptionist
async function listAssignmentsForWorkspace(
  supabase: SupabaseClient<Database>,
  workspaceId: string
): Promise<AssignmentWithUser[]>

// Lista receptionists del tenant (para el selector del formulario de asignación)
async function listReceptionists(
  supabase: SupabaseClient<Database>
): Promise<ReceptionistOption[]>

// Lista assignments del receptionist (para saber qué workspaces ya tiene)
async function listAssignmentsForUser(
  supabase: SupabaseClient<Database>,
  userId: string
): Promise<UserWorkspaceAssignment[]>

// Agrega asignación receptionist → workspace
async function addAssignment(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  userId: string
): Promise<void>

// Elimina asignación
async function removeAssignment(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  userId: string
): Promise<void>
```

### Query patterns

**listWorkspaces:**
```
.from('workspaces')
.select('*')
.eq('active', true)               ← default filter
.order('created_at', { ascending: true })
```
RLS already restricts to the current user's tenant and workspace scope.

**listAssignmentsForWorkspace:**
```
.from('user_workspace_assignments')
.select('*, tenant_users(id, name, email)')
.eq('workspace_id', workspaceId)
```

**listReceptionists:**
```
.from('tenant_users')
.select('id, name, email')
.eq('role', 'receptionist')
.eq('active', true)
.order('name')
```
RLS restricts to the current user's tenant.

---

## 8. Capa 5 — Server Actions

**Archivo:** `apps/web/src/modules/workspaces/actions.ts`

`'use server'` en la parte superior del archivo.

### Funciones a implementar

```typescript
// Crear workspace
// Guard: requireOwner()
// Validate: createWorkspaceSchema
// On success: revalidatePath('/workspaces'), redirect('/workspaces/{id}')
async function createWorkspaceAction(
  formData: FormData
): Promise<ActionResult<{ id: string }>>

// Editar workspace
// Guard: requireOwner()
// Validate: updateWorkspaceSchema
// On success: revalidatePath('/workspaces'), revalidatePath('/workspaces/{id}')
async function updateWorkspaceAction(
  id: string,
  formData: FormData
): Promise<ActionResult<WorkspaceRow>>

// Desactivar workspace
// Guard: requireOwner()
// Business rule: si type === 'general', retornar error 'NO_DEACTIVATE_GENERAL'
// On success: revalidatePath('/workspaces'), redirect('/workspaces')
async function deactivateWorkspaceAction(
  id: string
): Promise<ActionResult<void>>

// Asignar receptionist a workspace
// Guard: requireOwner()
// Validate: assignReceptionistSchema
// Business rule: verificar que el user pertenece al mismo tenant
// On success: revalidatePath('/workspaces/{workspaceId}')
async function assignReceptionistAction(
  workspaceId: string,
  formData: FormData
): Promise<ActionResult<void>>

// Quitar asignación
// Guard: requireOwner()
// On success: revalidatePath('/workspaces/{workspaceId}')
async function unassignReceptionistAction(
  workspaceId: string,
  userId: string
): Promise<ActionResult<void>>
```

### Error handling pattern

```typescript
// Las Actions retornan ActionResult, nunca lanzan excepción al cliente.
// Errores de DB se transforman en { success: false, error: string }
// El componente cliente lee el resultado y muestra el toast/error.
```

---

## 9. Capa 6 — API Route Handlers

**Directorio:** `apps/web/src/app/api/v1/workspaces/`

Implementar según los contratos de `12-api-spec.md`. Son opcionales para Phase 1 UI
(Server Actions son suficientes), pero deben existir para el worker y eventual mobile.

### Endpoints

| Método | Path | Auth | Descripción |
|--------|------|------|-------------|
| `GET`  | `/api/v1/workspaces` | AUTH | Lista workspaces del tenant |
| `POST` | `/api/v1/workspaces` | AUTH | Crea workspace (owner only) |
| `GET`  | `/api/v1/workspaces/[id]` | AUTH | Obtiene workspace |
| `PUT`  | `/api/v1/workspaces/[id]` | AUTH | Actualiza workspace (owner only) |
| `DELETE` | `/api/v1/workspaces/[id]` | AUTH | Desactiva workspace (owner only) |
| `GET`  | `/api/v1/workspaces/[id]/assignments` | AUTH | Lista asignaciones |
| `POST` | `/api/v1/workspaces/[id]/assignments` | AUTH | Agrega asignación (owner only) |
| `DELETE` | `/api/v1/workspaces/[id]/assignments/[userId]` | AUTH | Elimina asignación (owner only) |

### Pattern por Route Handler

```typescript
// 1. Validate session
const supabase = await createClient()
const { data: { user }, error } = await supabase.auth.getUser()
if (error || !user) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 })

// 2. Parse claims from JWT
const { data: { session } } = await supabase.auth.getSession()
const claims = parseAccessTokenClaims(session?.access_token)
if (!claims) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 })
if (claims.user_type !== 'tenant_user') return Response.json({ error: 'FORBIDDEN' }, { status: 403 })

// 3. Authorize by role (for mutations)
if (claims.role !== 'owner') return Response.json({ error: 'FORBIDDEN' }, { status: 403 })

// 4. Validate request body with Zod

// 5. Call repository

// 6. Return standardized response (see 12-api-spec.md format)
```

### Response format (from 12-api-spec.md)

```json
// Success list:
{ "data": [...], "meta": { "total": 3, "page": 1, "per_page": 20, "total_pages": 1 } }

// Success single:
{ "data": { ... } }

// Error:
{ "error": "error_code", "message": "Descripción legible", "details": {} }
```

---

## 10. Capa 7 — Componentes React

**Directorio:** `apps/web/src/components/tenant/workspaces/`

Todos usan shadcn/ui + Tailwind. Los componentes marcados como (client) usan `'use client'`.

### `workspace-badge.tsx` (server-compatible)

```
Props: { type: WorkspaceType }
Renders: Badge con label localizado
  general       → "General"
  physical_branch → "Sucursal"
  zone          → "Zona"
  team          → "Equipo"
Color coding: general=gray, physical_branch=blue, zone=green, team=purple
```

### `workspace-card.tsx` (server-compatible)

```
Props: { workspace: WorkspaceRow; showActions: boolean }
Renders:
  - Nombre del workspace
  - WorkspaceBadge (type)
  - Ciudad, teléfono, email (si existen)
  - WorkspaceActionsMenu (si showActions=true)
```

### `workspace-list.tsx` (server-compatible)

```
Props: { workspaces: WorkspaceRow[]; canCreate: boolean }
Renders:
  - Grid/tabla de WorkspaceCard
  - Empty state si length === 0
  - "Nuevo workspace" button (si canCreate)
```

### `workspace-actions-menu.tsx` (client)

```
Props: { workspace: WorkspaceRow }
Renders: DropdownMenu con:
  - "Editar" → router.push('/workspaces/{id}/edit')
  - "Desactivar" → llama deactivateWorkspaceAction(id)
    - Disabled + tooltip si type === 'general'
    - Confirm dialog antes de ejecutar
Requiere: useRouter, useTransition, toast
```

### `workspace-form.tsx` (client)

```
Props:
  - defaultValues?: Partial<CreateWorkspaceInput>
  - action: (formData: FormData) => Promise<ActionResult>
  - submitLabel: string
Renders: Form con React Hook Form + Zod resolver
Campos:
  - name (text input, required)
  - type (Select con WorkspaceBadge previews)
  - city (text input, optional)
  - address (text input, optional)
  - phone (text input, optional)
  - email (email input, optional)
On submit: llama action(formData), muestra toast success/error
```

### `assignments-panel.tsx` (server-compatible, fetch data server-side)

```
Props: { workspaceId: string; canManage: boolean }
Data fetch: listAssignmentsForWorkspace(supabase, workspaceId)
Renders:
  - Lista de receptionists asignados con nombre y email
  - Botón "Quitar" por fila (llama unassignReceptionistAction)
  - "Agregar receptionist" button → AssignReceptionistDialog (si canManage)
  - Empty state si no hay asignaciones ("Acceso sin restricción")
```

### `assign-receptionist-dialog.tsx` (client)

```
Props: { workspaceId: string; alreadyAssigned: string[] }
Data: listReceptionists() via Server Action o fetch on open
Renders: Dialog con:
  - Select de receptionists (filtra los ya asignados)
  - Confirm button → llama assignReceptionistAction
```

---

## 11. Capa 8 — Páginas

**Directorio:** `apps/web/src/app/(tenant)/workspaces/`

Todas son Server Components salvo los shells de formularios.

### `workspaces/page.tsx` — List

```typescript
// Auth: requireTenantUser()
// Data: listWorkspaces(supabase)
// Shows: WorkspaceList
// canCreate: claims.role === 'owner'
// Metadata: { title: 'Workspaces — OrderFlow' }
```

### `workspaces/new/page.tsx` — Create

```typescript
// Auth: requireOwner() → redirige si no es owner
// Renders: WorkspaceForm con createWorkspaceAction
// Metadata: { title: 'Nuevo Workspace — OrderFlow' }
```

### `workspaces/[id]/page.tsx` — Detail

```typescript
// Auth: requireTenantUser()
// Data: getWorkspaceById(supabase, id) → notFound() si null
// Shows: WorkspaceCard, AssignmentsPanel
// canManage: claims.role === 'owner'
// Metadata: { title: `${workspace.name} — OrderFlow` }
```

### `workspaces/[id]/edit/page.tsx` — Edit

```typescript
// Auth: requireOwner()
// Data: getWorkspaceById(supabase, id) → notFound() si null
// Renders: WorkspaceForm con updateWorkspaceAction(id) y defaultValues
// Metadata: { title: `Editar ${workspace.name} — OrderFlow` }
```

---

## 12. Permission Matrix

| Acción | Super Admin (impersonating) | Owner | Receptionist |
|--------|----------------------------|-------|--------------|
| Ver lista de workspaces | ✓ (todos del tenant impersonado) | ✓ (todos) | ✓ (asignados o todos si sin asignaciones) |
| Ver detalle de workspace | ✓ | ✓ | ✓ (solo si tiene acceso) |
| Crear workspace | ✗ (no implementado en Fase 1) | ✓ | ✗ |
| Editar workspace | ✗ | ✓ | ✗ |
| Desactivar workspace | ✗ | ✓ (excepto `general`) | ✗ |
| Ver asignaciones | ✓ | ✓ | ✓ (las propias) |
| Agregar asignación | ✗ | ✓ | ✗ |
| Quitar asignación | ✗ | ✓ | ✗ |
| Acceder a API `/api/v1/workspaces` | según impersonación | ✓ | ✓ (GET only) |

**Impersonation:** El Super Admin accede como si fuera un owner del tenant target.
La RLS lee `auth_impersonating_tenant_id()` para saber qué tenant impersonar.
En Phase 1, la impersonación está en la tabla pero la UI de iniciar/terminar sesión no está implementada.

---

## 13. Error Catalog

| Código | HTTP | Descripción | Causa |
|--------|------|-------------|-------|
| `UNAUTHORIZED` | 401 | Sin sesión | JWT ausente o expirado |
| `FORBIDDEN` | 403 | Rol insuficiente | Receptionist intentando mutation |
| `NOT_FOUND` | 404 | Workspace no encontrado | ID inválido o sin acceso por RLS |
| `NO_DEACTIVATE_GENERAL` | 422 | No se puede desactivar el workspace General | `type === 'general'` |
| `DUPLICATE_ASSIGNMENT` | 409 | El receptionist ya está asignado a este workspace | UNIQUE constraint en DB |
| `CROSS_TENANT_ASSIGNMENT` | 409 | El usuario no pertenece a este tenant | DB trigger consistency check |
| `VALIDATION_ERROR` | 400 | Error de validación Zod | Datos del form inválidos |
| `DATABASE_ERROR` | 500 | Error de base de datos | Error inesperado en Supabase |

---

## 14. UI States

Cada componente debe manejar estos estados:

| Estado | Componente | Render |
|--------|-----------|--------|
| Loading | WorkspaceList | Skeleton grid (4 cards) |
| Empty | WorkspaceList | "No hay workspaces. Creá el primero." |
| Error | WorkspaceList | "Error al cargar. Intentá de nuevo." |
| No permission | WorkspaceActionsMenu | Edit/Deactivate disabled con tooltip |
| General workspace | WorkspaceActionsMenu | Deactivate disabled + tooltip "El workspace General no puede desactivarse" |
| 0 assignments | AssignmentsPanel | "Sin restricción de workspaces (acceso total)" |
| Optimistic update | deactivateWorkspaceAction | Usar `useTransition` + `isPending` state |

---

## 15. Test Scenarios

Los siguientes escenarios deben verificarse manualmente antes de cerrar Phase 1:

### Auth
- [ ] Acceder a `/workspaces` sin sesión → redirige a `/login`
- [ ] Acceder a `/workspaces/new` como receptionist → redirige a `/workspaces`
- [ ] Owner ve botones de editar/desactivar
- [ ] Receptionist no ve botones de mutación

### CRUD — Owner
- [ ] Crear workspace con todos los campos → aparece en lista
- [ ] Crear workspace solo con nombre y tipo → OK
- [ ] Editar nombre y ciudad de workspace → cambios persistidos
- [ ] Intentar desactivar workspace General → error visible en UI
- [ ] Desactivar workspace no-General → desaparece de lista activa

### Assignments
- [ ] Agregar receptionist a workspace → aparece en panel
- [ ] Intentar agregar el mismo receptionist dos veces → error 409 manejado
- [ ] Quitar asignación → desaparece de panel
- [ ] Receptionist con 0 asignaciones ve todos los workspaces
- [ ] Receptionist con N asignaciones ve solo esos workspaces

### Tenant Isolation
- [ ] Workspace de tenant A no aparece para usuario de tenant B (RLS)
- [ ] API GET `/api/v1/workspaces` con JWT de tenant A no retorna datos de tenant B

---

## 16. Dependencias a Instalar

No se requieren nuevas dependencias de npm. Todo lo necesario ya está instalado:

| Paquete | Versión | Uso |
|---------|---------|-----|
| `@supabase/ssr` | existente | createClient (server) |
| `@supabase/supabase-js` | existente | SupabaseClient type |
| `react-hook-form` | existente | workspace-form |
| `@hookform/resolvers` | existente | Zod resolver |
| `zod` | existente | validators |
| shadcn/ui components | existente | UI |

**Nuevos componentes shadcn/ui a instalar si no existen:**
```bash
pnpm --filter @orderflow/web dlx shadcn@latest add dialog
pnpm --filter @orderflow/web dlx shadcn@latest add select
pnpm --filter @orderflow/web dlx shadcn@latest add dropdown-menu
pnpm --filter @orderflow/web dlx shadcn@latest add badge
pnpm --filter @orderflow/web dlx shadcn@latest add skeleton
pnpm --filter @orderflow/web dlx shadcn@latest add sonner   # toasts
```

---

## 17. Orden de Implementación

Implementar en este orden exacto — cada paso compila y funciona antes de avanzar:

```
1. apps/web/src/lib/auth.ts
   → prerequisito para todas las páginas y actions

2. apps/web/src/modules/workspaces/types.ts
   → define los tipos internos del módulo

3. apps/web/src/modules/workspaces/repository.ts
   → única capa que toca la DB directamente

4. apps/web/src/modules/workspaces/actions.ts
   → depende de repository + validators

5. apps/web/src/app/(tenant)/workspaces/page.tsx
   → primera página, solo lectura, valida que repository funciona

6. apps/web/src/components/tenant/workspaces/workspace-badge.tsx
   → sin dependencias, base visual

7. apps/web/src/components/tenant/workspaces/workspace-card.tsx
   → depende de workspace-badge

8. apps/web/src/components/tenant/workspaces/workspace-list.tsx
   → depende de workspace-card

9. Integrar WorkspaceList en workspaces/page.tsx
   → primer flujo completo visible

10. apps/web/src/components/tenant/workspaces/workspace-form.tsx
    → depende de validators, RHF

11. apps/web/src/app/(tenant)/workspaces/new/page.tsx
    → primer flujo de mutación

12. apps/web/src/app/(tenant)/workspaces/[id]/edit/page.tsx
    → reutiliza WorkspaceForm

13. apps/web/src/components/tenant/workspaces/workspace-actions-menu.tsx
    → depende de actions (deactivate)

14. apps/web/src/components/tenant/workspaces/assignments-panel.tsx
    → depende de repository.listAssignmentsForWorkspace

15. apps/web/src/components/tenant/workspaces/assign-receptionist-dialog.tsx
    → depende de repository.listReceptionists + actions.assign

16. apps/web/src/app/(tenant)/workspaces/[id]/page.tsx
    → integra AssignmentsPanel + WorkspaceActionsMenu

17. apps/web/src/app/api/v1/workspaces/route.ts         (GET + POST)
18. apps/web/src/app/api/v1/workspaces/[id]/route.ts    (GET + PUT + DELETE)
19. apps/web/src/app/api/v1/workspaces/[id]/assignments/route.ts
20. apps/web/src/app/api/v1/workspaces/[id]/assignments/[userId]/route.ts
```

---

## 18. Archivos Modificados (no nuevos)

| Archivo | Cambio |
|---------|--------|
| `apps/web/src/app/(tenant)/layout.tsx` | Agregar link "Workspaces" en la nav |
| `packages/types/src/index.ts` | Ya exporta `Database` y row aliases |
| `packages/validators/src/index.ts` | ✅ Ya exporta workspace validators |

---

## 19. Migraciones

No se requieren nuevas migraciones para Phase 1. El schema v3 ya tiene:
- `workspaces` table con todos los campos necesarios
- `user_workspace_assignments` junction table
- RLS policies en ambas tablas
- Indexes para las queries más frecuentes

**Próxima migración requerida en:** Phase 2 (Properties), si se agregan campos.

---

## 20. Checklist Pre-Merge

- [ ] `pnpm typecheck` pasa sin errores
- [ ] `pnpm build` pasa sin errores  
- [ ] Test manual de todos los escenarios de la Sección 15
- [ ] Owner puede crear, editar y desactivar workspaces
- [ ] Receptionist no puede mutar workspaces
- [ ] Workspace General no puede ser desactivado
- [ ] Asignaciones funcionan (agregar + quitar)
- [ ] Receptionist con asignaciones ve solo sus workspaces
- [ ] API endpoints retornan el formato correcto de `12-api-spec.md`
- [ ] Sin console.log en código de producción
- [ ] Todos los errores de DB están capturados y transformados en `ActionResult`
