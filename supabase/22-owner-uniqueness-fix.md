# 22 — Owner Uniqueness Fix

## Problema original

La validación de "un solo owner por tenant" era exclusivamente a nivel de aplicación:

```typescript
// actions/users.ts
const ownerCount = await repo.countActiveOwners(tenantId)
if (ownerCount >= 1) return { success: false, error: '...' }
// ← gap here
const user = await repo.createTenantUser(tenantId, ...)
```

El check y el insert son operaciones distintas, no atómicas.

## Escenario de carrera (TOCTOU)

```
Request A                         Request B
─────────────────────────────     ─────────────────────────────
countActiveOwners → 0  ✓
                                  countActiveOwners → 0  ✓
createTenantUser (owner) → OK
                                  createTenantUser (owner) → OK  ← segundo owner creado
```

Ambos requests leen 0 owners, ambos pasan el check, ambos insertan. Resultado: dos owners activos en el mismo tenant. Ningún mecanismo en la app ni en RLS impedía esto.

## Evaluación de opciones

### UNIQUE PARTIAL INDEX (elegida)

```sql
CREATE UNIQUE INDEX idx_one_active_owner_per_tenant
  ON public.tenant_users (tenant_id)
  WHERE (role = 'owner' AND active = true);
```

**Por qué es la mejor opción para PostgreSQL + Supabase:**

- Nativo en PostgreSQL, sin extensiones adicionales
- La cláusula `WHERE` excluye exactamente las filas que no deben participar (owners inactivos, receptionists)
- El enforcement es atómico a nivel de storage engine — PostgreSQL usa un lock de índice durante el insert/update, haciendo la race condition imposible
- Compatible con Supabase completamente (se aplica vía migración estándar)
- Bajo overhead: el índice es pequeño (solo owners activos, típicamente 1 fila por tenant)

### EXCLUDE CONSTRAINT (descartada)

```sql
ALTER TABLE tenant_users
  ADD CONSTRAINT excl_one_active_owner_per_tenant
  EXCLUDE USING btree (tenant_id WITH =)
  WHERE (role = 'owner' AND active = true);
```

Semánticamente idéntico al índice parcial para igualdad escalar. Agrega complejidad sintáctica sin ventaja funcional. EXCLUDE es apropiado para operadores no-igualdad (rangos, geometrías). Descartado.

### Trigger CHECK (descartada)

Un trigger `BEFORE INSERT OR UPDATE` con una función PL/pgSQL haría el check dentro de la transacción, pero introduce overhead de función, más código que mantener, y es menos legible. La race condition se resuelve igual con el índice. Descartado.

## Cobertura de transiciones

| Transición | Comportamiento |
|------------|----------------|
| Crear primer owner del tenant | Insert pasa — ningún owner activo existe en el índice |
| Crear segundo owner (race condition) | Insert falla con `23505` — índice rechaza la segunda inserción |
| Promover receptionist → owner (hay owner activo) | Update falla con `23505` |
| Promover receptionist → owner (no hay owner activo) | Update pasa — fila entra al índice |
| Cambiar rol owner → receptionist | Fila sale del índice (ya no cumple `WHERE`) — constraint liberado |
| Desactivar owner (`active = false`) | Fila sale del índice — nuevo owner puede crearse |
| Reactivar owner inactivo cuando hay otro activo | Update falla con `23505` |
| Crear owner en nuevo tenant | Insert pasa — no existe ninguna fila del tenant en el índice |

## Impacto

### En la base de datos

- Se agrega un índice parcial de baja cardinalidad (típicamente 1 fila por tenant activo)
- Overhead de espacio: mínimo
- Overhead de escritura: aplicado solo en INSERT/UPDATE sobre `tenant_users` con `role = 'owner'` y `active = true`

### En la capa de aplicación

`users.repository.ts` — Se agregó `throwIfOwnerUniqueViolation(error)` en `createTenantUser` y `updateTenantUser`. Detecta `error.code === '23505'` con el nombre del índice en el mensaje y lanza el sentinel `OWNER_UNIQUE_VIOLATION`.

`actions/users.ts` — Los catch blocks de `createTenantUserAction` y `updateTenantUserAction` capturan `OWNER_UNIQUE_VIOLATION` y retornan un error amigable al cliente. El rollback de auth (delete del usuario creado) se ejecuta igualmente antes de relanzar.

### Sin impacto en RLS

La migración no toca ninguna política RLS. El índice opera a nivel de storage, por debajo de RLS.

## Queries de validación

```sql
-- 1. Verificar que el índice existe y tiene el WHERE correcto
SELECT indexname, indexdef
FROM   pg_indexes
WHERE  tablename = 'tenant_users'
  AND  indexname = 'idx_one_active_owner_per_tenant';

-- Resultado esperado:
-- indexdef: CREATE UNIQUE INDEX idx_one_active_owner_per_tenant
--           ON public.tenant_users(tenant_id)
--           WHERE ((role = 'owner'::tenant_role) AND (active = true))

-- 2. Confirmar que no hay violaciones existentes
SELECT tenant_id, COUNT(*) AS owner_count
FROM   public.tenant_users
WHERE  role = 'owner'
  AND  active = true
GROUP  BY tenant_id
HAVING COUNT(*) > 1;
-- Resultado esperado: 0 filas

-- 3. Verificar enforcement (debe fallar con unique_violation)
-- Ejecutar en un tenant que ya tiene un owner activo:
INSERT INTO public.tenant_users (id, tenant_id, name, email, role, active)
SELECT
  gen_random_uuid(),
  tenant_id,
  'Owner Test',
  'owner-test-' || gen_random_uuid() || '@test.com',
  'owner',
  true
FROM public.tenant_users
WHERE role = 'owner' AND active = true
LIMIT 1;
-- Resultado esperado: ERROR 23505 duplicate key value violates unique constraint
--                     "idx_one_active_owner_per_tenant"
```

## Archivos modificados

| Archivo | Cambio |
|---------|--------|
| `supabase/migrations/20260624000000_owner_uniqueness_fix.sql` | Nueva migración con pre-flight check + índice parcial |
| `apps/web/src/lib/repositories/users.repository.ts` | `throwIfOwnerUniqueViolation()` + `OWNER_UNIQUE_VIOLATION` sentinel |
| `apps/web/src/actions/users.ts` | Catch específico para `OWNER_UNIQUE_VIOLATION` en create y update |
