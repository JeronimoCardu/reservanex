# OrderFlow — Architecture Final Audit

**Versión:** 1.0  
**Fecha:** 2026-06-22  
**Auditor:** Principal Software Architect  
**Scope:** Todos los documentos de diseño (01 → 14)  
**Estado:** Pre-desarrollo — auditoría antes de escribir código

---

## Executive Summary

Se auditaron 14 documentos de diseño y 3 archivos SQL que cubren visión, MVP, roles, flujos, base de datos, RLS, arquitectura de IA, APIs, estructura de proyecto y roadmap.

**La arquitectura central es sólida.** El modelo multi-tenant con shared schema + RLS, el pipeline asíncrono WhatsApp → queue → worker → IA, el modelo de impersonación auditada, y el diseño de las 7 herramientas de IA son decisiones correctas y bien razonadas.

Se identificaron **17 hallazgos** distribuidos en 4 niveles de severidad:

| Severidad | Cantidad | Impacto |
|---|---|---|
| CRÍTICO | 2 | Bloquean implementación correcta |
| ALTO | 5 | Conflictos de comportamiento o funcionalidades sin soporte |
| MEDIO | 5 | Inconsistencias que generan deuda técnica |
| BAJO | 5 | Documentación desactualizada o ambigüedades menores |

**Veredicto: B — Minor Adjustments Required**

Los ajustes requeridos son específicos y quirúrgicos. No requieren rediseñar la arquitectura. La mayor parte son addenda al schema SQL + decisiones de negocio pendientes + actualización de un documento desactualizado.

---

## 1. Functional Consistency Review

Se verificaron los 12 flujos de negocio definidos en `04-flujos.md` contra API, DB, permisos y roadmap.

### Flujos con soporte completo ✓

| Flujo | APIs | DB | RLS | Roadmap |
|---|---|---|---|---|
| F1 — Consulta desde web | `GET /public/properties` | properties, units, availability_blocks | anon SELECT published | Fase 6 |
| F2 — Consulta directa WhatsApp | webhook + worker | message_queue, messages | service_role | Fase 3 |
| F3 — Recomendación de propiedades | `search_properties` tool | properties, units, availability_blocks | service_role en worker | Fase 4 |
| F4 — Consulta de disponibilidad | `check_availability` tool | availability_blocks | service_role en worker | Fase 4 |
| F5 — Pre-Reserva | `create_pre_reservation` tool | reservations, availability_blocks | service_role en worker | Fase 5 |
| F6 — Confirmación de reserva | `POST /reservations/:id/confirm` | reservations, availability_blocks | owner (ver A-03) | Fase 5 |
| F7 — Cancelación | `POST /reservations/:id/cancel` | reservations, availability_blocks | owner + receptionist | Fase 5 |
| F8 — Escalamiento humano | `escalate_to_human` tool | conversations, notifications, notes | service_role | Fase 4 |
| F9 — Creación de cliente por Vendedor | `POST /platform/tenants` | tenants, tenant_users | super_admin | Fase 7 |
| F10 — Publicación de propiedad | `POST /properties/:id/publish` | properties, property_images, units | owner + receptionist | Fase 2 |
| F11 — Gestión de tareas | `POST /tasks`, `PATCH /tasks/:id` | tasks | owner + receptionist | Fase 5 |
| F12 — Notificaciones | notifications table + realtime | notifications | owner + receptionist | Fase 5 |

**Todos los 12 flujos tienen soporte lógico completo.**

### Hallazgo funcional: F6 tiene conflicto de permisos

`03-roles.md` lista "Confirmar reservas" como permiso del Recepcionista. `12-api-spec.md` marca `POST /reservations/:id/confirm` como owner-only. **Ver A-03.**

### Flujo adicional no documentado en 04-flujos.md: Web Chat

La Fase 6 introduce un flujo completo web → chat anónimo → IA que no está en `04-flujos.md`. Funcionalidad soportada en API spec (endpoints `/public/chat/start` y `/public/chat/:id/message`) pero el web chat session token no tiene mecanismo de invalidación. **Ver M-04.**

---

## 2. Data Consistency Review

Se verificó que todas las tablas tienen uso real y que no existen endpoints que dependan de columnas inexistentes.

### Tablas y sus consumidores

| Tabla | API endpoints | Worker | Triggers | RLS | Estado |
|---|---|---|---|---|---|
| `platform_users` | `/platform/users`, `/auth/me` | — | `trg_check_user_profile_exclusivity` | `sa_all_platform_users`, `platform_user_self` | ✓ |
| `tenants` | `/platform/tenants`, `/tenant` | — | `trg_audit_*` | `sa_all_tenants`, `owner_select_own_tenant` | ✓ |
| `seller_clients` | `/platform/seller-clients` | — | — | `sa_all_seller_clients`, `seller_select_own_clients` | ✓ |
| `branches` | `/branches` | — | — | `sa_imp_all_branches`, `owner_all_branches`, `receptionist_select_branches` | ✓ |
| `tenant_users` | `/users`, `/auth/me` | — | `trg_tenant_users_branch_consistency` | `sa_imp_all_tenant_users`, `owner_all_tenant_users`, `receptionist_select_tenant_users` | ✓ |
| `impersonation_sessions` | `/impersonation/*` | — | — | `sa_all_impersonation_sessions` | ✓ |
| `properties` | `/properties/*` | `search_properties` tool | `trg_cascade_soft_delete_units`, `trg_audit_*` | todas las políticas | ✓ |
| `property_images` | `/properties/:id/images` | `search_properties` (image_url) | — | `sa_imp_*`, `owner_all_*`, `receptionist_select/insert/update` | ✓ |
| `units` | `/properties/:id/units`, `/units/:id` | `search_properties`, `check_availability`, `create_pre_reservation` | `trg_units_tenant_consistency` | todas | ✓ |
| `unit_images` | `/units/:id/images` | — | — | mismas que units | ✓ |
| `contacts` | `/contacts` | UPSERT en inbound | — | `sa_imp_*`, `owner_all_*`, `receptionist_select/insert/update` | ✓ |
| `conversations` | `/conversations/*` | CREATE en inbound | `trg_set_conversation_closed_at` | todas | ✓ |
| `messages` | `/conversations/:id/messages` | INSERT customer + AI | — | SELECT authenticated, INSERT authenticated + service_role | ✓ |
| `reservations` | `/reservations/*` | `create_pre_reservation` | `trg_clear_expires_at` | todas | ✓ |
| `availability_blocks` | `/availability/*` | `check_availability`, `create_pre_reservation` | `trg_availability_block_tenant_consistency` | todas + anon SELECT | ✓ |
| `documents` | `/contacts/:id/documents`, `/reservations/:id/documents` | — | — | `sa_imp_*`, `owner_all_*`, `receptionist_select/insert/update` | ⚠️ **C-02** |
| `tasks` | `/tasks/*` | `create_task` tool | `trg_tasks_completed_at` | todas | ✓ |
| `notes` | `/contacts/:id/notes`, `/reservations/:id/notes` | `escalate_to_human` | — | todas | ✓ |
| `notifications` | `/notifications/*` | `escalate_to_human` (INSERT) | — | `owner_all_*`, `receptionist_select_own` | ✓ |
| `whatsapp_accounts` | `/whatsapp-accounts/*` | usa access_token_encrypted | — | `sa_imp_*`, `owner_all_*` | ✓ |
| `ai_settings` | `/ai-settings/*` | lee configuración | — | `sa_imp_*`, `owner_all_*` | ✓ |
| `message_queue` | webhook inserta | worker consume | `trg_message_queue_notify` | ninguna para authenticated | ✓ |
| `ai_usage_log` | `GET /dashboard/ai-usage` (lectura) | INSERT post-AI call | — | `sa_select_all`, `owner_select_own` | ✓ |
| `audit_logs` | `GET /audit-logs` | — | `trg_audit_table_change` | `sa_select_all`, `owner_select_own_tenant` | ✓ |

### Tabla sin soporte completo de datos

**`documents`** — Los endpoints de API la consumen vía `contact_id` y `reservation_id` que NO existen en la tabla. **Ver C-02.**

### Relaciones verificadas

- `units.tenant_id = properties.tenant_id` → enforced por `trg_units_tenant_consistency` ✓
- `availability_blocks.tenant_id = units.tenant_id` → enforced por `trg_availability_block_tenant_consistency` ✓
- `tenant_users.branch_id` → pertenece al mismo tenant → enforced por `trg_tenant_users_branch_consistency` ✓
- `reservations.expires_at IS NOT NULL` cuando `status = 'pre_reserved'` → enforced por CHECK ✓
- `messages.sender_id IS NOT NULL` cuando `sender_type = 'human'` → enforced por CHECK ✓
- `tasks.completed_at IS NOT NULL` cuando `status = 'completed'` → enforced por trigger ✓
- `notes` debe referenciar al menos 1 entidad → enforced por CHECK ✓

---

## 3. API Consistency Review

Se verificaron los 95 endpoints del `12-api-spec.md` contra soporte de datos, permisos y consumidores reales.

### Endpoints sin soporte de datos

| Endpoint | Problema | Referencia |
|---|---|---|
| `GET /contacts/:id/documents` | `documents` no tiene `contact_id` FK | C-02 |
| `POST /contacts/:id/documents` | Igual | C-02 |
| `GET /reservations/:id/documents` | `documents` no tiene `reservation_id` FK | C-02 |
| `POST /reservations/:id/documents` | Igual | C-02 |

### Endpoints sin consumidor real identificado

| Endpoint | Observación |
|---|---|
| `GET /dashboard/ai-usage` | Consumidor: owner. Soportado por `ai_usage_log`. ✓ |
| `POST /ai-settings/test` | Consumidor: owner. Requiere llamada a Anthropic API — sin entrada en roadmap de forma explícita |

### Endpoints con conflicto de permisos

| Endpoint | API Spec | 03-roles.md | Decisión requerida |
|---|---|---|---|
| `POST /reservations/:id/confirm` | owner only | receptionist puede confirmar | A-03 |

### Endpoints cuyo consumidor es el Worker (verificados)

`POST /internal/ai/process`, `POST /internal/ai/tools/execute`, `GET /internal/worker/health` — soportados por la arquitectura del worker. ✓

### Endpoints cuyo consumidor es Meta (verificados)

`GET /webhooks/whatsapp`, `POST /webhooks/whatsapp` — soportados. Respuesta 200 siempre a Meta; validación HMAC interna. ✓

### Conclusión

95 endpoints: **91 completamente soportados**, **4 sin soporte de datos** (todos relacionados a `documents`).

---

## 4. AI Consistency Review

### Herramientas definidas vs implementación prevista

| Herramienta | Definida en 09-ai-architecture.md | SQL necesario | Endpoint relacionado | Estado |
|---|---|---|---|---|
| `search_properties` | ✓ (query completa documentada) | `units JOIN properties` + GIN index | ninguno (directo a DB) | ✓ |
| `check_availability` | ✓ | `availability_blocks` daterange query | ninguno (directo a DB) | ✓ |
| `get_property_details` | ✓ | `properties JOIN units JOIN property_images` | ninguno (directo a DB) | ✓ |
| `create_pre_reservation` | ✓ (lógica de transacción documentada) | `reservations + availability_blocks` en transacción | ninguno (directo a DB) | ✓ |
| `get_contact_history` | ✓ | `contacts JOIN reservations JOIN conversations` | ninguno (directo a DB) | ✓ |
| `create_task` | ✓ | `tasks INSERT` | ninguno (directo a DB) | ✓ |
| `escalate_to_human` | ✓ (lógica completa documentada) | `conversations UPDATE + notifications INSERT + notes INSERT` | ninguno (directo a DB) | ✓ |

**Las 7 herramientas tienen acceso a datos necesarios y lógica documentada.**

### Brechas detectadas

**B-01 (ALTO): Límite de rondas de tool calling inconsistente**

| Documento | Límite |
|---|---|
| `09-ai-architecture.md` | Máximo **3 rondas** por mensaje |
| `14-development-roadmap.md` | Máximo **5 iteraciones** de tool_use |

Conflicto directo. El worker necesita una constante definida. **Ver A-04.**

**B-02 (MEDIO): `payment_instructions` en output de `create_pre_reservation` sin fuente de datos**

`09-ai-architecture.md` define que `create_pre_reservation` retorna `payment_instructions?: string`. La lógica dice "instrucciones de pago del tenant". Pero `ai_settings` no tiene un campo `payment_instructions`. El `system_prompt` libre podría contenerlas, pero el código del worker necesita saber de dónde extraerlo. **Ver M-03.**

**B-03 (MEDIO): `conversation_source` enum: 'website' vs 'website_button'**

`09-ai-architecture.md` (sección 10): `Setear conversations.source = 'website'`. El enum en schema V2 es `conversation_source ENUM ('whatsapp_direct', 'website_button', 'manual')`. El valor `'website'` no existe. El código del worker que siga el doc fallará silenciosamente o con error de enum. **Ver M-02.**

---

## 5. WhatsApp Pipeline Review

### Verificación del pipeline completo

```
[1] Meta envía webhook
    → POST /webhooks/whatsapp
    → Valida X-Hub-Signature-256
    → Identifica tenant por slug (whatsapp_accounts.phone_number → tenants.slug)
    → INSERT message_queue (status = 'pending')
    → pg_notify 'new_message_queue'
    → HTTP 200 a Meta (< 100ms)
    ✓ Soportado: webhook handler en Next.js Route Handler
    ✓ HMAC validation: webhook_secret en whatsapp_accounts
    ✓ Deduplicación: ON CONFLICT DO NOTHING en messages.whatsapp_message_id

[2] pg_notify despierta al worker
    → Worker escucha 'new_message_queue'
    → SELECT ... FOR UPDATE SKIP LOCKED (consumer.ts)
    → UPDATE status = 'processing', processing_started_at = now()
    ✓ Soportado: queue/listener.ts + queue/consumer.ts
    ✓ Fallback: polling cada 30s para items pending sin processing_started_at

[3] Worker procesa mensaje
    → Parse raw_payload (Meta format)
    → UPSERT contacts (tenant_id, phone) → ON CONFLICT DO NOTHING
    → SELECT/INSERT conversations (WHERE contact_id AND status = 'open')
    → INSERT messages (sender_type = 'customer')
    ✓ Soportado: lógica documentada en 06-architecture.md y 09-ai-architecture.md
    ✓ Transacciones correctas

[4] Worker llama a la IA
    → Build context (tenant, contact, conversation history)
    → Call Anthropic API (claude-sonnet-4-6)
    → Tool call loop (MAX X rondas — ver A-04)
    → Execute whitelisted tools contra DB (service_role)
    ✓ Soportado: packages/ai, apps/worker/src/ai/
    ✓ Whitelist enforced en tools/index.ts

[5] Worker envía respuesta
    → INSERT messages (sender_type = 'ai')
    → POST Meta Cloud API (send message)
    → INSERT ai_usage_log
    → UPDATE message_queue SET status = 'completed'
    ✓ Soportado

[6] CRM se actualiza en tiempo real
    → Supabase Realtime subscription en conversations + messages
    → Dashboard del recepcionista recibe push update
    ✓ Soportado: Supabase Realtime con filtro por tenant_id
```

**El pipeline es completo. No hay pasos faltantes.**

### Hallazgo en pipeline: no hay canal 'web' para web chat

El web chat widget usa el mismo worker para procesamiento. Los mensajes del web chat se insertan en `message_queue` con un mecanismo diferente (via API, no webhook Meta). Pero `conversations.channel` solo tiene `'whatsapp'` y `'manual'`. Las conversaciones web no tienen clasificación propia. **Ver A-02.**

---

## 6. Multi-Tenant Security Review

### Tenant isolation por tabla

| Tabla | tenant_id presente | RLS activo | Política de isolación | Estado |
|---|---|---|---|---|
| `tenants` | es la raíz | ✓ | `id = auth_tenant_id()` | ✓ |
| `platform_users` | no aplica | ✓ | solo platform_users pueden ver | ✓ |
| `seller_clients` | `tenant_id` | ✓ | SA o seller asignado | ✓ |
| `branches` | `tenant_id` | ✓ | `tenant_id = auth_tenant_id()` | ✓ |
| `tenant_users` | `tenant_id` | ✓ | `tenant_id = auth_tenant_id()` | ✓ |
| `impersonation_sessions` | `target_tenant_id` | ✓ | SA only, no tenant puede leer | ✓ |
| `properties` | `tenant_id` | ✓ | `tenant_id = auth_tenant_id()` + branch | ✓ |
| `property_images` | via property | ✓ | via `EXISTS (SELECT 1 FROM properties)` | ✓ |
| `units` | `tenant_id` | ✓ | `tenant_id = auth_tenant_id()` | ✓ |
| `unit_images` | via unit | ✓ | via `EXISTS (SELECT 1 FROM units)` | ✓ |
| `contacts` | `tenant_id` | ✓ | `tenant_id = auth_tenant_id()` | ✓ |
| `conversations` | `tenant_id` | ✓ | `tenant_id = auth_tenant_id()` + branch | ✓ |
| `messages` | `tenant_id` (desnorm.) | ✓ | `tenant_id = auth_tenant_id()` | ✓ |
| `reservations` | `tenant_id` | ✓ | `tenant_id = auth_tenant_id()` | ✓ |
| `availability_blocks` | `tenant_id` (desnorm.) | ✓ | `tenant_id = auth_tenant_id()` | ✓ |
| `documents` | `tenant_id` | ✓ | `tenant_id = auth_tenant_id()` | ✓ |
| `tasks` | `tenant_id` | ✓ | `tenant_id = auth_tenant_id()` | ✓ |
| `notes` | `tenant_id` | ✓ | `tenant_id = auth_tenant_id()` | ✓ |
| `notifications` | `tenant_id` | ✓ | owner all / receptionist own | ✓ |
| `whatsapp_accounts` | `tenant_id` | ✓ | owner only | ✓ |
| `ai_settings` | `tenant_id` | ✓ | owner only | ✓ |
| `message_queue` | `tenant_id` | ✓ | zero policies para authenticated | ✓ |
| `ai_usage_log` | `tenant_id` | ✓ | SA global / owner own | ✓ |
| `audit_logs` | `tenant_id` | ✓ | append-only, no DELETE | ✓ |

**No se detectaron posibles fugas cross-tenant a nivel de RLS.**

### Modelo de impersonación — CONFLICTO CRÍTICO

**Ver C-01 para descripción completa.** La forma en que `audit_logs.impersonated_by` se popula bajo el modelo de `11-rls-policies.sql` no está completamente definida. El schema V2 tiene la columna pero `audit_table_change()` necesita leer de `impersonation_sessions` para determinar si la operación es bajo impersonación (ya que el JWT no tiene `impersonated_by` en el modelo DB-query). Verificar función `audit_table_change()` en schema V2.

### Scope del Seller

- Seller solo ve tenants en `seller_clients WHERE seller_id = uid() AND active = true`
- Seller NO tiene políticas en tablas de tenant → aislamiento por omisión ✓
- Seller puede crear tenants → asigna el nuevo tenant a su `seller_clients` → correcto ✓

### Scope del Owner

- Acceso completo a su `tenant_id` en todas las tablas de negocio ✓
- No puede ver otros tenants ✓
- Puede ver `audit_logs` de su tenant (incluyendo impersonaciones del SA) ✓

### Scope del Receptionist

- `branch_id` en JWT filtra properties, conversations, messages por sucursal ✓
- No tiene acceso a `audit_logs` ✓
- No tiene acceso a `ai_settings` ni `whatsapp_accounts` ✓
- No puede eliminar contacts ✓
- Confirmar reserva: pendiente de resolución (A-03)

### Acceso anónimo

- `tenants_public` VIEW solo expone campos no sensibles ✓
- `properties`: solo publicadas + no eliminadas ✓
- `units`: solo activas, de propiedades publicadas ✓
- `availability_blocks`: filtrado por unit activa de property publicada ✓
- Ninguna tabla sensible (contacts, conversations, messages, reservations) es accesible para anon ✓

---

## 7. Roadmap Review

### Verificación de dependencias entre fases

| Fase | Depende de | Dependencia resuelta |
|---|---|---|
| F0 — Infraestructura | nada | ✓ |
| F1 — Auth | F0 (DB + Auth Hook) | ✓ |
| F2 — CRM Core | F1 (Auth) | ✓ |
| F3 — WhatsApp Inbound | F2 (contacts, conversations) | ✓ |
| F4 — AI Pipeline | F3 (worker base, messages) | ✓ |
| F5 — Reservas | F2 (properties/units) + F4 (AI puede crear pre-reservas) | ✓ |
| F6 — Sitio Público | F2 (properties) + F3 (worker procesa web chat) | ✓ |
| F7 — Platform Admin | F0–F6 (datos existentes para dashboard) | ✓ |
| F8 — Calidad | F0–F7 | ✓ |

**El orden de implementación es correcto. Ninguna fase depende de trabajo futuro no resuelto.**

### Riesgos de roadmap identificados

| Riesgo | Fase | Severidad | Estado en roadmap |
|---|---|---|---|
| Meta WhatsApp approval tarda días | F3 | ALTO | Mencionado, mitigado (iniciar en paralelo) |
| pg_notify no llega si worker cae | F3 | ALTO | Mitigado (polling fallback) |
| Loop infinito de tool calls | F4 | ALTO | Mitigado con límite (pero límite en conflicto — A-04) |
| Costo de tokens Anthropic | F4 | MEDIO | Mitigado con ai_usage_log |
| EXCLUDE constraint causa error críptico | F5 | MEDIO | Mencionado, mitigado |
| Worker necesita Always-on (no serverless) | F0 | ALTO | Documentado en 13-project-structure.md |

### Dependencia externa crítica no en roadmap

**Email via Resend** se menciona en `02-mvp.md` y `12-api-spec.md` pero no tiene una fase de implementación definida en `14-development-roadmap.md`. Si email es parte del MVP, debe agregarse a la Fase 5 (junto con notificaciones). **Ver A-05.**

---

## 8. Production Risks

---

### CRÍTICO — C-01

**Conflicto de modelo técnico de impersonación entre 08-permissions-and-rls.md y 11-rls-policies.sql**

**Descripción:**

`08-permissions-and-rls.md` (sección 4.2) documenta que la impersonación re-emite un JWT con `user_type: 'tenant_user'`, `tenant_id: target-uuid`, `role: 'owner'`, e `impersonated_by: sa-uuid` en `app_metadata`. Este JWT permite al Super Admin operar como si fuera el owner del tenant.

`11-rls-policies.sql` implementa un modelo completamente diferente: el SA mantiene su JWT original (`user_type: 'platform_user'`) y las políticas para tenant data usan `auth_impersonating_tenant_id()` que consulta `impersonation_sessions` en tiempo real. No hay re-emisión de JWT.

Estos dos modelos son técnicamente incompatibles:

| Aspecto | 08-permissions-and-rls.md | 11-rls-policies.sql |
|---|---|---|
| JWT del SA durante impersonación | Nuevo JWT como tenant_user | JWT original como platform_user |
| `impersonated_by` en JWT | Sí, en app_metadata | No existe |
| Cómo RLS valida acceso | Políticas de tenant_user | `auth_impersonating_tenant_id()` |
| `audit_logs.impersonated_by` | Leído del JWT | Indefinido (el JWT no lo tiene) |

**Impacto:** Un desarrollador que lea `08-permissions-and-rls.md` implementará re-emisión de JWT. Otro que lea `11-rls-policies.sql` implementará el modelo DB-query. Ambos no funcionarán juntos. La auditoría en `audit_logs.impersonated_by` quedará vacía con el modelo correcto (DB-query).

**Solución recomendada:** 
1. Actualizar `08-permissions-and-rls.md` para reflejar el modelo DB-query de `11-rls-policies.sql` (este es el modelo correcto — más seguro, sin JWT re-issuance).
2. Agregar en `audit_table_change()` del schema: leer `auth_impersonating_tenant_id()` para detectar si la operación es bajo impersonación y populer `audit_logs.impersonated_by` con `auth.uid()` cuando sea el caso.

---

### CRÍTICO — C-02

**`documents` table no tiene `contact_id` ni `reservation_id`: 4 endpoints de API sin soporte de datos**

**Descripción:**

La tabla `documents` en `10-supabase-schema-v2.sql` tiene la siguiente estructura:
```sql
id, tenant_id, property_id, unit_id, name, file_url, document_type, created_at
```

Pero `12-api-spec.md` define estos 4 endpoints:
- `GET /contacts/:id/documents`
- `POST /contacts/:id/documents`
- `GET /reservations/:id/documents`
- `POST /reservations/:id/documents`

Para implementar estos endpoints, se necesita poder filtrar documentos por `contact_id` y `reservation_id`. Ninguno de estos campos existe en la tabla actual. Un JOIN indirecto (contact → reservation → unit → documents) es posible para lectura, pero no para `POST /contacts/:id/documents` que crearía un documento vinculado a un contacto (no a una propiedad/unidad).

**Impacto:** Los 4 endpoints no pueden implementarse como están especificados. El desarrollador deberá inventar una solución no especificada o modificar el schema sin documentación de respaldo.

**Solución recomendada:** Agregar columns a `documents`:

```sql
ALTER TABLE public.documents
  ADD COLUMN contact_id     UUID REFERENCES public.contacts(id),
  ADD COLUMN reservation_id UUID REFERENCES public.reservations(id);

-- Actualizar constraint: al menos un anchor
ALTER TABLE public.documents
  DROP CONSTRAINT documents_must_have_entity;

ALTER TABLE public.documents
  ADD CONSTRAINT documents_must_have_entity CHECK (
    property_id IS NOT NULL OR
    unit_id IS NOT NULL OR
    contact_id IS NOT NULL OR
    reservation_id IS NOT NULL
  );

-- Índices
CREATE INDEX idx_documents_contact ON public.documents(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX idx_documents_reservation ON public.documents(reservation_id) WHERE reservation_id IS NOT NULL;
```

---

### ALTO — A-01

**`conversation_channel` enum no tiene valor 'web' para el web chat widget**

**Descripción:**

El enum `conversation_channel` en schema V2 solo tiene: `'whatsapp'` y `'manual'`.

La Fase 6 del roadmap y el API spec introducen el web chat widget. Las conversaciones iniciadas desde el widget web tienen un canal diferente (no son WhatsApp, no son "manual" creadas por el equipo). Sin un valor `'web'` en el enum, estas conversaciones deben clasificarse como `'manual'`, lo que:
1. Rompe el filtrado por canal en el CRM ("ver solo conversaciones de WhatsApp")
2. Confunde las métricas del dashboard (conversaciones web vs. creadas manualmente)
3. Oscurece el contexto en el que trabaja el worker (web chat y WhatsApp tienen comportamientos diferentes)

**Impacto:** El CRM no puede distinguir conversaciones web de conversaciones manuales. El dashboard de KPIs mezcla métricas.

**Solución recomendada:**
```sql
ALTER TYPE conversation_channel ADD VALUE 'web';
```

---

### ALTO — A-02

**Límite de rondas de tool calling inconsistente entre documentos**

**Descripción:**

| Documento | Límite definido |
|---|---|
| `09-ai-architecture.md` sección 6.1 | "Máximo **3 rondas** de tool calling por mensaje" |
| `14-development-roadmap.md` Fase 4 tabla de riesgos | "Limitar a máximo **5 iteraciones** de tool_use" |

El worker necesita una constante compilada. Con 3 rondas, la IA tiene: búsqueda → check disponibilidad → crear pre-reserva (que internamente también llama check_availability). Esto apenas alcanza para el flujo de reserva completo. Con 5, hay más margen pero más costo potencial.

**Impacto:** Costo de tokens, comportamiento del worker, potencial de loop.

**Solución recomendada:** Definir explícitamente como `MAX_TOOL_ROUNDS = 5` (el número del roadmap es más conservador y permite el flujo completo). Actualizar `09-ai-architecture.md`. El valor debe ser configurable como constante en `packages/ai/src/client.ts`, no hardcoded en el worker.

---

### ALTO — A-03

**Conflicto de permisos: recepcionista y confirmación de reservas**

**Descripción:**

`03-roles.md` (Recepcionista, permisos): "Confirmar reservas."

`12-api-spec.md` (`POST /reservations/:id/confirm`): Roles permitidos: **owner**.

`08-permissions-and-rls.md` (Recepcionista, tabla 7.4): "Confirmar/cancelar reservas — ✓ — Validación en capa de aplicación."

Tres documentos con dos respuestas distintas. La confirmación de reserva implica compromisos financieros. La decisión de si el recepcionista puede confirmar es de negocio, no técnica.

**Impacto:** El desarrollador que implemente el endpoint no sabrá qué comportamiento es correcto.

**Solución recomendada:** Decidir el comportamiento de negocio antes de implementar:
- **Opción A (recomendada):** Receptionist puede confirmar. Actualizar API spec y RLS policy de `reservations`.
- **Opción B:** Solo owner confirma. Actualizar `03-roles.md` y `08-permissions-and-rls.md`.

---

### ALTO — A-04

**Email notifications sin ruta de implementación definida**

**Descripción:**

El MVP (`02-mvp.md`) incluye "Notificaciones: WhatsApp, Email". La tabla `notifications` tiene `channel: notification_channel NOT NULL` con valores `'whatsapp' | 'email' | 'in_app'`. La arquitectura (`06-architecture.md`) menciona Resend como proveedor. La API spec menciona Resend en dos endpoints (`POST /platform/tenants` y `POST /users`).

Sin embargo:
- No existe ningún endpoint de configuración de email en la API spec
- No existe ningún módulo de email en `13-project-structure.md`
- No existe ninguna fase de implementación de email en `14-development-roadmap.md`
- No existen variables de entorno de Resend en `.env.example`

**Impacto:** Las notificaciones de tipo 'email' se crearán en la tabla pero nunca se enviarán. El worker no tiene código para enviar emails. Los emails de bienvenida e invitación mencionados en el API spec no tienen implementación.

**Solución recomendada:** Decidir antes de iniciar:
- **Opción A:** Excluir email del MVP (actualizar `02-mvp.md` y eliminar referencias de API spec). Agregar solo como notificación `in_app` y WhatsApp.
- **Opción B:** Incluir email. Agregar módulo `apps/worker/src/email/` con Resend SDK. Agregar `RESEND_API_KEY` a variables de entorno. Agregar a Fase 5 del roadmap.

---

### ALTO — A-05

**4 endpoints de documentos sin soporte de datos (ver C-02 para detalles)**

Este hallazgo es consecuencia directa de C-02. Si C-02 se resuelve agregando `contact_id` y `reservation_id` a la tabla `documents`, este hallazgo queda automáticamente resuelto.

---

## 9. Medium and Low Risks

### MEDIO — M-01

**`payment_instructions` en output de `create_pre_reservation` sin campo en schema**

`09-ai-architecture.md` define que `create_pre_reservation` retorna `payment_instructions?: string` (instrucciones de pago para el cliente). La lógica documentada dice "del tenant". Pero `ai_settings` no tiene este campo. El `system_prompt` libre podría contenerlas, pero entonces el worker debería extraer esas instrucciones del texto libre del prompt, lo que es frágil.

**Solución:** Agregar `payment_instructions TEXT` a `ai_settings` y al endpoint `PATCH /ai-settings`.

---

### MEDIO — M-02

**`conversation_source` enum: valor 'website' en doc vs 'website_button' en schema**

`09-ai-architecture.md` (sección 10): `Setear conversations.source = 'website'`.

Schema V2 enum `conversation_source`: `('whatsapp_direct', 'website_button', 'manual')`.

El valor `'website'` no existe. El worker que intente `INSERT ... source = 'website'` recibirá un error de PostgreSQL enum en runtime.

**Solución:** Actualizar `09-ai-architecture.md` para usar `'website_button'`, que es el valor correcto del enum.

---

### MEDIO — M-03

**Seller no tiene endpoint para ver sus propias comisiones**

`03-roles.md`: "Ver comisiones." `08-permissions-and-rls.md`: "Ver comisiones propias — RLS en seller_clients WHERE seller_id = uid()."

La RLS está en `11-rls-policies.sql`: `seller_select_own_clients` política en `seller_clients`. Pero el único endpoint que expone `seller_clients` es `GET /platform/seller-clients`, que es `super_admin` only.

El seller no tiene un endpoint `GET /me/clients` ni `GET /me/commissions` para ver sus propios datos.

**Solución:** Si el Seller tiene un panel propio (no está claro en el roadmap), agregar `GET /platform/seller-clients/mine` con permisos para el rol seller. Si el Seller no tiene panel propio en MVP, documentar como post-MVP.

---

### MEDIO — M-04

**Web chat session token sin mecanismo de invalidación**

El API spec describe `POST /public/chat/start` que retorna un `session_token` (JWT corta duración con `conversation_id`). Si este token se compromete, no hay forma de invalidarlo antes de su TTL. No existe tabla de sesiones web chat.

Para MVP, esto es aceptable (el token solo da acceso a una conversación específica — scope muy limitado). Pero debe documentarse explícitamente como riesgo aceptado.

**Solución para MVP:** Documentar como RISK aceptado. Para post-MVP: agregar tabla `web_chat_sessions` con `invalidated_at`.

---

### MEDIO — M-05

**`messages_archive` tabla referenciada pero no definida**

`06-architecture.md` (sección 8.4) y `07-database-v2.md` (tabla messages) mencionan `messages_archive` como destino del archivado mensual. No existe en `10-supabase-schema-v2.sql`. El pg_cron job tampoco está definido en el schema.

Para MVP con bajo volumen, no urgente. Pero la estrategia de archivado no está lista para cuando sí sea necesaria.

**Solución:** Agregar como migración futura. Documentar que el archivado no está implementado en MVP y que hasta Mes 18 aproximado el volumen no lo requiere.

---

### BAJO — B-01

**`06-architecture.md` menciona Next.js 14; `13-project-structure.md` usa Next.js 15**

Inconsistencia menor de versión. `13-project-structure.md` es el documento más reciente y debe tomarse como fuente de verdad.

**Solución:** Actualizar `06-architecture.md` a Next.js 15.

---

### BAJO — B-02

**`06-architecture.md` menciona PostgreSQL 15; `10-supabase-schema-v2.sql` es PostgreSQL 17**

Igual que B-01. El schema SQL es la fuente de verdad.

**Solución:** Actualizar `06-architecture.md` a PostgreSQL 17.

---

### BAJO — B-03

**Helper functions en schema `auth` (08-permissions-and-rls.md) vs `public` (schema V2)**

`08-permissions-and-rls.md` define `auth.user_type()`, `auth.tenant_id()`, `auth.is_super_admin()`, etc. en el schema `auth`. El schema V2 y las políticas RLS las implementan como `public.auth_user_type()`, `public.is_super_admin()`, etc.

El schema `auth` pertenece a Supabase y no se puede extender con funciones propias. El documento original tenía el namespace incorrecto; el SQL implementa correctamente en `public`.

**Solución:** Actualizar `08-permissions-and-rls.md` para reflejar el namespace `public.*`.

---

### BAJO — B-04

**`06-architecture.md` menciona "Edge Function" para webhook handler; `13-project-structure.md` lo define como Route Handler de Next.js**

El diagrama de arquitectura muestra `Webhook Handler (Edge Function)`. La implementación real usa `apps/web/src/app/api/v1/webhooks/whatsapp/route.ts` (Route Handler de Next.js, que corre en Edge Runtime de Vercel). Son funcionalmente equivalentes pero técnicamente distintos. No hay Supabase Edge Functions en el plan de implementación.

**Solución:** Actualizar el diagrama de `06-architecture.md` a "Webhook Handler (Next.js Route Handler / Edge Runtime)".

---

### BAJO — B-05

**`ai_settings.business_hours` referenciado en `12-api-spec.md` pero no en schema**

En la sección PATCH /ai-settings del API spec se menciona `business_hours` como campo. El schema `ai_settings` no lo tiene. Si el worker necesita este campo para no responder fuera de horario, debe estar en el schema.

**Solución:** Agregar `business_hours JSONB` a `ai_settings` (estructura `{ days: [...], open: "09:00", close: "18:00", timezone: "America/Argentina/Buenos_Aires" }`) o definir como post-MVP.

---

## 9. Final Verdict

**B — Minor Adjustments Required**

### Justificación

La arquitectura central de OrderFlow es **sólida y bien razonada**:

- El modelo multi-tenant con shared schema + RLS es correcto para el volumen del MVP
- El pipeline asíncrono WhatsApp → pg_notify → worker está correctamente desacoplado
- El modelo Zero Trust de RLS (deny by default) está implementado correctamente en `11-rls-policies.sql`
- Las 7 herramientas de IA tienen datos, lógica y acceso bien definidos
- El monorepo con Turborepo y la separación apps/worker es apropiada
- El roadmap tiene orden correcto y dependencias resueltas
- El anti-double-booking via EXCLUDE USING GIST es la solución correcta

Los 2 hallazgos CRÍTICOS son **addenda específicos**, no redesigns:
- C-01 requiere actualizar 1 documento + agregar lógica a 1 función del schema
- C-02 requiere agregar 2 columnas a 1 tabla

Los 5 hallazgos ALTOS requieren **decisiones de negocio** (A-03, A-04) o **pequeñas adiciones** al schema (A-01, A-02).

**No hay problemas arquitecturales, no hay rediseño requerido.**

---

## Next Documents To Generate

Para comenzar el desarrollo, se requieren los siguientes artefactos en orden:

### Paso 1 — Correcciones previas (antes de cualquier código)

**15a — Schema Addendum SQL** (archivo nuevo o migración)
Contiene exactamente:
1. `ALTER TYPE conversation_channel ADD VALUE 'web';` (C-01/A-01)
2. Agregar `contact_id` y `reservation_id` a `documents` + nuevo CHECK + índices (C-02)
3. Agregar `payment_instructions TEXT` a `ai_settings` (M-01)
4. Agregar `business_hours JSONB` a `ai_settings` (B-05) — opcional para MVP

**15b — Decisiones de negocio a documentar** (puede ser sección en este documento)
1. ¿Recepcionista puede confirmar reservas? (A-03)
2. ¿Email está en scope del MVP? (A-04)
3. ¿Cuál es el límite de rondas de tool calling? 3 o 5 (A-02)

### Paso 2 — Documentación actualizada

Actualizar (no regenerar) los siguientes documentos con los cambios específicos:
- `08-permissions-and-rls.md` → reflejar modelo DB-query de impersonación (C-01)
- `06-architecture.md` → Next.js 15, PostgreSQL 17, Route Handler en lugar de Edge Function (B-01, B-02, B-04)
- `09-ai-architecture.md` → corregir `source = 'website_button'`, definir límite de tool rounds (M-02, A-02)

### Paso 3 — Artefactos de desarrollo (comenzar aquí si pasos 1 y 2 están resueltos)

**16 — Environment Variables Reference**
Lista completa de todas las variables con: nombre, descripción, ejemplo, si es pública o secreta, qué app la usa. Incluir `RESEND_API_KEY` si email está en scope.

**17 — Database Seed Script** (`supabase/seed/dev_seed.sql`)
Datos de desarrollo reales: 1 super_admin, 2 tenants, 1 owner por tenant, 1 receptionist, 3 properties con units e imágenes, 1 whatsapp_account con datos de test, 1 ai_settings por tenant.

**18 — API Route Implementation Template**
Un Route Handler de referencia que muestra el patrón correcto: auth validation → JWT claims extraction → Zod validation → Supabase query → response format. Sirve para que todos los endpoints sean consistentes.

**19 — Worker Implementation Guide**
Arquitectura interna del worker: cómo arranca, cómo consume la queue, cómo construye el contexto de IA, cómo despacha tools. Define el contrato entre `packages/ai` y `apps/worker/src/tools/`.

### Prioridad de implementación post-ajustes

```
1. Resolver las 3 decisiones de negocio (15b)
2. Aplicar schema addendum (15a) → re-ejecutar supabase gen types
3. Generar 16 (env vars) — unblocks todo el setup inicial
4. Generar 17 (seed) — unblocks testing en F0-F1
5. Iniciar Fase 0 del roadmap (infraestructura)
```
