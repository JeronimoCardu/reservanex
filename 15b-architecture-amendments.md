# OrderFlow — Architecture Amendments v1.0

**Versión:** 1.0  
**Fecha:** 2026-06-22  
**Autor:** Principal Software Architect  
**Propósito:** Consolidar decisiones finales y congelar la arquitectura para iniciar desarrollo  
**Prerrequisito:** 15-architecture-final-audit.md

---

## 1. Executive Summary

Este documento incorpora 8 decisiones arquitecturales definitivas que cierran los hallazgos del audit anterior (15-architecture-final-audit.md) y resuelven ambigüedades de diseño identificadas en la revisión pre-desarrollo.

**Las 8 decisiones están cerradas. No generan discusión adicional.**

El impacto más significativo es la **evolución de `branches` a `workspaces`** con asignación múltiple para recepcionistas. Este cambio afecta la estructura de datos, el modelo de JWT, y los patrones de RLS — pero es el momento de cero costo para hacerlo: ninguna línea de código producción fue escrita.

Los demás cambios son quirúrgicos: un addendum de schema, una corrección de documento, dos decisiones de alcance (email, tool calling) y una aclaración de permisos.

**Ninguna decisión requiere rediseñar la arquitectura central.**

Al finalizar este documento, OrderFlow Architecture v1.0 queda congelada y lista para desarrollo.

---

## 2. Final Architecture Decisions

### Decisión 1 — Workspaces reemplazan Branches

**Estado:** CERRADO  
**Origen:** 15-architecture-final-audit.md hallazgo semántico + análisis de negocio

**Definición oficial:**

Un `workspace` es un grupo operativo dentro de un tenant. No implica ubicación física. Puede representar:

| Tipo | Ejemplo |
|---|---|
| `general` | Organización completa (default al crear tenant) |
| `physical_branch` | Sucursal Centro, Sucursal Norte |
| `zone` | Zona Palermo, Zona Litoral |
| `team` | Equipo Temporario, Equipo Residencial |

**Nuevo enum:**
```
workspace_type: general | physical_branch | zone | team
```

**Workspace "General":**  
Al crear un nuevo tenant, el sistema crea automáticamente un workspace con `type = 'general'` y `name = 'General'`. Este workspace es la organización completa. No se puede eliminar. Sirve como valor por defecto en la UI para entidades sin workspace específico asignado.

**`workspace_id` en tablas:** Nullable. `NULL` significa "visible para todos los workspaces" (equivalente al workspace General pero sin FK explícita). La UI defaultea a "General" pero el campo en DB puede ser NULL o apuntar al UUID del workspace General.

---

### Decisión 2 — Owner: acceso total sin excepción

**Estado:** CERRADO  
**Origen:** Clarificación explícita del modelo de permisos

**Regla definitiva:**

El Owner tiene acceso completo a todos los datos de su tenant. No existe ningún filtro de workspace para el Owner. Sus políticas RLS ignoran `workspace_id` completamente.

```
Owner accede a:
  ✓ Todos los workspaces
  ✓ Todas las conversaciones (independientemente del workspace)
  ✓ Todas las reservas
  ✓ Todos los contactos
  ✓ Todas las propiedades
  ✓ Todos los usuarios del tenant
  ✓ Audit log completo del tenant
```

**Sin excepciones.** La política RLS del Owner nunca contiene condición sobre `workspace_id`.

---

### Decisión 3 — Receptionist: asignación múltiple de workspaces

**Estado:** CERRADO  
**Origen:** Evolución del modelo de negocio (branches → workspaces)

**Cambio arquitectural de mayor impacto en este documento.**

#### 3.1 Modelo de datos

Se elimina `tenant_users.workspace_id` (antes `branch_id`). Se reemplaza por una tabla de junction:

```
user_workspace_assignments
──────────────────────────────────────────────
id             UUID PK
user_id        UUID FK tenant_users(id) ON DELETE CASCADE
workspace_id   UUID FK workspaces(id) ON DELETE CASCADE
created_at     TIMESTAMPTZ NOT NULL DEFAULT now()

UNIQUE(user_id, workspace_id)
```

**Semántica de acceso:**

| Filas en `user_workspace_assignments` para el receptionist | Acceso |
|---|---|
| Sin filas (vacío) | Todos los workspaces |
| 1 o más filas | Solo los workspaces asignados |

**Por qué "sin filas = acceso total":** Permite crear un recepcionista que gestiona toda la operación sin configuración adicional. Consistente con el comportamiento anterior donde `branch_id = NULL` significaba "todos". El Owner puede restringir asignando workspaces específicos.

**Constraint sobre Owners:** El Owner nunca tiene entradas en `user_workspace_assignments`. Su acceso total está enforced por la política RLS del rol, no por ausencia de asignaciones.

#### 3.2 JWT claims

Cambio en el claim del token JWT:

```json
// ANTES (model de branches — eliminado)
"app_metadata": {
  "branch_id": "uuid-o-null"
}

// AHORA (model de workspaces)
"app_metadata": {
  "workspace_ids": ["uuid1", "uuid2"]  // array de UUIDs asignados
                                        // null o [] = todos los workspaces
}
```

El Auth Hook (`custom_access_token_hook`) debe:
1. Verificar que el usuario es `tenant_user` con `role = 'receptionist'`
2. Hacer `SELECT ARRAY_AGG(workspace_id) FROM user_workspace_assignments WHERE user_id = $uid`
3. Si el resultado es NULL o vacío: `workspace_ids = null` en JWT (acceso total)
4. Si hay asignaciones: `workspace_ids = ["uuid1", "uuid2"]` en JWT

#### 3.3 Función helper RLS

```
ANTES: public.auth_branch_id() → UUID | NULL
AHORA: public.auth_workspace_ids() → UUID[] | NULL
```

`NULL` = acceso total (sin restricción de workspace).  
`UUID[]` = acceso limitado a esos workspaces.

#### 3.4 Patrón RLS actualizado

```sql
-- ANTES (single FK)
auth_branch_id() IS NULL
OR workspace_id IS NULL  
OR workspace_id = auth_branch_id()

-- AHORA (multi-workspace array)
public.auth_workspace_ids() IS NULL           -- acceso total (owner o receptionist sin restricción)
OR workspace_id IS NULL                        -- entidad sin workspace asignado (visible para todos)
OR workspace_id = ANY(public.auth_workspace_ids())  -- entidad en workspace asignado al usuario
```

Este patrón aplica a: `properties`, `conversations`, `messages` (via conversation).

---

### Decisión 4 — Impersonación: fuente de verdad es `impersonation_sessions`

**Estado:** CERRADO  
**Origen:** 15-architecture-final-audit.md C-01

**Modelo definitivo:**

El Super Admin **nunca** recibe un nuevo JWT durante la impersonación. Mantiene su JWT original con `user_type = 'platform_user'` y `role = 'super_admin'`.

El acceso a datos de tenant durante impersonación se logra mediante la función:

```sql
public.auth_impersonating_tenant_id() → UUID | NULL
```

Esta función consulta `impersonation_sessions WHERE platform_user_id = auth.uid() AND ended_at IS NULL`. Retorna el `target_tenant_id` de la sesión activa, o NULL si no hay impersonación activa.

Las políticas RLS para tenant data del Super Admin usan:
```sql
public.is_super_admin() AND tenant_id = public.auth_impersonating_tenant_id()
```
Si no hay sesión activa, `auth_impersonating_tenant_id()` retorna NULL → `tenant_id = NULL` es siempre FALSE → acceso denegado. Sin bypass global.

**`audit_logs.impersonated_by`:** Se popula mediante la función `audit_table_change()` en el schema, que llama a `auth_impersonating_tenant_id()`. Cuando hay sesión activa, `impersonated_by = auth.uid()` (el SA que está impersonando) se registra automáticamente en el audit log.

**`08-permissions-and-rls.md` seción 4 queda obsoleta** en su descripción del JWT re-emitido. Ver sección 4 del presente documento para instrucción de actualización.

---

### Decisión 5 — Documents: soporte para contact y reservation

**Estado:** CERRADO  
**Origen:** 15-architecture-final-audit.md C-02

La tabla `documents` debe soportar los 4 anchors de negocio:

| Campo | Tipo | Uso |
|---|---|---|
| `property_id` | UUID nullable FK | Documentos de propiedad (reglamento, planos) |
| `unit_id` | UUID nullable FK | Documentos de unidad (contrato tipo, manual) |
| `contact_id` | UUID nullable FK | Documentos del cliente (DNI, comprobante) |
| `reservation_id` | UUID nullable FK | Documentos de la reserva (contrato firmado, voucher) |

**Constraint:** Al menos uno de los cuatro campos debe ser NOT NULL.

Los endpoints de API spec (`GET/POST /contacts/:id/documents`, `GET/POST /reservations/:id/documents`) quedan soportados con esta estructura.

---

### Decisión 6 — Confirmación de reservas: Receptionist + Owner

**Estado:** CERRADO  
**Origen:** 15-architecture-final-audit.md A-03 + clarificación de flujo

**Flujo oficial de reservas:**

```
IA crea pre-reserva automáticamente
        ↓
    PRE_RESERVED
        ↓
  Recepcionista o Owner confirman (manual)
        ↓
    CONFIRMED
```

**Reglas definitivas:**

| Acción | IA | Recepcionista | Owner |
|---|---|---|---|
| Crear pre-reserva | ✓ | ✓ | ✓ |
| Confirmar reserva | ✗ | ✓ | ✓ |
| Cancelar reserva | ✗ | ✓ | ✓ |
| Eliminar reserva (soft delete) | ✗ | ✗ | ✓ |

La IA **nunca** confirma definitivamente. El paso de `pre_reserved` → `confirmed` siempre requiere intervención humana. Esto preserva el control del equipo sobre el compromiso financiero.

Los endpoints afectados en `12-api-spec.md`:
- `POST /reservations/:id/confirm` → roles: `owner, receptionist`
- `POST /reservations/:id/cancel` → roles: `owner, receptionist` (sin cambio, ya era así)

---

### Decisión 7 — Tool Calling: límite de 5 rondas

**Estado:** CERRADO  
**Origen:** 15-architecture-final-audit.md A-02 — conflicto 3 vs 5

**Regla oficial: máximo 5 rondas de tool calling por mensaje.**

**Justificación:**

El flujo más complejo documentado en `09-ai-architecture.md` involucra estas llamadas secuenciales:

```
Ronda 1: get_contact_history (contexto del cliente)
Ronda 2: search_properties (buscar opciones)
Ronda 3: get_property_details + check_availability (detalles + disponibilidad — paralelas)
Ronda 4: create_pre_reservation (crear reserva si cliente acepta)
[Ronda 5: create_task (seguimiento) — en flujos complejos]
```

Con 3 rondas, la Ronda 1 (historial de contacto) quema una ronda y el flujo de reserva queda en 2 rondas para search + reserve. Si el cliente pide detalles antes de confirmar (`get_property_details` en ronda 3), el flujo necesita 4 rondas. 3 es insuficiente para el caso real más común.

Con 5 rondas: el flujo más complejo tiene espacio. El costo adicional vs. 3 rondas es de ~2 llamadas extra a Claude cuando son necesarias (≈ $0.01 por mensaje en el peor caso).

**Nota importante:** La distinción entre "rondas" e "iteraciones" queda eliminada. El término oficial es **rondas** (*rounds*). Una ronda = un ciclo: AI responde con `tool_use` → worker ejecuta → AI recibe `tool_result`. Dentro de una ronda, Claude puede llamar múltiples herramientas en paralelo (esto no consume rondas adicionales).

**Constante en código:** `MAX_TOOL_ROUNDS = 5` en `packages/ai/src/client.ts`.

---

### Decisión 8 — Email: postergado a post-MVP

**Estado:** CERRADO  
**Origen:** 15-architecture-final-audit.md A-04

**Email de notificaciones (reservas, escalaciones) queda fuera del MVP.**

**Justificación:** La propuesta de valor del MVP es WhatsApp + IA. El canal de notificación prioritario es WhatsApp. Agregar Resend al MVP introduce: SDK adicional, templates de email, un modo de falla más, y una tarea de integración que no agrega valor al piloto inicial.

**Lo que sí se usa en MVP:** Supabase Auth maneja nativamente los emails de invitación de usuario (`inviteUserByEmail()`) y recuperación de contraseña con sus propios templates. No requiere Resend.

**Qué se elimina del scope actual:**
- Módulo email en `apps/worker`
- Variable de entorno `RESEND_API_KEY`
- Procesamiento de `notifications` con `channel = 'email'`
- Referencias a Resend en API spec para welcome email y invitaciones

**Qué se mantiene en DB:** El enum `notification_channel` conserva el valor `'email'`. Las filas con `channel = 'email'` en `notifications` se crearán pero no se procesarán hasta post-MVP. El schema no cambia.

**Estado de notificaciones en MVP:**
- `in_app`: activo (Supabase Realtime)
- `whatsapp`: activo (Meta Cloud API via worker)
- `email`: almacenado en DB, no procesado

---

## 3. Workspace Migration Plan (Conceptual)

Esta sección describe los cambios conceptuales necesarios para migrar de `branches` a `workspaces`. No contiene SQL ni código.

### 3.1 Entidades que cambian de nombre

| Antes | Después |
|---|---|
| Tabla `branches` | Tabla `workspaces` |
| FK `tenant_users.branch_id` | Eliminada → reemplazada por `user_workspace_assignments` |
| FK `conversations.branch_id` | FK `conversations.workspace_id` |
| FK `properties.branch_id` | FK `properties.workspace_id` |
| FK `whatsapp_accounts.branch_id` | FK `whatsapp_accounts.workspace_id` |
| Constraint `owner_no_branch` | Eliminado (no FK directa en tenant_users) |
| Trigger `trg_tenant_users_branch_consistency` | Actualizado → `trg_tenant_users_workspace_assignment_consistency` |
| Función `public.auth_branch_id()` | Función `public.auth_workspace_ids()` |
| Claim JWT `branch_id: UUID \| null` | Claim JWT `workspace_ids: UUID[] \| null` |
| Endpoints `/branches` | Endpoints `/workspaces` |

### 3.2 Entidades nuevas

**Tabla `workspaces`** (evolución de `branches`):
- Conserva todos los campos actuales de `branches`
- Agrega: `type workspace_type NOT NULL DEFAULT 'general'`
- El COMMENT de la tabla cambia a reflejar el concepto genérico

**Enum `workspace_type`:**
```
general | physical_branch | zone | team
```

**Tabla `user_workspace_assignments`:**
- Relación muchos-a-muchos entre `tenant_users` y `workspaces`
- Scoped por `workspace_id` — los dos UUIDs deben pertenecer al mismo tenant (enforced por trigger)
- Solo aplicable a receptionists — owners no tienen entradas (su acceso es total por rol)

### 3.3 Workspace "General" automático

Al crear un nuevo tenant (vía `POST /platform/tenants`), el sistema crea automáticamente:
```
workspaces (name = 'General', type = 'general', active = true)
```

Este workspace no puede eliminarse mientras el tenant esté activo. Representa la organización completa. En la UI, aparece primero en cualquier selector de workspaces.

### 3.4 Comportamiento de `workspace_id = NULL` en tablas

Cuando `workspace_id IS NULL` en `properties`, `conversations`, etc.:
- Es visible para todos los receptionists (independientemente de sus asignaciones)
- Es visible para el Owner siempre
- Semánticamente equivale a "sin restricción de workspace"

La UI puede interpretar `NULL` como "General" para el usuario final, sin cambiar el valor en DB.

### 3.5 Impacto en Auth Hook

El `custom_access_token_hook` actualizado debe:
1. Determinar `user_type` y `role` como actualmente
2. Si `role = 'receptionist'`: consultar `user_workspace_assignments` para ese usuario
3. Si tiene asignaciones: incluir `workspace_ids: [uuid1, uuid2, ...]` en JWT
4. Si no tiene asignaciones: incluir `workspace_ids: null` en JWT (acceso total)
5. Si `role = 'owner'`: no incluir `workspace_ids` (o incluir `null`) — el rol define acceso total

### 3.6 Impacto en patrones RLS

**Patrón antes (single branch):**
```
user tiene branch_id en JWT → entidad filtrada por branch_id = ese UUID o NULL
```

**Patrón después (multi-workspace):**
```
user tiene workspace_ids en JWT → entidad filtrada si workspace_id IN (workspace_ids) o NULL
NULL en JWT → sin restricción (owner o receptionist global)
```

La condición de RLS para receptionist en tablas con workspace_id:
```
auth_workspace_ids() IS NULL
OR workspace_id IS NULL
OR workspace_id = ANY(auth_workspace_ids())
```

### 3.7 API de gestión de workspaces

Los endpoints `/workspaces` reemplazan `/branches` sin cambio funcional:

| Método | Ruta | Diferencia vs. antes |
|---|---|---|
| GET | `/workspaces` | Incluye campo `type` en respuesta |
| POST | `/workspaces` | Acepta campo `type` en body |
| GET | `/workspaces/:id` | Incluye campo `type` |
| PATCH | `/workspaces/:id` | Acepta campo `type` |
| DELETE | `/workspaces/:id` | Sin cambio |

**Nuevo endpoint de gestión de asignaciones de receptionist:**

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/users/:id/workspaces` | Lista workspaces asignados al usuario |
| PUT | `/users/:id/workspaces` | Reemplaza la lista completa de asignaciones |

El `PUT` recibe `{ workspace_ids: ["uuid1", "uuid2"] }` y reemplaza todas las asignaciones existentes. Un array vacío o `null` → sin asignaciones → acceso total.

---

## 4. Documentation Update Matrix

La siguiente tabla indica exactamente qué documentos requieren actualización, qué cambio, y con qué prioridad.

**Prioridad:** BLOQUEANTE (debe actualizarse antes de escribir código), ALTO (antes de onboarding del equipo), MEDIO (antes del MVP Beta), BAJO (antes del launch).

| Documento | Cambio requerido | Decisión origen | Prioridad | Estado |
|---|---|---|---|---|
| `10-supabase-schema-v2.sql` | Renombrar `branches` → `workspaces`; agregar `workspace_type` enum; agregar `user_workspace_assignments` table; eliminar `tenant_users.branch_id`; agregar `contact_id` y `reservation_id` a `documents`; actualizar constraint y trigger names | D1, D3, D5 | BLOQUEANTE | Pendiente |
| `11-rls-policies.sql` | Renombrar `auth_branch_id()` → `auth_workspace_ids()` (retorna UUID[]); actualizar patrón de scoping a `= ANY()`; actualizar todas las políticas de branches → workspaces; actualizar header comentario sobre claims | D1, D3 | BLOQUEANTE | Pendiente |
| `12-api-spec.md` | Renombrar todos los endpoints `/branches` → `/workspaces`; agregar campo `type` a workspace; cambiar `branch_id` → `workspace_ids` (array) en `/auth/me` y `/users`; agregar `GET/PUT /users/:id/workspaces`; cambiar roles de `POST /reservations/:id/confirm` a `owner, receptionist`; eliminar referencias a Resend para welcome/invite email | D1, D3, D6, D8 | BLOQUEANTE | Pendiente |
| `08-permissions-and-rls.md` | Reescribir completamente sección 4 (Impersonación): eliminar modelo JWT re-emitido, documentar modelo DB-query con `auth_impersonating_tenant_id()`; actualizar `audit_logs.impersonated_by` (via función en schema); actualizar helper functions namespace (`public.*`); actualizar tabla de permisos del Recepcionista (confirmar reservas = ✓) | D4, D6 | BLOQUEANTE | Pendiente |
| `07-database-v2.md` | Actualizar tabla `branches` → `workspaces` con nuevos campos; documentar `user_workspace_assignments`; actualizar tabla `tenant_users` (remover branch_id); actualizar tabla `documents` (agregar contact_id, reservation_id); actualizar constraint cross-check de workspace | D1, D3, D5 | ALTO | Pendiente |
| `06-architecture.md` | Actualizar sección 7 (Impersonación) para reflejar modelo DB-query; actualizar diagrama de componentes eliminando "Edge Function" para webhook; cambiar Next.js 14 → 15, PostgreSQL 15 → 17 | D4 | ALTO | Pendiente |
| `03-roles.md` | Actualizar permisos de Recepcionista: "Confirmar reservas" ✓ (ya estaba, solo confirmar explícitamente) | D6 | ALTO | Pendiente |
| `09-ai-architecture.md` | Actualizar límite de rondas de 3 → 5; actualizar `conversation_source` de `'website'` → `'website_button'` | D7 | ALTO | Pendiente |
| `13-project-structure.md` | Renombrar todas las referencias a `branches` → `workspaces`; agregar `user_workspace_assignments` en explicación de tablas afectadas; actualizar descripción de Auth Hook | D1, D3 | MEDIO | Pendiente |
| `14-development-roadmap.md` | Actualizar "Branches CRUD" → "Workspaces CRUD" en Fase 2; confirmar email como post-MVP; consolidar "5 rondas" de tool calling | D1, D7, D8 | MEDIO | Pendiente |
| `02-mvp.md` | Actualizar sección Notificaciones: `WhatsApp, Email` → `WhatsApp (in-app notifications)`. Agregar nota: "Email notificaciones: post-MVP v1.1" | D8 | MEDIO | Pendiente |
| `15-architecture-final-audit.md` | Marcar como resueltos: C-01 (impersonación), C-02 (documents), A-02 (tool rounds), A-03 (receptionist confirm), A-04 (email scope) | D4, D5, D6, D7, D8 | BAJO | Pendiente |

### Resumen de impacto por documento

| Documento | Decisiones que lo impactan | Nivel de cambio |
|---|---|---|
| `10-supabase-schema-v2.sql` | D1, D3, D5 | Alto — multiple table changes |
| `11-rls-policies.sql` | D1, D3 | Alto — all branch policies + new pattern |
| `12-api-spec.md` | D1, D3, D6, D8 | Alto — endpoints + fields + roles |
| `08-permissions-and-rls.md` | D4, D6 | Alto — section 4 full rewrite |
| `07-database-v2.md` | D1, D3, D5 | Medio — table updates |
| `06-architecture.md` | D4 | Medio — section update |
| `03-roles.md` | D6 | Bajo — one line clarification |
| `09-ai-architecture.md` | D7 | Bajo — one number change + one enum value |
| `13-project-structure.md` | D1, D3 | Bajo — naming updates |
| `14-development-roadmap.md` | D1, D7, D8 | Bajo — naming + number |
| `02-mvp.md` | D8 | Bajo — one section update |
| `15-architecture-final-audit.md` | D4, D5, D6, D7, D8 | Bajo — mark resolved |

---

## 5. Open Questions

**No remaining architectural blockers.**

Las 8 decisiones cierran todos los puntos abiertos del audit anterior. La única pregunta de diseño que podría surgir durante implementación es de comportamiento por defecto:

> "Si un recepcionista no tiene ninguna asignación en `user_workspace_assignments`, ¿el sistema le muestra un aviso en el onboarding?"

Esto es UX, no arquitectura. La regla de negocio está definida (sin asignaciones = acceso total). La UI puede mostrar el estado con un badge "Acceso completo" vs. "X workspaces asignados". No bloquea el inicio del desarrollo.

---

## 6. Architecture Freeze Checklist

Para declarar **OrderFlow Architecture v1.0 Frozen**, todos los siguientes puntos deben estar verificados:

### Schema y Base de Datos

- [ ] Tabla `branches` renombrada a `workspaces` en `10-supabase-schema-v2.sql`
- [ ] Enum `workspace_type (general | physical_branch | zone | team)` definido en schema
- [ ] Tabla `user_workspace_assignments` definida con constraint UNIQUE(user_id, workspace_id)
- [ ] Columna `tenant_users.branch_id` eliminada
- [ ] Constraint `owner_no_branch` eliminado
- [ ] FK columns actualizadas: `conversations.workspace_id`, `properties.workspace_id`, `whatsapp_accounts.workspace_id`
- [ ] Tabla `documents` tiene columnas `contact_id` y `reservation_id` con FKs correspondientes
- [ ] Constraint `documents_must_have_entity` actualizado para incluir los 4 posibles anchors
- [ ] Trigger de consistencia de workspace actualizado para validar que `user_workspace_assignments.workspace_id` pertenece al mismo tenant que el usuario
- [ ] Workspace "General" se crea automáticamente en el flujo de onboarding de tenant

### RLS

- [ ] Función `public.auth_branch_id()` renombrada/reemplazada por `public.auth_workspace_ids() → UUID[]`
- [ ] Todas las políticas de `branches` actualizadas para `workspaces`
- [ ] Patrón de scoping de receptionist usa `= ANY(auth_workspace_ids())` en lugar de `= auth_branch_id()`
- [ ] Políticas de `workspaces` definidas: SA (impersonación), Owner (full CRUD), Receptionist (SELECT)
- [ ] Políticas de `user_workspace_assignments` definidas: Owner (full CRUD), SA (impersonación SELECT)
- [ ] Función `auth_impersonating_tenant_id()` está en `11-rls-policies.sql` y documentada en `08-permissions-and-rls.md`
- [ ] Ninguna política utiliza re-emisión de JWT para impersonación

### Auth Hook

- [ ] `custom_access_token_hook` popula `workspace_ids: UUID[] | null` (no `branch_id`)
- [ ] Hook consulta `user_workspace_assignments` para receptionist
- [ ] Hook retorna `workspace_ids: null` para owners y receptionists sin asignaciones (acceso total)
- [ ] Hook registrado en Supabase Dashboard (Pro plan activo)

### API Spec

- [ ] Todos los endpoints `/branches` renombrados a `/workspaces` en `12-api-spec.md`
- [ ] Objeto workspace incluye campo `type` en GET/POST/PATCH
- [ ] Endpoint `GET /users/:id/workspaces` y `PUT /users/:id/workspaces` definidos
- [ ] JWT response en `/auth/me` refleja `workspace_ids: UUID[]` (no `branch_id`)
- [ ] `POST /reservations/:id/confirm` tiene roles: `owner, receptionist`
- [ ] Referencias a Resend para emails de bienvenida/invitación eliminadas o marcadas como Supabase Auth built-in
- [ ] Notificaciones `email` marcadas como "procesadas post-MVP v1.1"

### Decisiones de alcance

- [ ] Email de notificaciones explícitamente fuera del MVP en `02-mvp.md` y `14-development-roadmap.md`
- [ ] Constante `MAX_TOOL_ROUNDS = 5` documentada en `09-ai-architecture.md`
- [ ] `conversation_source` en `09-ai-architecture.md` usa valor `'website_button'` (no `'website'`)
- [ ] Receptionist puede confirmar y cancelar reservas en `03-roles.md` y `12-api-spec.md`

### Documentación

- [ ] `08-permissions-and-rls.md` sección 4 reescrita para reflejar modelo DB-query de impersonación
- [ ] Todas las referencias a `branch_id` en `08-permissions-and-rls.md` actualizadas a `workspace_id`
- [ ] `06-architecture.md` sección 7 actualizada (impersonación sin JWT re-issuance)
- [ ] `06-architecture.md` versiones corregidas: Next.js 15, PostgreSQL 17
- [ ] `07-database-v2.md` refleja `workspaces` + `user_workspace_assignments` + `documents` actualizado
- [ ] `13-project-structure.md` actualizado: referencias a workspaces, Auth Hook actualizado
- [ ] `14-development-roadmap.md` actualizado: Workspace CRUD, tool rounds, email post-MVP

### Pre-Desarrollo

- [ ] Schema addendum SQL preparado con todos los cambios de este documento (contenido de la Decisión 1+3+5)
- [ ] `supabase gen types typescript` re-ejecutado post-schema-update
- [ ] `.env.example` documentado con todas las variables (sin `RESEND_API_KEY` por ahora)
- [ ] Supabase Pro plan activo (requerido para Auth Hook)
- [ ] Cuenta de Meta Business con número de WhatsApp aprobado iniciada (proceso tarda días)

---

## 7. Final Verdict

**B — Minor Documentation Updates Required**

La arquitectura de OrderFlow está conceptualmente completa y lista para desarrollo. Los cambios de este documento son actualizaciones de documentación y un addendum de schema — no rediseños.

El path al código es:

```
1. Preparar schema addendum SQL (cambios de workspaces + documents)
   → aplica todos los cambios de Decisiones 1, 3, 5

2. Actualizar 4 documentos BLOQUEANTE:
   → 10-supabase-schema-v2.sql
   → 11-rls-policies.sql
   → 12-api-spec.md
   → 08-permissions-and-rls.md

3. Actualizar documentos ALTO:
   → 07-database-v2.md
   → 06-architecture.md
   → 03-roles.md
   → 09-ai-architecture.md

4. Declarar Architecture Frozen (checklist completa)

5. Iniciar Fase 0 del roadmap
```

Una vez que los 4 documentos BLOQUEANTE estén actualizados y el schema addendum esté preparado, el equipo puede comenzar Fase 0 (infraestructura) en paralelo mientras los documentos ALTO/MEDIO se actualizan.

**La decisión más impactante ya fue tomada.** Workspaces con multi-asignación es el cambio estructural más significativo. Todo lo demás es cosmético o de alcance.
