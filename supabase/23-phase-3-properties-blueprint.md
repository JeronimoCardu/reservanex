# 23 — Phase 3: Properties & Units Core — Architecture Blueprint

## 1. Scope completo

### In scope
- CRUD completo de `properties` (crear, editar, publicar/despublicar, soft-delete)
- CRUD completo de `units` (crear, editar, activar/desactivar, soft-delete)
- Workspace scoping para propiedades (visibilidad y permisos por workspace)
- Permission matrix owner vs receptionist
- Validación de `attributes` JSON con shape tipado
- Manejo de `deleted_at` (soft delete) en ambas entidades
- Unit count en el listado de propiedades
- Property detail page con units embedded
- Integración con `listWorkspaces` para el select de workspace en el form

### Out of scope (Fase 3 explícitamente excluye)
- `property_images` — upload y gestión de imágenes (Fase 3.5)
- `reservations` — gestión de reservas (Fase 4)
- `availability_blocks` — bloqueos de calendario (Fase 4)
- `contacts` — gestión de contactos (Fase 5)
- Exposición pública de propiedades (API pública / landing page)
- `max_properties` enforcement (tenant plan limit) — documentado como TODO

---

## 2. Arquitectura por capas

```
┌─────────────────────────────────────────────────────────────┐
│  Pages (Server Components)                                   │
│  /dashboard/properties         /dashboard/properties/[id]   │
│     └── requireTenantContext()    └── requireTenantContext() │
├─────────────────────────────────────────────────────────────┤
│  Client Components                                           │
│  PropertyTable  PropertyDetailCard  UnitList                 │
│  + Dialog tree per entity                                    │
├─────────────────────────────────────────────────────────────┤
│  Server Actions  ('use server')                              │
│  actions/properties.ts          actions/units.ts             │
│     └── requireTenantContext()    └── requireTenantContext() │
│     └── role checks inline        └── role checks inline    │
├─────────────────────────────────────────────────────────────┤
│  Repositories                                                │
│  properties.repository.ts       units.repository.ts         │
│     └── always .eq('tenant_id')   └── always .eq('tenant_id')│
│     └── always .is('deleted_at', null)                       │
│     └── workspace filter for receptionists                   │
├─────────────────────────────────────────────────────────────┤
│  Supabase SSR Client (RLS enforced)                          │
│  createClient() — anon key, respects RLS                     │
└─────────────────────────────────────────────────────────────┘
```

### Invariantes de arquitectura (heredados de Fases 1-2)
- Todo query incluye `.eq('tenant_id', tenantId)` explícito (defense-in-depth sobre RLS)
- Todo query sobre properties incluye `.is('deleted_at', null)` salvo auditoría
- `requireTenantContext()` es la única fuente de verdad para `tenantId`, `role`, `workspaceIds`
- `requireOwner()` se usa solo para rutas exclusivas de owner (no aplica en /properties ni /units — ambos roles tienen acceso)
- Server Actions NO aceptan `tenantId` como parámetro del cliente — siempre lo leen de la sesión

---

## 3. Árbol de archivos

```
packages/validators/src/
  properties.ts                   # createPropertySchema, updatePropertySchema
  units.ts                        # createUnitSchema, updateUnitSchema
  index.ts                        # re-export todo

apps/web/src/
  lib/
    repositories/
      properties.repository.ts    # listProperties, getPropertyById, ...
      units.repository.ts         # listUnits, getUnitById, ...
    auth/
      require-tenant-context.ts   # YA EXISTE — sin cambios
      require-owner.ts            # YA EXISTE — sin cambios

  actions/
    properties.ts                 # createPropertyAction, updatePropertyAction, ...
    units.ts                      # createUnitAction, updateUnitAction, ...

  components/tenant/
    properties/
      property-table.tsx          # tabla principal con dialogs (client)
      property-form.tsx           # form compartido create/edit (client)
      create-property-dialog.tsx  # (client)
      edit-property-dialog.tsx    # (client)
      delete-property-dialog.tsx  # AlertDialog (client)
    units/
      unit-list.tsx               # lista embedded en property detail (client)
      unit-form.tsx               # form compartido create/edit (client)
      create-unit-dialog.tsx      # (client)
      edit-unit-dialog.tsx        # (client)
      delete-unit-dialog.tsx      # AlertDialog (client)

  app/(tenant)/dashboard/
    properties/
      page.tsx                    # server component — listado
      [id]/
        page.tsx                  # server component — detalle + units
```

---

## 4. Validators requeridos

### packages/validators/src/properties.ts

```typescript
propertyAttributesSchema    // z.object({ bedrooms?, bathrooms?, surface_m2?, parking?, ... }).optional()
createPropertySchema        // title, description?, address?, city?, neighborhood?, google_maps_url?, workspace_id?, attributes?
updatePropertySchema        // todos los campos de create, todos opcionales
```

**Reglas de validación:**
- `title`: required, min 1, max 200
- `description`: opcional, max 2000
- `address`: opcional, max 300
- `city`: opcional, max 100
- `neighborhood`: opcional, max 100
- `google_maps_url`: opcional, URL válida, max 500
- `workspace_id`: opcional string UUID — la validación de pertenencia al tenant ocurre en la action, NO en el validator
- `attributes.bedrooms`: número entero 0-99
- `attributes.bathrooms`: número entero 0-99
- `attributes.surface_m2`: número 0-99999
- `attributes.parking`: boolean
- `attributes.furnished`: boolean

### packages/validators/src/units.ts

```typescript
createUnitSchema   // name, capacity, price?, currency?, property_id (en la action, no en el form)
updateUnitSchema   // name?, capacity?, price?, currency?
```

**Reglas de validación:**
- `name`: required, min 1, max 200
- `capacity`: required, número entero 1-999
- `price`: opcional, número >= 0, max 99999999
- `currency`: opcional, enum ARS | USD | EUR | BRL — default ARS

**Nota**: `property_id` va como parámetro separado en la action, no dentro del schema del form. Esto previene que el cliente manipule el property_id.

---

## 5. Repositories requeridos

### properties.repository.ts

```typescript
type PropertyWithUnitCount = PropertyRow & { unitCount: number }
type PropertyWithUnits     = PropertyRow & { units: UnitRow[] }

listProperties(
  tenantId: string,
  workspaceIds: string[] | null   // null = owner (sin filtro), string[] = receptionist
): Promise<PropertyWithUnitCount[]>

getPropertyById(
  tenantId: string,
  id: string,
  workspaceIds: string[] | null
): Promise<PropertyWithUnits | null>

createProperty(
  tenantId: string,
  input: CreatePropertyInput
): Promise<PropertyRow>

updateProperty(
  tenantId: string,
  id: string,
  input: UpdatePropertyInput
): Promise<PropertyRow>

setPublished(
  tenantId: string,
  id: string,
  published: boolean
): Promise<PropertyRow>

deleteProperty(                   // soft delete — sets deleted_at = now()
  tenantId: string,
  id: string
): Promise<void>

hasActiveReservations(            // internal — check before delete
  tenantId: string,
  propertyId: string
): Promise<boolean>
```

**Workspace filter logic en repository:**
```
workspaceIds === null  → sin filtro adicional (owner ve todo)
workspaceIds.length === 0 → .in('workspace_id', [''])  → 0 resultados (receptionist sin workspaces)
workspaceIds.length > 0   → .in('workspace_id', workspaceIds)
```

**Nota crítica**: propiedades con `workspace_id = null` son visibles SOLO para owners. Los receptionists solo ven propiedades explícitamente asignadas a sus workspaces.

### units.repository.ts

```typescript
listUnits(
  tenantId: string,
  propertyId: string
): Promise<UnitRow[]>            // todos (activos e inactivos, no eliminados)

getUnitById(
  tenantId: string,
  id: string
): Promise<UnitRow | null>

createUnit(
  tenantId: string,
  propertyId: string,
  input: CreateUnitInput
): Promise<UnitRow>

updateUnit(
  tenantId: string,
  id: string,
  input: UpdateUnitInput
): Promise<UnitRow>

setUnitActive(
  tenantId: string,
  id: string,
  active: boolean
): Promise<UnitRow>

deleteUnit(                      // soft delete — sets deleted_at = now()
  tenantId: string,
  id: string
): Promise<void>

hasActiveReservations(           // check unit has no pending/confirmed reservations
  tenantId: string,
  unitId: string
): Promise<boolean>

validatePropertyAccess(          // verifica que property pertenece al tenant y al workspace del user
  tenantId: string,
  propertyId: string,
  workspaceIds: string[] | null
): Promise<boolean>
```

**Invariantes de units:**
- Siempre filtra `.is('deleted_at', null)` salvo auditoría
- Siempre filtra `.eq('tenant_id', tenantId)` explícito
- Al crear, `tenant_id` viene del server context, nunca del cliente
- `property_id` se valida que pertenece al tenant ANTES del insert

---

## 6. Server Actions requeridas

### actions/properties.ts

| Action | Guard | Input |
|--------|-------|-------|
| `createPropertyAction(input)` | `requireTenantContext()` | CreatePropertyInput |
| `updatePropertyAction(id, input)` | `requireTenantContext()` | UpdatePropertyInput |
| `publishPropertyAction(id)` | `requireTenantContext()` | — |
| `unpublishPropertyAction(id)` | `requireTenantContext()` | — |
| `deletePropertyAction(id)` | `requireTenantContext()` + `role === 'owner'` check | — |

**Lógica en createPropertyAction:**
1. `requireTenantContext()` → `{ tenantId, role, workspaceIds }`
2. Parsear y validar input con `createPropertySchema`
3. Si `role === 'receptionist'`:
   - `workspace_id` debe estar presente
   - `workspace_id` debe estar en `workspaceIds` del user
4. Si `workspace_id` presente: validar que pertenece al tenant (workspaces table)
5. `createProperty(tenantId, input)`
6. `revalidatePath('/dashboard/properties')`

**Lógica en deletePropertyAction:**
1. `requireTenantContext()` → si `role !== 'owner'` → `{ success: false, error: 'Sin permisos' }`
2. Verificar propiedad existe en tenant + workspace del user
3. `hasActiveReservations(tenantId, id)` → si true → error amigable
4. `deleteProperty(tenantId, id)` (cascada soft-delete a units sin reservas activas)

### actions/units.ts

| Action | Guard | Input |
|--------|-------|-------|
| `createUnitAction(propertyId, input)` | `requireTenantContext()` | CreateUnitInput |
| `updateUnitAction(id, input)` | `requireTenantContext()` | UpdateUnitInput |
| `toggleUnitActiveAction(id)` | `requireTenantContext()` | — |
| `deleteUnitAction(id)` | `requireTenantContext()` + `role === 'owner'` check | — |

**Lógica en createUnitAction:**
1. `requireTenantContext()`
2. Validar `propertyId` pertenece al tenant Y es accesible al user (workspace check)
3. Parsear input
4. `createUnit(tenantId, propertyId, input)`
5. `revalidatePath('/dashboard/properties/' + propertyId)`

**Tipo de retorno unificado:**
```typescript
// Reutilizar ActionResult de workspaces.ts — PENDIENTE mover a shared file
export type ActionResult<T = undefined> =
  | { success: true; data?: T }
  | { success: false; error: string }
```

---

## 7. Componentes React requeridos

### properties/property-form.tsx (client)
**Props**: `defaultValues?`, `workspaces: WorkspaceRow[]`, `onSubmit`, `isPending`, `onCancel?`, `mode: 'create' | 'edit'`

**Campos:**
- `title` — Input, required
- `description` — Textarea (nuevo componente) o Input largo
- `workspace_id` — Select de workspaces activos (solo los accesibles al usuario)
- `city` — Input
- `address` — Input
- `neighborhood` — Input
- `google_maps_url` — Input
- **Sección Atributos** (colapsable o grid):
  - `bedrooms`, `bathrooms` — number inputs
  - `surface_m2` — number input
  - `parking`, `furnished` — checkboxes

**Nota UI**: workspace_id es **requerido para receptionists** (se valida en action). Para owners es opcional. El label/placeholder debe reflejar esto. Se puede mostrar el requisito condicionalmente si el form recibe el rol del user.

### properties/property-table.tsx (client)
**Props**: `properties: PropertyWithUnitCount[]`, `workspaces: WorkspaceRow[]`, `currentRole: TenantRole`

**Columnas**: Título, Ciudad, Workspace, Unidades, Estado (Publicado/Borrador), Acciones

**Acciones por fila:**
- Editar (owner + receptionist)
- Publicar/Despublicar toggle (owner + receptionist, según workspace access)
- Ver detalle → link a `/dashboard/properties/[id]`
- Eliminar (owner only, disabled con tooltip para receptionist)

### units/unit-form.tsx (client)
**Props**: `defaultValues?`, `onSubmit`, `isPending`, `onCancel?`

**Campos:**
- `name` — Input, required
- `capacity` — number Input, required
- `currency` — Select (ARS | USD | EUR | BRL)
- `price` — number Input, opcional

### units/unit-list.tsx (client)
**Props**: `units: UnitRow[]`, `propertyId: string`, `currentRole: TenantRole`

**Columnas**: Nombre, Capacidad, Precio, Moneda, Estado (Activo/Inactivo), Acciones

**Acciones por fila:**
- Editar (owner + receptionist)
- Activar/Desactivar toggle (owner + receptionist)
- Eliminar (owner only)

---

## 8. Páginas requeridas

### /dashboard/properties/page.tsx (Server Component)

```typescript
export default async function PropertiesPage() {
  const ctx = await requireTenantContext()
  const [properties, workspaces] = await Promise.all([
    listProperties(ctx.tenantId, ctx.workspaceIds),
    listWorkspaces(ctx.tenantId),       // para el form de create/edit
  ])
  return (
    <PropertyTable
      properties={properties}
      workspaces={workspaces}
      currentRole={ctx.role}
    />
  )
}
```

### /dashboard/properties/[id]/page.tsx (Server Component)

```typescript
export default async function PropertyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenantContext()
  const { id } = await params
  const [property, workspaces] = await Promise.all([
    getPropertyById(ctx.tenantId, id, ctx.workspaceIds),
    listWorkspaces(ctx.tenantId),
  ])
  if (!property) notFound()
  return (
    <>
      <PropertyDetailCard property={property} workspaces={workspaces} currentRole={ctx.role} />
      <UnitList units={property.units} propertyId={id} currentRole={ctx.role} />
    </>
  )
}
```

**Metadata dinámica:**
```typescript
export async function generateMetadata({ params }) {
  // fetch title para SEO
  return { title: `${property.title} — OrderFlow` }
}
```

---

## 9. Casos de uso

| CU | Actor | Precondición | Flujo |
|----|-------|--------------|-------|
| CU-P01 | Owner | Logueado | Crea propiedad sin workspace → visible para todos en el tenant |
| CU-P02 | Owner | Logueado | Crea propiedad con workspace X → visible para usuarios con acceso a X |
| CU-P03 | Receptionist | Workspace Y asignado | Crea propiedad → workspace Y es requerido, selecciona Y → propiedad creada |
| CU-P04 | Receptionist | Workspace Y asignado | Intenta crear propiedad con workspace Z (no asignado) → error |
| CU-P05 | Owner | Propiedad existe | Publica propiedad → `published = true` |
| CU-P06 | Owner | Propiedad publicada | Despublica propiedad → `published = false` |
| CU-P07 | Owner | Propiedad sin reservas activas | Elimina propiedad → soft delete cascada a units |
| CU-P08 | Owner | Propiedad con reservas activas | Intenta eliminar → error controlado |
| CU-P09 | Receptionist | — | Intenta eliminar propiedad → error de permisos |
| CU-P10 | Receptionist | Workspace Y | Lista propiedades → solo ve las de workspace Y |
| CU-U01 | Owner/Receptionist | Propiedad accesible | Crea unit → name, capacity, currency, price? |
| CU-U02 | Owner/Receptionist | Unit activa | Desactiva unit → `active = false`, no reservable |
| CU-U03 | Owner/Receptionist | Unit inactiva | Reactiva unit → `active = true` |
| CU-U04 | Owner | Unit sin reservas activas | Elimina unit → soft delete |
| CU-U05 | Owner | Unit con reservas activas | Intenta eliminar → error controlado |
| CU-U06 | Receptionist | — | Intenta eliminar unit → error de permisos |

---

## 10. Permission Matrix

| Operación | Owner | Receptionist |
|-----------|-------|--------------|
| `listProperties` (todas) | ✓ | ✗ (solo su workspace) |
| `listProperties` (su workspace) | ✓ | ✓ |
| `getPropertyById` (su workspace) | ✓ | ✓ |
| `createProperty` (workspace propio) | ✓ | ✓ |
| `createProperty` (sin workspace / otro workspace) | ✓ | ✗ |
| `updateProperty` (su workspace) | ✓ | ✓ |
| `updateProperty` (otro workspace) | ✓ | ✗ |
| `publishProperty` | ✓ | ✓ (su workspace) |
| `deleteProperty` | ✓ | ✗ |
| `createUnit` (propiedad propia) | ✓ | ✓ |
| `updateUnit` | ✓ | ✓ (su workspace) |
| `toggleUnitActive` | ✓ | ✓ (su workspace) |
| `deleteUnit` | ✓ | ✗ |

**Implementación de permisos**: Los checks de rol se realizan en la Server Action, no en el repositorio. El repositorio siempre aplica el filtro de workspace para garantizar la isolación, pero la decisión de "permitir o denegar" la toma la action según el rol.

---

## 11. Workspace scoping rules

### Regla fundamental
```
Owner   → workspaceIds = null  → ve TODO (incluye properties con workspace_id = null)
Receptor → workspaceIds = []    → ve NADA
Receptor → workspaceIds = [A,B] → ve solo properties donde workspace_id IN (A, B)
```

### properties con workspace_id = null
Estas propiedades son **owner-only**. Un receptionist NUNCA las ve, aunque tenga acceso general. Esto es una consecuencia de `.in('workspace_id', workspaceIds)` que excluye NULLs.

**Implicación de diseño**: Si el owner crea una propiedad sin workspace, está creando una propiedad de administración interna que los receptionists no ven. Esto es intencional.

### Filtro en repository
```typescript
// Implementación en listProperties:
if (workspaceIds === null) {
  // owner: sin filtro adicional
} else if (workspaceIds.length === 0) {
  // receptionist sin workspaces: forzar 0 resultados
  query = query.in('workspace_id', ['__none__'])
} else {
  // receptionist con workspaces
  query = query.in('workspace_id', workspaceIds)
}
```

### Cambio de workspace en update
Si el owner reasigna una propiedad de workspace A a workspace B:
- Los usuarios de workspace A ya no la ven
- Los usuarios de workspace B ahora la ven
- No hay notificación automática (Fase 5+)

---

## 12. Property lifecycle

```
         createProperty()
              │
              ▼
    ┌─────────────────┐
    │     DRAFT       │  published = false, deleted_at = null
    │  (visible en    │
    │   dashboard)    │
    └────────┬────────┘
             │ publishProperty()
             ▼
    ┌─────────────────┐
    │    PUBLISHED    │  published = true, deleted_at = null
    │  (visible para  │
    │    clientes)    │
    └────────┬────────┘
             │ unpublishProperty()
             │◄─────────────────────
             │                       
             │ deleteProperty() ── BLOQUEADO si hay reservas activas
             ▼
    ┌─────────────────┐
    │   SOFT DELETED  │  deleted_at = now()
    │  (invisible en  │
    │   dashboard)    │
    └─────────────────┘
```

**Transiciones válidas:**
- DRAFT → PUBLISHED: `publishProperty()`
- PUBLISHED → DRAFT: `unpublishProperty()`
- DRAFT → SOFT DELETED: `deleteProperty()` (solo owner, solo si no hay reservas activas)
- PUBLISHED → SOFT DELETED: `deleteProperty()` (solo owner, solo si no hay reservas activas)

**No existe restauración de soft-delete en Fase 3.** Sería una operación de soporte (Fase 6+).

---

## 13. Unit lifecycle

```
         createUnit()
              │
              ▼
    ┌─────────────────┐
    │     ACTIVE      │  active = true, deleted_at = null
    │  (disponible    │
    │   para reserva) │
    └────────┬────────┘
             │ toggleUnitActive() → false
             ▼
    ┌─────────────────┐
    │    INACTIVE     │  active = false, deleted_at = null
    │  (no reservable)│
    └────────┬────────┘
             │ toggleUnitActive() → true
             │◄──────────────────
             │
             │ deleteUnit() ── BLOQUEADO si hay reservas activas
             ▼
    ┌─────────────────┐
    │   SOFT DELETED  │  deleted_at = now()
    └─────────────────┘
```

**Regla de cascada desde deleteProperty:**
- Si se elimina la propiedad padre, se soft-delete TAMBIÉN todas sus units
- Precondición: ninguna unit del property puede tener reservas en estado `inquiry | interested | pre_reserved | pending_payment | confirmed`
- Si alguna unit tiene reservas activas, el `deleteProperty` se bloquea completamente (no elimina ninguna unit)

---

## 14. Error catalog

| Código | Trigger | Mensaje al usuario |
|--------|---------|-------------------|
| `PROPERTY_NOT_FOUND` | `getPropertyById` retorna null | "Propiedad no encontrada." |
| `PROPERTY_WORKSPACE_FORBIDDEN` | Workspace del user no incluye el workspace de la propiedad | "No tenés acceso a esta propiedad." |
| `PROPERTY_WORKSPACE_REQUIRED` | Receptionist crea propiedad sin workspace_id | "Debés asignar un workspace." |
| `PROPERTY_WORKSPACE_NOT_ASSIGNED` | Receptionist asigna workspace que no tiene | "No tenés acceso a ese workspace." |
| `PROPERTY_WORKSPACE_NOT_IN_TENANT` | workspace_id no pertenece al tenant | "El workspace no existe." |
| `PROPERTY_HAS_ACTIVE_RESERVATIONS` | `hasActiveReservations` retorna true en delete | "No podés eliminar una propiedad con reservas activas." |
| `PROPERTY_DELETE_FORBIDDEN` | Receptionist intenta deleteProperty | "Sin permisos para eliminar propiedades." |
| `UNIT_NOT_FOUND` | `getUnitById` retorna null | "Unidad no encontrada." |
| `UNIT_PROPERTY_FORBIDDEN` | unit.property_id no accesible para el user | "No tenés acceso a esta unidad." |
| `UNIT_HAS_ACTIVE_RESERVATIONS` | `hasActiveReservations` retorna true en delete | "No podés eliminar una unidad con reservas activas." |
| `UNIT_DELETE_FORBIDDEN` | Receptionist intenta deleteUnit | "Sin permisos para eliminar unidades." |

---

## 15. Test scenarios

### Properties

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| T-P01 | Owner crea sin workspace_id | `{ title: 'Casa Centro' }` | 201, property.workspace_id = null |
| T-P02 | Owner crea con workspace_id válido | `{ title: 'Casa', workspace_id: 'ws-A' }` | 201 |
| T-P03 | Owner crea con workspace_id de otro tenant | `{ workspace_id: 'ws-otro-tenant' }` | error: `PROPERTY_WORKSPACE_NOT_IN_TENANT` |
| T-P04 | Receptionist crea sin workspace_id | `{ title: 'Casa' }` | error: `PROPERTY_WORKSPACE_REQUIRED` |
| T-P05 | Receptionist crea con workspace no asignado | `{ workspace_id: 'ws-Z' }` | error: `PROPERTY_WORKSPACE_NOT_ASSIGNED` |
| T-P06 | Receptionist crea con workspace asignado | `{ workspace_id: 'ws-Y' }` | 201 |
| T-P07 | Owner lista propiedades | — | Todas las properties del tenant (incluyendo null workspace) |
| T-P08 | Receptionist lista propiedades | — | Solo properties con workspace IN [ws-Y] |
| T-P09 | Publicar propiedad draft | `publishPropertyAction('prop-1')` | published = true |
| T-P10 | Delete propiedad con reservas activas | `deletePropertyAction('prop-1')` | error: `PROPERTY_HAS_ACTIVE_RESERVATIONS` |
| T-P11 | Delete propiedad sin reservas | `deletePropertyAction('prop-2')` | deleted_at set, units soft-deleted |
| T-P12 | Receptionist intenta delete | `deletePropertyAction('prop-1')` | error: `PROPERTY_DELETE_FORBIDDEN` |
| T-P13 | Acceso a property de otro tenant | `getPropertyById(otherTenantId, 'prop-1', null)` | null |

### Units

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| T-U01 | Crear unit en property propia | `{ name: 'Hab 1', capacity: 2 }` | 201 |
| T-U02 | Crear unit en property de otro tenant | — | error |
| T-U03 | Receptionist crea unit en property de su workspace | — | 201 |
| T-U04 | Receptionist crea unit en property de otro workspace | — | error |
| T-U05 | Desactivar unit activa | `toggleUnitActiveAction('unit-1')` | active = false |
| T-U06 | Reactivar unit inactiva | `toggleUnitActiveAction('unit-1')` | active = true |
| T-U07 | Delete unit sin reservas | `deleteUnitAction('unit-1')` | deleted_at set |
| T-U08 | Delete unit con reservas activas | `deleteUnitAction('unit-2')` | error: `UNIT_HAS_ACTIVE_RESERVATIONS` |
| T-U09 | Receptionist delete unit | — | error: `UNIT_DELETE_FORBIDDEN` |
| T-U10 | Unit hereda tenant_id de la propiedad | create unit | unit.tenant_id = property.tenant_id |
| T-U11 | Currency default | `{ name: 'Hab 1', capacity: 2 }` | currency = 'ARS' |

---

## 16. Checklist pre-implementación

### Decisiones de negocio a confirmar antes de codear

- [ ] **B1**: ¿Las propiedades con `workspace_id = null` son invisibles para receptionists? (recomendado: SÍ — ver §11)
- [ ] **B2**: ¿Se permite eliminar una propiedad publicada o solo las draft? (recomendado: ambas)
- [ ] **B3**: ¿El `deleteProperty` hace soft-delete en cascada de units, o solo bloquea si tiene units? (recomendado: cascada siempre que no haya reservas activas)
- [ ] **B4**: ¿Cuáles estados de reserva se consideran "activos" para bloquear delete? (recomendado: todos excepto `cancelled`)
- [ ] **B5**: ¿Se aplica `tenant.max_properties` en Fase 3? (recomendado: NO — diferir a Fase 6)
- [ ] **B6**: ¿El form de propiedad muestra `workspace_id` como requerido para receptionists con label diferente? (recomendado: SÍ — UX informativa)

### Verificaciones técnicas antes de codear

- [ ] Confirmar que `property_images` NO se toca en esta fase
- [ ] Confirmar que `requireTenantContext()` (no `requireOwner()`) es el guard correcto para properties/units pages
- [ ] Confirmar que `listWorkspaces()` retorna solo workspaces activos (para el select en el form)
- [ ] Confirmar Textarea UI component disponible o si usar Input tall
- [ ] Confirmar que el `params` en Next.js 15 App Router es `Promise<{ id: string }>` (async params — ya establecido en el proyecto)
- [ ] Confirmar que `notFound()` de next/navigation está disponible (sí, confirmado en arquitectura)
- [ ] Confirmar que `revalidatePath('/dashboard/properties')` y `revalidatePath('/dashboard/properties/' + propertyId)` son suficientes para invalidar caché

### Archivos a crear/modificar

- [ ] `packages/validators/src/properties.ts` — NUEVO
- [ ] `packages/validators/src/units.ts` — NUEVO
- [ ] `packages/validators/src/index.ts` — MODIFICAR (agregar exports)
- [ ] `apps/web/src/lib/repositories/properties.repository.ts` — NUEVO
- [ ] `apps/web/src/lib/repositories/units.repository.ts` — NUEVO
- [ ] `apps/web/src/actions/properties.ts` — NUEVO
- [ ] `apps/web/src/actions/units.ts` — NUEVO
- [ ] `apps/web/src/components/tenant/properties/*.tsx` — 5 archivos NUEVOS
- [ ] `apps/web/src/components/tenant/units/*.tsx` — 5 archivos NUEVOS
- [ ] `apps/web/src/app/(tenant)/dashboard/properties/page.tsx` — NUEVO
- [ ] `apps/web/src/app/(tenant)/dashboard/properties/[id]/page.tsx` — NUEVO
- [ ] `apps/web/src/components/ui/textarea.tsx` — NUEVO (componente shadcn/ui)

### Open questions (no bloquean implementación)

- **OQ1**: ¿El `attributes` JSON necesita un UI dedicado (formulario estructurado) o se puede omitir en Fase 3 y solo guardar `{}`? (recomendado: incluir bedrooms/bathrooms/surface_m2 como campos en el form)
- **OQ2**: ¿La página de detalle de propiedad necesita un CTA "Volver a propiedades" o navegación por breadcrumbs? (recomendado: breadcrumb simple)
- **OQ3**: ¿Cuál es el orden por defecto de propiedades en el listado? (recomendado: `created_at DESC` — más nuevas primero)
- **OQ4**: ¿Los números de precio usan separador de decimales o son enteros? (recomendado: decimal con 2 dígitos — z.number().multipleOf(0.01))
