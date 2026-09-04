# OrderFlow — API Specification v1

**Versión:** 1.0  
**Fecha:** 2026-06-22  
**Base URL:** `https://{tenant}.orderflow.app/api/v1` (tenant apps) y `https://app.orderflow.app/api/v1` (plataforma)

---

## Convenciones Generales

### Tipos de endpoint

| Tipo | Auth requerida | Descripción |
|---|---|---|
| `PUBLIC` | Ninguna | Accesible sin JWT (anon) |
| `AUTH` | JWT de usuario | Supabase Auth session token |
| `SERVICE` | Service-role key | Solo desde servidores internos |
| `INTERNAL` | IP allowlist + secret | Worker ↔ API interna |
| `WEBHOOK` | HMAC signature | Meta verifica con `X-Hub-Signature-256` |

### Headers estándar

```
Authorization: Bearer {supabase_jwt}          # endpoints AUTH
X-Service-Key: {SUPABASE_SERVICE_ROLE_KEY}    # endpoints SERVICE
X-Internal-Secret: {INTERNAL_API_SECRET}       # endpoints INTERNAL
```

### Formato de respuesta exitosa

```json
{
  "data": { ... },
  "meta": { "total": 100, "page": 1, "per_page": 20, "total_pages": 5 }
}
```

`meta` solo aparece en listados paginados.

### Formato de error

```json
{
  "error": "error_code",
  "message": "Descripción legible",
  "details": {}
}
```

### Paginación (query params en listados)

| Param | Default | Descripción |
|---|---|---|
| `page` | 1 | Página (base 1) |
| `per_page` | 20 | Filas por página (máx 100) |
| `sort` | `created_at` | Campo de ordenamiento |
| `order` | `desc` | `asc` o `desc` |

### Códigos HTTP usados

| Código | Uso |
|---|---|
| 200 | Operación exitosa |
| 201 | Recurso creado |
| 204 | Sin contenido (DELETE exitoso) |
| 400 | Request inválido (validación) |
| 401 | Sin autenticación |
| 403 | Sin autorización (rol insuficiente) |
| 404 | Recurso no encontrado |
| 409 | Conflicto (duplicado, estado inválido) |
| 422 | Entidad no procesable (regla de negocio) |
| 429 | Rate limit excedido |
| 500 | Error interno |

### Tenant isolation

Los endpoints `AUTH` para tenant users leen `tenant_id` **desde el JWT** (claim `app_metadata.tenant_id`), nunca desde el body o path. La capa RLS garantiza el aislamiento. Los endpoints no aceptan un `tenant_id` externo de usuarios de tenant.

---

## 1. Auth

> Supabase Auth maneja credenciales directamente desde el cliente (SDK). Las rutas aquí son wrappers del backend que complementan el flujo con lógica de negocio.

---

### `POST /auth/login`

**Tipo:** PUBLIC  
**Descripción:** Login con email/password. Crea sesión Supabase y retorna el perfil del usuario.

**Request Body:**
```json
{
  "email": "admin@orderflow.app",
  "password": "secret"
}
```

**Response 200:**
```json
{
  "data": {
    "access_token": "eyJ...",
    "refresh_token": "...",
    "expires_at": 1750000000,
    "user": {
      "id": "uuid",
      "email": "admin@orderflow.app",
      "user_type": "platform_user",
      "role": "super_admin",
      "name": "Nombre"
    }
  }
}
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 401 | `invalid_credentials` | Email o password incorrectos |
| 403 | `user_inactive` | Usuario desactivado en platform_users o tenant_users |

**Notas:** Tras el login, el JWT incluye claims de `app_metadata` seteados por `custom_access_token_hook`. Si el hook no está configurado (Supabase Pro requerido), `user_type` es `null` y RLS bloqueará todos los accesos. Validar con `verify_hook_configured()`.

---

### `POST /auth/logout`

**Tipo:** AUTH  
**Roles:** todos  
**Descripción:** Invalida la sesión activa. Si hay impersonación activa, la cierra.

**Request:** Sin body.

**Response 204:** Sin contenido.

**Notas:** Llama a `supabase.auth.signOut()`. Si el usuario es super_admin con impersonación activa, setear `ended_at = now()` en `impersonation_sessions` antes de cerrar sesión.

---

### `POST /auth/refresh`

**Tipo:** PUBLIC  
**Descripción:** Renueva el access token usando el refresh token.

**Request Body:**
```json
{ "refresh_token": "..." }
```

**Response 200:**
```json
{
  "data": {
    "access_token": "eyJ...",
    "refresh_token": "...",
    "expires_at": 1750003600
  }
}
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 401 | `invalid_refresh_token` | Token inválido o expirado |

---

### `GET /auth/me`

**Tipo:** AUTH  
**Roles:** todos  
**Descripción:** Retorna el perfil completo del usuario autenticado según su tipo.

**Response 200 (platform_user):**
```json
{
  "data": {
    "id": "uuid",
    "user_type": "platform_user",
    "role": "super_admin",
    "name": "Javier López",
    "email": "javier@orderflow.app",
    "active": true,
    "impersonating": {
      "session_id": "uuid",
      "tenant_id": "uuid",
      "tenant_name": "Inmobiliaria Sur",
      "started_at": "2026-06-22T10:00:00Z"
    }
  }
}
```

**Response 200 (tenant_user):**
```json
{
  "data": {
    "id": "uuid",
    "user_type": "tenant_user",
    "role": "owner",
    "name": "María García",
    "email": "maria@inmobiliariasur.com",
    "tenant_id": "uuid",
    "tenant_name": "Inmobiliaria Sur",
    "branch_id": null,
    "branch_name": null,
    "active": true
  }
}
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 401 | `unauthorized` | JWT ausente o inválido |

**Notas:** El campo `impersonating` solo aparece en platform_users con sesión activa. Útil para mostrar el banner de impersonación en el dashboard.

---

## 2. Platform Admin

> Solo super_admin. No requieren impersonación. Administración de la plataforma OrderFlow.

---

### `GET /platform/tenants`

**Tipo:** AUTH  
**Roles:** super_admin  
**Descripción:** Lista todos los tenants con estadísticas de uso.

**Query Params:**
| Param | Tipo | Descripción |
|---|---|---|
| `status` | string | Filtro: `trial`, `active`, `suspended`, `churned` |
| `seller_id` | uuid | Filtro por vendedor asignado |
| `q` | string | Búsqueda por nombre o slug |

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Inmobiliaria Sur",
      "slug": "inmobiliaria-sur",
      "status": "active",
      "plan": "starter",
      "trial_ends_at": null,
      "max_properties": 10,
      "max_users": 5,
      "created_at": "2026-01-15T10:00:00Z",
      "stats": {
        "total_properties": 8,
        "active_conversations": 3,
        "confirmed_reservations_this_month": 12
      }
    }
  ],
  "meta": { "total": 47, "page": 1, "per_page": 20, "total_pages": 3 }
}
```

---

### `POST /platform/tenants`

**Tipo:** AUTH  
**Roles:** super_admin  
**Descripción:** Crea un nuevo tenant con su owner. Operación de onboarding completo.

**Request Body:**
```json
{
  "tenant": {
    "name": "Complejo Las Sierras",
    "slug": "complejo-las-sierras",
    "plan": "starter",
    "max_properties": 10,
    "max_users": 5
  },
  "owner": {
    "name": "Carlos Méndez",
    "email": "carlos@lassierras.com",
    "password": "temp_password_123"
  },
  "seller_id": "uuid"
}
```

**Response 201:**
```json
{
  "data": {
    "tenant_id": "uuid",
    "tenant_slug": "complejo-las-sierras",
    "owner_id": "uuid",
    "owner_email": "carlos@lassierras.com",
    "onboarding_url": "https://complejo-las-sierras.orderflow.app/onboarding"
  }
}
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 409 | `slug_taken` | El slug ya existe |
| 409 | `email_taken` | El email ya existe en auth.users |
| 422 | `invalid_slug_format` | Slug no cumple regex `^[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$` |

**Notas:** Crea en orden: `tenants` → `auth.users` (service_role) → `tenant_users`. Si falla en cualquier paso, rollback completo. Usa `service_role` para crear el usuario en Supabase Auth. Envía email de bienvenida vía Resend.

---

### `PATCH /platform/tenants/:id`

**Tipo:** AUTH  
**Roles:** super_admin  
**Descripción:** Actualiza plan, estado, límites del tenant.

**Request Body (todos los campos son opcionales):**
```json
{
  "status": "active",
  "plan": "pro",
  "trial_ends_at": "2026-07-22T23:59:59Z",
  "max_properties": 50,
  "max_users": 20
}
```

**Response 200:**
```json
{ "data": { "id": "uuid", "status": "active", "plan": "pro" } }
```

---

### `GET /platform/platform-users`

**Tipo:** AUTH  
**Roles:** super_admin  
**Descripción:** Lista vendedores y otros admins de la plataforma.

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Ana Rodríguez",
      "email": "ana@orderflow.app",
      "role": "seller",
      "active": true,
      "clients_count": 12
    }
  ]
}
```

---

### `POST /platform/platform-users`

**Tipo:** AUTH  
**Roles:** super_admin  
**Descripción:** Crea un nuevo usuario de plataforma (seller u otro super_admin).

**Request Body:**
```json
{
  "name": "Ana Rodríguez",
  "email": "ana@orderflow.app",
  "role": "seller",
  "password": "initial_password"
}
```

**Response 201:**
```json
{ "data": { "id": "uuid", "email": "ana@orderflow.app", "role": "seller" } }
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 409 | `email_taken` | Email ya existe |

---

### `PATCH /platform/platform-users/:id`

**Tipo:** AUTH  
**Roles:** super_admin  
**Descripción:** Actualiza nombre, rol o estado activo de un platform_user.

**Request Body:**
```json
{ "name": "Ana R.", "active": false }
```

**Response 200:**
```json
{ "data": { "id": "uuid", "name": "Ana R.", "active": false } }
```

---

### `GET /platform/seller-clients`

**Tipo:** AUTH  
**Roles:** super_admin, seller  
**Descripción:** Lista asignaciones vendedor-tenant. super_admin ve todos; seller ve solo los suyos.

**Query Params:** `seller_id` (uuid, solo super_admin)

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "seller": { "id": "uuid", "name": "Ana Rodríguez" },
      "tenant": { "id": "uuid", "name": "Inmobiliaria Sur", "slug": "inmobiliaria-sur" },
      "commission_percentage": "5.00",
      "active": true
    }
  ]
}
```

---

### `POST /platform/seller-clients`

**Tipo:** AUTH  
**Roles:** super_admin  
**Descripción:** Asigna un seller a un tenant.

**Request Body:**
```json
{
  "seller_id": "uuid",
  "tenant_id": "uuid",
  "commission_percentage": 5.00
}
```

**Response 201:**
```json
{ "data": { "id": "uuid", "seller_id": "uuid", "tenant_id": "uuid" } }
```

---

## 3. Impersonación

---

### `POST /impersonation`

**Tipo:** AUTH  
**Roles:** super_admin  
**Descripción:** Inicia una sesión de impersonación en un tenant. Crea el registro en `impersonation_sessions`. El JWT del super_admin no cambia; los endpoints de tenant leen la sesión activa vía `auth_impersonating_tenant_id()`.

**Request Body:**
```json
{
  "tenant_id": "uuid",
  "reason": "Soporte técnico: WhatsApp no conecta"
}
```

**Response 201:**
```json
{
  "data": {
    "session_id": "uuid",
    "tenant_id": "uuid",
    "tenant_name": "Inmobiliaria Sur",
    "started_at": "2026-06-22T10:00:00Z"
  }
}
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 409 | `active_session_exists` | Ya hay una sesión activa. Cerrar la actual primero. |
| 422 | `reason_required` | El campo reason es obligatorio (auditoría) |

**Notas:** El backend valida que no exista otra sesión activa para este super_admin antes de crear la nueva. Registra la IP del request en `ip_address`.

---

### `POST /impersonation/:id/end`

**Tipo:** AUTH  
**Roles:** super_admin  
**Descripción:** Cierra la sesión de impersonación activa.

**Response 200:**
```json
{
  "data": {
    "session_id": "uuid",
    "duration_minutes": 23,
    "ended_at": "2026-06-22T10:23:00Z"
  }
}
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 404 | `session_not_found` | Sesión no existe |
| 403 | `not_your_session` | La sesión pertenece a otro admin |
| 409 | `already_ended` | La sesión ya fue cerrada |

---

### `GET /impersonation/sessions`

**Tipo:** AUTH  
**Roles:** super_admin (propio historial), owner (sesiones sobre su tenant)  
**Descripción:** Lista sesiones de impersonación.

**Query Params:** `tenant_id` (super_admin), `active_only` (boolean)

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "platform_user": { "id": "uuid", "name": "Javier López" },
      "tenant": { "id": "uuid", "name": "Inmobiliaria Sur" },
      "reason": "Soporte técnico",
      "started_at": "2026-06-22T10:00:00Z",
      "ended_at": "2026-06-22T10:23:00Z",
      "duration_minutes": 23
    }
  ]
}
```

---

## 4. Tenants (Configuración del propio tenant)

---

### `GET /tenant`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Retorna la configuración completa del tenant del usuario autenticado.

**Response 200:**
```json
{
  "data": {
    "id": "uuid",
    "name": "Inmobiliaria Sur",
    "slug": "inmobiliaria-sur",
    "status": "active",
    "plan": "starter",
    "trial_ends_at": null,
    "max_properties": 10,
    "max_users": 5,
    "logo_url": "https://storage.supabase.co/...",
    "primary_color": "#2563EB",
    "secondary_color": "#64748B",
    "site_config": {
      "template": "modern",
      "hero_title": "Tu próxima aventura comienza aquí",
      "hero_subtitle": "Alquileres temporarios en las sierras",
      "show_prices": true,
      "contact_email": "contacto@inmobiliariasur.com"
    },
    "custom_domain": null,
    "usage": {
      "properties_used": 8,
      "users_used": 3
    }
  }
}
```

---

### `PATCH /tenant`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Actualiza configuración del tenant (branding, site_config, slug). No puede modificar plan, status ni límites (solo super_admin).

**Request Body (todos opcionales):**
```json
{
  "name": "Complejo Turístico Las Sierras",
  "logo_url": "https://storage.supabase.co/...",
  "primary_color": "#1E40AF",
  "secondary_color": "#475569",
  "site_config": {
    "template": "minimal",
    "hero_title": "Descansa en las sierras",
    "show_prices": true,
    "contact_email": "info@lassierras.com"
  }
}
```

**Response 200:**
```json
{ "data": { "id": "uuid", "name": "Complejo Turístico Las Sierras" } }
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 400 | `invalid_color_format` | Color no cumple `#RRGGBB` |
| 422 | `plan_limit_exceeded` | No puede subir max_properties (solo super_admin) |

---

### `POST /tenant/logo`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Sube el logo del tenant a Supabase Storage y actualiza `logo_url`.

**Request:** `multipart/form-data`
```
file: <imagen> (max 2MB, PNG/JPG/WebP)
```

**Response 200:**
```json
{ "data": { "logo_url": "https://storage.supabase.co/..." } }
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 400 | `invalid_file_type` | Solo PNG, JPG, WebP |
| 400 | `file_too_large` | Máximo 2MB |

---

## 5. Branches (Sucursales)

---

### `GET /branches`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Lista sucursales del tenant.

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Sucursal Centro",
      "address": "Av. San Martín 123",
      "city": "Córdoba",
      "phone": "+5493514000000",
      "email": "centro@inmobiliariasur.com",
      "active": true,
      "users_count": 2,
      "properties_count": 4
    }
  ]
}
```

---

### `POST /branches`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Crea una nueva sucursal.

**Request Body:**
```json
{
  "name": "Sucursal Norte",
  "address": "Av. Colón 456",
  "city": "Córdoba",
  "phone": "+5493514111111",
  "email": "norte@inmobiliariasur.com"
}
```

**Response 201:**
```json
{ "data": { "id": "uuid", "name": "Sucursal Norte" } }
```

---

### `GET /branches/:id`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Response 200:** Objeto completo de branch (igual a listado).

---

### `PATCH /branches/:id`

**Tipo:** AUTH  
**Roles:** owner  
**Request Body:** Cualquier campo del POST, todos opcionales.  
**Response 200:** Objeto actualizado.

---

### `DELETE /branches/:id`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Desactiva la sucursal (`active = false`). No elimina el registro.

**Response 204:** Sin contenido.

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 409 | `branch_has_active_users` | Reasignar usuarios antes de desactivar |
| 409 | `branch_has_active_whatsapp` | Desvincular número WhatsApp primero |

---

## 6. Usuarios (tenant_users)

---

### `GET /users`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Lista usuarios del tenant.

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Laura Paz",
      "email": "laura@inmobiliariasur.com",
      "role": "receptionist",
      "branch": { "id": "uuid", "name": "Sucursal Centro" },
      "active": true,
      "last_sign_in": "2026-06-21T08:30:00Z"
    }
  ]
}
```

---

### `POST /users`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Invita un nuevo usuario al tenant. Crea `auth.users` (service_role) + `tenant_users`. Envía email de invitación vía Supabase Auth invite o Resend.

**Request Body:**
```json
{
  "name": "Laura Paz",
  "email": "laura@inmobiliariasur.com",
  "role": "receptionist",
  "branch_id": "uuid"
}
```

**Response 201:**
```json
{
  "data": {
    "id": "uuid",
    "email": "laura@inmobiliariasur.com",
    "role": "receptionist",
    "invite_sent": true
  }
}
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 409 | `email_taken` | Email ya existe en el tenant |
| 422 | `user_limit_reached` | Se alcanzó `max_users` del plan |
| 422 | `owner_cannot_have_branch` | Rol owner no puede tener branch_id |
| 422 | `branch_not_in_tenant` | branch_id no pertenece al tenant |

---

### `GET /users/:id`

**Tipo:** AUTH  
**Roles:** owner  
**Response 200:** Objeto completo del usuario.

---

### `PATCH /users/:id`

**Tipo:** AUTH  
**Roles:** owner (cualquier usuario), tenant_user (solo self — nombre y email)  
**Descripción:** Actualiza datos del usuario. Owner puede cambiar rol y branch. Usuarios solo pueden actualizar su propio nombre/email.

**Request Body (owner actualizando otro):**
```json
{
  "name": "Laura Paz Hernández",
  "role": "receptionist",
  "branch_id": "uuid",
  "active": true
}
```

**Request Body (self-update):**
```json
{
  "name": "Laura Paz Hernández",
  "email": "nueva@email.com"
}
```

**Response 200:** Objeto usuario actualizado.

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 403 | `cannot_modify_own_role` | Un usuario no puede cambiar su propio rol |
| 422 | `owner_cannot_have_branch` | Ver POST /users |
| 422 | `branch_not_in_tenant` | Ver POST /users |

---

### `DELETE /users/:id`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Desactiva el usuario (`active = false`). No elimina el registro ni la cuenta auth.users.

**Response 204:** Sin contenido.

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 403 | `cannot_deactivate_self` | Un owner no puede desactivarse a sí mismo |
| 409 | `last_owner` | No se puede desactivar el último owner del tenant |

---

## 7. Properties (Propiedades)

---

### `GET /properties`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Lista propiedades del tenant. Receptionist con branch_id ve solo las de su sucursal.

**Query Params:**
| Param | Tipo | Descripción |
|---|---|---|
| `branch_id` | uuid | Filtro por sucursal (owner) |
| `published` | boolean | Filtro por publicadas/no |
| `city` | string | Filtro por ciudad |
| `q` | string | Búsqueda por título |

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "title": "Cabaña del Bosque",
      "city": "La Cumbrecita",
      "neighborhood": "Zona central",
      "published": true,
      "branch": { "id": "uuid", "name": "Sucursal Centro" },
      "units_count": 3,
      "cover_image": "https://storage.supabase.co/...",
      "created_at": "2026-03-10T10:00:00Z"
    }
  ],
  "meta": { "total": 8, "page": 1, "per_page": 20, "total_pages": 1 }
}
```

---

### `POST /properties`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Crea una nueva propiedad.

**Request Body:**
```json
{
  "title": "Cabaña del Bosque",
  "description": "Cabaña acogedora con vista al bosque...",
  "city": "La Cumbrecita",
  "neighborhood": "Zona central",
  "address": "Camino al Bosque 45",
  "google_maps_url": "https://maps.google.com/?q=...",
  "branch_id": "uuid",
  "attributes": {
    "pileta": true,
    "cochera": false,
    "mascotas": true,
    "wifi": true,
    "capacidad_maxima": 6
  }
}
```

**Response 201:**
```json
{ "data": { "id": "uuid", "title": "Cabaña del Bosque", "published": false } }
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 422 | `property_limit_reached` | Se alcanzó `max_properties` del plan |
| 422 | `branch_not_in_tenant` | branch_id inválido |

---

### `GET /properties/:id`

**Tipo:** AUTH  
**Roles:** owner, receptionist  

**Response 200:**
```json
{
  "data": {
    "id": "uuid",
    "title": "Cabaña del Bosque",
    "description": "...",
    "city": "La Cumbrecita",
    "neighborhood": "Zona central",
    "address": "Camino al Bosque 45",
    "google_maps_url": "https://maps.google.com/?q=...",
    "branch": { "id": "uuid", "name": "Sucursal Centro" },
    "attributes": { "pileta": true, "cochera": false },
    "published": true,
    "images": [
      { "id": "uuid", "image_url": "https://...", "sort_order": 0, "is_cover": true }
    ],
    "units": [
      { "id": "uuid", "name": "Cabaña A", "capacity": 4, "price": "15000.00", "active": true }
    ],
    "created_at": "2026-03-10T10:00:00Z",
    "updated_at": "2026-06-01T12:00:00Z"
  }
}
```

---

### `PATCH /properties/:id`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Actualiza campos de la propiedad. Campos no incluidos no se modifican.

**Request Body:** Igual a POST, todos opcionales.

**Response 200:** Objeto propiedad actualizado.

---

### `POST /properties/:id/publish`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Publica la propiedad en el sitio público. Valida que tenga al menos una imagen y una unidad activa.

**Response 200:**
```json
{ "data": { "id": "uuid", "published": true } }
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 422 | `no_images` | La propiedad necesita al menos una imagen para publicarse |
| 422 | `no_active_units` | La propiedad necesita al menos una unidad activa |

---

### `POST /properties/:id/unpublish`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Despublica la propiedad.

**Response 200:**
```json
{ "data": { "id": "uuid", "published": false } }
```

---

### `DELETE /properties/:id`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Soft delete. Setea `deleted_at = now()`. El trigger `trg_cascade_property_soft_delete` propaga a sus unidades. Las reservas futuras NO se cancelan automáticamente — el owner debe gestionarlas primero.

**Response 204:** Sin contenido.

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 409 | `has_future_reservations` | Existen reservas futuras confirmadas. Cancelar o reasignar primero. |

---

## 8. Property Images

---

### `GET /properties/:id/images`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Response 200:**
```json
{
  "data": [
    { "id": "uuid", "image_url": "https://...", "sort_order": 0, "is_cover": true },
    { "id": "uuid", "image_url": "https://...", "sort_order": 1, "is_cover": false }
  ]
}
```

---

### `POST /properties/:id/images`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Sube una o más imágenes a Supabase Storage y registra los URLs. Acepta multipart o array de URLs ya subidas (upload directo desde cliente).

**Request:** `multipart/form-data`
```
files[]: <imagen> (max 5MB c/u, máx 10 imágenes por request)
is_cover: false
```

**Alternativa (URLs pre-subidas desde cliente):**
```json
{
  "images": [
    { "image_url": "https://storage.supabase.co/...", "is_cover": false },
    { "image_url": "https://storage.supabase.co/...", "is_cover": true }
  ]
}
```

**Response 201:**
```json
{
  "data": [
    { "id": "uuid", "image_url": "https://...", "sort_order": 0, "is_cover": true }
  ]
}
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 400 | `invalid_file_type` | Solo PNG, JPG, WebP |
| 409 | `cover_already_exists` | Si `is_cover=true` y ya hay una cover (índice UNIQUE parcial) |

---

### `PATCH /properties/:id/images/sort`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Actualiza el orden de las imágenes en bloque.

**Request Body:**
```json
{
  "order": [
    { "id": "uuid", "sort_order": 0 },
    { "id": "uuid", "sort_order": 1 }
  ]
}
```

**Response 200:**
```json
{ "data": { "updated": 3 } }
```

---

### `PATCH /properties/:id/images/:imageId/cover`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Establece una imagen como cover. Desestablece la anterior automáticamente.

**Response 200:**
```json
{ "data": { "id": "uuid", "is_cover": true } }
```

---

### `DELETE /properties/:id/images/:imageId`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Elimina la imagen del registro y de Supabase Storage.

**Response 204:** Sin contenido.

---

## 9. Units (Unidades)

---

### `GET /units`

**Tipo:** AUTH  
**Roles:** owner, receptionist  

**Query Params:**
| Param | Tipo | Descripción |
|---|---|---|
| `property_id` | uuid | **Requerido**. Filtrar por propiedad |
| `active` | boolean | Filtro |

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Cabaña A",
      "capacity": 4,
      "price": "15000.00",
      "currency": "ARS",
      "active": true,
      "cover_image": "https://...",
      "upcoming_reservations_count": 2
    }
  ]
}
```

---

### `POST /units`

**Tipo:** AUTH  
**Roles:** owner  

**Request Body:**
```json
{
  "property_id": "uuid",
  "name": "Cabaña A",
  "capacity": 4,
  "price": 15000.00,
  "currency": "ARS"
}
```

**Response 201:**
```json
{ "data": { "id": "uuid", "name": "Cabaña A", "property_id": "uuid" } }
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 422 | `property_not_in_tenant` | property_id no pertenece al tenant del JWT |

---

### `GET /units/:id`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Response 200:** Objeto completo con `images`, `upcoming_blocks`.

---

### `PATCH /units/:id`

**Tipo:** AUTH  
**Roles:** owner  
**Request Body:** Igual a POST, todos opcionales.  
**Response 200:** Objeto actualizado.

---

### `DELETE /units/:id`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Soft delete. Igual que propiedades, valida reservas futuras primero.

**Response 204:** Sin contenido.

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 409 | `has_future_reservations` | Cancelar reservas futuras primero |

---

## 10. Unit Images

> Idéntico a Property Images, bajo la ruta `/units/:id/images`. Mismos endpoints: `GET`, `POST`, `PATCH sort`, `PATCH :imageId/cover`, `DELETE :imageId`.

---

## 11. Availability (Disponibilidad)

---

### `GET /units/:id/availability`

**Tipo:** PUBLIC / AUTH  
**Roles:** anon, owner, receptionist  
**Descripción:** Consulta bloques de disponibilidad. Si el usuario es anon, solo muestra bloqueos de unidades de propiedades publicadas.

**Query Params:**
| Param | Tipo | Descripción |
|---|---|---|
| `start_date` | date (YYYY-MM-DD) | **Requerido** |
| `end_date` | date (YYYY-MM-DD) | **Requerido** |

**Response 200:**
```json
{
  "data": {
    "unit_id": "uuid",
    "unit_name": "Cabaña A",
    "blocks": [
      {
        "start_date": "2026-07-01",
        "end_date": "2026-07-07",
        "reason": "reservation",
        "reservation_id": "uuid"
      },
      {
        "start_date": "2026-07-15",
        "end_date": "2026-07-20",
        "reason": "maintenance",
        "reservation_id": null
      }
    ],
    "is_available_for_range": false
  }
}
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 400 | `invalid_date_range` | end_date debe ser posterior a start_date |
| 400 | `range_too_large` | Máximo 365 días por consulta |

---

### `POST /units/:id/blocks`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Crea un bloqueo manual (mantenimiento u otros). El constraint `no_double_booking` rechaza a nivel DB si hay superposición.

**Request Body:**
```json
{
  "start_date": "2026-07-15",
  "end_date": "2026-07-20",
  "reason": "maintenance"
}
```

**Response 201:**
```json
{
  "data": {
    "id": "uuid",
    "unit_id": "uuid",
    "start_date": "2026-07-15",
    "end_date": "2026-07-20",
    "reason": "maintenance"
  }
}
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 409 | `dates_overlap` | El constraint `no_double_booking` detectó superposición |
| 422 | `reason_reservation_requires_id` | Si reason='reservation', usar el flujo de reservas |

---

### `DELETE /units/:id/blocks/:blockId`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Libera un bloqueo manual. No puede eliminar bloques de tipo `reservation` — esos se liberan cancelando la reserva.

**Response 204:** Sin contenido.

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 422 | `cannot_delete_reservation_block` | Cancelar la reserva para liberar el bloqueo |

---

## 12. Contacts (Contactos)

---

### `GET /contacts`

**Tipo:** AUTH  
**Roles:** owner, receptionist  

**Query Params:**
| Param | Tipo | Descripción |
|---|---|---|
| `q` | string | Búsqueda por nombre, teléfono o email |
| `source` | string | `whatsapp`, `website`, `manual` |

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Pedro Fernández",
      "phone": "+5493516000000",
      "email": "pedro@email.com",
      "source": "whatsapp",
      "open_conversations_count": 1,
      "last_reservation_date": "2026-06-10",
      "created_at": "2026-05-01T10:00:00Z"
    }
  ],
  "meta": { "total": 234, "page": 1, "per_page": 20 }
}
```

---

### `POST /contacts`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Crea un contacto manual. Usa `ON CONFLICT DO NOTHING` sobre el índice parcial de phone para evitar duplicados.

**Request Body:**
```json
{
  "name": "Pedro Fernández",
  "phone": "+5493516000000",
  "email": "pedro@email.com",
  "source": "manual"
}
```

**Response 201:**
```json
{ "data": { "id": "uuid", "name": "Pedro Fernández" } }
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 409 | `phone_already_exists` | El teléfono ya está registrado para un contacto activo del tenant |
| 422 | `missing_contact_method` | Se requiere al menos phone o email (CHECK constraint) |

---

### `GET /contacts/:id`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Response 200:** Objeto completo + historial reciente (últimas 5 conversaciones, última reserva, tareas abiertas).

---

### `PATCH /contacts/:id`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Request Body:** Cualquier campo de POST, todos opcionales.  
**Response 200:** Objeto actualizado.

---

### `DELETE /contacts/:id`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Soft delete. Setea `deleted_at = now()`. Conversaciones y reservas existentes no se afectan.

**Response 204:** Sin contenido.

---

## 13. Conversations (Conversaciones)

---

### `GET /conversations`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Inbox de conversaciones. Receptionist con branch_id solo ve las de su sucursal.

**Query Params:**
| Param | Tipo | Descripción |
|---|---|---|
| `status` | string | `open`, `waiting`, `closed` |
| `ai_mode` | string | `auto`, `human`, `disabled` |
| `assigned_to` | uuid | Filtro por usuario asignado |
| `branch_id` | uuid | Filtro por sucursal (owner) |
| `contact_id` | uuid | Filtro por contacto |
| `q` | string | Búsqueda en nombre de contacto |
| `unread_only` | boolean | Solo con mensajes no leídos |

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "status": "open",
      "ai_mode": "auto",
      "channel": "whatsapp",
      "contact": { "id": "uuid", "name": "Pedro Fernández", "phone": "+5493516000000" },
      "assigned_to": { "id": "uuid", "name": "Laura Paz" },
      "branch": { "id": "uuid", "name": "Sucursal Centro" },
      "last_message": {
        "content": "¿Tienen disponibilidad para julio?",
        "sender_type": "customer",
        "created_at": "2026-06-22T09:15:00Z"
      },
      "unread_count": 2,
      "updated_at": "2026-06-22T09:15:00Z"
    }
  ],
  "meta": { "total": 15, "page": 1, "per_page": 20 }
}
```

---

### `POST /conversations`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Crea una conversación manual (no por WhatsApp entrante).

**Request Body:**
```json
{
  "contact_id": "uuid",
  "channel": "manual",
  "branch_id": "uuid",
  "source": "manual"
}
```

**Response 201:**
```json
{ "data": { "id": "uuid", "status": "open", "contact_id": "uuid" } }
```

---

### `GET /conversations/:id`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Response 200:**
```json
{
  "data": {
    "id": "uuid",
    "status": "open",
    "ai_mode": "auto",
    "channel": "whatsapp",
    "source": "whatsapp_direct",
    "contact": { "id": "uuid", "name": "Pedro Fernández", "phone": "+549351..." },
    "assigned_to": null,
    "branch": { "id": "uuid", "name": "Sucursal Centro" },
    "whatsapp_thread_id": "wamid.xxx",
    "created_at": "2026-06-22T08:00:00Z",
    "closed_at": null,
    "reservations": [{ "id": "uuid", "status": "pre_reserved" }],
    "tasks": [{ "id": "uuid", "title": "Enviar presupuesto", "status": "pending" }]
  }
}
```

---

### `PATCH /conversations/:id/assign`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Asigna la conversación a un usuario del tenant.

**Request Body:**
```json
{ "user_id": "uuid" }
```

**Response 200:**
```json
{ "data": { "id": "uuid", "assigned_user_id": "uuid" } }
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 422 | `user_not_in_tenant` | El usuario no pertenece al tenant |

---

### `PATCH /conversations/:id/ai-mode`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Cambia el modo de IA (auto/human/disabled).

**Request Body:**
```json
{ "ai_mode": "human" }
```

**Response 200:**
```json
{ "data": { "id": "uuid", "ai_mode": "human" } }
```

---

### `POST /conversations/:id/close`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Response 200:**
```json
{ "data": { "id": "uuid", "status": "closed", "closed_at": "2026-06-22T10:00:00Z" } }
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 409 | `already_closed` | La conversación ya está cerrada |

---

### `POST /conversations/:id/reopen`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Response 200:**
```json
{ "data": { "id": "uuid", "status": "open", "closed_at": null } }
```

---

## 14. Messages (Mensajes)

---

### `GET /conversations/:id/messages`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Lista mensajes de una conversación en orden cronológico. Paginación cursor-based (más eficiente para chat history).

**Query Params:**
| Param | Tipo | Descripción |
|---|---|---|
| `before` | uuid | Cursor: mensajes anteriores a este ID |
| `limit` | int | Default 50, máx 100 |

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "sender_type": "customer",
      "sender_id": null,
      "content": "¿Tienen disponibilidad para el finde de semana del 4 de julio?",
      "content_type": "text",
      "metadata": null,
      "created_at": "2026-06-22T08:00:00Z"
    },
    {
      "id": "uuid",
      "sender_type": "ai",
      "sender_id": null,
      "content": "¡Hola! Sí, tenemos disponibilidad...",
      "content_type": "text",
      "metadata": { "model": "claude-sonnet-4-6", "tools_used": ["check_availability"] },
      "created_at": "2026-06-22T08:00:03Z"
    }
  ],
  "meta": { "has_more": true, "next_cursor": "uuid" }
}
```

---

### `POST /conversations/:id/messages`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Envía un mensaje humano en la conversación. Si el canal es WhatsApp, envía a la API de Meta. Cambia `ai_mode` a `human` si no lo está.

**Request Body:**
```json
{
  "content": "Hola Pedro, le confirmo que tenemos disponibilidad.",
  "content_type": "text"
}
```

**Response 201:**
```json
{
  "data": {
    "id": "uuid",
    "sender_type": "human",
    "sender_id": "uuid",
    "content": "Hola Pedro, le confirmo...",
    "content_type": "text",
    "created_at": "2026-06-22T10:05:00Z",
    "whatsapp_message_id": "wamid.xxx"
  }
}
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 422 | `conversation_closed` | Reabrir conversación antes de enviar mensajes |
| 422 | `whatsapp_window_expired` | La ventana de 24h de WhatsApp expiró. Usar template. |
| 502 | `whatsapp_api_error` | Meta API rechazó el mensaje |

**Notas:** La lógica de envío a Meta usa `service_role` internamente para no exponer credenciales. El endpoint inserta en `messages` y llama a la Meta API en el mismo request (no en cola, ya que el humano espera confirmación).

---

## 15. Reservations (Reservas)

---

### `GET /reservations`

**Tipo:** AUTH  
**Roles:** owner, receptionist  

**Query Params:**
| Param | Tipo | Descripción |
|---|---|---|
| `status` | string | `inquiry`, `interested`, `pre_reserved`, `pending_payment`, `confirmed`, `cancelled` |
| `unit_id` | uuid | Filtro por unidad |
| `contact_id` | uuid | Filtro por contacto |
| `start_date` | date | Filtro: reservas que empiezan desde esta fecha |
| `end_date` | date | Filtro: reservas que empiezan hasta esta fecha |

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "status": "confirmed",
      "contact": { "id": "uuid", "name": "Pedro Fernández" },
      "unit": { "id": "uuid", "name": "Cabaña A", "property_title": "Cabaña del Bosque" },
      "start_date": "2026-07-04",
      "end_date": "2026-07-07",
      "guests": 4,
      "total_amount": "45000.00",
      "currency": "ARS",
      "expires_at": null,
      "created_at": "2026-06-20T14:00:00Z"
    }
  ]
}
```

---

### `POST /reservations`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Crea una reserva y su `availability_block` correspondiente en una transacción. El constraint `no_double_booking` garantiza atomicidad.

**Request Body:**
```json
{
  "contact_id": "uuid",
  "unit_id": "uuid",
  "conversation_id": "uuid",
  "start_date": "2026-07-04",
  "end_date": "2026-07-07",
  "guests": 4,
  "total_amount": 45000.00,
  "currency": "ARS",
  "status": "pre_reserved",
  "notes": "Llegan tarde, ~22hs"
}
```

**Response 201:**
```json
{
  "data": {
    "id": "uuid",
    "status": "pre_reserved",
    "expires_at": "2026-06-24T14:00:00Z",
    "availability_block_id": "uuid"
  }
}
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 409 | `dates_not_available` | El constraint `no_double_booking` detectó superposición |
| 422 | `unit_not_in_tenant` | unit_id no pertenece al tenant |
| 422 | `contact_not_in_tenant` | contact_id no pertenece al tenant |
| 422 | `invalid_guest_count` | guests > unidad.capacity |

---

### `GET /reservations/:id`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Response 200:** Objeto completo con contact, unit, property, blocks, tasks relacionadas.

---

### `PATCH /reservations/:id`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Actualiza campos de la reserva (notas, cantidad de huéspedes, monto). No cambia status — usar endpoints específicos de transición.

**Request Body:**
```json
{
  "guests": 5,
  "total_amount": 50000.00,
  "notes": "Traen mascota"
}
```

**Response 200:** Objeto actualizado.

---

### `POST /reservations/:id/confirm`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Confirma la reserva. Transición de cualquier estado → `confirmed`.

**Response 200:**
```json
{ "data": { "id": "uuid", "status": "confirmed", "expires_at": null } }
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 409 | `already_cancelled` | No se puede confirmar una reserva cancelada |

---

### `POST /reservations/:id/cancel`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Cancela la reserva. El trigger `release_availability_on_cancellation` elimina el `availability_block` automáticamente.

**Request Body:**
```json
{ "reason": "El cliente desistió" }
```

**Response 200:**
```json
{ "data": { "id": "uuid", "status": "cancelled" } }
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 409 | `already_cancelled` | Ya está cancelada |

---

## 16. Tasks (Tareas)

---

### `GET /tasks`

**Tipo:** AUTH  
**Roles:** owner, receptionist  

**Query Params:**
| Param | Tipo | Descripción |
|---|---|---|
| `status` | string | `pending`, `in_progress`, `completed`, `cancelled` |
| `assigned_to` | uuid | Filtro por asignado |
| `contact_id` | uuid | Filtro por contacto |
| `reservation_id` | uuid | Filtro por reserva |
| `overdue_only` | boolean | Solo vencidas |

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "title": "Enviar presupuesto de julio",
      "status": "pending",
      "due_date": "2026-06-23T18:00:00Z",
      "assigned_to": { "id": "uuid", "name": "Laura Paz" },
      "contact": { "id": "uuid", "name": "Pedro Fernández" },
      "is_overdue": false,
      "created_at": "2026-06-22T09:00:00Z"
    }
  ]
}
```

---

### `POST /tasks`

**Tipo:** AUTH  
**Roles:** owner, receptionist  

**Request Body:**
```json
{
  "title": "Enviar presupuesto de julio",
  "description": "Incluir descuento por semana completa",
  "due_date": "2026-06-23T18:00:00Z",
  "assigned_to": "uuid",
  "contact_id": "uuid",
  "conversation_id": "uuid",
  "reservation_id": null
}
```

**Response 201:**
```json
{ "data": { "id": "uuid", "title": "...", "status": "pending" } }
```

---

### `GET /tasks/:id`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Response 200:** Objeto completo con contact, reservation, conversation vinculados.

---

### `PATCH /tasks/:id`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Actualiza campos. Si `status = 'completed'`, el trigger `trg_tasks_completed_at` setea `completed_at` automáticamente.

**Request Body:** Cualquier campo del POST + `status`.

**Response 200:** Objeto actualizado.

---

### `DELETE /tasks/:id`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Hard delete. Las tareas completadas o canceladas pueden eliminarse.

**Response 204:** Sin contenido.

---

## 17. Notes (Notas)

---

### `GET /notes`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Lista notas. Siempre filtrar por al menos un entity.

**Query Params:**
| Param | Tipo | Descripción |
|---|---|---|
| `contact_id` | uuid | Notas de un contacto |
| `reservation_id` | uuid | Notas de una reserva |
| `conversation_id` | uuid | Notas de una conversación |

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "content": "Cliente muy exigente, confirmar todo por escrito.",
      "created_by": { "id": "uuid", "name": "Laura Paz" },
      "created_at": "2026-06-20T11:00:00Z"
    }
  ]
}
```

---

### `POST /notes`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Agrega una nota (append-only). `created_by` se toma del JWT, no del body.

**Request Body:**
```json
{
  "content": "Cliente interesado para julio. Confirmar disponibilidad.",
  "contact_id": "uuid",
  "reservation_id": null,
  "conversation_id": "uuid"
}
```

**Response 201:**
```json
{ "data": { "id": "uuid", "content": "...", "created_at": "2026-06-22T10:00:00Z" } }
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 422 | `missing_entity` | Al menos un entity (contact/reservation/conversation) es requerido |

**Notas:** No existe `PATCH /notes/:id` ni `DELETE /notes/:id`. Las notas son inmutables por diseño.

---

## 18. Notifications (Notificaciones)

---

### `GET /notifications`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Owner ve todas; receptionist ve solo las propias.

**Query Params:**
| Param | Tipo | Descripción |
|---|---|---|
| `status` | string | `pending`, `sent`, `failed` |
| `unread_only` | boolean | Solo no leídas (status='sent' y sin mark-read) |
| `channel` | string | `in_app`, `whatsapp`, `email` |

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "type": "new_conversation",
      "channel": "in_app",
      "status": "sent",
      "payload": { "conversation_id": "uuid", "contact_name": "Pedro Fernández" },
      "created_at": "2026-06-22T09:00:00Z"
    }
  ]
}
```

---

### `POST /notifications/read`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Marca múltiples notificaciones como leídas (status → 'sent' + campo `read_at`).

**Request Body:**
```json
{ "ids": ["uuid1", "uuid2"] }
```

**Response 200:**
```json
{ "data": { "updated": 2 } }
```

---

### `POST /notifications/read-all`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Marca todas las notificaciones del usuario como leídas.

**Response 200:**
```json
{ "data": { "updated": 14 } }
```

---

## 19. Documents (Documentos)

---

### `GET /documents`

**Tipo:** AUTH  
**Roles:** owner, receptionist  

**Query Params:** `property_id`, `unit_id`, `document_type`

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Reglamento de convivencia",
      "document_type": "regulation",
      "file_url": "https://storage.supabase.co/...",
      "property": { "id": "uuid", "title": "Cabaña del Bosque" },
      "unit": null,
      "created_at": "2026-03-01T10:00:00Z"
    }
  ]
}
```

---

### `POST /documents`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Sube un documento a Supabase Storage.

**Request:** `multipart/form-data`
```
file: <documento> (PDF, DOC, DOCX — máx 10MB)
name: "Reglamento de convivencia"
document_type: "regulation"
property_id: "uuid"
```

**Response 201:**
```json
{ "data": { "id": "uuid", "name": "...", "file_url": "https://..." } }
```

---

### `DELETE /documents/:id`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Elimina documento del registro y Supabase Storage.

**Response 204:** Sin contenido.

---

## 20. AI Settings

---

### `GET /ai-settings`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Response 200:**
```json
{
  "data": {
    "id": "uuid",
    "model": "claude-sonnet-4-6",
    "system_prompt": "Sos el asistente de Complejo Las Sierras...",
    "assistant_name": "Simón",
    "escalation_keywords": ["hablar con alguien", "humano", "persona"],
    "max_turns_before_escalation": 20,
    "response_delay_ms": 1500,
    "max_context_messages": 10,
    "active": true
  }
}
```

---

### `PUT /ai-settings`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Actualiza la configuración de IA del tenant. Si no existe, la crea (upsert).

**Request Body:**
```json
{
  "system_prompt": "Sos Simón, el asistente virtual de Complejo Las Sierras...",
  "assistant_name": "Simón",
  "escalation_keywords": ["quiero hablar con alguien", "agente humano"],
  "max_turns_before_escalation": 15,
  "response_delay_ms": 2000,
  "max_context_messages": 10,
  "active": true
}
```

**Response 200:** Objeto ai_settings completo.

---

### `POST /ai-settings/test`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Envía un mensaje de prueba al AI con la configuración actual. Respuesta síncrona (timeout 30s). Útil para validar el system_prompt antes de activar.

**Request Body:**
```json
{
  "message": "Hola, ¿tienen disponibilidad para 4 personas del 4 al 7 de julio?"
}
```

**Response 200:**
```json
{
  "data": {
    "response": "¡Hola! Soy Simón, el asistente de Complejo Las Sierras...",
    "model": "claude-sonnet-4-6",
    "input_tokens": 245,
    "output_tokens": 87,
    "tools_called": ["check_availability"],
    "response_time_ms": 1823
  }
}
```

---

## 21. WhatsApp Accounts

---

### `GET /whatsapp-accounts`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "phone_number": "+5493512000000",
      "business_account_id": "1234567890",
      "branch": { "id": "uuid", "name": "Sucursal Centro" },
      "active": true,
      "last_verified_at": "2026-06-20T10:00:00Z",
      "token_expires_at": "2026-09-20T10:00:00Z"
    }
  ]
}
```

---

### `POST /whatsapp-accounts`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Registra un nuevo número de WhatsApp Business. El token se encripta antes de almacenar.

**Request Body:**
```json
{
  "phone_number": "+5493512000000",
  "business_account_id": "1234567890",
  "access_token": "EAAxxxx...",
  "webhook_secret": "random_secret_for_hmac",
  "token_expires_at": "2026-09-20T10:00:00Z",
  "branch_id": "uuid"
}
```

**Response 201:**
```json
{
  "data": {
    "id": "uuid",
    "phone_number": "+5493512000000",
    "webhook_url": "https://app.orderflow.app/api/webhooks/whatsapp?account=uuid"
  }
}
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 409 | `phone_already_active` | El número ya tiene una cuenta activa en este tenant |

---

### `POST /whatsapp-accounts/:id/verify`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Verifica el token enviando un test a la Meta API. Actualiza `last_verified_at`.

**Response 200:**
```json
{ "data": { "verified": true, "phone_number": "+5493512000000" } }
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 502 | `meta_verification_failed` | Meta rechazó el token |

---

### `DELETE /whatsapp-accounts/:id`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Desactiva la cuenta (`active = false`). El índice parcial `idx_whatsapp_accounts_phone_active` permite reutilizar el número en el futuro.

**Response 204:** Sin contenido.

---

## 22. WhatsApp Webhook (Meta)

> Estos endpoints los llama Meta, no el frontend.

---

### `GET /webhooks/whatsapp`

**Tipo:** WEBHOOK  
**Descripción:** Verificación del webhook por Meta. Responde al challenge de validación.

**Query Params enviados por Meta:**
```
hub.mode=subscribe
hub.verify_token={WEBHOOK_VERIFY_TOKEN}
hub.challenge={random_string}
```

**Response 200 (texto plano):** El valor de `hub.challenge`.

**Response 403:** Si `hub.verify_token` no coincide con el configurado.

**Notas:** `WEBHOOK_VERIFY_TOKEN` es una variable de entorno del servidor. Nunca hardcodear.

---

### `POST /webhooks/whatsapp`

**Tipo:** WEBHOOK (HMAC)  
**Descripción:** Recibe eventos de Meta (mensajes entrantes, status updates). Debe responder 200 en menos de 5 segundos. Toda la lógica pesada va a `message_queue`.

**Headers requeridos:**
```
X-Hub-Signature-256: sha256={hmac_hex}
```

**Request Body (ejemplo mensaje entrante):**
```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "WABA_ID",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": { "display_phone_number": "5493512000000", "phone_number_id": "..." },
        "contacts": [{ "profile": { "name": "Pedro Fernández" }, "wa_id": "5493516000000" }],
        "messages": [{
          "from": "5493516000000",
          "id": "wamid.xxx",
          "timestamp": "1750000000",
          "text": { "body": "Hola, ¿tienen disponibilidad?" },
          "type": "text"
        }]
      },
      "field": "messages"
    }]
  }]
}
```

**Response 200 (siempre):**
```json
{ "status": "queued" }
```

**Flujo interno:**
1. Validar firma HMAC con `X-Hub-Signature-256`.
2. Identificar el `whatsapp_account` por `phone_number_id` o número.
3. `INSERT INTO message_queue (tenant_id, whatsapp_account_id, raw_payload) VALUES (...)` vía service_role.
4. Responder 200 inmediatamente.
5. El trigger `trg_message_queue_notify` dispara `pg_notify('message_queue_new', queue_id)`.
6. El worker despierta y procesa.

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 403 | — | Firma HMAC inválida. Siempre responder 200 a Meta para evitar retries, loguear el error internamente. |

**Notas de seguridad:** Validar HMAC antes de cualquier procesamiento. Usar `timingSafeEqual` para comparación de firmas. Si el `whatsapp_account` no existe (número desconocido), igualmente encolar y loguear — no retornar 404 a Meta.

---

### `POST /webhooks/whatsapp/send`

**Tipo:** SERVICE  
**Descripción:** Endpoint interno que el worker usa para enviar mensajes salientes a Meta API. Desacopla el worker de la gestión de tokens encriptados.

**Headers:**
```
X-Service-Key: {SUPABASE_SERVICE_ROLE_KEY}
```

**Request Body:**
```json
{
  "whatsapp_account_id": "uuid",
  "to": "+5493516000000",
  "message": {
    "type": "text",
    "text": { "body": "Hola! Le confirmo disponibilidad para esas fechas..." }
  }
}
```

**Response 200:**
```json
{
  "data": {
    "whatsapp_message_id": "wamid.yyy",
    "status": "sent"
  }
}
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 422 | `whatsapp_window_expired` | Ventana 24h expirada, requiere template |
| 502 | `meta_api_error` | Error en Meta API con detalles |

---

## 23. AI Processing (Worker)

> Endpoints usados exclusivamente por el worker de IA. No accesibles desde el frontend.

---

### `POST /internal/ai/process`

**Tipo:** INTERNAL  
**Descripción:** El worker llama a este endpoint para procesar un mensaje de la cola. El endpoint orquesta el flujo completo: contexto → Claude → tools → respuesta.

**Headers:**
```
X-Internal-Secret: {INTERNAL_API_SECRET}
```

**Request Body:**
```json
{
  "queue_id": "uuid",
  "tenant_id": "uuid",
  "conversation_id": "uuid",
  "message": "¿Tienen disponibilidad del 4 al 7 de julio para 4 personas?"
}
```

**Flujo interno:**
1. Leer `ai_settings` del tenant.
2. Cargar contexto: últimos N mensajes (N = `max_context_messages`).
3. Detectar keywords de escalamiento.
4. Llamar a Claude API con tools definidas.
5. Si Claude llama tools → ejecutar → retornar resultado → continuar.
6. Insertar mensaje AI en `messages`.
7. Insertar en `ai_usage_log`.
8. Actualizar `message_queue` status → `completed`.

**Response 200:**
```json
{
  "data": {
    "message_id": "uuid",
    "response": "¡Hola! Tenemos disponibilidad para esas fechas...",
    "tools_called": ["check_availability"],
    "escalated": false,
    "tokens": { "input": 312, "output": 94 }
  }
}
```

---

### `POST /internal/ai/tools/execute`

**Tipo:** INTERNAL  
**Descripción:** Ejecuta un tool de IA validado. El worker llama esto por cada tool_call de Claude. Ejecuta la query SQL correspondiente de forma segura (no SQL arbitrario).

**Request Body:**
```json
{
  "tenant_id": "uuid",
  "tool_name": "check_availability",
  "parameters": {
    "unit_id": "uuid",
    "start_date": "2026-07-04",
    "end_date": "2026-07-07"
  }
}
```

**Tools disponibles:**

| Tool | Descripción |
|---|---|
| `search_properties` | Busca propiedades por atributos (GIN query en attributes JSONB) |
| `check_availability` | Verifica disponibilidad de una unidad en un rango de fechas |
| `get_property_details` | Retorna detalles completos de una propiedad y sus unidades |
| `create_pre_reservation` | Crea reserva en estado pre_reserved + availability_block |
| `get_contact_history` | Historial de reservas y conversaciones del contacto |
| `create_task` | Crea una tarea de seguimiento |
| `escalate_to_human` | Cambia ai_mode a 'human' y notifica al equipo |

**Response 200:**
```json
{
  "data": {
    "tool": "check_availability",
    "result": {
      "available": true,
      "unit_name": "Cabaña A",
      "price_per_night": 15000,
      "total_nights": 3
    }
  }
}
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 400 | `unknown_tool` | Tool no existe en el whitelist |
| 422 | `invalid_parameters` | Parámetros del tool inválidos |

---

### `POST /conversations/:id/escalate`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Escala manualmente una conversación a atención humana. Cambia `ai_mode → 'human'` y crea notificación.

**Request Body:**
```json
{
  "reason": "El cliente solicita hablar con un asesor"
}
```

**Response 200:**
```json
{
  "data": {
    "id": "uuid",
    "ai_mode": "human",
    "assigned_to": null
  }
}
```

---

## 24. Audit (Auditoría)

---

### `GET /audit-logs`

**Tipo:** AUTH  
**Roles:** super_admin (todos), owner (solo su tenant)  

**Query Params:**
| Param | Tipo | Descripción |
|---|---|---|
| `entity_type` | string | `tenants`, `reservations`, `tenant_users`, etc. |
| `entity_id` | uuid | Filtro por entidad específica |
| `actor_id` | uuid | Filtro por quien realizó la acción |
| `action` | string | `reservations.update`, `tenants.insert`, etc. |
| `from` | datetime | Rango desde |
| `to` | datetime | Rango hasta |

**Response 200:**
```json
{
  "data": [
    {
      "id": 12345,
      "action": "reservations.update",
      "entity_type": "reservations",
      "entity_id": "uuid",
      "actor_type": "tenant_user",
      "actor": { "id": "uuid", "name": "Laura Paz" },
      "impersonated_by": null,
      "old_value": { "status": "pre_reserved" },
      "new_value": { "status": "confirmed" },
      "created_at": "2026-06-22T10:05:00Z"
    }
  ],
  "meta": { "total": 1423, "page": 1, "per_page": 50 }
}
```

---

## 25. Dashboard (KPIs)

---

### `GET /dashboard/kpis`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** KPIs principales del tenant para el dashboard. Siempre del mes en curso vs mes anterior.

**Response 200:**
```json
{
  "data": {
    "period": { "from": "2026-06-01", "to": "2026-06-22" },
    "conversations": {
      "total": 48,
      "open": 12,
      "closed": 36,
      "change_pct": 15.3
    },
    "reservations": {
      "confirmed": 18,
      "pre_reserved": 5,
      "cancelled": 3,
      "revenue": 810000.00,
      "currency": "ARS",
      "change_pct": 22.1
    },
    "ai_stats": {
      "messages_processed": 312,
      "escalations": 8,
      "escalation_rate_pct": 2.6,
      "avg_response_time_ms": 1943
    },
    "contacts": {
      "new": 31,
      "total": 234,
      "change_pct": 12.7
    }
  }
}
```

---

### `GET /dashboard/conversations-by-day`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Volumen de conversaciones nuevas por día (últimos 30 días). Para el gráfico de líneas.

**Query Params:** `from` (date), `to` (date)

**Response 200:**
```json
{
  "data": [
    { "date": "2026-06-01", "new_conversations": 3, "closed_conversations": 5 },
    { "date": "2026-06-02", "new_conversations": 7, "closed_conversations": 4 }
  ]
}
```

---

### `GET /dashboard/reservations-by-unit`

**Tipo:** AUTH  
**Roles:** owner  
**Descripción:** Ocupación por unidad para el calendario del dashboard.

**Query Params:** `month` (YYYY-MM)

**Response 200:**
```json
{
  "data": [
    {
      "unit_id": "uuid",
      "unit_name": "Cabaña A",
      "property_title": "Cabaña del Bosque",
      "occupancy_days": 18,
      "total_days_in_month": 30,
      "occupancy_pct": 60.0,
      "revenue": 270000.00
    }
  ]
}
```

---

### `GET /dashboard/tasks-summary`

**Tipo:** AUTH  
**Roles:** owner, receptionist  
**Descripción:** Resumen de tareas propias y del equipo.

**Response 200:**
```json
{
  "data": {
    "my_tasks": { "pending": 3, "overdue": 1, "due_today": 2 },
    "team_tasks": { "pending": 12, "overdue": 4 }
  }
}
```

---

## 26. Public Website (anon)

> Endpoints para el sitio público de cada tenant. No requieren autenticación.

---

### `GET /public/tenants/:slug`

**Tipo:** PUBLIC  
**Descripción:** Información pública del tenant por slug. Para el SSR del sitio público.

**Response 200:**
```json
{
  "data": {
    "id": "uuid",
    "name": "Complejo Las Sierras",
    "slug": "complejo-las-sierras",
    "logo_url": "https://...",
    "primary_color": "#2563EB",
    "secondary_color": "#64748B",
    "site_config": {
      "template": "modern",
      "hero_title": "Tu próxima aventura comienza aquí",
      "show_prices": true,
      "contact_email": "info@lassierras.com"
    },
    "custom_domain": null
  }
}
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 404 | `tenant_not_found` | Slug inexistente o tenant eliminado |

---

### `GET /public/tenants/:slug/properties`

**Tipo:** PUBLIC  
**Descripción:** Lista propiedades publicadas del tenant. Para el catálogo del sitio público.

**Query Params:** `city`, `q`, `attributes` (JSON: `{"pileta":true}`), `guests` (int — filtra unidades con capacity ≥)

**Response 200:**
```json
{
  "data": [
    {
      "id": "uuid",
      "title": "Cabaña del Bosque",
      "description": "Cabaña acogedora con vista al bosque...",
      "city": "La Cumbrecita",
      "neighborhood": "Zona central",
      "attributes": { "pileta": true, "mascotas": true },
      "cover_image": "https://...",
      "min_price": 15000.00,
      "currency": "ARS",
      "units_count": 3
    }
  ]
}
```

---

### `GET /public/properties/:id`

**Tipo:** PUBLIC  
**Descripción:** Detalle de una propiedad publicada.

**Response 200:**
```json
{
  "data": {
    "id": "uuid",
    "title": "Cabaña del Bosque",
    "description": "...",
    "city": "La Cumbrecita",
    "address": "Camino al Bosque 45",
    "google_maps_url": "https://...",
    "attributes": { "pileta": true, "cochera": false, "wifi": true },
    "images": [
      { "image_url": "https://...", "sort_order": 0, "is_cover": true }
    ],
    "units": [
      {
        "id": "uuid",
        "name": "Cabaña A",
        "capacity": 4,
        "price": "15000.00",
        "currency": "ARS",
        "images": []
      }
    ]
  }
}
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 404 | `property_not_found` | No existe o no está publicada |

---

### `GET /public/units/:id/availability`

**Tipo:** PUBLIC  
**Descripción:** Consulta bloques de disponibilidad de una unidad (para el calendario de reservas públicas). Igual que `GET /units/:id/availability` pero con RLS de anon.

---

### `POST /public/inquiries`

**Tipo:** PUBLIC  
**Descripción:** Un visitante del sitio público inicia una consulta (lead). Crea o recupera el contacto por teléfono, crea una conversación con `source='website_button'`, y pone en cola el mensaje inicial para el AI.

**Request Body:**
```json
{
  "tenant_id": "uuid",
  "name": "Roberto Silva",
  "phone": "+5493511000000",
  "email": "roberto@email.com",
  "message": "Hola, me interesa la Cabaña del Bosque para julio.",
  "property_id": "uuid",
  "unit_id": "uuid"
}
```

**Response 201:**
```json
{
  "data": {
    "conversation_id": "uuid",
    "contact_id": "uuid",
    "message": "Tu consulta fue recibida. Te responderemos a la brevedad."
  }
}
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 422 | `missing_contact_method` | Se requiere phone o email |
| 429 | `rate_limit_exceeded` | Máximo 5 inquiries por IP por hora |

**Notas de seguridad:** Rate limit por IP + phone para evitar spam. Validar que `tenant_id` y `property_id` son de un tenant activo y propiedad publicada. Usar `service_role` internamente para crear contacto y conversación (el anon no tiene permisos de INSERT en contacts).

---

### `POST /public/chat/start`

**Tipo:** PUBLIC  
**Descripción:** Inicia una sesión de chat en el widget del sitio público. Si el contacto ya existe por phone, reutiliza o crea nueva conversación abierta.

**Request Body:**
```json
{
  "tenant_id": "uuid",
  "phone": "+5493511000000",
  "name": "Roberto Silva",
  "property_id": "uuid"
}
```

**Response 201:**
```json
{
  "data": {
    "conversation_id": "uuid",
    "session_token": "eyJ..."
  }
}
```

**Notas:** El `session_token` es un JWT de corta duración (1h) sin roles de usuario, solo con `conversation_id` y `tenant_id`. Permite que el visitante envíe mensajes en esa conversación sin crear una cuenta completa.

---

### `POST /public/chat/:conversationId/message`

**Tipo:** PUBLIC (session_token)  
**Descripción:** Visitante envía un mensaje. Procesamiento síncrono por Claude (timeout 30s). Para el MVP, la respuesta viene en el mismo request.

**Headers:**
```
Authorization: Bearer {session_token}
```

**Request Body:**
```json
{ "content": "¿Tienen cabaña para 6 personas disponible en julio?" }
```

**Response 200:**
```json
{
  "data": {
    "user_message": {
      "id": "uuid",
      "content": "¿Tienen cabaña para 6 personas disponible en julio?",
      "created_at": "2026-06-22T10:00:00Z"
    },
    "ai_response": {
      "id": "uuid",
      "content": "¡Hola Roberto! Sí, tenemos la Cabaña del Bosque con capacidad para 6...",
      "created_at": "2026-06-22T10:00:02Z"
    },
    "escalated": false
  }
}
```

**Errores:**
| Code | Error | Descripción |
|---|---|---|
| 401 | `invalid_session` | Session token inválido o expirado |
| 408 | `ai_timeout` | Claude tardó más de 30s (raro) |
| 429 | `rate_limit` | Máximo 30 mensajes por sesión por hora |

---

## Appendix A — Worker API (Interna)

> El worker Node.js corre como proceso separado. Estos endpoints son para administración y monitoreo, no expuestos a internet.

---

### `GET /internal/worker/health`

**Tipo:** INTERNAL  
**Response 200:**
```json
{
  "data": {
    "status": "healthy",
    "queue_pending": 3,
    "queue_processing": 1,
    "queue_failed_last_hour": 0,
    "last_processed_at": "2026-06-22T10:04:55Z"
  }
}
```

---

### `POST /internal/worker/requeue/:queueId`

**Tipo:** INTERNAL  
**Descripción:** Fuerza el reintento de un item de la cola (para admin de plataforma).

**Response 200:**
```json
{ "data": { "queue_id": "uuid", "status": "pending", "attempts": 2 } }
```

---

## Appendix B — Tabla de Endpoints

| Método | Ruta | Tipo | Roles |
|---|---|---|---|
| POST | /auth/login | PUBLIC | — |
| POST | /auth/logout | AUTH | todos |
| POST | /auth/refresh | PUBLIC | — |
| GET | /auth/me | AUTH | todos |
| GET | /platform/tenants | AUTH | super_admin |
| POST | /platform/tenants | AUTH | super_admin |
| PATCH | /platform/tenants/:id | AUTH | super_admin |
| GET | /platform/platform-users | AUTH | super_admin |
| POST | /platform/platform-users | AUTH | super_admin |
| PATCH | /platform/platform-users/:id | AUTH | super_admin |
| GET | /platform/seller-clients | AUTH | super_admin, seller |
| POST | /platform/seller-clients | AUTH | super_admin |
| POST | /impersonation | AUTH | super_admin |
| POST | /impersonation/:id/end | AUTH | super_admin |
| GET | /impersonation/sessions | AUTH | super_admin, owner |
| GET | /tenant | AUTH | owner, receptionist |
| PATCH | /tenant | AUTH | owner |
| POST | /tenant/logo | AUTH | owner |
| GET | /branches | AUTH | owner, receptionist |
| POST | /branches | AUTH | owner |
| GET | /branches/:id | AUTH | owner, receptionist |
| PATCH | /branches/:id | AUTH | owner |
| DELETE | /branches/:id | AUTH | owner |
| GET | /users | AUTH | owner |
| POST | /users | AUTH | owner |
| GET | /users/:id | AUTH | owner |
| PATCH | /users/:id | AUTH | owner, self |
| DELETE | /users/:id | AUTH | owner |
| GET | /properties | AUTH | owner, receptionist |
| POST | /properties | AUTH | owner |
| GET | /properties/:id | AUTH | owner, receptionist |
| PATCH | /properties/:id | AUTH | owner |
| POST | /properties/:id/publish | AUTH | owner |
| POST | /properties/:id/unpublish | AUTH | owner |
| DELETE | /properties/:id | AUTH | owner |
| GET | /properties/:id/images | AUTH | owner, receptionist |
| POST | /properties/:id/images | AUTH | owner |
| PATCH | /properties/:id/images/sort | AUTH | owner |
| PATCH | /properties/:id/images/:imageId/cover | AUTH | owner |
| DELETE | /properties/:id/images/:imageId | AUTH | owner |
| GET | /units | AUTH | owner, receptionist |
| POST | /units | AUTH | owner |
| GET | /units/:id | AUTH | owner, receptionist |
| PATCH | /units/:id | AUTH | owner |
| DELETE | /units/:id | AUTH | owner |
| GET | /units/:id/images | AUTH | owner, receptionist |
| POST | /units/:id/images | AUTH | owner |
| PATCH | /units/:id/images/sort | AUTH | owner |
| PATCH | /units/:id/images/:imageId/cover | AUTH | owner |
| DELETE | /units/:id/images/:imageId | AUTH | owner |
| GET | /units/:id/availability | PUBLIC/AUTH | anon, owner, receptionist |
| POST | /units/:id/blocks | AUTH | owner, receptionist |
| DELETE | /units/:id/blocks/:blockId | AUTH | owner, receptionist |
| GET | /contacts | AUTH | owner, receptionist |
| POST | /contacts | AUTH | owner, receptionist |
| GET | /contacts/:id | AUTH | owner, receptionist |
| PATCH | /contacts/:id | AUTH | owner, receptionist |
| DELETE | /contacts/:id | AUTH | owner |
| GET | /conversations | AUTH | owner, receptionist |
| POST | /conversations | AUTH | owner, receptionist |
| GET | /conversations/:id | AUTH | owner, receptionist |
| PATCH | /conversations/:id/assign | AUTH | owner |
| PATCH | /conversations/:id/ai-mode | AUTH | owner, receptionist |
| POST | /conversations/:id/close | AUTH | owner, receptionist |
| POST | /conversations/:id/reopen | AUTH | owner, receptionist |
| POST | /conversations/:id/escalate | AUTH | owner, receptionist |
| GET | /conversations/:id/messages | AUTH | owner, receptionist |
| POST | /conversations/:id/messages | AUTH | owner, receptionist |
| GET | /reservations | AUTH | owner, receptionist |
| POST | /reservations | AUTH | owner, receptionist |
| GET | /reservations/:id | AUTH | owner, receptionist |
| PATCH | /reservations/:id | AUTH | owner, receptionist |
| POST | /reservations/:id/confirm | AUTH | owner |
| POST | /reservations/:id/cancel | AUTH | owner, receptionist |
| GET | /tasks | AUTH | owner, receptionist |
| POST | /tasks | AUTH | owner, receptionist |
| GET | /tasks/:id | AUTH | owner, receptionist |
| PATCH | /tasks/:id | AUTH | owner, receptionist |
| DELETE | /tasks/:id | AUTH | owner |
| GET | /notes | AUTH | owner, receptionist |
| POST | /notes | AUTH | owner, receptionist |
| GET | /notifications | AUTH | owner, receptionist |
| POST | /notifications/read | AUTH | owner, receptionist |
| POST | /notifications/read-all | AUTH | owner, receptionist |
| GET | /documents | AUTH | owner, receptionist |
| POST | /documents | AUTH | owner |
| DELETE | /documents/:id | AUTH | owner |
| GET | /ai-settings | AUTH | owner, receptionist |
| PUT | /ai-settings | AUTH | owner |
| POST | /ai-settings/test | AUTH | owner |
| GET | /whatsapp-accounts | AUTH | owner, receptionist |
| POST | /whatsapp-accounts | AUTH | owner |
| POST | /whatsapp-accounts/:id/verify | AUTH | owner |
| DELETE | /whatsapp-accounts/:id | AUTH | owner |
| GET | /webhooks/whatsapp | WEBHOOK | Meta |
| POST | /webhooks/whatsapp | WEBHOOK | Meta |
| POST | /webhooks/whatsapp/send | SERVICE | Worker |
| POST | /internal/ai/process | INTERNAL | Worker |
| POST | /internal/ai/tools/execute | INTERNAL | Worker |
| GET | /audit-logs | AUTH | super_admin, owner |
| GET | /dashboard/kpis | AUTH | owner |
| GET | /dashboard/conversations-by-day | AUTH | owner |
| GET | /dashboard/reservations-by-unit | AUTH | owner |
| GET | /dashboard/tasks-summary | AUTH | owner, receptionist |
| GET | /public/tenants/:slug | PUBLIC | anon |
| GET | /public/tenants/:slug/properties | PUBLIC | anon |
| GET | /public/properties/:id | PUBLIC | anon |
| GET | /public/units/:id/availability | PUBLIC | anon |
| POST | /public/inquiries | PUBLIC | anon |
| POST | /public/chat/start | PUBLIC | anon |
| POST | /public/chat/:conversationId/message | PUBLIC (session) | anon |
| GET | /internal/worker/health | INTERNAL | Worker |
| POST | /internal/worker/requeue/:queueId | INTERNAL | Worker |

**Total: 95 endpoints**

---

## Appendix C — Endpoints Justificados No Mencionados en el Brief

| Endpoint | Justificación |
|---|---|
| `POST /platform/tenants` | El brief menciona "onboarding" como sección separada. Se incluye aquí porque el onboarding de tenant es una operación de plataforma (super_admin). |
| `POST /tenant/logo` | Necesario para el flujo de branding. `PATCH /tenant` acepta URL ya subida, pero el flujo de upload desde el dashboard necesita este endpoint. |
| `POST /properties/:id/publish` / `unpublish` | Las reglas de negocio (mínimo imagen + unidad activa) justifican endpoints dedicados en lugar de incluirlo en `PATCH`. |
| `PATCH /conversations/:id/ai-mode` | Control granular del modo IA. Esencial para que el receptionist deshabilite IA en conversaciones sensibles. |
| `POST /ai-settings/test` | Sin este endpoint, los owners no pueden validar su system_prompt antes de activarlo. Reduce errores en producción. |
| `POST /public/inquiries` | Flujo lead desde el sitio público sin WhatsApp. Crea contacto + conversación + encola para AI. |
| `POST /public/chat/start` + `message` | Web chat widget. El brief menciona "chat endpoint" en la sección IA. Se expone como flujo público completo. |
| `GET /webhooks/whatsapp` | Requerido por Meta para la verificación inicial del webhook (challenge). |
| `POST /webhooks/whatsapp/send` | El worker necesita un endpoint interno para enviar mensajes salientes sin acceder directamente a tokens encriptados. |
| `POST /internal/ai/tools/execute` | Whitelist de tool execution. Evita que el worker ejecute SQL arbitrario — solo tools predefinidas con validación. |
| `GET /dashboard/*` (3 endpoints) | El brief menciona "KPIs principales" pero los datos necesarios para el dashboard requieren al menos 3 queries distintas. |
| `GET /internal/worker/health` | Operacional: monitoreo del worker. Sin esto, no hay forma de saber si el pipeline de IA está funcionando. |
| `POST /impersonation/:id/end` | Complemento necesario del `POST /impersonation`. Sin cierre explícito, las sesiones quedan abiertas indefinidamente. |
| `GET /impersonation/sessions` | Auditoría de impersonación. Owners necesitan ver cuándo accedió soporte a su tenant. |
