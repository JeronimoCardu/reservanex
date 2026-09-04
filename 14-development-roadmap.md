# OrderFlow — Development Roadmap

**Versión:** 1.0  
**Fecha:** 2026-06-22  
**Basado en:** 12-api-spec.md, 13-project-structure.md

---

## Visión general del roadmap

```
Fase 0 — Infraestructura          (Semana 1)
Fase 1 — Auth + Fundación         (Semana 1-2)
Fase 2 — CRM Core                 (Semana 2-3)     ← MVP INTERNO
Fase 3 — WhatsApp Inbound         (Semana 3-4)
Fase 4 — AI Pipeline              (Semana 4-5)     ← MVP BETA
Fase 5 — Reservas + Disponibilidad (Semana 5-6)
Fase 6 — Sitio Público + Web Chat (Semana 6-7)
Fase 7 — Platform Admin Completo  (Semana 7-8)     ← MVP COMERCIAL
Fase 8 — Calidad + Launch         (Semana 8-9)
```

---

## Fase 0 — Infraestructura base

**Objetivo:** Tener el ambiente de desarrollo y el esquema de DB funcionando antes de escribir una sola línea de lógica de negocio.

### Funcionalidades

**Supabase:**
- Crear proyecto en Supabase (Plan Pro — requerido para Auth Hook)
- Registrar extensiones: `pgcrypto`, `btree_gist`
- Aplicar migración `20260622000001_schema_v2.sql` (de `10-supabase-schema-v2.sql`)
- Aplicar migración `20260622000002_rls_policies.sql` (de `11-rls-policies.sql`)
- Registrar `custom_access_token_hook` en Dashboard → Auth → Hooks
- Configurar `pg_cron` para expiración de pre-reservas
- Verificar que `tenants_public` VIEW es accesible por `anon`

**Monorepo:**
- Inicializar repositorio con pnpm workspaces + Turborepo
- Crear estructura de carpetas de `13-project-structure.md`
- Configurar `packages/config` (tsconfig base, eslint base)
- Configurar CI/CD básico (GitHub Actions: lint + typecheck en PR)

**Variables de entorno:**
- Documentar `.env.example` con todas las variables requeridas (apps/web + apps/worker)
- Configurar entornos: `development`, `staging`, `production`

**Supabase CLI local:**
- Configurar `supabase/config.toml` para desarrollo local
- Seed de datos de desarrollo en `supabase/seed/dev_seed.sql`:
  - 1 Super Admin en `platform_users`
  - 1 tenant de prueba
  - 1 owner de prueba
  - Propiedades y unidades de prueba

### Dependencias

Ninguna. Esta es la fase fundacional.

### Criterios de finalización

- [ ] `supabase db push` en staging no genera errores
- [ ] RLS activo en todas las tablas (verificar con `SELECT tablename FROM pg_tables WHERE schemaname = 'public'` y confirmar `rowsecurity = true`)
- [ ] Auth Hook registrado — un login de prueba retorna JWT con claims `user_type`, `tenant_id`, `role`
- [ ] `turbo build` corre sin errores con estructura vacía
- [ ] `.env.example` documentado y revisado

### Riesgos

| Riesgo | Mitigación |
|---|---|
| Supabase Pro no disponible inmediatamente | Tener tarjeta cargada; activar Pro antes de iniciar |
| Auth Hook rechazado por Supabase (plan incorrecto) | Verificar plan antes de escribir código dependiente |
| `btree_gist` no disponible en versión de Postgres | Supabase usa PG17; verificar con `SELECT * FROM pg_available_extensions WHERE name = 'btree_gist'` |

---

## Fase 1 — Auth + Fundación multi-tenant

**Objetivo:** Cualquier usuario puede autenticarse y recibir el JWT correcto con sus claims. El Super Admin puede crear tenants y usuarios.

### Funcionalidades

**packages/types:**
- Generar `database.ts` con `supabase gen types typescript`
- Definir tipos de API para Auth, Tenants, Users (`api.ts`)
- Definir tipos de dominio base (`domain.ts`)

**packages/supabase:**
- `browser.ts` — cliente para componentes React client-side
- `server.ts` — cliente para Server Components y Route Handlers
- `admin.ts` — service role client

**packages/validators:**
- Schema de login (`auth.ts`)
- Schema de creación de tenant (`tenants.ts`)
- Schema de creación de usuario (`users.ts`)

**apps/web — API routes:**
- `POST /auth/login` — wrapper con fetch del perfil post-login
- `POST /auth/logout`
- `GET /auth/me` — retorna perfil + claims del JWT
- `GET /auth/refresh`

**apps/web — Auth Hook ya registrado en Supabase (Fase 0):**
- Verificar que el hook popula correctamente `user_type`, `tenant_id`, `role`, `branch_id`

**apps/web — Middleware:**
- `src/middleware.ts` — verifica sesión, redirige según rol a `(platform)` o `(tenant)`, protege rutas autenticadas
- Resolución de tenant desde hostname (`{tenant}.orderflow.app` → `tenants.slug`)

**apps/web — UI básica (solo lo necesario para testear):**
- Pantalla de login (`(auth)/login`)
- Redirección post-login según `user_type`

### Dependencias

- Fase 0 completa (DB con schema + RLS + Auth Hook)

### Criterios de finalización

- [ ] Un Super Admin puede loguearse y recibir JWT con `user_type: 'super_admin'`
- [ ] Un Owner puede loguearse y recibir JWT con `user_type: 'tenant_user'`, `role: 'owner'`, `tenant_id` correcto
- [ ] Un usuario sin tenant recibe error 403 en endpoints protegidos
- [ ] El middleware redirige correctamente entre `(platform)` y `(tenant)` según JWT
- [ ] `GET /auth/me` retorna perfil correcto para cada tipo de usuario
- [ ] Un usuario de tenant A no puede ver datos de tenant B (prueba con Postman usando JWT de tenant A en endpoint de tenant B)

### Riesgos

| Riesgo | Mitigación |
|---|---|
| Auth Hook no recibe `app_metadata` correctamente | Testear hook en aislamiento con Supabase Dashboard |
| Middleware en Vercel Edge Runtime con limitaciones | Next.js Edge Middleware soporta Supabase Auth — seguir guía oficial |
| Resolución de tenant por hostname en desarrollo local | Usar header `X-Tenant-Slug` como fallback en dev |

---

## Fase 2 — CRM Core

**Objetivo:** Un Owner puede gestionar propiedades, unidades, contactos y el equipo de su tenant. Esta fase produce el MVP Interno.

### Funcionalidades

**packages/validators:**
- Schemas para: branches, properties, units, contacts, users

**apps/web — API routes:**

*Branches:*
- `GET /branches`, `POST /branches`, `GET /branches/:id`, `PATCH /branches/:id`, `DELETE /branches/:id`

*Users (gestión de equipo):*
- `GET /users`, `POST /users`, `GET /users/:id`, `PATCH /users/:id`, `DELETE /users/:id`

*Properties:*
- `GET /properties`, `POST /properties`, `GET /properties/:id`, `PATCH /properties/:id`, `DELETE /properties/:id`
- `POST /properties/:id/publish`, `POST /properties/:id/unpublish`

*Property Images:*
- `POST /properties/:id/images`, `DELETE /properties/:id/images/:imageId`, `PATCH /properties/:id/images/:imageId/cover`

*Units:*
- `GET /properties/:id/units`, `POST /properties/:id/units`, `GET /units/:id`, `PATCH /units/:id`, `DELETE /units/:id`

*Unit Images:*
- `POST /units/:id/images`, `DELETE /units/:id/images/:imageId`

*Contacts:*
- `GET /contacts`, `POST /contacts`, `GET /contacts/:id`, `PATCH /contacts/:id`, `DELETE /contacts/:id`

**Supabase Storage:**
- Configurar buckets: `property-images`, `unit-images`, `documents`
- Políticas de Storage: propietario del tenant puede subir, anon puede leer imágenes de propiedades publicadas

**apps/web — UI básica de CRM (solo para validar flujos):**
- CRUD de propiedades con imágenes
- CRUD de contactos
- Gestión de equipo (invitar usuarios, asignar rol)

### Dependencias

- Fase 1 completa (Auth funcionando)

### Criterios de finalización

- [ ] Owner puede crear propiedad con imágenes y unidades
- [ ] `POST /properties/:id/publish` falla si la propiedad no tiene imágenes ni unidades activas
- [ ] Owner puede invitar a un Receptionist; el Receptionist solo ve propiedades de su branch (si tiene branch asignado)
- [ ] Soft delete: propiedad eliminada no aparece en listados pero existe en DB con `deleted_at`
- [ ] Trigger `cascade_soft_delete_units` verifica que al eliminar propiedad, sus unidades también se marcan con `deleted_at`
- [ ] Trigger `check_unit_tenant_consistency` rechaza unidad con `tenant_id` diferente al de la propiedad
- [ ] Un Receptionist de tenant A no puede ver contactos de tenant B (verificación RLS)

### Riesgos

| Riesgo | Mitigación |
|---|---|
| Supabase Storage CORS en uploads desde browser | Configurar CORS en bucket settings antes de implementar UI |
| Trigger de cascade soft-delete crea loop | El trigger verifica `OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL` — solo actúa en primer soft-delete |
| Tenant isolation en Storage (imágenes) | Usar path `{tenant_id}/{property_id}/{filename}` en Storage — RLS de Storage basada en path |

---

## MVP Interno

**Alcance:** Fases 0 + 1 + 2 completas.

**Capacidad:** Un equipo interno puede usar el CRM para gestionar propiedades, unidades y contactos. No hay WhatsApp ni IA todavía.

**Objetivo del MVP Interno:**
- Validar flujos de onboarding de tenant
- Detectar problemas de UX en la gestión de propiedades
- Verificar que RLS funciona correctamente en escenarios reales
- Identificar campos faltantes en el schema antes de avanzar

**Usuarios target:** 1-2 tenants internos del equipo de desarrollo.

---

## Fase 3 — WhatsApp Inbound

**Objetivo:** Los mensajes de WhatsApp de los clientes llegan al CRM. El equipo puede responder manualmente desde la interfaz.

### Funcionalidades

**apps/worker — setup inicial:**
- Scaffolding del proceso Node.js (`packages/types`, `packages/supabase`)
- `queue/listener.ts` — conexión a PostgreSQL, escucha `LISTEN new_message_queue`
- `queue/consumer.ts` — `SELECT ... FOR UPDATE SKIP LOCKED` en `message_queue`, procesamiento sequencial
- Graceful shutdown (SIGTERM → esperar mensajes en vuelo → cerrar)

**apps/web — Webhook Meta:**
- `GET /webhooks/whatsapp` — verificación del webhook Meta (challenge)
- `POST /webhooks/whatsapp` — recibe eventos Meta, verifica HMAC `X-Hub-Signature-256`, inserta en `message_queue`, responde 200 siempre

**apps/worker — procesamiento inbound:**
- `whatsapp/client.ts` — solo envío por ahora (preparación Fase 4)
- `whatsapp/formatter.ts` — transforma payload Meta → estructura de message
- Lógica de enrutamiento: encontrar o crear `contacts`, encontrar o crear `conversations`, insertar en `messages`
- Actualizar `message_queue` a `processed`/`failed`

**apps/web — API routes de conversaciones:**
- `GET /conversations`, `GET /conversations/:id`
- `GET /conversations/:id/messages`
- `POST /conversations/:id/messages` — envío manual de respuesta
- `PATCH /conversations/:id` — asignar agente, cambiar estado
- `POST /conversations/:id/escalate` — escalar a humano

**apps/web — Supabase Realtime:**
- Suscripción a cambios en `messages` y `conversations` para actualización en tiempo real del CRM

**Worker — envío outbound manual:**
- `POST /internal/ai/tools/execute` no está activo aún — el worker solo procesa inbound y el CRM envía outbound manualmente

### Dependencias

- Fase 2 completa (contacts y conversations tienen schema listo)
- Cuenta de Meta Business y número de WhatsApp aprobado
- Meta Webhook URL registrada (requiere `apps/web` deployado en URL pública)

### Criterios de finalización

- [ ] Mensaje enviado desde WhatsApp aparece en CRM en menos de 5 segundos
- [ ] HMAC inválido retorna 200 a Meta pero no inserta en `message_queue` (log de error interno)
- [ ] Worker procesa mensaje sin duplicados incluso con 2 instancias concurrentes (`FOR UPDATE SKIP LOCKED`)
- [ ] Contacto nuevo se crea automáticamente si el número de WhatsApp no existe
- [ ] Conversación se crea automáticamente si no existe activa para ese contacto en ese tenant
- [ ] Receptionist puede responder manualmente desde CRM y el mensaje llega al cliente en WhatsApp
- [ ] Worker se recupera de reinicio sin procesar mensajes ya completados

### Riesgos

| Riesgo | Mitigación |
|---|---|
| Meta no aprueba el número de WhatsApp Business | Iniciar proceso de verificación en Fase 0 en paralelo — tarda varios días |
| pg_notify no llega al worker (conexión caída) | Implementar polling de fallback cada 30s en `consumer.ts` para mensajes `pending` sin `processing_started_at` |
| Doble procesamiento en restart del worker | `FOR UPDATE SKIP LOCKED` + `processing_started_at` + timeout de recovery (mensajes con `processing_started_at` > 5min se resetean a `pending`) |
| Rate limit de Meta API | Implementar retry con exponential backoff en `whatsapp/client.ts` |

---

## Fase 4 — AI Pipeline

**Objetivo:** El worker procesa mensajes con IA. Claude responde automáticamente en WhatsApp usando las 7 herramientas definidas.

### Funcionalidades

**packages/ai:**
- `client.ts` — Anthropic SDK setup
- `tools.ts` — Definiciones de las 7 herramientas (formato `tool_use` de Anthropic)
- `prompts.ts` — System prompt base con placeholders de tenant (nombre, propiedades activas)

**apps/worker — AI pipeline:**
- `ai/pipeline.ts` — orquesta el ciclo: mensaje → contexto → Claude → tool_use → ejecutar → resultado → Claude → respuesta final
- `ai/parser.ts` — parsea `tool_use` blocks del response de Claude
- `tools/index.ts` — whitelist + dispatch a implementación concreta
- `tools/search-properties.ts` — busca propiedades por criterios del contacto
- `tools/check-availability.ts` — verifica disponibilidad de una unidad en rango de fechas
- `tools/get-property-details.ts` — detalles completos de una propiedad
- `tools/create-pre-reservation.ts` — crea pre-reserva con `expires_at`
- `tools/get-contact-history.ts` — historial de conversaciones anteriores del contacto
- `tools/create-task.ts` — crea tarea para el equipo
- `tools/escalate-to-human.ts` — marca conversación como `escalated`, notifica al equipo

**apps/web — API routes internas:**
- `POST /internal/ai/process` — endpoint que el worker puede llamar opcionalmente para procesamiento
- `POST /internal/ai/tools/execute` — ejecuta una herramienta del whitelist con validación adicional

**AI Settings por tenant:**
- `GET /ai-settings`, `PATCH /ai-settings`, `POST /ai-settings/test`
- Campos: `ai_enabled`, `response_language`, `custom_instructions`, `escalation_keywords`, `business_hours`

**ai_usage_log:**
- El worker registra cada llamada a Anthropic: `tokens_input`, `tokens_output`, `tools_used`, `duration_ms`

### Dependencias

- Fase 3 completa (worker funcionando, mensajes llegando)
- API key de Anthropic activa con acceso a Claude claude-sonnet-4-6 o superior

### Criterios de finalización

- [ ] Mensaje "¿tienen departamentos de 2 ambientes?" genera respuesta automática con propiedades relevantes
- [ ] AI usa `check_availability` antes de ofrecer una unidad
- [ ] `create_pre_reservation` crea registro en DB con `expires_at = NOW() + INTERVAL '24 hours'`
- [ ] Palabra clave de escalación (ej: "quiero hablar con alguien") llama `escalate_to_human`
- [ ] Una herramienta fuera del whitelist es ignorada (no ejecutada)
- [ ] `ai_usage_log` registra cada interacción con tokens y costo estimado
- [ ] Con `ai_enabled = false`, el worker no llama a Anthropic (pasa mensaje a cola de atención humana)
- [ ] Ciclo completo (mensaje → AI → respuesta) en menos de 10 segundos en p95

### Riesgos

| Riesgo | Mitigación |
|---|---|
| Claude genera tool_use inválido (tool fuera de whitelist) | Worker verifica nombre de tool contra whitelist antes de ejecutar — rechaza con log |
| Respuesta de AI demasiado larga para WhatsApp (>4096 chars) | Truncar y agregar "Escríbenos para más información" — implementar en `formatter.ts` |
| Costo de tokens Anthropic excede presupuesto | `ai_usage_log` + alerta por tenant cuando tokens_output > umbral configurable |
| AI en loop infinito de tool calls | Limitar a máximo 5 iteraciones de tool_use por mensaje en `ai/pipeline.ts` |
| System prompt con datos de tenant desactualizados | Regenerar system prompt en cada conversación (no cachear) |

---

## MVP Beta

**Alcance:** Fases 0 + 1 + 2 + 3 + 4 completas.

**Capacidad:** Un tenant puede gestionar propiedades, recibir mensajes de WhatsApp y tener respuestas automáticas de IA con herramientas de búsqueda y pre-reservas.

**Objetivo del MVP Beta:**
- Validar que la IA responde adecuadamente en conversaciones reales
- Medir tasa de escalación a humano vs. resolución autónoma
- Detectar herramientas faltantes o mal definidas
- Validar performance del worker bajo carga real

**Usuarios target:** 2-5 tenants seleccionados como early adopters. Acceso controlado.

---

## Fase 5 — Reservas + Disponibilidad completa

**Objetivo:** El flujo de reservas es completo: desde la pre-reserva de IA hasta la confirmación por el equipo y el bloqueo de disponibilidad.

### Funcionalidades

**apps/web — API routes:**
- `GET /availability` — disponibilidad de unidades en rango de fechas
- `POST /availability/block` — bloqueo manual por mantenimiento/reserva directa
- `DELETE /availability/blocks/:id` — liberar bloqueo manual

*Reservations:*
- `GET /reservations`, `POST /reservations`
- `GET /reservations/:id`, `PATCH /reservations/:id`
- `POST /reservations/:id/confirm` — owner only, cambia estado a `confirmed`
- `POST /reservations/:id/cancel` — owner o receptionist

**pg_cron — expiración de pre-reservas:**
- Verificar que el job está activo: `SELECT * FROM cron.job WHERE jobname = 'expire_pre_reservations'`
- El job ya está definido en el schema V2; solo verificar ejecución

**Constraint de no double-booking:**
- El EXCLUDE constraint en `availability_blocks` ya está en DB
- Verificar que `POST /reservations` falla con 409 si hay solapamiento
- `POST /reservations` debe crear `availability_block` en la misma transacción

**Notificaciones:**
- `GET /notifications`, `PATCH /notifications/:id/read`, `PATCH /notifications/read-all`
- Trigger en DB notifica a owner/receptionist en cambio de estado de reserva
- Realtime suscription para notificaciones en tiempo real en CRM

**Tasks y Notes:**
- `GET /tasks`, `POST /tasks`, `GET /tasks/:id`, `PATCH /tasks/:id`, `DELETE /tasks/:id`
- `GET /contacts/:id/notes`, `POST /contacts/:id/notes` (append-only — sin PATCH/DELETE)
- `GET /reservations/:id/notes`, `POST /reservations/:id/notes`

### Dependencias

- Fase 2 completa (propiedades y unidades existentes)
- Fase 4 completa (AI puede crear pre-reservas via tool)

### Criterios de finalización

- [ ] Pre-reserva creada por AI expira a las 24h (verificar con pg_cron)
- [ ] Intento de reserva en fechas ya bloqueadas retorna 409
- [ ] `POST /reservations` y `POST /availability/block` son atómicos (si falla uno, falla todo)
- [ ] Owner confirma reserva → estado cambia a `confirmed` → notificación en CRM en tiempo real
- [ ] Cancelación libera el bloque de disponibilidad automáticamente
- [ ] Trigger `clear_expires_at_on_advance` limpia `expires_at` cuando la reserva avanza de `pre_reserved`
- [ ] Notes son inmutables (intentar PATCH en la API retorna 405)

### Riesgos

| Riesgo | Mitigación |
|---|---|
| EXCLUDE constraint causa error críptico en la API | Capturar `23P01` (exclusion violation) y retornar 409 con mensaje claro |
| pg_cron no ejecuta en Supabase Pro | Verificar en Dashboard → Database → Cron Jobs; crear job si no existe |
| Race condition entre AI creando pre-reserva y usuario manual | EXCLUDE constraint lo previene a nivel DB — es atómico |

---

## Fase 6 — Sitio Público + Web Chat

**Objetivo:** Cada tenant tiene un sitio público con catálogo de propiedades y un widget de chat web para consultas desde la web.

### Funcionalidades

**apps/web — Route group `(public):`**
- `GET /public/tenants/:slug` — info pública del tenant (de `tenants_public` VIEW)
- `GET /public/tenants/:slug/properties` — listado de propiedades publicadas con filtros
- `GET /public/properties/:id` — detalle de propiedad pública
- `GET /public/properties/:id/availability` — disponibilidad para booking widget
- `POST /public/inquiries` — formulario de contacto sin chat
- `POST /public/chat/start` — inicia conversación web (retorna `session_token`)
- `POST /public/chat/:id/message` — envía mensaje con `session_token`

**Web chat session token:**
- JWT de corta duración (1h) con solo `conversation_id` — sin datos de usuario
- Generado en `POST /public/chat/start`
- Validado en `POST /public/chat/:id/message`
- Conversaciones web también van al worker (mismo pipeline de IA)

**SEO + rendimiento:**
- Páginas de propiedades públicas usan `generateStaticParams` para ISR
- Revalidación on-demand cuando el tenant actualiza una propiedad

**Documents:**
- `GET /contacts/:id/documents`, `POST /contacts/:id/documents`
- `GET /reservations/:id/documents`, `POST /reservations/:id/documents`
- `DELETE /documents/:id`

### Dependencias

- Fase 2 completa (propiedades publicables)
- Fase 3 completa (worker procesa mensajes — también del web chat)

### Criterios de finalización

- [ ] Anon puede ver propiedades publicadas sin JWT
- [ ] Anon NO puede ver propiedades con `published = false`
- [ ] `session_token` expirado retorna 401
- [ ] Mensaje desde widget web llega al CRM como conversación de canal `web`
- [ ] AI responde mensajes del web chat igual que WhatsApp
- [ ] Custom domain de tenant (si configurado) sirve el sitio público correctamente

### Riesgos

| Riesgo | Mitigación |
|---|---|
| Custom domain en Vercel requiere configuración por tenant | Usar Vercel API para agregar domains programáticamente — o usar solo subdominios para MVP |
| ISR no invalida caché cuando propiedad se despublica | Llamar `revalidatePath` en `POST /properties/:id/unpublish` |
| Web chat abusado por bots | Rate limit en `POST /public/chat/start` por IP (5 conversaciones/hora/IP) |

---

## Fase 7 — Platform Admin completo

**Objetivo:** El Super Admin tiene visibilidad y control total de la plataforma. Impersonación funcional. Audit logs visibles.

### Funcionalidades

**apps/web — API routes Platform Admin:**
- `GET /platform/tenants`, `POST /platform/tenants`, `GET /platform/tenants/:id`, `PATCH /platform/tenants/:id`, `DELETE /platform/tenants/:id`
- `GET /platform/users`, `POST /platform/users`, `GET /platform/users/:id`, `PATCH /platform/users/:id`, `DELETE /platform/users/:id`
- `GET /platform/seller-clients`, `POST /platform/seller-clients`, `PATCH /platform/seller-clients/:id`, `DELETE /platform/seller-clients/:id`

**Impersonación:**
- `POST /impersonation/start` — crea registro en `impersonation_sessions`, retorna contexto
- `POST /impersonation/:id/end` — cierra sesión con `ended_at`
- `GET /impersonation/sessions` — historial de impersonaciones

**Audit Logs:**
- `GET /audit-logs` — listado paginado con filtros por `table_name`, `action`, `actor_id`, `from_date`, `to_date`

**Dashboard:**
- `GET /dashboard/kpis` — métricas del tenant (propiedades activas, contactos nuevos, reservas del mes)
- `GET /dashboard/conversations-chart` — volumen de conversaciones por día/semana
- `GET /dashboard/reservations-chart` — reservas por estado
- `GET /dashboard/ai-usage` — tokens consumidos, costo estimado por período

### Dependencias

- Todas las fases anteriores (para que los datos del dashboard tengan sentido)
- `impersonation_sessions` tabla ya existe desde Fase 0

### Criterios de finalización

- [ ] Super Admin puede iniciar impersonación y ver datos del tenant como si fuera Owner
- [ ] Super Admin SIN impersonación activa no puede ver datos de tenant (RLS rechaza)
- [ ] Impersonación se registra en `audit_logs` con `actor_type = 'platform_user'`
- [ ] `GET /audit-logs` filtrado por tenant funciona durante impersonación
- [ ] Dashboard KPIs retorna datos del tenant impersonado (no del Super Admin)
- [ ] `POST /impersonation/:id/end` cierra la sesión — próxima query al tenant retorna 403

### Riesgos

| Riesgo | Mitigación |
|---|---|
| Super Admin abre 2 sesiones de impersonación simultáneas | UNIQUE partial index en `impersonation_sessions (platform_user_id) WHERE ended_at IS NULL` — documentado en RISK-02 de 11-rls-policies.sql |
| Dashboard lento por queries costosas | Agregar índices específicos para queries de dashboard; usar `EXPLAIN ANALYZE` antes de lanzar |

---

## MVP Comercial

**Alcance:** Fases 0 a 7 completas.

**Capacidad:**
- Tenants completos: CRM, WhatsApp, IA, Reservas, Sitio Público
- Platform Admin con impersonación y auditoría
- Super Admin puede onboardear tenants autónomamente

**Objetivo del MVP Comercial:**
- Primer cliente de pago
- SLA documentado
- Onboarding de tenant en menos de 1 hora
- Soporte a 10 tenants simultáneos sin degradación

---

## Fase 8 — Calidad + Launch

**Objetivo:** El producto está listo para clientes que pagan. Estabilidad, observabilidad y onboarding documentado.

### Funcionalidades

**Testing:**
- Tests de integración para RLS (verificar aislamiento tenant A vs B para cada rol)
- Tests de API para los flujos críticos (login → crear propiedad → publicar → reserva → confirmar)
- Tests del worker (procesamiento de mensaje, tool execution, escalación)
- Test de carga básico: 50 mensajes/minuto simultáneos

**Observabilidad:**
- Logging estructurado en worker (pino) con campos: `tenant_id`, `conversation_id`, `duration_ms`, `error`
- Alertas: worker caído > 2min, error rate > 5%, latencia p95 > 15s
- `GET /internal/worker/health` conectado a uptime monitoring

**Seguridad:**
- Rotation de secretos documentada (Meta token, Anthropic key, service role)
- Revisar RISK-01 de `11-rls-policies.sql`: role escalation via self-UPDATE (whitelist de columnas en API)
- Revisar LIMIT-02: `whatsapp_accounts.access_token_encrypted` visible a receptionist (ocultar en response)
- Rate limiting en endpoints públicos y webhook

**Documentación operacional:**
- Runbook de worker: reiniciar, revisar queue, recuperar mensajes stuck
- Runbook de Supabase: backup, restauración, upgrade de plan
- Proceso de onboarding de nuevo tenant (paso a paso)

**Performance:**
- Ejecutar `EXPLAIN ANALYZE` en las 10 queries más frecuentes de producción
- Verificar uso de índices con `pg_stat_user_indexes`
- Ajustar `per_page` defaults y límites máximos

### Criterios de finalización

- [ ] 0 errores de aislamiento de tenant en suite de tests de RLS
- [ ] Flujo completo (mensaje WhatsApp → AI → respuesta) funciona en staging con load test de 50 msg/min sin errores
- [ ] Worker se reinicia automáticamente en falla (process manager configurado)
- [ ] Runbook de onboarding de tenant ejecutado por alguien que no escribió el sistema (sin ayuda)
- [ ] Todos los RISK y LIMIT de `11-rls-policies.sql` revisados y mitigados o aceptados con justificación escrita

### Riesgos

| Riesgo | Mitigación |
|---|---|
| Tests de RLS requieren acceso a múltiples JWTs distintos | Usar Supabase Testing Helpers o scripts que generen tokens de prueba con claims forzados |
| Load test revela cuello de botella en el worker (un solo proceso) | Diseñar `consumer.ts` para procesar N mensajes en paralelo (configurable, default N=5) |

---

## Resumen de milestones

| Milestone | Fases | Semana estimada | Indicador clave |
|---|---|---|---|
| **MVP Interno** | 0, 1, 2 | Semana 3 | Owner gestiona propiedades y contactos en CRM |
| **MVP Beta** | 0–4 | Semana 5 | WhatsApp → IA → respuesta automática funcionando |
| **MVP Comercial** | 0–7 | Semana 8 | Primer tenant paga; Super Admin opera sin asistencia técnica |
| **Launch** | 0–8 | Semana 9 | Suite de tests verde; observabilidad activa; runbooks listos |

---

## Orden de implementación por desarrollador

Si hay un solo desarrollador full-stack:

```
Semana 1:   Fase 0 (infra) + Fase 1 (auth)
Semana 2:   Fase 2 primera mitad (propiedades + unidades)
Semana 3:   Fase 2 segunda mitad (contactos + equipo) → MVP Interno
Semana 4:   Fase 3 (WhatsApp inbound + worker base)
Semana 5:   Fase 4 (AI pipeline) → MVP Beta
Semana 6:   Fase 5 (reservas + disponibilidad)
Semana 7:   Fase 6 (sitio público + web chat)
Semana 8:   Fase 7 (platform admin) → MVP Comercial
Semana 9:   Fase 8 (calidad + launch)
```

Si hay dos desarrolladores:

```
Dev 1 (backend/infra):    Fase 0 → Fase 1 → Fase 3 → Fase 4 → Fase 5 → Fase 7
Dev 2 (frontend/API):     Fase 2 → API routes de Fase 3-4 → Fase 6 → Fase 8
```

La separación es posible porque el worker (`apps/worker`) es completamente independiente del frontend — se comunican solo a través de Supabase.

---

## Decisiones diferidas (no incluidas en MVP)

Estas funcionalidades están fuera del scope del roadmap actual. Documentadas para no perder contexto:

| Funcionalidad | Razón de exclusión |
|---|---|
| Email marketing integrado | Fuera del MVP — requiere proveedor externo y compliance |
| Portal de propietarios (dueños de inmuebles) | Nuevo tipo de usuario no definido en roles actuales |
| Pagos online (Stripe) | Reservas se confirman offline; pago fuera de scope V1 |
| App móvil nativa | Web app responsive es suficiente para MVP |
| Multi-idioma del CRM | Español inicial; i18n se agrega si hay demanda internacional |
| Reportes exportables (PDF, Excel) | Nice-to-have; prioridad baja vs. funcionalidades core |
| WhatsApp templates aprobados por Meta | Templates son para mensajes outbound pro-activos; en MVP solo reactivos |
| Chatbot por voz (WhatsApp Voice) | `message_content_type` ya tiene `audio` pero el procesamiento de voz no está en scope |
