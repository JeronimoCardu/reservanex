# OrderFlow — Auditoría del Schema SQL

**Versión:** 1.0
**Fecha:** 2026-06-22
**Auditor:** Principal Database Architect / Senior PostgreSQL Reviewer
**Archivo auditado:** `10-supabase-schema.sql`

---

## Metodología

Se analizaron 15 dimensiones:
integridad referencial, foreign keys, índices (redundantes/faltantes),
performance, RLS, multi-tenant, soft delete, triggers, auditoría,
escalabilidad, compatibilidad Supabase, buenas prácticas PostgreSQL,
costos operativos, y riesgos de lock/deadlock.

---

## Resumen Ejecutivo

| Severidad | Cantidad |
|---|---|
| CRÍTICO | 5 |
| ALTO | 9 |
| MEDIO | 11 |
| BAJO | 6 |
| **Total** | **31** |

---

## CRÍTICOS — Deben resolverse antes de cualquier deploy

---

### C-01 — actor_id NOT NULL rompe el job de expiración de pre-reservas

**Dimensión:** Triggers / Auditoría / Escalabilidad

**Descripción:**
`audit_logs.actor_id` es `NOT NULL`. La función `audit_table_change()` obtiene el actor mediante `auth.uid()`. Cuando el job de `pg_cron` ejecuta:

```sql
UPDATE reservations
SET status = 'cancelled'
WHERE status = 'pre_reserved' AND expires_at < now();
```

No hay sesión de usuario activa. `auth.uid()` retorna `NULL`. La función `audit_table_change()` intenta insertar en `audit_logs` con `actor_id = NULL`, lo que viola la constraint `NOT NULL`. El INSERT falla. El trigger falla. El UPDATE de la reserva falla silenciosamente (o levanta una excepción según la configuración). **Las pre-reservas vencidas nunca se cancelan. Las fechas quedan bloqueadas indefinidamente.**

**Impacto:**
- Double-booking garantizado una vez que haya pre-reservas vencidas
- El tenant ve fechas bloqueadas sin reservas activas
- El problema escala con el tiempo hasta que el sistema sea inoperable

**Solución recomendada:**
Dos cambios obligatorios:

1. Hacer `actor_id` nullable en `audit_logs` (para operaciones de sistema):
```sql
actor_id UUID,  -- NULL para operaciones de sistema (pg_cron, workers)
```

2. Agregar manejo de actor NULL en `audit_table_change()`:
```sql
v_actor_id := auth.uid();
IF v_actor_id IS NULL THEN
  v_action := 'system.' || TG_TABLE_NAME || '.' || LOWER(TG_OP);
END IF;
```

---

### C-02 — Race condition de double-booking sin EXCLUSION constraint

**Dimensión:** Integridad referencial / Multi-tenant / Performance

**Descripción:**
No hay constraint de exclusión en `availability_blocks` que prevenga la inserción de rangos de fechas solapados para la misma unidad. El flujo actual es:

```
Worker A: CHECK availability → disponible
Worker B: CHECK availability → disponible (misma unidad, mismas fechas)
Worker A: INSERT availability_block → ok
Worker B: INSERT availability_block → ok (DOBLE BOOKING)
```

Esto ocurre cuando dos clientes consultan simultáneamente la misma unidad para las mismas fechas y ambos avanzan a pre-reserva en el mismo instante. El índice `idx_availability_unit_dates` optimiza la lectura, pero no previene la escritura concurrente conflictiva.

**Impacto:**
- Doble reserva de la misma unidad para las mismas fechas
- Responsabilidad legal para el tenant
- Daño reputacional

**Solución recomendada:**
Agregar la extensión `btree_gist` y un EXCLUSION constraint:

```sql
CREATE EXTENSION IF NOT EXISTS "btree_gist";

ALTER TABLE public.availability_blocks
  ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (
    unit_id  WITH =,
    daterange(start_date, end_date, '[)') WITH &&
  );
```

Esto garantiza a nivel de base de datos que dos bloques no pueden solaparse para la misma unidad. Ninguna lógica de aplicación puede evitar esta garantía.

---

### C-03 — Inconsistencia cross-tenant en units.tenant_id vs properties.tenant_id

**Dimensión:** Multi-tenant / Integridad referencial

**Descripción:**
La tabla `units` tiene `tenant_id UUID NOT NULL REFERENCES tenants(id)` y `property_id UUID NOT NULL REFERENCES properties(id)`. No existe ningún constraint que garantice que `units.tenant_id = properties.tenant_id`. Un bug en la capa de aplicación podría crear una unidad con `tenant_id = TenantA` pero `property_id` perteneciente a `TenantB`.

Esto genera dos categorías de problemas:
1. **Fuga de datos:** Las políticas RLS de `units` filtran por `units.tenant_id`, pero la unidad apunta a la propiedad de otro tenant
2. **Corrupción silenciosa:** Las queries del sitio público podrían devolver unidades de un tenant en la web de otro

El mismo patrón existe en `availability_blocks.tenant_id` vs `units.tenant_id`.

**Impacto:**
- Potencial exposición de datos de un tenant en el contexto de otro
- Inconsistencia de datos difícil de detectar después del hecho

**Solución recomendada:**
Trigger BEFORE INSERT OR UPDATE en `units`:

```sql
CREATE OR REPLACE FUNCTION public.check_unit_tenant_consistency()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_prop_tenant UUID;
BEGIN
  SELECT tenant_id INTO v_prop_tenant
  FROM public.properties WHERE id = NEW.property_id;

  IF v_prop_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'units.tenant_id (%) must match properties.tenant_id (%)',
      NEW.tenant_id, v_prop_tenant;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_units_tenant_consistency
  BEFORE INSERT OR UPDATE ON public.units
  FOR EACH ROW EXECUTE FUNCTION public.check_unit_tenant_consistency();
```

Aplicar el mismo patrón en `availability_blocks`.

---

### C-04 — GRANT masivo a `authenticated` incluye tablas que no deben ser accesibles

**Dimensión:** RLS / Seguridad multi-tenant

**Descripción:**
```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
```

Este grant otorga la capacidad técnica de operar sobre **todas** las tablas, incluyendo:
- `audit_logs` — un usuario autenticado podría intentar INSERT o DELETE (aunque RLS lo bloquee, si RLS se desactiva accidentalmente el daño es total)
- `message_queue` — un usuario autenticado podría inyectar mensajes en la cola del sistema
- `ai_usage_log` — datos de facturación internos
- `impersonation_sessions` — datos de seguridad críticos
- `platform_users` — datos internos de OrderFlow

Si por error humano se desactiva RLS en una de estas tablas, `authenticated` tiene acceso inmediato y completo. El principio de defensa en profundidad requiere que los GRANTs también sean restrictivos.

**Impacto:**
- Superficie de ataque innecesariamente amplia
- Un error de configuración (RLS desactivado) expone datos críticos

**Solución recomendada:**
Reemplazar el GRANT masivo con grants granulares por tabla:

```sql
-- Tablas de negocio: CRUD para authenticated
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.properties, public.property_images, public.units, public.unit_images,
  public.contacts, public.conversations, public.messages, public.reservations,
  public.availability_blocks, public.documents, public.tasks, public.notes,
  public.notifications, public.whatsapp_accounts, public.ai_settings,
  public.branches, public.tenant_users
TO authenticated;

-- Solo lectura (perfil propio)
GRANT SELECT ON public.platform_users, public.tenants, public.seller_clients TO authenticated;

-- Sin acceso directo para authenticated (solo service_role)
-- audit_logs, ai_usage_log, message_queue, impersonation_sessions
GRANT SELECT ON public.audit_logs TO authenticated;  -- solo lectura para owner
```

---

### C-05 — custom_access_token_hook requiere Supabase Pro (sin fallback documentado)

**Dimensión:** Compatibilidad Supabase / RLS

**Descripción:**
`custom_access_token_hook` es la pieza central de toda la arquitectura de seguridad. Sin ella, el JWT no tiene claims de `user_type`, `tenant_id`, `role`, ni `branch_id`. Como consecuencia, **todas** las funciones helper retornan valores vacíos o nulos:

- `auth_user_type()` → `'unknown'`
- `auth_tenant_id()` → `NULL`
- `auth_user_role()` → `NULL`

Todas las políticas RLS que usan estas funciones **deniegan acceso** (porque ninguna condición se cumple). El sistema es completamente inoperable para usuarios autenticados. El problema es que Auth Hooks **solo están disponibles en Supabase Pro**, no en Free o Starter.

Si se intenta desplegar en un proyecto Supabase Free, el schema se aplica sin errores, pero la aplicación no funciona en absoluto. No hay ningún error evidente; el RLS simplemente bloquea todo.

**Impacto:**
- El sistema no funciona en ningun plan que no sea Pro
- El fallo es silencioso (no hay error de SQL al aplicar la migración)

**Solución recomendada:**
1. Documentar explícitamente el requisito Supabase Pro en el README y en el checklist de deploy
2. Agregar al schema un comentario de advertencia al inicio:

```sql
-- ⚠️  PREREQUISITO: Supabase Pro plan requerido.
-- Auth Hook (custom_access_token_hook) no está disponible en Free/Starter.
-- Sin el Auth Hook, NINGÚN usuario puede acceder a datos (RLS bloquea todo).
```

3. Implementar una función de verificación que la aplicación ejecute en el startup:

```sql
CREATE OR REPLACE FUNCTION public.verify_hook_configured()
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT (auth.jwt() -> 'app_metadata' ->> 'user_type') IS NOT NULL;
$$;
```

---

## ALTOS — Deben resolverse antes de go-live con usuarios reales

---

### A-01 — Falta índice en conversations.whatsapp_thread_id

**Descripción:**
El campo `whatsapp_thread_id` es el identificador de Meta para mantener la continuidad del hilo de conversación dentro de la ventana de 24 horas del customer service window de WhatsApp. El worker necesita hacer queries del tipo:

```sql
SELECT * FROM conversations WHERE whatsapp_thread_id = $1 AND tenant_id = $2;
```

Sin índice, esto es un sequential scan en la tabla de mayor crecimiento del sistema.

**Solución:**
```sql
CREATE INDEX idx_conversations_whatsapp_thread
  ON public.conversations(whatsapp_thread_id)
  WHERE whatsapp_thread_id IS NOT NULL;
```

---

### A-02 — Soft-delete en properties no cascadea a units

**Descripción:**
Cuando se soft-deletes una propiedad (`deleted_at` se setea), sus unidades siguen activas. El índice `idx_units_property` filtra `WHERE deleted_at IS NULL AND active = true`, por lo que las unidades de la propiedad eliminada aún aparecen como disponibles. El tool `search_properties()` de la IA podría recomendar unidades de una propiedad eliminada.

**Impacto:**
- Clientes reciben recomendaciones de propiedades eliminadas
- El panel de administración muestra unidades huérfanas

**Solución:**
Trigger AFTER UPDATE en properties:
```sql
CREATE OR REPLACE FUNCTION public.cascade_property_soft_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    UPDATE public.units
    SET deleted_at = NEW.deleted_at
    WHERE property_id = NEW.id AND deleted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cascade_property_soft_delete
  AFTER UPDATE ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.cascade_property_soft_delete();
```

---

### A-03 — tenant_users.branch_id no está restringido al mismo tenant

**Descripción:**
No existe ningún constraint que garantice que `tenant_users.branch_id` pertenece al mismo tenant que el usuario. Un bug de aplicación podría asignar a un recepcionista a la sucursal de otro tenant.

**Impacto:**
- El recepcionista vería las conversaciones y propiedades de la sucursal del otro tenant (si las políticas RLS filtran por branch_id)
- Cruce de datos entre tenants a través de la asignación de sucursal

**Solución:**
```sql
CREATE OR REPLACE FUNCTION public.check_user_branch_consistency()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_branch_tenant UUID;
BEGIN
  IF NEW.branch_id IS NULL THEN RETURN NEW; END IF;
  SELECT tenant_id INTO v_branch_tenant
  FROM public.branches WHERE id = NEW.branch_id;
  IF v_branch_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'branch_id must belong to the same tenant as the user';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tenant_users_branch_consistency
  BEFORE INSERT OR UPDATE ON public.tenant_users
  FOR EACH ROW EXECUTE FUNCTION public.check_user_branch_consistency();
```

---

### A-04 — is_cover sin unicidad por property/unit

**Descripción:**
Los campos `is_cover BOOLEAN` en `property_images` y `unit_images` no tienen ningún constraint que garantice que solo hay una imagen de portada por propiedad/unidad. Es posible insertar 10 imágenes con `is_cover = true` para la misma propiedad.

**Impacto:**
- Queries como `SELECT * FROM property_images WHERE property_id = $1 AND is_cover = true` retornan múltiples filas
- El frontend necesita manejar este caso con lógica de desambiguación
- Las actualizaciones de portada no garantizan exclusividad

**Solución:**
```sql
CREATE UNIQUE INDEX idx_property_images_one_cover
  ON public.property_images(property_id)
  WHERE is_cover = true;

CREATE UNIQUE INDEX idx_unit_images_one_cover
  ON public.unit_images(unit_id)
  WHERE is_cover = true;
```

---

### A-05 — message_queue sin mecanismo de timeout para items en 'processing'

**Descripción:**
El worker toma un item de la cola, cambia su status a `'processing'` y comienza a procesarlo. Si el worker muere (crash, timeout, reinicio), el item queda en `'processing'` indefinidamente. No hay campo `locked_until` ni `processing_started_at`. El próximo ciclo del worker no puede distinguir entre "siendo procesado activamente" y "stuck desde hace 2 horas".

**Impacto:**
- Mensajes de clientes nunca procesados (cliente no recibe respuesta del bot)
- Manual recovery necesario (UPDATE directo a la DB)

**Solución:**
Agregar `processing_started_at`:
```sql
ALTER TABLE public.message_queue
  ADD COLUMN processing_started_at TIMESTAMPTZ;
```

El worker recupera items stuck:
```sql
UPDATE message_queue
SET status = 'pending', attempts = attempts + 1, processing_started_at = NULL
WHERE status = 'processing'
  AND processing_started_at < now() - interval '5 minutes';
```

---

### A-06 — audit_table_change() puede bloquear operaciones legítimas si falla el INSERT

**Descripción:**
`audit_table_change()` ejecuta un INSERT en `audit_logs` dentro del trigger. Si ese INSERT falla por cualquier razón (disco lleno, constraint violation, deadlock interno), la excepción se propaga y la operación original (el UPDATE de una reserva, por ejemplo) también falla.

**Impacto:**
- Una falla en el sistema de auditoría bloquea operaciones de negocio críticas
- Un recepcionista no puede confirmar una reserva porque el audit log está lleno

**Solución:**
Capturar excepciones dentro del trigger:
```sql
BEGIN
  INSERT INTO public.audit_logs (...) VALUES (...);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'audit_table_change failed for % on %: %',
    TG_OP, TG_TABLE_NAME, SQLERRM;
  -- Nunca bloquear la operación original por falla de auditoría
END;
```

---

### A-07 — expires_at no se limpia cuando la reserva avanza de pre_reserved

**Descripción:**
El CHECK `reservations_expires_at_required` solo valida que si `status = 'pre_reserved'` entonces `expires_at IS NOT NULL`. No valida el caso inverso: si `status <> 'pre_reserved'`, `expires_at` puede ser `NULL` O puede tener un valor. Una reserva `confirmed` puede tener `expires_at = '2026-06-22 03:00:00'` en el futuro. El job de pg_cron filtra por `status = 'pre_reserved'`, así que no la cancela. Pero es un estado inconsistente que puede confundir queries y reportes futuros.

**Solución:**
Trigger BEFORE UPDATE en reservations:
```sql
CREATE OR REPLACE FUNCTION public.clear_expires_at_on_advance()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'pre_reserved' AND NEW.status <> 'pre_reserved' THEN
    NEW.expires_at = NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_clear_expires_at
  BEFORE UPDATE ON public.reservations
  FOR EACH ROW EXECUTE FUNCTION public.clear_expires_at_on_advance();
```

---

### A-08 — content_type en messages es TEXT sin validación

**Descripción:**
```sql
content_type TEXT NOT NULL DEFAULT 'text'
```

Cualquier string es válido: `'Text'`, `'TEXT'`, `'voz'`, `'mp3'`, `''`. Las queries que filtren por `content_type = 'image'` pueden fallar silenciosamente si alguien insertó `'Image'` por error.

**Impacto:**
- Filtros de contenido inconsistentes en el CRM
- El panel de "imágenes compartidas" puede no mostrar todas las imágenes

**Solución:**
```sql
content_type TEXT NOT NULL DEFAULT 'text'
  CHECK (content_type IN ('text', 'image', 'document', 'audio', 'video')),
```

O mejor, agregar un enum `message_content_type` (preferido para consistencia con el resto del schema).

---

### A-09 — Índices faltantes en notes y documents para queries por tenant_id

**Descripción:**
Las tablas `notes` y `documents` tienen `tenant_id` pero ningún índice sobre él. Las políticas RLS que filtren `WHERE tenant_id = public.auth_tenant_id()` harán sequential scans sobre estas tablas a medida que crecen.

**Solución:**
```sql
CREATE INDEX idx_notes_tenant
  ON public.notes(tenant_id, created_at DESC);

CREATE INDEX idx_documents_tenant
  ON public.documents(tenant_id);

CREATE INDEX idx_documents_property
  ON public.documents(property_id) WHERE property_id IS NOT NULL;

CREATE INDEX idx_documents_unit
  ON public.documents(unit_id) WHERE unit_id IS NOT NULL;
```

---

## MEDIOS — Deben resolverse antes de escalar a producción

---

### M-01 — email en platform_users puede desincronizarse de auth.users.email

**Descripción:**
`platform_users.email` es una copia del email en `auth.users`. Si el Super Admin cambia su email en Supabase Auth (posible vía dashboard de Supabase o API), `platform_users.email` no se actualiza. La UNIQUE constraint en `platform_users.email` también sería inconsistente con el estado real de auth.

**Solución:**
Opción 1 (recomendada): Eliminar `email` de `platform_users` y leerlo siempre de `auth.users` mediante una VIEW.

Opción 2: Trigger en `auth.users` AFTER UPDATE para sincronizar:
```sql
-- No siempre posible en Supabase sin elevated permissions
```

Opción 3 (MVP): Agregar un comentario explícito documentando el riesgo y validar en la capa de aplicación.

---

### M-02 — Comment incorrecto en platform_users.id

**Descripción:**
El `COMMENT ON COLUMN` dice `'No explicit FK to avoid schema coupling with auth schema'`, pero el código tiene `REFERENCES auth.users(id) ON DELETE CASCADE`. La documentación contradice el código.

**Solución:**
Corregir el comentario:
```sql
COMMENT ON COLUMN public.platform_users.id IS
  'Same UUID as auth.users.id. FK enforces cascade delete when auth user is removed.';
```

---

### M-03 — contacts sin constraintde al menos un método de contacto

**Descripción:**
Un contacto puede tener `phone = NULL` y `email = NULL`. Un contacto sin datos de contacto es inútil para WhatsApp y para CRM.

**Solución:**
```sql
CONSTRAINT contacts_must_have_contact_method CHECK (
  phone IS NOT NULL OR email IS NOT NULL
)
```

---

### M-04 — documents sin constraint de al menos una entidad referenciada

**Descripción:**
`documents.property_id` y `documents.unit_id` son ambos nullable sin ninguna validación de que al menos uno esté presente. Un documento sin contexto es un registro huérfano.

**Solución:**
```sql
CONSTRAINT documents_must_have_entity CHECK (
  property_id IS NOT NULL OR unit_id IS NOT NULL
)
```

---

### M-05 — set_conversation_closed_at no aplica en INSERT

**Descripción:**
El trigger `trg_conversation_closed_at` es `BEFORE UPDATE`. Si se inserta una conversación con `status = 'closed'` (ej: migración de datos históricos), `closed_at` queda `NULL`. El invariante no está garantizado para inserciones directas.

**Solución:**
Cambiar el trigger a `BEFORE INSERT OR UPDATE` y agregar el caso INSERT:
```sql
IF TG_OP = 'INSERT' AND NEW.status = 'closed' AND NEW.closed_at IS NULL THEN
  NEW.closed_at = now();
END IF;
```

---

### M-06 — custom_access_token_hook declarada STABLE (debería ser VOLATILE)

**Descripción:**
La función lee de `platform_users` y `tenant_users` que son tablas mutables. `STABLE` significa "retorna el mismo resultado para los mismos argumentos dentro de una query". Para tablas mutables, `VOLATILE` es el tipo de volatilidad correcto. Aunque en la práctica Supabase llama esta función una vez por login (no en contexto de query), la declaración incorrecta puede causar comportamiento inesperado si PostgreSQL decide cachear el resultado.

**Solución:**
```sql
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER  -- cambiado de STABLE a VOLATILE
...
```

---

### M-07 — whatsapp_accounts UNIQUE no es partial (bloquea reutilización del número tras deactivación)

**Descripción:**
`UNIQUE(tenant_id, phone_number)` es una constraint de tabla completa (no parcial). Si una cuenta de WhatsApp se desactiva (`active = false`) y se quiere registrar el mismo número nuevamente (por ejemplo, tras una migración de Meta), la constraint bloquea la inserción aunque la fila previa esté inactiva.

**Solución:**
Reemplazar la constraint de tabla con un índice parcial:
```sql
-- Eliminar constraint de tabla:
ALTER TABLE public.whatsapp_accounts
  DROP CONSTRAINT whatsapp_accounts_phone_unique;

-- Agregar índice parcial:
CREATE UNIQUE INDEX idx_whatsapp_accounts_phone_active
  ON public.whatsapp_accounts(tenant_id, phone_number)
  WHERE active = true;
```

---

### M-08 — Race condition en check_user_profile_exclusivity

**Descripción:**
La función `check_user_profile_exclusivity()` tiene una ventana de race condition: entre el `IF EXISTS (SELECT ...)` y el INSERT real, otra transacción concurrente podría insertar el mismo `id` en la otra tabla. El trigger no usa un mutex o transacción serializable.

En la práctica, esto requiere que dos procesos simultáneos intenten crear el mismo usuario auth en ambas tablas al mismo tiempo. El onboarding no lo haría, pero es una vulnerabilidad si el proceso de onboarding tiene un bug que intenta crear el usuario en paralelo.

**Solución para MVP:**
Agregar un índice que lo haga imposible a nivel de `auth.users`:
```sql
-- En auth.users existe user_metadata con tipo de perfil
-- La protección real es el trigger + unicidad del UUID de auth
```

En MVP, documentar el supuesto: el onboarding es secuencial y no paralelo.

---

### M-09 — Falta protección contra slug vacío en tenants

**Descripción:**
No hay `CHECK (slug <> '')` ni `CHECK (length(slug) >= 3)`. Un slug vacío o de un solo carácter causaría problemas de routing en el middleware de Next.js.

**Solución:**
```sql
CONSTRAINT tenants_slug_format CHECK (
  slug ~ '^[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$'
)
```

---

### M-10 — anon puede acceder a campos sensibles de tenants

**Descripción:**
```sql
GRANT SELECT ON public.tenants TO anon;
```

El sitio público necesita leer `name`, `slug`, `logo_url`, `primary_color`, `secondary_color`, `site_config`. Pero `tenants` también tiene `plan`, `trial_ends_at`, `max_properties`, `max_users`. Con el GRANT actual y una política RLS permisiva para anon, estos campos serían expuestos.

**Solución:**
Crear una VIEW para acceso anónimo:
```sql
CREATE VIEW public.tenants_public AS
  SELECT id, name, slug, logo_url, primary_color, secondary_color, site_config, custom_domain
  FROM public.tenants
  WHERE deleted_at IS NULL;

GRANT SELECT ON public.tenants_public TO anon;
REVOKE SELECT ON public.tenants FROM anon;
```

---

### M-11 — impersonation_sessions tiene started_at y created_at redundantes

**Descripción:**
Ambos son `NOT NULL DEFAULT now()` y siempre tendrán el mismo valor al crear la fila. `started_at` es el campo semántico correcto; `created_at` es redundante.

**Solución:**
Eliminar `created_at` de `impersonation_sessions`:
```sql
-- Solo conservar started_at como campo de creation time
```

---

## BAJOS — Mejoras recomendadas para producción madura

---

### B-01 — idx_platform_users_email es redundante con el UNIQUE constraint

**Descripción:**
La tabla tiene `CONSTRAINT platform_users_email_unique UNIQUE (email)` que crea un índice full. El `idx_platform_users_email` partial (`WHERE active = true`) es adicional pero mayormente redundante para lookups de email (el UNIQUE index ya los sirve).

**Acción:** Evaluar si el índice parcial aporta suficiente beneficio para justificar el overhead de mantenimiento. Para MVP con pocas decenas de platform_users, eliminarlo simplifica el schema.

---

### B-02 — idx_tenant_users_tenant parcialmente redundante con idx_tenant_users_tenant_role

**Descripción:**
`idx_tenant_users_tenant` indexa `(tenant_id)`. `idx_tenant_users_tenant_role` indexa `(tenant_id, role)`. PostgreSQL puede usar el índice compuesto como prefijo para queries que solo filtran por `tenant_id`. El índice simple puede ser redundante.

**Acción:** Eliminar `idx_tenant_users_tenant` y verificar con `EXPLAIN` que el optimizador usa el compuesto.

---

### B-03 — commission_percentage sin valor por defecto

**Descripción:**
`commission_percentage NUMERIC(5,2)` es nullable sin default. Si el Vendedor crea un cliente sin especificar comisión, el campo queda NULL. Futuros reportes de comisiones necesitarán manejar el caso NULL explícitamente.

**Solución:**
```sql
commission_percentage NUMERIC(5,2) DEFAULT 0.00
  CHECK (commission_percentage >= 0 AND commission_percentage <= 100),
```

---

### B-04 — notify_message_queue_worker sin SET search_path

**Descripción:**
La función `notify_message_queue_worker` es `SECURITY DEFINER` pero no tiene `SET search_path = public, pg_catalog`. Aunque el riesgo concreto de inyección via search_path es bajo aquí (solo usa `pg_notify` que está en `pg_catalog`), la omisión es inconsistente con el resto de las funciones `SECURITY DEFINER`.

**Solución:**
```sql
CREATE OR REPLACE FUNCTION public.notify_message_queue_worker()
RETURNS TRIGGER LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM pg_notify('message_queue_new', NEW.id::TEXT);
  RETURN NEW;
END;
$$;
```

---

### B-05 — audit_logs no tiene FK para actor_id

**Descripción:**
`actor_id UUID NOT NULL` (después de aplicar C-01, pasará a nullable) no tiene FK hacia ninguna tabla. Esto es intencional para preservar el audit log cuando un usuario se elimina, pero significa que no hay integridad referencial verificable. Un actor_id podría ser un UUID inexistente si hay un bug.

**Acción aceptada para MVP:** Documentar el supuesto y agregar un comentario explicativo. No agregar FK (es la decisión correcta para inmutabilidad del audit log).

---

### B-06 — Falta extensión btree_gist en SECTION 1

**Descripción:**
La solución de C-02 (EXCLUSION constraint) requiere `CREATE EXTENSION IF NOT EXISTS "btree_gist"`. Esta extensión no está en la sección de Extensions del schema actual.

**Solución:**
Agregar en Section 1:
```sql
CREATE EXTENSION IF NOT EXISTS "btree_gist";
```

---

## Safe To Deploy Checklist

Verificar **en este orden** antes de ejecutar el schema en Supabase:

### Prerequisitos de Infraestructura

- [ ] **El proyecto Supabase es plan Pro o superior** (requerido para Auth Hooks)
- [ ] Acceso al Supabase Dashboard con permisos de administrador
- [ ] Backup del proyecto (si hay datos previos) antes de aplicar la migración

### Prerequisitos de Configuración

- [ ] Supabase Vault configurado con la clave para `access_token_encrypted`
- [ ] El proyecto tiene habilitado el Auth Hook `custom_access_token_hook` en Dashboard → Authentication → Hooks → Custom Access Token Hook

### Verificaciones del Schema (ejecutar en Supabase SQL Editor antes del deploy)

- [ ] Verificar que `btree_gist` es instalable:
  ```sql
  SELECT * FROM pg_available_extensions WHERE name = 'btree_gist';
  ```
- [ ] Verificar que `auth.users` existe y es accesible:
  ```sql
  SELECT count(*) FROM auth.users LIMIT 1;
  ```
- [ ] Verificar que no existen enums conflictivos con los mismos nombres:
  ```sql
  SELECT typname FROM pg_type WHERE typtype = 'e'
    AND typname IN ('platform_role','tenant_role','reservation_status');
  ```
- [ ] Verificar que no existen tablas con los mismos nombres:
  ```sql
  SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    AND tablename IN ('tenants','platform_users','messages','reservations');
  ```

### Correcciones CRÍTICAS que deben aplicarse ANTES del deploy

- [ ] **C-01 aplicado:** `audit_logs.actor_id` es nullable Y `audit_table_change()` maneja `auth.uid() IS NULL`
- [ ] **C-02 aplicado:** Extensión `btree_gist` agregada Y EXCLUSION constraint en `availability_blocks`
- [ ] **C-03 aplicado:** Trigger `trg_units_tenant_consistency` creado
- [ ] **C-04 aplicado:** GRANTs granulares reemplazan el GRANT masivo
- [ ] **C-05 documentado:** Prerequisito de Supabase Pro registrado en el README del proyecto

### Verificaciones Post-Deploy (ejecutar inmediatamente después)

- [ ] Verificar que RLS está habilitado en todas las tablas:
  ```sql
  SELECT tablename, rowsecurity
  FROM pg_tables
  WHERE schemaname = 'public' AND rowsecurity = false;
  -- Resultado esperado: 0 filas
  ```
- [ ] Verificar que la función hook existe:
  ```sql
  SELECT routine_name FROM information_schema.routines
  WHERE routine_schema = 'public'
    AND routine_name = 'custom_access_token_hook';
  ```
- [ ] Verificar que todos los índices se crearon correctamente:
  ```sql
  SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
  ORDER BY indexname;
  -- Deben aparecer todos los idx_ definidos en el schema
  ```
- [ ] Verificar el EXCLUSION constraint (después de aplicar C-02):
  ```sql
  SELECT conname FROM pg_constraint
  WHERE conrelid = 'public.availability_blocks'::regclass
    AND contype = 'x';
  -- Debe aparecer: no_double_booking
  ```
- [ ] Probar el Auth Hook con un login de prueba y verificar JWT claims:
  ```sql
  -- En la aplicación, hacer login y verificar que el JWT contiene:
  -- app_metadata.user_type, app_metadata.tenant_id (si aplica), app_metadata.role
  ```
- [ ] Verificar que el trigger de expiración no bloquea updates de service_role:
  ```sql
  -- Con service_role key, ejecutar:
  UPDATE public.reservations
  SET status = 'cancelled'
  WHERE id = (SELECT id FROM reservations WHERE status = 'inquiry' LIMIT 1);
  -- No debe lanzar error
  ```
- [ ] Verificar que no hay tablas accesibles sin RLS policy para `anon`:
  ```sql
  -- Intentar desde anon key:
  SELECT id FROM public.platform_users LIMIT 1;
  -- Resultado esperado: 0 filas (RLS bloquea)
  SELECT id FROM public.audit_logs LIMIT 1;
  -- Resultado esperado: 0 filas (RLS bloquea)
  ```
- [ ] Verificar que `pg_cron` está habilitado (Supabase lo incluye en Pro):
  ```sql
  SELECT * FROM cron.job LIMIT 1;
  ```

### Verificaciones de Negocio (antes de habilitar usuarios)

- [ ] Crear un tenant de prueba y verificar que el slug genera el subdominio correcto
- [ ] Crear un usuario Owner de prueba, hacer login y verificar que el JWT tiene los claims correctos
- [ ] Crear una propiedad y unidad bajo ese tenant y verificar que no son visibles bajo otro tenant
- [ ] Simular una pre-reserva y verificar que `availability_blocks` tiene el registro correcto
- [ ] Cancelar la reserva y verificar que `availability_blocks` se eliminó (trigger de release)
- [ ] Simular el expiry job manualmente y verificar que funciona sin errores:
  ```sql
  UPDATE public.reservations
  SET status = 'cancelled'
  WHERE status = 'pre_reserved' AND expires_at < now();
  ```

---

## Veredicto Final

### **C — Requires Significant Changes**

**Justificación:**

El schema es sintácticamente correcto y puede ejecutarse en Supabase sin errores de sintaxis. La arquitectura general es sólida: la separación de platform_users/tenant_users es correcta, los índices cubren los queries críticos, los triggers de business logic son apropiados, y el diseño JSONB para atributos de propiedades es la decisión correcta.

Sin embargo, **dos issues CRÍTICOS son bloqueantes para producción:**

**C-01 (actor_id NOT NULL)** es un bug operacional que se manifestará el primer día que el job de pg_cron intente expirar una pre-reserva. No es un problema teórico: fallará en producción. Las pre-reservas acumularán bloqueos de fechas que nunca se liberan, causando double-bookings y deterioro progresivo del calendario de disponibilidad.

**C-02 (race condition de double-booking)** es un defecto de integridad referencial en un sistema de reservas. Sin el EXCLUSION constraint, dos usuarios que consultan simultáneamente la misma unidad pueden crear una doble reserva. Aunque la probabilidad es baja en MVP con pocos usuarios, el impacto cuando ocurra es crítico para el negocio del tenant.

**Estas dos correcciones son cambios de 20-30 líneas de SQL.** No requieren rediseño del schema. Una vez aplicadas (junto con los items ALTOS más urgentes: A-01, A-02, A-03), el schema pasa a **B — Ready with minor fixes**.

**Tiempo estimado para corregir todos los CRÍTICOS y ALTOS prioritarios:** 2-4 horas de trabajo.

**Recomendación:** Generar `10b-supabase-schema-fixes.sql` con las correcciones antes de ejecutar el schema completo.
