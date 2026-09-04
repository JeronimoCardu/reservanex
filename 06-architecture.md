# OrderFlow — Arquitectura del Sistema

**Versión:** 2.0
**Fecha:** 2026-06-22
**Audience:** Staff Engineers / Senior Developers

---

## 1. Visión General

OrderFlow es un SaaS multi-tenant que combina CRM, WhatsApp Business API e IA conversacional para inmobiliarias y alquileres temporarios.

La arquitectura debe satisfacer tres invariantes simultáneamente:

1. **Aislamiento estricto de datos entre tenants** — una inmobiliaria no puede ver datos de otra bajo ninguna circunstancia.
2. **Respuesta WhatsApp sub-20 segundos** — Meta cancela la sesión de usuario y reintenta si no recibe ACK rápido.
3. **Costo operativo predecible por tenant** — cada llamada a IA cuesta dinero; el sistema debe controlar ese gasto.

---

## 2. Stack Tecnológico

| Capa | Tecnología | Justificación |
|---|---|---|
| Frontend Admin | Next.js 14 (App Router) | Server Components para performance, RSC para datos |
| Frontend Público | Next.js 14 (ISR/SSG) | SEO + regeneración incremental por tenant |
| Base de Datos | PostgreSQL 15 (Supabase) | RLS nativo, realtime, storage integrado |
| Auth | Supabase Auth | JWT con custom claims para roles |
| Cola de Mensajes | PostgreSQL + pg_notify | MVP: sin Redis adicional; escala a BullMQ si necesario |
| Workers | Node.js / Bun | Procesos long-running para consumir cola |
| IA | Claude API (Anthropic) | Tool calling nativo, structured outputs |
| WhatsApp | Meta Business API (Cloud) | Hosted por Meta, no requiere servidor propio |
| Storage | Supabase Storage | Imágenes propiedades, documentos |
| Email | Resend | SDK simple, deliverability alta |

**Decisión: No Redis en MVP.**
La cola de mensajes se implementa sobre PostgreSQL usando `LISTEN/NOTIFY` + tabla `message_queue`. Esto elimina una dependencia de infraestructura. Si el volumen supera 500 mensajes/minuto, se migra a BullMQ + Redis sin cambiar la lógica de negocio.

---

## 3. Componentes del Sistema

```
┌─────────────────────────────────────────────────────────┐
│                    INTERNET                             │
└──────────┬──────────────────────┬───────────────────────┘
           │                      │
           ▼                      ▼
┌──────────────────┐   ┌──────────────────────────────────┐
│  Web Pública     │   │   Meta WhatsApp Business API      │
│  {slug}.app      │   │   (webhooks + send API)           │
│  Next.js SSG/ISR │   └──────────────┬───────────────────┘
└────────┬─────────┘                  │ webhook POST
         │                            ▼
         │                 ┌──────────────────────┐
         │                 │  Webhook Handler      │
         │                 │  (Edge Function)      │
         │                 │  1. Valida firma      │
         │                 │  2. ACK 200 inmediato │
         │                 │  3. Inserta en cola   │
         │                 └──────────┬────────────┘
         │                            │
         ▼                            ▼
┌──────────────────┐      ┌──────────────────────────────┐
│  Dashboard Admin │      │  message_queue (PostgreSQL)   │
│  Next.js App     │      │  status: pending              │
│  Router          │      └──────────────┬───────────────┘
└────────┬─────────┘                     │ LISTEN/NOTIFY
         │                               ▼
         │                  ┌────────────────────────────┐
         │                  │  Message Worker (Node.js)  │
         │                  │  1. Fetch contact          │
         │                  │  2. Fetch/create conv      │
         │                  │  3. Build AI context       │
         │                  │  4. Call AI with tools     │
         │                  │  5. Execute tool calls     │
         │                  │  6. Send WhatsApp response │
         │                  └────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────┐
│                   Supabase                           │
│  PostgreSQL  │  Auth  │  Storage  │  Realtime       │
│  + RLS       │  JWT   │  S3-like  │  (websockets)   │
└──────────────────────────────────────────────────────┘
```

---

## 4. Pipeline WhatsApp Asíncrono

### 4.1 Por qué es obligatorio el desacoplamiento

**Problema:** Meta requiere ACK HTTP 200 en menos de 20 segundos. Una llamada a Claude puede tomar 5-15 segundos. Si además hay que buscar propiedades, verificar disponibilidad y construir la respuesta, el tiempo total puede superar el límite.

**Consecuencia sin cola:** Meta reintenta el webhook al no recibir respuesta en tiempo, generando **mensajes duplicados**. El cliente recibe la misma respuesta dos veces. En el caso de una pre-reserva, podrían crearse dos reservas.

**Riesgo adicional:** Si el procesamiento falla a mitad del camino (timeout de IA, error de red), el webhook se pierde sin posibilidad de reintento controlado.

### 4.2 Flujo detallado

```
Paso 1 — Recepción del webhook (< 100ms)
─────────────────────────────────────────
META → POST /api/webhooks/whatsapp/{tenant_slug}
       ↓
       Validar x-hub-signature-256
       ↓
       Identificar tenant por slug
       ↓
       INSERT INTO message_queue (tenant_id, raw_payload, status='pending')
       ↓
       NOTIFY message_queue_channel
       ↓
       HTTP 200 OK → META (inmediato)

Paso 2 — Procesamiento del Worker (async)
──────────────────────────────────────────
Worker LISTEN message_queue_channel
       ↓
       UPDATE message_queue SET status='processing', attempts=attempts+1
       ↓
       Parse raw_payload → extraer from, message, type
       ↓
       UPSERT contacts (tenant_id, phone) ON CONFLICT → fetch existing
       ↓
       SELECT conversations WHERE contact_id AND status='open' → open or CREATE
       ↓
       INSERT messages (sender_type='customer', content, whatsapp_message_id)
       ↓
       IF conversation.ai_enabled = true:
           → build_ai_context(conversation_id)
           → call_ai_with_tools(context)
           → execute_tool_calls(tool_calls)
           → INSERT messages (sender_type='ai', content=response)
           → send_whatsapp_message(phone, response)
       ELSE:
           → notify_assigned_user(conversation_id)
       ↓
       UPDATE message_queue SET status='completed', processed_at=now()

Paso 3 — Manejo de errores
────────────────────────────
Si falla:
  attempts < 3 → UPDATE status='pending', scheduled_at = now() + exponential_backoff
  attempts >= 3 → UPDATE status='failed', last_error = message
                → escalate_to_human(conversation_id, reason='ai_error')
                → notify_admin(tenant_id, 'message_processing_failed')
```

### 4.3 Deduplicación de webhooks

Meta puede enviar el mismo webhook más de una vez (reintentos, network issues).

**Solución:** Campo `whatsapp_message_id` en `messages` con `UNIQUE` constraint. Al intentar insertar un mensaje duplicado, la query falla silenciosamente (ON CONFLICT DO NOTHING) y el worker marca la cola como completed.

```sql
INSERT INTO messages (whatsapp_message_id, ...)
ON CONFLICT (whatsapp_message_id) DO NOTHING;
```

---

## 5. Estrategia Multi-Tenant

### 5.1 Modelo de aislamiento

Se usa **Shared Schema** con Row Level Security (RLS) de PostgreSQL.

**Por qué no Schema-per-tenant:**
- Schema-per-tenant escala mal más allá de 100 tenants (conexiones, migraciones, mantenimiento)
- RLS de Supabase es maduro y auditable
- Shared schema permite queries cross-tenant para el Super Admin

**Por qué no DB-per-tenant:**
- Costo prohibitivo en MVP
- Complejidad de despliegue innecesaria
- Se puede migrar a este modelo para enterprise tiers en el futuro

### 5.2 JWT Custom Claims

Cada usuario autenticado recibe un JWT con claims adicionales que las políticas RLS consumen directamente, evitando JOINs a tablas de perfil en cada query:

```json
// Tenant users (Dueño, Recepcionista)
{
  "sub": "auth-user-uuid",
  "user_type": "tenant_user",
  "tenant_id": "tenant-uuid",
  "role": "owner",
  "branch_id": "branch-uuid-or-null"
}

// Platform users (Super Admin, Vendedor)
{
  "sub": "auth-user-uuid",
  "user_type": "platform_user",
  "role": "super_admin"
}
```

Estos claims se setean mediante un **Auth Hook** de Supabase (`custom_access_token_hook`) que consulta las tablas de perfil al momento del login y los embebe en el JWT.

### 5.3 Routing por subdominio

Cada tenant tiene un slug único: `{slug}.orderflow.app`

El middleware de Next.js extrae el slug del hostname y lo pasa como contexto a todas las páginas y API routes del sitio público.

```
{slug}.orderflow.app          → Sitio público del tenant
app.orderflow.app             → Dashboard admin
app.orderflow.app/admin       → Panel Super Admin / Vendedor
```

---

## 6. Separación de Usuarios de Plataforma vs Tenant

### 6.1 Problema con el diseño original

El documento `05-base-de-datos.md` original tenía una única tabla `users` con `tenant_id` para todos los roles. Esto obliga a que `tenant_id` sea nullable para Super Admin y Vendedor, lo que:

- Envenena las políticas RLS (¿cómo distinguir "no tiene tenant" de "error de datos"?)
- Permite bugs silenciosos donde un Super Admin sin `tenant_id` escapa filtros
- Mezcla conceptos de plataforma y negocio en una sola abstracción

### 6.2 Solución

Dos tablas de perfil separadas, ambas referenciando `auth.users`:

```
auth.users (Supabase managed)
    ├── platform_users  → Super Admin, Vendedor
    └── tenant_users    → Dueño, Recepcionista
```

Un usuario existe en **una y solo una** de estas tablas. Un trigger en `auth.users` garantiza esto.

---

## 7. Impersonación Auditada del Super Admin

### 7.1 Problema

El Super Admin necesita acceder a cualquier tenant para soporte y administración. Si esto se implementa como "bypass de RLS", un bug en el código del Super Admin expone todos los datos.

### 7.2 Solución: Impersonación Explícita con Sesión Auditable

```
Super Admin → POST /api/admin/impersonate
             body: { tenant_id, reason }
             ↓
             Validar que caller es super_admin
             ↓
             INSERT impersonation_sessions (platform_user_id, target_tenant_id, reason, started_at)
             ↓
             Generar JWT de corta duración (30 min)
             con claims: { impersonated_by: "sa-uuid", tenant_id: "target-uuid", role: "owner" }
             ↓
             Toda operación bajo este JWT:
               - Se ejecuta con RLS del tenant objetivo
               - audit_logs.impersonated_by = "sa-uuid" se setea automáticamente
             ↓
             POST /api/admin/impersonate/end → ends session, revokes JWT
```

Esto garantiza que:
1. El Super Admin nunca bypass RLS; opera como si fuera el dueño del tenant
2. Cada acción queda registrada en `audit_logs` con `impersonated_by`
3. La sesión de impersonación expira automáticamente
4. El tenant puede ver en su audit log cuándo fue accedido y por qué

---

## 8. Estrategia de Escalabilidad

### 8.1 Crecimiento esperado MVP (primeros 12 meses)

| Métrica | MVP Launch | Mes 6 | Mes 12 |
|---|---|---|---|
| Tenants activos | 5-10 | 30-50 | 100-200 |
| Propiedades totales | 50-100 | 500-1000 | 3000-5000 |
| Mensajes/día | 200-500 | 2000-5000 | 10000-20000 |
| Reservas/mes | 20-50 | 200-500 | 1000-2000 |

### 8.2 Límites del MVP

Los siguientes no se implementan en MVP y están explícitamente excluidos:

| Item | Razón de exclusión |
|---|---|
| Particionado de tabla `messages` | No necesario hasta ~5M mensajes (~18 meses con 200 tenants) |
| Redis / BullMQ | pg_notify es suficiente hasta 500 msg/min |
| Read replicas | No necesario hasta 100+ tenants simultáneos |
| CDN para imágenes | Supabase Storage es suficiente para MVP |
| Vector DB / RAG | Tool calling con SQL es suficiente para el dominio estructurado |
| Multi-region | Innecesario hasta tener clientes en múltiples continentes |
| Rate limiting por tenant en API | Supabase RLS + max_connections es suficiente |
| Microservicios | Monolito modular es correcto para este tamaño |

### 8.3 Índices críticos (definidos desde el inicio)

Ver documento `07-database-v2.md` para la lista completa de índices con justificación por query pattern.

### 8.4 Estrategia de archivado

Tres tablas crecen sin límite: `messages`, `audit_logs`, `notifications`.

**Política de retención:**

| Tabla | Retención activa | Acción posterior |
|---|---|---|
| `messages` | 12 meses | Mover a `messages_archive` (misma estructura, sin índices) |
| `audit_logs` | 24 meses | Exportar a S3/Storage + eliminar |
| `notifications` | 3 meses | Eliminar físicamente |
| `message_queue` | 7 días (completed/failed) | Eliminar físicamente |

Implementación: `pg_cron` corriendo el primer día de cada mes.

**El archivado no afecta el CRM:** Las conversaciones y reservas no se archivan; solo los mensajes individuales. El panel muestra "historial disponible hasta 12 meses" para conversaciones antiguas.

---

## 9. Sitio Web Público por Tenant

### 9.1 Subdominios dinámicos

Cada tenant tiene un subdominio `{slug}.orderflow.app`. El sitio público se genera con Next.js usando ISR (Incremental Static Regeneration):

- La página de inicio del tenant se regenera cada 5 minutos
- La página de cada propiedad se regenera cada 5 minutos o al publicar cambios (on-demand revalidation)
- Las imágenes se sirven desde Supabase Storage via CDN

### 9.2 Botón "Consultar por WhatsApp"

El botón en cada propiedad/unidad abre WhatsApp con un mensaje pre-completado que incluye contexto estructurado:

```
https://wa.me/{tenant_phone}?text=Hola! Consulto por {property_title} - {unit_name}
[property_id:{uuid}][unit_id:{uuid}][source:website]
```

El worker detecta el patrón `[property_id:...]` en el primer mensaje del cliente e inyecta automáticamente el contexto de la propiedad en la conversación de la IA.

---

## 10. Notificaciones en Tiempo Real (Dashboard)

Supabase Realtime permite suscribir el dashboard a cambios en tablas específicas. El panel de conversaciones recibe actualizaciones en tiempo real cuando:

- Llega un nuevo mensaje a una conversación
- El estatus de una conversación cambia
- La IA escala a humano

**Implementación:** Supabase Realtime channel filtrado por `tenant_id`, usando las políticas RLS para garantizar que solo el tenant correcto recibe las notificaciones.

---

## 11. Qué NO Implementar Todavía

Estas son funcionalidades que podrían parecer necesarias pero representan sobreingeniería para el MVP:

- **Webhooks salientes** (para que tenants integren con sus propios sistemas) — post-MVP
- **API pública para tenants** — post-MVP
- **Multi-idioma** — excluido del MVP
- **Aplicación móvil** — excluido del MVP
- **Integraciones con Airbnb/Booking** — excluido del MVP
- **Dashboard financiero avanzado** — excluido del MVP
- **Firma digital** — excluido del MVP
- **IA de voz** — excluido del MVP
- **Event sourcing** — innecesario para este volumen
- **CQRS** — innecesario para este volumen
- **Elasticsearch** — los índices GIN de PostgreSQL son suficientes para búsqueda de propiedades

---

## 12. Decisiones de Arquitectura Relevantes

| Decisión | Alternativa considerada | Razón de la elección |
|---|---|---|
| Shared schema + RLS | Schema per tenant | Escala mejor en MVP; migraciones más simples |
| pg_notify como cola | Redis + BullMQ | Sin dependencia extra; migrable sin cambio de lógica |
| Tool calling para IA | RAG + embeddings | Datos estructurados → SQL es más preciso y sin alucinaciones |
| Custom JWT claims | Query a DB en RLS | RLS sin latencia adicional de JOIN |
| ISR para sitio público | SSR puro | Balance entre frescura de datos y performance |
| Soft delete selectivo | Soft delete universal | Solo donde el historial tiene valor legal/comercial |
| Impersonación con JWT limitado | Bypass RLS | Audit trail completo; principio de menor privilegio |
