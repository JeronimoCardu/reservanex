# OrderFlow — Modelo de Datos V2

**Versión:** 2.0
**Fecha:** 2026-06-22
**Reemplaza:** 05-base-de-datos.md

---

## Principios del Diseño

1. **tenant_id en toda entidad comercial** — ninguna tabla de negocio queda sin aislamiento
2. **Soft delete selectivo** — solo donde el historial tiene valor legal o comercial
3. **updated_at universal** — toda entidad mutable lo tiene; habilita cache invalidation y webhooks futuros
4. **Separación de plataforma y tenant** — usuarios de OrderFlow vs usuarios de cada inmobiliaria
5. **Índices definidos desde el inicio** — no como afterthought de producción

---

## Cambios Críticos Respecto a V1

| Cambio | Motivo |
|---|---|
| `users` → `platform_users` + `tenant_users` | Super Admin y Vendedor son de plataforma, no de tenant |
| `property_attributes` (EAV) → `attributes JSONB` | EAV sin tipo no es indexable eficientemente para búsqueda IA |
| `availability_blocks` + `tenant_id` | RLS sin JOINs; índice compuesto eficiente |
| `reservations` + `expires_at`, `conversation_id`, `currency` | TTL de pre-reserva, trazabilidad CRM, multi-país |
| `contacts.notes` eliminado | Duplicado con tabla `notes` |
| `property_images` nueva tabla | MVP mencionaba galería de propiedades; solo existían imágenes de unidades |
| `notifications` rediseñado | Sin status ni destinatario era inoperable para reintentos |
| `audit_logs` + `old_value`, `new_value` | Audit trail real requiere antes/después |
| `tasks` + `created_by`, `completed_at` | Reportes operativos y trazabilidad |
| `whatsapp_accounts` + `branch_id` | Soporte multi-número por sucursal (preparación) |
| `message_queue` nueva tabla | Pipeline asíncrono WhatsApp |

---

## Enumeraciones (ENUM types)

```
platform_role:      super_admin | seller
tenant_role:        owner | receptionist
tenant_status:      active | trial | suspended | churned
plan_tier:          starter | pro
conversation_status: open | waiting | closed
conversation_channel: whatsapp | manual
ai_mode:            auto | human | disabled
message_sender:     customer | ai | human
reservation_status: inquiry | interested | pre_reserved | pending_payment | confirmed | cancelled
block_reason:       reservation | maintenance | manual
document_type:      contract | regulation | policy | manual
task_status:        pending | in_progress | completed | cancelled
notification_type:  new_conversation | new_reservation | ai_escalation | reservation_confirmed | reservation_cancelled | payment_received
notification_channel: whatsapp | email | in_app
notification_status: pending | sent | failed
queue_status:       pending | processing | completed | failed
audit_user_type:    platform_user | tenant_user
contact_source:     whatsapp | website | manual
```

---

## Tablas

---

### platform_users

Usuarios internos de OrderFlow: Super Admin y Vendedor.

**Decisión de diseño:** Separados de `tenant_users` porque no pertenecen a ningún tenant. Tener `tenant_id = NULL` en una tabla compartida con usuarios de tenant crea ambigüedad peligrosa en las políticas RLS.

```
platform_users
──────────────────────────────────────────────────────
id              UUID PRIMARY KEY  -- mismo UUID que auth.users
name            TEXT NOT NULL
email           TEXT UNIQUE NOT NULL
role            platform_role NOT NULL  -- super_admin | seller
active          BOOLEAN NOT NULL DEFAULT true
created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Notas:**
- `id` es el mismo UUID que `auth.users.id` (no es FK explícita porque `auth.users` está en schema separado)
- Un trigger en `auth.users` garantiza que un usuario existe en `platform_users` XOR `tenant_users`
- No tiene `deleted_at` — la desactivación se hace con `active = false`

**Índices:**
```
idx_platform_users_email    ON platform_users(email)
idx_platform_users_role     ON platform_users(role) WHERE active = true
```

---

### tenant_users

Usuarios de cada inmobiliaria: Dueño y Recepcionista.

```
tenant_users
──────────────────────────────────────────────────────
id              UUID PRIMARY KEY  -- mismo UUID que auth.users
tenant_id       UUID NOT NULL REFERENCES tenants(id)
branch_id       UUID REFERENCES branches(id)  -- NULL = acceso a todas las sucursales
name            TEXT NOT NULL
email           TEXT NOT NULL
role            tenant_role NOT NULL  -- owner | receptionist
active          BOOLEAN NOT NULL DEFAULT true
created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()

UNIQUE(tenant_id, email)
```

**Notas:**
- `branch_id` define el scope de un Recepcionista; si es NULL, ve todas las sucursales (comportamiento de Dueño)
- El Dueño siempre tiene `branch_id = NULL`
- No tiene `deleted_at` — se desactiva con `active = false`

**Índices:**
```
idx_tenant_users_tenant_id      ON tenant_users(tenant_id)
idx_tenant_users_tenant_role    ON tenant_users(tenant_id, role) WHERE active = true
idx_tenant_users_branch         ON tenant_users(branch_id) WHERE branch_id IS NOT NULL
```

---

### tenants

Representa una inmobiliaria / empresa cliente de OrderFlow.

```
tenants
──────────────────────────────────────────────────────
id                  UUID PRIMARY KEY DEFAULT gen_random_uuid()
name                TEXT NOT NULL
slug                TEXT UNIQUE NOT NULL  -- subdominio: {slug}.orderflow.app
status              tenant_status NOT NULL DEFAULT 'trial'
plan                plan_tier NOT NULL DEFAULT 'starter'
trial_ends_at       TIMESTAMPTZ
max_properties      INT NOT NULL DEFAULT 10
max_users           INT NOT NULL DEFAULT 5
logo_url            TEXT
primary_color       CHAR(7)  -- hex: #RRGGBB
secondary_color     CHAR(7)
site_config         JSONB NOT NULL DEFAULT '{}'
  -- estructura esperada:
  -- { template: string, hero_title: string, hero_subtitle: string,
  --   about_text: string, seo_title: string, seo_description: string,
  --   font: string, show_prices: boolean, contact_email: string }
custom_domain       TEXT UNIQUE  -- dominio propio del tenant (opcional)
created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
deleted_at          TIMESTAMPTZ
```

**Notas:**
- `deleted_at` se usa cuando un cliente se da de baja; sus datos se retienen por 90 días
- `max_properties` y `max_users` se usan para enforcement del plan (CHECK en INSERT de properties/users)
- `site_config` usa JSONB para flexibilidad; el schema exacto se valida en la capa de aplicación

**Índices:**
```
idx_tenants_slug          ON tenants(slug) WHERE deleted_at IS NULL
idx_tenants_status        ON tenants(status) WHERE deleted_at IS NULL
idx_tenants_custom_domain ON tenants(custom_domain) WHERE custom_domain IS NOT NULL
```

---

### branches

Sucursales de una inmobiliaria.

```
branches
──────────────────────────────────────────────────────
id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
tenant_id   UUID NOT NULL REFERENCES tenants(id)
name        TEXT NOT NULL
address     TEXT
city        TEXT
phone       TEXT
email       TEXT
active      BOOLEAN NOT NULL DEFAULT true
created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Índices:**
```
idx_branches_tenant_id    ON branches(tenant_id) WHERE active = true
```

---

### properties

Complejos, edificios o propiedades que agrupan unidades.

**Cambio crítico:** `property_attributes` (tabla EAV separada) se reemplaza por `attributes JSONB` con índice GIN. Esto permite queries eficientes de la IA como "propiedades con pileta y cochera" usando operadores JSONB nativos de PostgreSQL.

```
properties
──────────────────────────────────────────────────────
id               UUID PRIMARY KEY DEFAULT gen_random_uuid()
tenant_id        UUID NOT NULL REFERENCES tenants(id)
branch_id        UUID REFERENCES branches(id)
title            TEXT NOT NULL
description      TEXT
city             TEXT
neighborhood     TEXT
address          TEXT
google_maps_url  TEXT
attributes       JSONB NOT NULL DEFAULT '{}'
  -- estructura esperada (ejemplos):
  -- { pileta: true, cochera: true, mascotas: false, wifi: true,
  --   parrilla: true, tipo: "cabaña", capacidad_max: 8 }
published        BOOLEAN NOT NULL DEFAULT false
created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
deleted_at       TIMESTAMPTZ
```

**Por qué JSONB en lugar de EAV:**
- El patrón EAV (`name`, `value` en filas separadas) no tiene tipado: ¿"true" es boolean o string?
- Sin tipo, no se pueden crear índices selectivos
- La IA necesita queries como: `attributes @> '{"pileta": true, "cochera": true}'`
- Con GIN index sobre JSONB, esa query usa índice; con EAV es full scan

**Índices:**
```
idx_properties_tenant_published   ON properties(tenant_id, published) WHERE deleted_at IS NULL
idx_properties_branch             ON properties(branch_id) WHERE deleted_at IS NULL
idx_properties_attributes         USING GIN ON properties(attributes)  -- búsqueda IA
```

---

### property_images

**Nueva tabla.** El MVP mencionaba "Galería de imágenes" en propiedades, pero V1 solo tenía `unit_images`. Las propiedades necesitan portada, galería, banner.

```
property_images
──────────────────────────────────────────────────────
id           UUID PRIMARY KEY DEFAULT gen_random_uuid()
property_id  UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE
image_url    TEXT NOT NULL
sort_order   INT NOT NULL DEFAULT 0
is_cover     BOOLEAN NOT NULL DEFAULT false  -- imagen principal
created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Índices:**
```
idx_property_images_property    ON property_images(property_id, sort_order)
```

---

### units

Unidades individuales reservables dentro de una propiedad.

```
units
──────────────────────────────────────────────────────
id           UUID PRIMARY KEY DEFAULT gen_random_uuid()
tenant_id    UUID NOT NULL REFERENCES tenants(id)  -- para RLS eficiente
property_id  UUID NOT NULL REFERENCES properties(id)
name         TEXT NOT NULL
capacity     INT NOT NULL CHECK (capacity > 0)
price        NUMERIC(10, 2)
currency     CHAR(3) NOT NULL DEFAULT 'ARS'
active       BOOLEAN NOT NULL DEFAULT true
created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
deleted_at   TIMESTAMPTZ
```

**Notas:**
- `tenant_id` duplicado desde `properties.tenant_id` para evitar JOINs en RLS de unidades
- `currency` a nivel de unidad (puede variar entre unidades del mismo complejo)

**Índices:**
```
idx_units_property_id   ON units(property_id) WHERE deleted_at IS NULL AND active = true
idx_units_tenant_id     ON units(tenant_id) WHERE deleted_at IS NULL
```

---

### unit_images

```
unit_images
──────────────────────────────────────────────────────
id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
unit_id     UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE
image_url   TEXT NOT NULL
sort_order  INT NOT NULL DEFAULT 0
is_cover    BOOLEAN NOT NULL DEFAULT false
created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Índices:**
```
idx_unit_images_unit    ON unit_images(unit_id, sort_order)
```

---

### contacts

Clientes externos que interactúan con la inmobiliaria.

**Cambios:**
- Se elimina `notes TEXT` (duplicado con tabla `notes`)
- Se agrega `source` (origen del contacto)
- Se agrega `UNIQUE(tenant_id, phone)` con índice parcial para deduplicación por WhatsApp

```
contacts
──────────────────────────────────────────────────────
id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
tenant_id   UUID NOT NULL REFERENCES tenants(id)
name        TEXT
phone       TEXT
email       TEXT
source      contact_source NOT NULL DEFAULT 'manual'  -- whatsapp | website | manual
created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
deleted_at  TIMESTAMPTZ

UNIQUE (tenant_id, phone) -- aplicado via índice parcial con WHERE deleted_at IS NULL
```

**Por qué UNIQUE en phone por tenant:**
WhatsApp usa el número de teléfono como identificador. Sin esta constraint, el mismo cliente que escribe dos veces crea dos registros de contacto, fragmentando su historial en el CRM.

**Índices:**
```
idx_contacts_tenant_phone     ON contacts(tenant_id, phone) WHERE deleted_at IS NULL AND phone IS NOT NULL
idx_contacts_tenant_created   ON contacts(tenant_id, created_at DESC) WHERE deleted_at IS NULL
idx_contacts_tenant_email     ON contacts(tenant_id, email) WHERE deleted_at IS NULL AND email IS NOT NULL
```

---

### conversations

Hilo de comunicación con un contacto.

**Cambios:**
- `branch_id` agregado (¿por cuál sucursal llegó el contacto?)
- `ai_mode` reemplaza `ai_enabled` (boolean) por un enum más granular
- `whatsapp_thread_id` para tracking del hilo en Meta
- `closed_at` para métricas de resolución

```
conversations
──────────────────────────────────────────────────────
id                UUID PRIMARY KEY DEFAULT gen_random_uuid()
tenant_id         UUID NOT NULL REFERENCES tenants(id)
contact_id        UUID NOT NULL REFERENCES contacts(id)
branch_id         UUID REFERENCES branches(id)
assigned_user_id  UUID REFERENCES tenant_users(id)
status            conversation_status NOT NULL DEFAULT 'open'  -- open | waiting | closed
channel           conversation_channel NOT NULL DEFAULT 'whatsapp'
ai_mode           ai_mode NOT NULL DEFAULT 'auto'  -- auto | human | disabled
whatsapp_thread_id TEXT  -- identificador del hilo en Meta (para continuidad)
created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
closed_at         TIMESTAMPTZ
```

**Constraint implícita:**
`assigned_user_id` debe pertenecer al mismo `tenant_id` que la conversación. Esto se enforcea en la capa de aplicación y mediante una FK check function, NO con un simple FK (que no puede cruzar columnas).

**Índices:**
```
idx_conversations_tenant_status     ON conversations(tenant_id, status, created_at DESC)
idx_conversations_contact           ON conversations(contact_id, created_at DESC)
idx_conversations_assigned          ON conversations(assigned_user_id, status) WHERE assigned_user_id IS NOT NULL
idx_conversations_tenant_updated    ON conversations(tenant_id, updated_at DESC)
```

---

### messages

Mensajes individuales de una conversación.

**Cambios:**
- `tenant_id` agregado para RLS eficiente sin JOIN
- `sender_id` agregado (quién del equipo respondió)
- `whatsapp_message_id` para deduplicación de webhooks
- `content_type` para soporte futuro de imágenes/audio (MVP solo text)
- Sin `updated_at` — los mensajes son inmutables

```
messages
──────────────────────────────────────────────────────
id                    UUID PRIMARY KEY DEFAULT gen_random_uuid()
tenant_id             UUID NOT NULL REFERENCES tenants(id)  -- desnormalizado para RLS
conversation_id       UUID NOT NULL REFERENCES conversations(id)
sender_type           message_sender NOT NULL  -- customer | ai | human
sender_id             UUID REFERENCES tenant_users(id)  -- solo cuando sender_type = 'human'
content               TEXT NOT NULL
content_type          TEXT NOT NULL DEFAULT 'text'  -- text | image | document | audio
metadata              JSONB  -- datos adicionales del mensaje (ej: nombre de archivo)
whatsapp_message_id   TEXT UNIQUE  -- para deduplicación de webhooks Meta
created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Notas:**
- El UNIQUE en `whatsapp_message_id` permite `ON CONFLICT DO NOTHING` para deduplicación
- `tenant_id` desnormalizado evita el JOIN `messages → conversations` en cada policy RLS

**Índices:**
```
idx_messages_conversation_created   ON messages(conversation_id, created_at DESC)
idx_messages_tenant_created         ON messages(tenant_id, created_at DESC)
idx_messages_whatsapp_id            ON messages(whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL
```

**Archivado:**
Mensajes con `created_at < now() - interval '12 months'` se mueven a `messages_archive` mensualmente.

---

### reservations

Reservas de unidades.

**Cambios críticos:**
- `expires_at` — TTL para pre-reservas (Flujo 5 bloqueaba fechas indefinidamente)
- `conversation_id` — link al origen de la reserva en el CRM
- `currency` — multi-país
- `deleted_at` — soft delete

```
reservations
──────────────────────────────────────────────────────
id               UUID PRIMARY KEY DEFAULT gen_random_uuid()
tenant_id        UUID NOT NULL REFERENCES tenants(id)
contact_id       UUID NOT NULL REFERENCES contacts(id)
unit_id          UUID NOT NULL REFERENCES units(id)
conversation_id  UUID REFERENCES conversations(id)  -- origen de la reserva
start_date       DATE NOT NULL
end_date         DATE NOT NULL
guests           INT NOT NULL CHECK (guests > 0)
total_amount     NUMERIC(10, 2)
currency         CHAR(3) NOT NULL DEFAULT 'ARS'
status           reservation_status NOT NULL DEFAULT 'inquiry'
expires_at       TIMESTAMPTZ
  -- se setea cuando status = 'pre_reserved'
  -- default: now() + interval '48 hours' (configurable por tenant)
  -- el worker de limpieza libera availability_blocks cuando expires_at < now()
notes            TEXT  -- notas internas de la reserva
created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
deleted_at       TIMESTAMPTZ

CHECK (end_date > start_date)
```

**Ciclo de vida de expires_at:**
```
status = 'pre_reserved'  → expires_at = now() + 48h  (configurable)
status = 'confirmed'     → expires_at = NULL  (ya no expira)
status = 'cancelled'     → el availability_block se elimina
expires_at < now()       → job limpieza → status = 'cancelled', libera bloqueo
```

**Índices:**
```
idx_reservations_tenant_status      ON reservations(tenant_id, status, start_date)
idx_reservations_unit_status        ON reservations(unit_id, status, start_date)
idx_reservations_contact            ON reservations(contact_id, created_at DESC)
idx_reservations_expires            ON reservations(status, expires_at) WHERE status = 'pre_reserved'
idx_reservations_conversation       ON reservations(conversation_id) WHERE conversation_id IS NOT NULL
```

---

### availability_blocks

Bloqueos de calendario de unidades.

**Cambio crítico:** `tenant_id` agregado para RLS directa y para el índice de búsqueda de disponibilidad más eficiente.

```
availability_blocks
──────────────────────────────────────────────────────
id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
tenant_id       UUID NOT NULL REFERENCES tenants(id)  -- NUEVO: RLS sin JOIN
unit_id         UUID NOT NULL REFERENCES units(id)
reservation_id  UUID REFERENCES reservations(id)  -- NULL si es bloqueo manual/mantenimiento
start_date      DATE NOT NULL
end_date        DATE NOT NULL
reason          block_reason NOT NULL  -- reservation | maintenance | manual
created_by      UUID REFERENCES tenant_users(id)  -- quién lo creó
created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()

CHECK (end_date > start_date)
CHECK (
  (reason = 'reservation' AND reservation_id IS NOT NULL) OR
  (reason != 'reservation')
)
```

**Por qué CHECK en reservation_id:**
Si el motivo es `reservation`, la FK a `reservations` debe estar presente. Sin este constraint, pueden quedar bloqueos huérfanos que bloquean fechas sin reserva asociada.

**Índices:**
```
idx_availability_unit_dates     ON availability_blocks(unit_id, start_date, end_date)
idx_availability_tenant_dates   ON availability_blocks(tenant_id, start_date)
idx_availability_reservation    ON availability_blocks(reservation_id) WHERE reservation_id IS NOT NULL
```

**Query de verificación de disponibilidad:**
```sql
SELECT EXISTS (
  SELECT 1 FROM availability_blocks
  WHERE unit_id = $unit_id
    AND start_date < $end_date
    AND end_date > $start_date
) AS is_blocked;
```

---

### documents

Documentos de negocio asociados a propiedades o unidades.

**Cambio:** `unit_id` agregado para documentos específicos de unidad (reglamentos, contratos por cabaña).

```
documents
──────────────────────────────────────────────────────
id             UUID PRIMARY KEY DEFAULT gen_random_uuid()
tenant_id      UUID NOT NULL REFERENCES tenants(id)
property_id    UUID REFERENCES properties(id)
unit_id        UUID REFERENCES units(id)  -- NUEVO: para docs de unidad específica
name           TEXT NOT NULL
file_url       TEXT NOT NULL
document_type  document_type NOT NULL  -- contract | regulation | policy | manual
created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Índices:**
```
idx_documents_property    ON documents(property_id) WHERE property_id IS NOT NULL
idx_documents_unit        ON documents(unit_id) WHERE unit_id IS NOT NULL
idx_documents_tenant      ON documents(tenant_id)
```

---

### tasks

Tareas operativas del equipo.

**Cambios:**
- `created_by` agregado (trazabilidad)
- `completed_at` agregado (reportes de tiempo de resolución)
- `conversation_id` agregado (tarea generada desde conversación IA)

```
tasks
──────────────────────────────────────────────────────
id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
tenant_id       UUID NOT NULL REFERENCES tenants(id)
created_by      UUID NOT NULL REFERENCES tenant_users(id)  -- NUEVO
assigned_to     UUID REFERENCES tenant_users(id)
contact_id      UUID REFERENCES contacts(id)
reservation_id  UUID REFERENCES reservations(id)
conversation_id UUID REFERENCES conversations(id)  -- NUEVO: origen en conversación
title           TEXT NOT NULL
description     TEXT
due_date        TIMESTAMPTZ
status          task_status NOT NULL DEFAULT 'pending'
completed_at    TIMESTAMPTZ  -- NUEVO: se setea cuando status = 'completed'
created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Índices:**
```
idx_tasks_tenant_assigned   ON tasks(tenant_id, assigned_to, status)
idx_tasks_tenant_due        ON tasks(tenant_id, due_date, status) WHERE status != 'completed'
idx_tasks_contact           ON tasks(contact_id) WHERE contact_id IS NOT NULL
idx_tasks_reservation       ON tasks(reservation_id) WHERE reservation_id IS NOT NULL
```

---

### notes

Notas internas del equipo sobre contactos, reservas o conversaciones.

**Cambio:** Se elimina `contacts.notes` (campo de texto en la tabla `contacts`). Todas las notas van aquí. Se agrega `conversation_id` como FK opcional.

```
notes
──────────────────────────────────────────────────────
id              UUID PRIMARY KEY DEFAULT gen_random_uuid()
tenant_id       UUID NOT NULL REFERENCES tenants(id)
created_by      UUID NOT NULL REFERENCES tenant_users(id)
contact_id      UUID REFERENCES contacts(id)
reservation_id  UUID REFERENCES reservations(id)
conversation_id UUID REFERENCES conversations(id)  -- NUEVO
content         TEXT NOT NULL
created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Índices:**
```
idx_notes_contact       ON notes(contact_id, created_at DESC) WHERE contact_id IS NOT NULL
idx_notes_reservation   ON notes(reservation_id, created_at DESC) WHERE reservation_id IS NOT NULL
idx_notes_conversation  ON notes(conversation_id) WHERE conversation_id IS NOT NULL
```

---

### notifications

**Rediseño completo.** El diseño original no tenía estado, no tenía destinatario explícito, no permitía reintentos.

```
notifications
──────────────────────────────────────────────────────
id               UUID PRIMARY KEY DEFAULT gen_random_uuid()
tenant_id        UUID NOT NULL REFERENCES tenants(id)
type             notification_type NOT NULL
channel          notification_channel NOT NULL  -- whatsapp | email | in_app
recipient_type   TEXT NOT NULL CHECK (recipient_type IN ('user', 'contact'))
recipient_id     UUID NOT NULL  -- tenant_users.id o contacts.id según recipient_type
payload          JSONB NOT NULL  -- datos del evento (flexible)
status           notification_status NOT NULL DEFAULT 'pending'
error_message    TEXT  -- mensaje de error si status = 'failed'
attempts         INT NOT NULL DEFAULT 0
sent_at          TIMESTAMPTZ
created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Índices:**
```
idx_notifications_status_created   ON notifications(status, created_at) WHERE status = 'pending'
idx_notifications_tenant           ON notifications(tenant_id, created_at DESC)
idx_notifications_recipient        ON notifications(recipient_id, created_at DESC)
```

**Retención:** Notificaciones con `created_at < now() - interval '3 months'` se eliminan físicamente.

---

### whatsapp_accounts

Configuración de números WhatsApp por tenant.

**Cambios:**
- `branch_id` agregado (soporte multi-número por sucursal)
- `token_expires_at` para tracking de rotación de tokens
- `last_verified_at` para health checks
- UNIQUE en `(tenant_id, phone_number)`

```
whatsapp_accounts
──────────────────────────────────────────────────────
id                      UUID PRIMARY KEY DEFAULT gen_random_uuid()
tenant_id               UUID NOT NULL REFERENCES tenants(id)
branch_id               UUID REFERENCES branches(id)  -- NUEVO: número por sucursal
phone_number            TEXT NOT NULL
business_account_id     TEXT NOT NULL
access_token_encrypted  TEXT NOT NULL  -- AES-256-GCM, key en vault
webhook_secret          TEXT NOT NULL  -- para verificar firma de Meta
token_expires_at        TIMESTAMPTZ  -- NUEVO: para rotación
last_verified_at        TIMESTAMPTZ  -- NUEVO: health check
active                  BOOLEAN NOT NULL DEFAULT true
created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()

UNIQUE(tenant_id, phone_number)
```

**Nota de seguridad:** `access_token_encrypted` se cifra con AES-256-GCM a nivel de aplicación antes de guardar. La clave de cifrado se almacena en Supabase Vault (no en la tabla). Nunca se guarda el token en texto plano.

---

### ai_settings

Configuración del asistente IA por tenant.

**Cambio:** `escalation_rules` (campo genérico) reemplazado por campos específicos y estructurados.

```
ai_settings
──────────────────────────────────────────────────────
id                          UUID PRIMARY KEY DEFAULT gen_random_uuid()
tenant_id                   UUID NOT NULL UNIQUE REFERENCES tenants(id)
model                       TEXT NOT NULL DEFAULT 'claude-sonnet-4-6'
system_prompt               TEXT  -- personalidad base del asistente
assistant_name              TEXT NOT NULL DEFAULT 'Asistente'  -- nombre del bot
escalation_keywords         TEXT[]  -- palabras que disparan escalamiento inmediato
max_turns_before_escalation INT NOT NULL DEFAULT 20
response_delay_ms           INT NOT NULL DEFAULT 1500  -- simula typing humano
max_context_messages        INT NOT NULL DEFAULT 10  -- mensajes previos que ve la IA
active                      BOOLEAN NOT NULL DEFAULT true
created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
```

---

### seller_clients

Relación entre Vendedor (plataforma) y Tenants asignados.

```
seller_clients
──────────────────────────────────────────────────────
id                      UUID PRIMARY KEY DEFAULT gen_random_uuid()
seller_id               UUID NOT NULL REFERENCES platform_users(id)
tenant_id               UUID NOT NULL REFERENCES tenants(id)
commission_percentage   NUMERIC(5, 2) CHECK (commission_percentage >= 0 AND commission_percentage <= 100)
active                  BOOLEAN NOT NULL DEFAULT true
created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()

UNIQUE(seller_id, tenant_id)
```

---

### message_queue

Cola de mensajes para el pipeline asíncrono de WhatsApp.

**Nueva tabla.** Reemplaza Redis como mecanismo de queue para MVP, usando PostgreSQL LISTEN/NOTIFY.

```
message_queue
──────────────────────────────────────────────────────
id                    UUID PRIMARY KEY DEFAULT gen_random_uuid()
tenant_id             UUID NOT NULL REFERENCES tenants(id)
whatsapp_account_id   UUID REFERENCES whatsapp_accounts(id)
raw_payload           JSONB NOT NULL  -- payload original de Meta
status                queue_status NOT NULL DEFAULT 'pending'
attempts              INT NOT NULL DEFAULT 0
last_error            TEXT
scheduled_at          TIMESTAMPTZ NOT NULL DEFAULT now()  -- para retry con backoff
processed_at          TIMESTAMPTZ
created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Índices:**
```
idx_message_queue_status    ON message_queue(status, scheduled_at) WHERE status IN ('pending', 'processing')
idx_message_queue_tenant    ON message_queue(tenant_id, created_at DESC)
```

**Retención:** Registros con `status IN ('completed', 'failed')` y `created_at < now() - interval '7 days'` se eliminan físicamente.

---

### impersonation_sessions

Registro de sesiones de impersonación del Super Admin.

**Nueva tabla.** Auditoría de acceso cross-tenant por personal interno.

```
impersonation_sessions
──────────────────────────────────────────────────────
id                UUID PRIMARY KEY DEFAULT gen_random_uuid()
platform_user_id  UUID NOT NULL REFERENCES platform_users(id)
target_tenant_id  UUID NOT NULL REFERENCES tenants(id)
reason            TEXT NOT NULL  -- por qué se está impersonando
started_at        TIMESTAMPTZ NOT NULL DEFAULT now()
ended_at          TIMESTAMPTZ
ip_address        INET
```

---

### audit_logs

Registro de cambios importantes en el sistema.

**Cambios:**
- `old_value JSONB` y `new_value JSONB` agregados
- `user_type` para distinguir acción de platform_user vs tenant_user
- `impersonated_by` para rastrear acciones bajo impersonación
- `ip_address` para seguridad

```
audit_logs
──────────────────────────────────────────────────────
id              BIGSERIAL PRIMARY KEY  -- BIGINT para mejor performance en escrituras secuenciales
tenant_id       UUID REFERENCES tenants(id)  -- NULL para acciones de plataforma
user_id         UUID NOT NULL  -- platform_users.id o tenant_users.id
user_type       audit_user_type NOT NULL  -- platform_user | tenant_user
impersonated_by UUID REFERENCES platform_users(id)  -- si fue acción bajo impersonación
action          TEXT NOT NULL  -- ej: 'reservation.confirmed', 'user.created'
entity_type     TEXT NOT NULL  -- ej: 'reservation', 'property', 'user'
entity_id       UUID
old_value       JSONB  -- estado anterior (campos modificados)
new_value       JSONB  -- estado posterior
ip_address      INET
created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Notas:**
- Tabla append-only; sin UPDATE ni DELETE
- BIGSERIAL en lugar de UUID para mejor performance en inserciones secuenciales masivas
- `old_value` y `new_value` contienen solo los campos modificados, no el objeto completo

**Índices:**
```
idx_audit_logs_tenant_created     ON audit_logs(tenant_id, created_at DESC) WHERE tenant_id IS NOT NULL
idx_audit_logs_entity             ON audit_logs(entity_type, entity_id, created_at DESC)
idx_audit_logs_user               ON audit_logs(user_id, created_at DESC)
```

**Retención:** Después de 24 meses, exportar a Supabase Storage y eliminar físicamente.

---

## Soft Delete — Resumen

| Tabla | ¿Soft Delete? | Razón |
|---|---|---|
| `tenants` | ✓ `deleted_at` | Retención 90 días por legal |
| `tenant_users` | ✗ `active = false` | No hay valor en historial de usuario eliminado |
| `properties` | ✓ `deleted_at` | Las reservas históricas la referencian |
| `units` | ✓ `deleted_at` | Las reservas históricas la referencian |
| `contacts` | ✓ `deleted_at` | Historial CRM completo |
| `reservations` | ✓ `deleted_at` | Registro histórico obligatorio |
| `conversations` | ✗ (solo `closed_at`) | El close es el fin del ciclo, no una eliminación |
| `messages` | ✗ (archivado por fecha) | Volumen alto; se archiva, no se elimina |
| `audit_logs` | ✗ (export + delete) | Inmutable por diseño |
| `availability_blocks` | ✗ (delete físico) | Se elimina cuando la reserva se cancela |
| `notifications` | ✗ (delete físico) | Retención corta (3 meses) |
| `message_queue` | ✗ (delete físico) | Retención corta (7 días) |

---

## Resumen de Índices Críticos

```sql
-- === AVAILABILITY (más crítico) ===
CREATE INDEX idx_availability_unit_dates
  ON availability_blocks(unit_id, start_date, end_date);

CREATE INDEX idx_availability_tenant_dates
  ON availability_blocks(tenant_id, start_date);

-- === MESSAGES (mayor volumen) ===
CREATE INDEX idx_messages_conversation_created
  ON messages(conversation_id, created_at DESC);

CREATE INDEX idx_messages_whatsapp_id
  ON messages(whatsapp_message_id)
  WHERE whatsapp_message_id IS NOT NULL;

-- === CONVERSATIONS (inbox en tiempo real) ===
CREATE INDEX idx_conversations_tenant_status
  ON conversations(tenant_id, status, created_at DESC);

CREATE INDEX idx_conversations_assigned
  ON conversations(assigned_user_id, status)
  WHERE assigned_user_id IS NOT NULL;

-- === RESERVATIONS ===
CREATE INDEX idx_reservations_expires
  ON reservations(status, expires_at)
  WHERE status = 'pre_reserved';

CREATE INDEX idx_reservations_tenant_status
  ON reservations(tenant_id, status, start_date);

-- === PROPERTIES (búsqueda IA) ===
CREATE INDEX idx_properties_attributes
  ON properties USING GIN(attributes);

CREATE INDEX idx_properties_tenant_published
  ON properties(tenant_id, published)
  WHERE deleted_at IS NULL;

-- === CONTACTS (deduplicación WhatsApp) ===
CREATE UNIQUE INDEX idx_contacts_tenant_phone_unique
  ON contacts(tenant_id, phone)
  WHERE phone IS NOT NULL AND deleted_at IS NULL;

-- === QUEUE ===
CREATE INDEX idx_message_queue_status
  ON message_queue(status, scheduled_at)
  WHERE status IN ('pending', 'processing');
```
