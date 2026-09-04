# OrderFlow — Permisos y Row Level Security

**Versión:** 2.0
**Fecha:** 2026-06-22
**Audience:** Backend Engineers / Database Administrators

---

## 1. Arquitectura de Roles

OrderFlow tiene dos tipos de usuarios estructuralmente distintos:

### Usuarios de Plataforma (tabla: `platform_users`)

Son empleados de OrderFlow. No pertenecen a ningún tenant.

| Rol | Descripción | Scope |
|---|---|---|
| `super_admin` | Control total del sistema | Global — todos los tenants |
| `seller` | Vendedor que gestiona clientes | Sus tenants asignados via `seller_clients` |

### Usuarios de Tenant (tabla: `tenant_users`)

Son empleados de cada inmobiliaria cliente.

| Rol | Descripción | Scope |
|---|---|---|
| `owner` | Dueño de la inmobiliaria | Su tenant completo |
| `receptionist` | Operador comercial | Su tenant; opcionalmente su sucursal |

---

## 2. JWT Custom Claims

Supabase Auth incluye claims adicionales en el JWT de cada usuario. Esto permite que las políticas RLS los lean directamente sin hacer JOINs a las tablas de perfil en cada query.

Se implementa via **Auth Hook** (`custom_access_token_hook`) que se ejecuta en el login.

### Claims para tenant_users

```json
{
  "sub": "auth-user-uuid",
  "email": "user@example.com",
  "app_metadata": {
    "user_type": "tenant_user",
    "tenant_id": "uuid-del-tenant",
    "role": "owner",
    "branch_id": "uuid-o-null"
  }
}
```

### Claims para platform_users

```json
{
  "sub": "auth-user-uuid",
  "email": "admin@orderflow.app",
  "app_metadata": {
    "user_type": "platform_user",
    "role": "super_admin"
  }
}
```

### Funciones helper en PostgreSQL

Estas funciones extraen claims del JWT para uso en políticas RLS. Son extremadamente eficientes porque leen del JWT en memoria, sin tocar la DB.

```sql
-- Tipo de usuario (platform_user | tenant_user)
CREATE OR REPLACE FUNCTION auth.user_type()
RETURNS TEXT
LANGUAGE SQL STABLE
AS $$
  SELECT (auth.jwt() -> 'app_metadata' ->> 'user_type')
$$;

-- Tenant ID del usuario actual (NULL para platform_users)
CREATE OR REPLACE FUNCTION auth.tenant_id()
RETURNS UUID
LANGUAGE SQL STABLE
AS $$
  SELECT (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::UUID
$$;

-- Rol del usuario actual
CREATE OR REPLACE FUNCTION auth.user_role()
RETURNS TEXT
LANGUAGE SQL STABLE
AS $$
  SELECT (auth.jwt() -> 'app_metadata' ->> 'role')
$$;

-- Branch ID (NULL si el usuario tiene acceso a todas las sucursales)
CREATE OR REPLACE FUNCTION auth.branch_id()
RETURNS UUID
LANGUAGE SQL STABLE
AS $$
  SELECT (auth.jwt() -> 'app_metadata' ->> 'branch_id')::UUID
$$;

-- ¿Es Super Admin?
CREATE OR REPLACE FUNCTION auth.is_super_admin()
RETURNS BOOLEAN
LANGUAGE SQL STABLE
AS $$
  SELECT auth.user_role() = 'super_admin'
$$;

-- ¿Es Owner de su tenant?
CREATE OR REPLACE FUNCTION auth.is_owner()
RETURNS BOOLEAN
LANGUAGE SQL STABLE
AS $$
  SELECT auth.user_type() = 'tenant_user' AND auth.user_role() = 'owner'
$$;
```

---

## 3. Estrategia RLS por Tabla

### Principios generales

1. **Toda tabla comercial tiene RLS habilitada.** No hay excepciones.
2. **Los workers (webhook handler, AI worker) usan `service_role`**, que bypassa RLS. Esto es correcto porque son procesos server-side bajo nuestro control. Siempre operan con `tenant_id` explícito.
3. **Super Admin NUNCA bypassa RLS directamente.** Usa impersonación auditada.
4. **El Vendedor opera a nivel de plataforma** y solo puede ver tenants en su `seller_clients`.

---

### tenants

```sql
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

-- Super Admin: ve todos los tenants activos
CREATE POLICY "super_admin_all_tenants" ON tenants
FOR ALL TO authenticated
USING (auth.is_super_admin())
WITH CHECK (auth.is_super_admin());

-- Seller: solo ve sus tenants asignados
CREATE POLICY "seller_assigned_tenants" ON tenants
FOR SELECT TO authenticated
USING (
  auth.user_type() = 'platform_user'
  AND auth.user_role() = 'seller'
  AND id IN (
    SELECT tenant_id FROM seller_clients
    WHERE seller_id = auth.uid() AND active = true
  )
);

-- Owner: ve y edita solo su propio tenant
CREATE POLICY "owner_own_tenant" ON tenants
FOR SELECT TO authenticated
USING (
  auth.user_type() = 'tenant_user'
  AND id = auth.tenant_id()
);

CREATE POLICY "owner_update_tenant" ON tenants
FOR UPDATE TO authenticated
USING (
  auth.is_owner()
  AND id = auth.tenant_id()
)
WITH CHECK (
  auth.is_owner()
  AND id = auth.tenant_id()
);
```

---

### tenant_users

```sql
ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;

-- Cualquier tenant_user ve a los miembros de su mismo tenant
CREATE POLICY "tenant_users_same_tenant" ON tenant_users
FOR SELECT TO authenticated
USING (
  auth.user_type() = 'tenant_user'
  AND tenant_id = auth.tenant_id()
);

-- Solo el Owner puede crear recepcionistas en su tenant
CREATE POLICY "owner_create_users" ON tenant_users
FOR INSERT TO authenticated
WITH CHECK (
  auth.is_owner()
  AND tenant_id = auth.tenant_id()
  AND role = 'receptionist'  -- el owner no puede crear otros owners vía API
);

-- Owner puede actualizar usuarios de su tenant
CREATE POLICY "owner_update_users" ON tenant_users
FOR UPDATE TO authenticated
USING (
  auth.is_owner()
  AND tenant_id = auth.tenant_id()
);

-- Super Admin: ve todos
CREATE POLICY "super_admin_platform_users" ON tenant_users
FOR ALL TO authenticated
USING (auth.is_super_admin())
WITH CHECK (auth.is_super_admin());
```

---

### properties

```sql
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;

-- Tenant users: solo su tenant (+ branch filter para receptionist con branch)
CREATE POLICY "tenant_properties" ON properties
FOR ALL TO authenticated
USING (
  auth.user_type() = 'tenant_user'
  AND tenant_id = auth.tenant_id()
  AND deleted_at IS NULL
  AND (
    auth.branch_id() IS NULL  -- owner o receptionist sin branch asignada
    OR branch_id = auth.branch_id()  -- receptionist con branch asignada
    OR branch_id IS NULL  -- propiedades sin sucursal específica
  )
)
WITH CHECK (
  auth.user_type() = 'tenant_user'
  AND tenant_id = auth.tenant_id()
);

-- Sitio público: propiedades publicadas (acceso anónimo)
CREATE POLICY "public_published_properties" ON properties
FOR SELECT TO anon
USING (published = true AND deleted_at IS NULL);
```

---

### units

```sql
ALTER TABLE units ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_units" ON units
FOR ALL TO authenticated
USING (
  auth.user_type() = 'tenant_user'
  AND tenant_id = auth.tenant_id()
  AND deleted_at IS NULL
)
WITH CHECK (
  auth.user_type() = 'tenant_user'
  AND tenant_id = auth.tenant_id()
);

-- Sitio público: unidades activas de propiedades publicadas
CREATE POLICY "public_units" ON units
FOR SELECT TO anon
USING (
  active = true
  AND deleted_at IS NULL
  AND property_id IN (
    SELECT id FROM properties WHERE published = true AND deleted_at IS NULL
  )
);
```

---

### contacts

```sql
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_contacts" ON contacts
FOR ALL TO authenticated
USING (
  auth.user_type() = 'tenant_user'
  AND tenant_id = auth.tenant_id()
  AND deleted_at IS NULL
)
WITH CHECK (
  auth.user_type() = 'tenant_user'
  AND tenant_id = auth.tenant_id()
);
```

---

### conversations

```sql
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

-- Owner: todas las conversaciones del tenant
CREATE POLICY "owner_all_conversations" ON conversations
FOR ALL TO authenticated
USING (
  auth.is_owner()
  AND tenant_id = auth.tenant_id()
)
WITH CHECK (
  auth.is_owner()
  AND tenant_id = auth.tenant_id()
);

-- Receptionist: todas las del tenant (o filtradas por branch si tiene branch asignada)
CREATE POLICY "receptionist_conversations" ON conversations
FOR ALL TO authenticated
USING (
  auth.user_type() = 'tenant_user'
  AND auth.user_role() = 'receptionist'
  AND tenant_id = auth.tenant_id()
  AND (
    auth.branch_id() IS NULL
    OR branch_id = auth.branch_id()
    OR branch_id IS NULL
  )
)
WITH CHECK (
  auth.user_type() = 'tenant_user'
  AND auth.user_role() = 'receptionist'
  AND tenant_id = auth.tenant_id()
);
```

**Nota:** La asignación de conversaciones a usuarios valida que `assigned_user_id` pertenezca al mismo tenant. Esta validación ocurre en la capa de aplicación mediante una función que verifica la FK cruzada antes de hacer UPDATE.

---

### messages

```sql
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Tenant users: mensajes de conversaciones de su tenant
CREATE POLICY "tenant_messages" ON messages
FOR SELECT TO authenticated
USING (
  auth.user_type() = 'tenant_user'
  AND tenant_id = auth.tenant_id()
);

-- INSERT: solo via service_role (webhook handler y AI worker)
-- Los usuarios del tenant NO insertan mensajes directamente vía API pública
-- Existe un endpoint dedicado: POST /api/conversations/{id}/messages
-- que valida permisos en la capa de aplicación antes de insertar con service_role

-- Nota: esta política permite INSERT a tenant_users para el caso del chat manual (humano responde)
CREATE POLICY "tenant_user_send_message" ON messages
FOR INSERT TO authenticated
WITH CHECK (
  auth.user_type() = 'tenant_user'
  AND tenant_id = auth.tenant_id()
  AND sender_type = 'human'
  AND sender_id = auth.uid()
);
```

---

### reservations

```sql
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;

-- Tenant users: todas las reservas de su tenant
CREATE POLICY "tenant_reservations" ON reservations
FOR ALL TO authenticated
USING (
  auth.user_type() = 'tenant_user'
  AND tenant_id = auth.tenant_id()
  AND deleted_at IS NULL
)
WITH CHECK (
  auth.user_type() = 'tenant_user'
  AND tenant_id = auth.tenant_id()
);
```

---

### availability_blocks

```sql
ALTER TABLE availability_blocks ENABLE ROW LEVEL SECURITY;

-- Tenant users: bloqueos de su tenant
CREATE POLICY "tenant_availability" ON availability_blocks
FOR ALL TO authenticated
USING (
  auth.user_type() = 'tenant_user'
  AND tenant_id = auth.tenant_id()
)
WITH CHECK (
  auth.user_type() = 'tenant_user'
  AND tenant_id = auth.tenant_id()
);

-- Sitio público: verificación de disponibilidad (solo lectura)
CREATE POLICY "public_availability_check" ON availability_blocks
FOR SELECT TO anon
USING (true);  -- filtrado por unit_id en la query; no expone datos sensibles
```

---

### tasks y notes

```sql
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_tasks" ON tasks
FOR ALL TO authenticated
USING (
  auth.user_type() = 'tenant_user'
  AND tenant_id = auth.tenant_id()
)
WITH CHECK (
  auth.user_type() = 'tenant_user'
  AND tenant_id = auth.tenant_id()
);

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_notes" ON notes
FOR ALL TO authenticated
USING (
  auth.user_type() = 'tenant_user'
  AND tenant_id = auth.tenant_id()
)
WITH CHECK (
  auth.user_type() = 'tenant_user'
  AND tenant_id = auth.tenant_id()
);
```

---

### audit_logs

```sql
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Owner: ve el audit log de su tenant
CREATE POLICY "owner_audit_logs" ON audit_logs
FOR SELECT TO authenticated
USING (
  auth.is_owner()
  AND tenant_id = auth.tenant_id()
);

-- Super Admin: ve todos los logs
CREATE POLICY "super_admin_audit_logs" ON audit_logs
FOR SELECT TO authenticated
USING (auth.is_super_admin());

-- INSERT: solo via service_role (la aplicación inserta logs)
-- Nadie puede insertar audit_logs directamente via API
-- Nadie puede UPDATE ni DELETE audit_logs
```

---

### notifications, whatsapp_accounts, ai_settings

```sql
-- notifications: owner administra, receptionist solo lee las suyas
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_notifications" ON notifications
FOR ALL TO authenticated
USING (
  auth.is_owner() AND tenant_id = auth.tenant_id()
)
WITH CHECK (
  auth.is_owner() AND tenant_id = auth.tenant_id()
);

CREATE POLICY "receptionist_notifications" ON notifications
FOR SELECT TO authenticated
USING (
  auth.user_role() = 'receptionist'
  AND tenant_id = auth.tenant_id()
  AND recipient_id = auth.uid()
);

-- whatsapp_accounts: solo owner
ALTER TABLE whatsapp_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_whatsapp_accounts" ON whatsapp_accounts
FOR ALL TO authenticated
USING (auth.is_owner() AND tenant_id = auth.tenant_id())
WITH CHECK (auth.is_owner() AND tenant_id = auth.tenant_id());

-- ai_settings: solo owner
ALTER TABLE ai_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_ai_settings" ON ai_settings
FOR ALL TO authenticated
USING (auth.is_owner() AND tenant_id = auth.tenant_id())
WITH CHECK (auth.is_owner() AND tenant_id = auth.tenant_id());
```

---

## 4. Impersonación Auditada del Super Admin

### 4.1 Problema

El Super Admin necesita acceder a los datos de cualquier tenant para brindar soporte. Si esto se implementa como un bypass de RLS, cualquier bug en el código del panel de Super Admin expone datos de todos los tenants simultáneamente.

### 4.2 Diseño de la Impersonación

La impersonación crea un JWT de corta duración con el contexto del tenant objetivo. Bajo este JWT, el Super Admin opera con las mismas restricciones RLS que tendría el Owner del tenant, pero con una marca `impersonated_by` en cada operación.

**Flujo:**

```
1. Super Admin → POST /api/admin/impersonate
   Body: { tenant_id: "uuid", reason: "soporte ticket #123" }

2. Validaciones:
   - Caller tiene role = 'super_admin'
   - El tenant existe y no está deleted
   - No hay sesión de impersonación activa para este SA + tenant (prevención de stacking)

3. INSERT INTO impersonation_sessions (
     platform_user_id, target_tenant_id, reason, ip_address
   )

4. Generar JWT especial (30 minutos de vida):
   {
     "sub": "super-admin-uuid",
     "user_type": "tenant_user",     -- opera como tenant_user
     "tenant_id": "target-uuid",     -- con tenant del objetivo
     "role": "owner",                -- con permisos de owner
     "impersonated_by": "sa-uuid",   -- marca de impersonación
     "impersonation_session_id": "session-uuid"
   }

5. Toda operación con este JWT:
   - Pasa RLS como si fuera el owner del tenant
   - audit_logs.impersonated_by = "sa-uuid" (seteado via trigger)

6. Super Admin → POST /api/admin/impersonate/end
   → UPDATE impersonation_sessions SET ended_at = now()
   → El JWT expira en 30 min de todos modos
```

### 4.3 Trigger de Auditoría Automática

Un trigger en las tablas principales detecta si la sesión es de impersonación y enriquece el `audit_log`:

```sql
CREATE OR REPLACE FUNCTION audit_impersonation_trigger()
RETURNS TRIGGER AS $$
DECLARE
  impersonated_by_uuid UUID;
BEGIN
  impersonated_by_uuid := (auth.jwt() -> 'app_metadata' ->> 'impersonated_by')::UUID;

  IF impersonated_by_uuid IS NOT NULL THEN
    INSERT INTO audit_logs (
      tenant_id, user_id, user_type, impersonated_by,
      action, entity_type, entity_id, old_value, new_value
    ) VALUES (
      NEW.tenant_id,
      auth.uid(),
      'tenant_user',  -- opera como tenant_user bajo impersonación
      impersonated_by_uuid,
      TG_OP,
      TG_TABLE_NAME,
      NEW.id,
      to_jsonb(OLD),
      to_jsonb(NEW)
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 4.4 Límites de la Impersonación

- Duración máxima: 30 minutos por sesión
- No puede crear otras sesiones de impersonación (no escalation)
- No puede acceder a `platform_users` ni `audit_logs` de plataforma (solo del tenant)
- Todas las acciones quedan en `audit_logs` con `impersonated_by` visible para el Owner
- El Owner del tenant puede ver en su audit log cuándo y por qué fue accedido

---

## 5. Permisos por Rol — Resumen Operacional

### Super Admin

| Operación | Permitido | Mecanismo |
|---|---|---|
| Ver todos los tenants | ✓ | RLS policy |
| Crear/suspender tenants | ✓ | RLS policy |
| Acceder a datos de tenant | ✓ solo via impersonación | JWT impersonación |
| Ver métricas globales | ✓ | Queries con service_role en endpoint dedicado |
| Crear platform_users | ✓ | RLS policy |
| Ver/modificar datos de otro SA | ✗ | No política definida (requiere consenso) |

### Vendedor

| Operación | Permitido | Mecanismo |
|---|---|---|
| Ver tenants asignados | ✓ | RLS via seller_clients |
| Crear nuevos tenants | ✓ | Endpoint dedicado valida + registra en seller_clients |
| Suspender tenants | ✓ solo sus asignados | Validación en capa de aplicación + RLS |
| Ver conversaciones internas | ✗ | Sin acceso a datos del tenant |
| Ver comisiones propias | ✓ | RLS en seller_clients WHERE seller_id = uid() |

### Dueño

| Operación | Permitido | Mecanismo |
|---|---|---|
| Acceso completo a su tenant | ✓ | RLS policy |
| Crear/desactivar recepcionistas | ✓ | RLS con role check |
| Crear sucursales | ✓ | RLS policy |
| Configurar IA y WhatsApp | ✓ | RLS policy (solo owner) |
| Eliminar propiedades (soft) | ✓ | RLS policy |
| Ver audit log de su tenant | ✓ | RLS policy |
| Acceder a otro tenant | ✗ | RLS estricta |

### Recepcionista

| Operación | Permitido | Mecanismo |
|---|---|---|
| Ver y responder conversaciones | ✓ | RLS policy (con branch filter opcional) |
| Crear y editar propiedades | ✓ | RLS policy |
| Eliminar propiedades | ✗ | No hay WITH CHECK para DELETE |
| Gestionar reservas | ✓ | RLS policy |
| Confirmar/cancelar reservas | ✓ | Validación en capa de aplicación |
| Configurar IA o WhatsApp | ✗ | Policies solo para owner |
| Ver audit log | ✗ | No hay policy SELECT para receptionist |
| Modificar configuraciones globales | ✗ | Policies solo para owner |

---

## 6. Service Role — Usos Permitidos

Los siguientes componentes usan `service_role` (bypass de RLS) y están documentados aquí como accesos autorizados explícitos:

| Componente | Acceso service_role | Justificación |
|---|---|---|
| Webhook handler | INSERT message_queue, UPDATE conversations | Procesa webhooks antes de identificar tenant completo |
| AI Worker | READ/WRITE messages, conversations, reservations, contacts | Backend process, no expuesto al usuario |
| Job de limpieza de pre-reservas | UPDATE reservations, DELETE availability_blocks | Proceso batch nocturno |
| Job de archivado de mensajes | INSERT messages_archive, DELETE messages | Proceso batch mensual |
| Auth Hook (custom claims) | READ platform_users, tenant_users | Ejecutado por Supabase al hacer login |
| Endpoint de métricas Super Admin | SELECT agregado cross-tenant | Endpoint protegido, solo SA |

**Regla:** Todo uso de `service_role` debe estar documentado aquí. Nunca exponer la `service_role` key en el frontend.

---

## 7. Validaciones en Capa de Aplicación

Algunas validaciones no pueden expresarse en RLS (porque involucran múltiples tablas o lógica de negocio) y se implementan en la capa de aplicación:

### 7.1 Asignación de conversación a usuario del mismo tenant

```
Antes de UPDATE conversations SET assigned_user_id = :uid:
→ SELECT COUNT(*) FROM tenant_users WHERE id = :uid AND tenant_id = :conversation.tenant_id
→ Si 0 → HTTP 400 "Usuario no pertenece a este tenant"
```

### 7.2 Límite de propiedades por plan

```
Antes de INSERT INTO properties:
→ SELECT COUNT(*) FROM properties WHERE tenant_id = :tid AND deleted_at IS NULL
→ SELECT max_properties FROM tenants WHERE id = :tid
→ Si count >= max_properties → HTTP 402 "Límite del plan alcanzado"
```

### 7.3 Confirmar reserva solo cuando hay availability_block

```
Antes de UPDATE reservations SET status = 'confirmed':
→ SELECT COUNT(*) FROM availability_blocks WHERE reservation_id = :rid
→ Si 0 → Error: "No hay bloqueo de fechas asociado a esta reserva"
```

### 7.4 Cancelación de reserva libera availability_block

```
UPDATE reservations SET status = 'cancelled', deleted_at = now()
→ (trigger o application logic) DELETE FROM availability_blocks WHERE reservation_id = :rid
```

### 7.5 Scope del Vendedor en suspend

```
Antes de UPDATE tenants SET status = 'suspended':
→ Si caller es seller → SELECT COUNT(*) FROM seller_clients WHERE seller_id = :uid AND tenant_id = :tid AND active = true
→ Si 0 → HTTP 403 "Tenant no asignado a este vendedor"
```

---

## 8. Política de Auditoría Automática

Un trigger genérico registra cambios en las tablas más críticas. Se implementa en las siguientes tablas:

- `reservations` — toda creación, cambio de estado
- `tenant_users` — creación, desactivación
- `tenants` — cambios de estado, plan
- `properties` — publicación, eliminación
- `ai_settings` — cambios de configuración
- `whatsapp_accounts` — cambios de configuración

El trigger captura `OLD` y `NEW` como JSONB y los inserta en `audit_logs` con el contexto del usuario actual (via `auth.uid()` y claims del JWT).

---

## 9. Acceso Anónimo (Sitio Público)

El sitio web público de cada tenant usa el **anon key** de Supabase. Las políticas permiten:

| Tabla | Acceso anon | Condición |
|---|---|---|
| `properties` | SELECT | `published = true AND deleted_at IS NULL` |
| `units` | SELECT | `active = true AND deleted_at IS NULL` (join a property published) |
| `unit_images` | SELECT | Via unit activo |
| `property_images` | SELECT | Via property publicada |
| `availability_blocks` | SELECT | Solo `start_date`, `end_date`, `unit_id` (sin campos sensibles) |
| `tenants` | SELECT | Solo `name`, `slug`, `logo_url`, `primary_color`, `secondary_color`, `site_config` |

**El anon key nunca tiene acceso a:** contacts, conversations, messages, reservations, tasks, notes, audit_logs, whatsapp_accounts, ai_settings, tenant_users.

---

## 10. Checklist de Seguridad Pre-Deploy

Antes de ir a producción, verificar:

- [ ] RLS habilitado en todas las tablas (`SELECT tablename FROM pg_tables WHERE schemaname = 'public'` vs `SELECT tablename FROM pg_tables WHERE rowsecurity = true`)
- [ ] No hay ninguna tabla comercial sin al menos una política RLS
- [ ] `service_role` key no está en variables de entorno del frontend
- [ ] `anon key` en el frontend tiene RLS restrictiva verificada
- [ ] Auth Hook de custom claims deployado y testeado con cada combinación de rol
- [ ] JWT expiration configurado en 1 hora (no más)
- [ ] Refresh token rotation habilitada en Supabase
- [ ] Impersonation sessions tienen expiración automatica (pg_cron o check en login)
- [ ] `audit_logs` no tiene política DELETE ni UPDATE para ningún rol
- [ ] Todos los accesos con `service_role` están documentados en la sección 6
