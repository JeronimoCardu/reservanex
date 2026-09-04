# OrderFlow — Schema Addendum v1.0

**Versión:** 1.0  
**Fecha:** 2026-06-22  
**Basado en:** 15b-architecture-amendments.md  
**Propósito:** Enumerar todos los cambios pendientes para alinear la documentación existente con las 8 decisiones arquitecturales congeladas  
**Reemplaza:** Ningún documento — este es un registro de deuda técnica de documentación  

---

## Resumen ejecutivo

La base de datos schema v2 (`10-supabase-schema-v2.sql`) y los documentos asociados tienen **14 cambios pendientes** distribuidos en 6 archivos. Todos los cambios son consecuencia directa de las 8 decisiones de `15b-architecture-amendments.md`.

El cambio más impactante es la migración `branches → workspaces` con asignación múltiple de receptionist, que afecta el schema, RLS, API spec, y la función del Auth Hook.

**Al finalizar este addendum:** Architecture v1.0 Frozen — sin blockers de desarrollo.

---

## Cambios pendientes por documento

### Documento: `10-supabase-schema-v2.sql`

---

**Cambio 1**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Agregar enum `workspace_type` con valores: `general`, `physical_branch`, `zone`, `team` |
| **Motivo** | Decisión 1: workspaces reemplazan branches con semántica flexible |
| **Impacto** | Nuevo tipo base usado en tabla `workspaces.type` |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 2**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Renombrar tabla `branches` → `workspaces`. Agregar columna `type workspace_type NOT NULL DEFAULT 'general'`. Actualizar comment de tabla. |
| **Motivo** | Decisión 1 |
| **Impacto** | Todas las FKs que apuntan a `branches.id` deben actualizarse a `workspaces.id` |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 3**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Agregar tabla `user_workspace_assignments (id, user_id FK tenant_users, workspace_id FK workspaces, created_at). UNIQUE(user_id, workspace_id)` |
| **Motivo** | Decisión 3: receptionist puede pertenecer a múltiples workspaces |
| **Impacto** | Nueva tabla que reemplaza el campo `branch_id` de `tenant_users`. Requiere trigger de consistencia de tenant y políticas RLS propias. |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 4**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Tabla `tenant_users`: eliminar columna `branch_id`, eliminar constraint `owner_no_branch`. |
| **Motivo** | Decisión 3: multi-workspace vía junction table reemplaza el FK singular |
| **Impacto** | El trigger `trg_tenant_users_branch_consistency` y la función `check_user_branch_consistency()` quedan obsoletos y deben eliminarse. |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 5**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Renombrar columna `properties.branch_id` → `properties.workspace_id`. FK apunta a `workspaces(id)`. Actualizar índice `idx_properties_branch` → `idx_properties_workspace`. |
| **Motivo** | Decisión 1 |
| **Impacto** | Todas las queries de propiedades con filtro de workspace deben actualizar el campo |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 6**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Renombrar columna `conversations.branch_id` → `conversations.workspace_id`. FK apunta a `workspaces(id)`. Actualizar índice `idx_conversations_branch_status` → `idx_conversations_workspace_status`. |
| **Motivo** | Decisión 1 |
| **Impacto** | Worker que crea conversaciones debe usar `workspace_id` |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 7**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Renombrar columna `whatsapp_accounts.branch_id` → `whatsapp_accounts.workspace_id`. FK apunta a `workspaces(id)`. |
| **Motivo** | Decisión 1 |
| **Impacto** | El routing de webhooks por workspace usa este campo |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 8**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Tabla `documents`: agregar columnas `contact_id UUID REFERENCES contacts(id)` y `reservation_id UUID REFERENCES reservations(id)`. Actualizar constraint `documents_must_have_entity` para incluir los 4 anchors: `property_id IS NOT NULL OR unit_id IS NOT NULL OR contact_id IS NOT NULL OR reservation_id IS NOT NULL`. Agregar índices `idx_documents_contact` e `idx_documents_reservation`. |
| **Motivo** | Decisión 5: documents debe soportar asociación con property, unit, contact, reservation |
| **Impacto** | Habilita los endpoints `/contacts/:id/documents` y `/reservations/:id/documents` ya definidos en la API spec pero sin soporte en DB |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 9**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Reemplazar función `auth_branch_id() → UUID` por `auth_workspace_ids() → UUID[]`. La nueva función lee el claim JWT `app_metadata.workspace_ids` (array). Retorna NULL si el array es null o vacío (semántica: acceso a todos los workspaces). |
| **Motivo** | Decisiones 1 y 3: JWT cambia de `branch_id: UUID` a `workspace_ids: UUID[]` |
| **Impacto** | Todas las políticas RLS que usaban `auth_branch_id()` deben actualizar al nuevo patrón `= ANY(auth_workspace_ids())` |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 10**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Actualizar `custom_access_token_hook`: (a) para tenant_users con `role = 'receptionist'`, consultar `user_workspace_assignments` y popular `workspace_ids: UUID[]` en `app_metadata`; (b) si no hay asignaciones o el rol es `owner`, popular `workspace_ids: null`. Eliminar `branch_id` del JWT. |
| **Motivo** | Decisiones 1, 3: JWT ahora tiene `workspace_ids` en lugar de `branch_id` |
| **Impacto** | El hook es la fuente de verdad del JWT. Sin este cambio, `auth_workspace_ids()` siempre retorna NULL y las políticas de workspace no funcionan. |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 11**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Mover función `auth_impersonating_tenant_id()` desde `11-rls-policies.sql` al schema v3. Esta función pertenece a la capa de schema, no solo a las policies. Agregar GRANT EXECUTE a `authenticated`. |
| **Motivo** | Decisión 4: impersonación via DB query. La función es usada también en `audit_table_change()`, por lo que debe estar en el schema. |
| **Impacto** | La función `auth_impersonating_tenant_id()` debe declararse ANTES del trigger `audit_table_change()` en el schema. |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 12**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Actualizar `audit_table_change()`: reemplazar `v_impersonated := public.auth_impersonated_by()` (lee JWT) por una consulta a `impersonation_sessions`. Eliminar función `auth_impersonated_by()` (obsoleta). |
| **Motivo** | Decisión 4: el JWT ya no tiene claim `impersonated_by`. La fuente de verdad es `impersonation_sessions`. |
| **Impacto** | Los registros de audit durante impersonación ahora reflejan correctamente al SA que ejecutó la acción |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 13**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Actualizar todos los triggers y nombres de funciones relacionados con branches: `trg_branches_updated_at` → `trg_workspaces_updated_at`; eliminar `trg_tenant_users_branch_consistency` y función `check_user_branch_consistency()`; agregar trigger `trg_user_workspace_assignments_consistency` con función `check_workspace_assignment_consistency()`. |
| **Motivo** | Decisiones 1, 3 |
| **Impacto** | Los triggers de consistencia son la defensa final contra datos multi-tenant incorrectos |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 14**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Actualizar GRANTS: reemplazar `public.branches` → `public.workspaces` en el GRANT a `authenticated`. Agregar GRANT SELECT, INSERT, DELETE ON `public.user_workspace_assignments` TO authenticated. Actualizar `ALTER TABLE ENABLE ROW LEVEL SECURITY` para incluir `workspaces` y `user_workspace_assignments`. |
| **Motivo** | Decisiones 1, 3 |
| **Impacto** | Sin estos GRANTs, las consultas de authenticated a `workspaces` retornan error de permisos |
| **Prioridad** | BLOQUEANTE |

---

### Documento: `11-rls-policies.sql`

---

**Cambio 15**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Eliminar definición de `auth_impersonating_tenant_id()` de este archivo (se mueve al schema v3). Eliminar GRANT EXECUTE correspondiente. Actualizar el ARCHITECTURE comment al inicio del archivo para reflejar nuevos claims (`workspace_ids` en lugar de `branch_id`). |
| **Motivo** | Decisión 4, reorganización de schema |
| **Impacto** | Evita duplicación de definición de función |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 16**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Reemplazar todas las políticas de `branches` por políticas equivalentes de `workspaces`. Los nombres de políticas cambian (`*_branches` → `*_workspaces`). El acceso del Owner y SA sigue el mismo patrón. El Receptionist puede hacer SELECT. |
| **Motivo** | Decisión 1 |
| **Impacto** | Sin las políticas de `workspaces`, el Owner no puede gestionar workspaces |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 17**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Agregar políticas para `user_workspace_assignments`: Owner (full CRUD para su tenant), SA-impersonación (SELECT), Receptionist (SELECT de sus propias asignaciones: `WHERE user_id = auth.uid()`). |
| **Motivo** | Decisión 3: nueva tabla requiere nuevas políticas |
| **Impacto** | Sin estas políticas, la asignación de workspaces a receptionists no funciona |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 18**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Actualizar todas las políticas de `properties`, `conversations`, `tasks`, `notes`, `reservations` donde el Receptionist tiene filtro de workspace: reemplazar el patrón `auth_branch_id() IS NULL OR branch_id IS NULL OR branch_id = auth_branch_id()` por `auth_workspace_ids() IS NULL OR workspace_id IS NULL OR workspace_id = ANY(auth_workspace_ids())`. |
| **Motivo** | Decisiones 1, 3: nuevo patrón multi-workspace |
| **Impacto** | Los receptionistas multi-workspace ven datos de todos sus workspaces asignados correctamente |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 19**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Actualizar política de confirmación de reservas: agregar receptionist a la política `receptionist_update_reservations` para incluir transiciones de estado `pre_reserved → confirmed` y `confirmed/pre_reserved → cancelled`. |
| **Motivo** | Decisión 6: Receptionist y Owner pueden confirmar y cancelar reservas |
| **Impacto** | Sin este cambio, solo el Owner puede confirmar reservas |
| **Prioridad** | BLOQUEANTE |

---

### Documento: `12-api-spec.md`

---

**Cambio 20**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Renombrar todos los endpoints `/branches/*` a `/workspaces/*`. Agregar campo `type: workspace_type` (enum: `general`, `physical_branch`, `zone`, `team`) en body de POST y PATCH, y en respuesta de GET. |
| **Motivo** | Decisión 1 |
| **Impacto** | Todos los clientes frontend que llaman a `/branches` deben actualizar a `/workspaces` |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 21**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Actualizar respuesta de `GET /auth/me`: reemplazar `branch_id: UUID \| null` por `workspace_ids: UUID[] \| null`. Actualizar request body de `POST /users` e `PATCH /users/:id`: reemplazar `branch_id` por `workspace_ids: UUID[]`. |
| **Motivo** | Decisión 3: JWT y API reflejan el modelo multi-workspace |
| **Impacto** | El onboarding de receptionists debe enviar array de workspace IDs |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 22**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Agregar dos endpoints nuevos: `GET /users/:id/workspaces` (lista workspaces asignados al usuario) y `PUT /users/:id/workspaces` (reemplaza todas las asignaciones, body: `{ workspace_ids: UUID[] }`). Roles: Owner. |
| **Motivo** | Decisión 3: gestión de asignaciones de workspace para receptionists |
| **Impacto** | Permite al Owner administrar qué workspaces ve cada receptionist |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 23**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Actualizar `POST /reservations/:id/confirm` y `POST /reservations/:id/cancel`: cambiar roles de `[owner]` a `[owner, receptionist]`. |
| **Motivo** | Decisión 6: receptionist puede confirmar y cancelar reservas |
| **Impacto** | Receptionist puede completar el flujo de reservas sin escalar al owner |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 24**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Eliminar referencias a Resend en: `POST /platform/tenants` (welcome email) y `POST /users` (invitation email). Reemplazar por nota: "Supabase Auth maneja emails de invitación nativamente vía `inviteUserByEmail()`. No se requiere integración con Resend en MVP." |
| **Motivo** | Decisión 8: email de notificaciones postergado a post-MVP v1.1. Invitaciones manejadas por Supabase Auth. |
| **Impacto** | Simplifica el onboarding de nuevos tenants |
| **Prioridad** | ALTO |

---

### Documento: `08-permissions-and-rls.md`

---

**Cambio 25**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Reescribir completamente Sección 4.2 "Diseño de la Impersonación". Eliminar el flujo de JWT re-emitido con `user_type: "tenant_user"`. Reemplazar por el modelo correcto: SA mantiene su JWT original, acceso a datos del tenant via `auth_impersonating_tenant_id()` que consulta `impersonation_sessions`. Incluir el flujo correcto en 6 pasos. |
| **Motivo** | Decisión 4: fuente de verdad es `impersonation_sessions`, NO JWT re-emitido |
| **Impacto** | El documento `08` es la referencia de diseño de seguridad. Tener el modelo incorrecto documentado genera confusión durante implementación. |
| **Prioridad** | BLOQUEANTE |

---

**Cambio 26**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Actualizar Sección 3 (tabla de permisos por rol): en la fila de Receptionist, agregar "Confirmar reserva ✓" y "Cancelar reserva ✓". Aclarar "IA nunca confirma definitivamente (solo crea pre_reserved)". |
| **Motivo** | Decisión 6 |
| **Impacto** | Claridad en el modelo de permisos |
| **Prioridad** | ALTO |

---

**Cambio 27**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Actualizar toda referencia a `branch_id` en el documento: reemplazar por `workspace_ids` (array). Actualizar la sección de claims JWT. Agregar sección explicativa del modelo multi-workspace y el patrón `= ANY(auth_workspace_ids())`. |
| **Motivo** | Decisiones 1, 3 |
| **Impacto** | Consistencia del documento de diseño de seguridad |
| **Prioridad** | ALTO |

---

### Documento: `09-ai-architecture.md`

---

**Cambio 28**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Sección 6.1: actualizar "Máximo **3 rondas**" → "Máximo **5 rondas**". Actualizar el diagrama del pipeline interno: "AI calls tools (0-3 rounds)" → "AI calls tools (0-5 rounds)". |
| **Motivo** | Decisión 7: límite oficial de tool calling es 5 rondas |
| **Impacto** | El worker debe implementar `MAX_TOOL_ROUNDS = 5` como constante |
| **Prioridad** | ALTO |

---

**Cambio 29**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Sección 10: corregir `conversations.source = 'website'` → `conversations.source = 'website_button'` (el valor correcto del enum `conversation_source` definido en el schema). Corregir el header del pipeline: "Webhook Handler (Edge Function)" → "Webhook Handler (Next.js Route Handler)". |
| **Motivo** | Inconsistencia de valor de enum con el schema. El webhook es un Route Handler en `apps/web`, no una Edge Function. |
| **Impacto** | El worker que parsea el source del mensaje usa este valor |
| **Prioridad** | MEDIO |

---

### Documento: `07-database-v2.md`

---

**Cambio 30**

| Campo | Valor |
|---|---|
| **Cambio requerido** | Actualizar tabla `branches` → `workspaces` con el nuevo campo `type`. Documentar tabla `user_workspace_assignments`. Actualizar tabla `tenant_users` (remover `branch_id`). Actualizar tabla `documents` (agregar `contact_id`, `reservation_id`). Actualizar descripciones de todos los campos con `branch_id` → `workspace_id`. |
| **Motivo** | Decisiones 1, 3, 5 |
| **Impacto** | Este documento es la referencia de modelo de datos para el equipo |
| **Prioridad** | ALTO |

---

## Resumen de cambios por prioridad

| Prioridad | Cantidad | Archivos afectados |
|---|---|---|
| BLOQUEANTE | 19 | 10-schema, 11-rls, 12-api-spec, 08-permissions |
| ALTO | 7 | 08-permissions, 09-ai, 07-database |
| MEDIO | 4 | 09-ai, otros |

**Total de cambios registrados:** 30

---

## Archivos generados como reemplazo

Los cambios BLOQUEANTE en `10-supabase-schema-v2.sql` y `11-rls-policies.sql` no se aplican como patches — se reemplazan completamente por archivos nuevos:

| Archivo viejo | Archivo nuevo |
|---|---|
| `10-supabase-schema-v2.sql` | `16-supabase-schema-v3.sql` |
| `11-rls-policies.sql` | `17-rls-policies-v2.sql` |

Los archivos de documentación (`07`, `08`, `09`, `12`) requieren edición inline. Se documenta en este archivo cuáles son los cambios exactos.

---

## Architecture v1.0 Frozen

Todos los cambios listados en este documento son actualizaciones de documentación y schema. Ninguno requiere cambio de diseño o nueva funcionalidad.

Una vez que los archivos `16-supabase-schema-v3.sql` y `17-rls-policies-v2.sql` están generados y los documentos BLOQUEANTE actualizados, la arquitectura está completa y el desarrollo puede comenzar.

**No quedan blockers de diseño.**
