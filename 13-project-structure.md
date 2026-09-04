# OrderFlow — Project Structure

**Versión:** 1.0  
**Fecha:** 2026-06-22  
**Basado en:** 10-supabase-schema-v2.sql, 11-rls-policies.sql, 12-api-spec.md

---

## Decisión: Monorepo

**Sí, monorepo.** Justificación:

- El worker y el web app comparten tipos, validators y el cliente de Supabase.
- La capa AI es usada por el worker; sus definiciones de herramientas deben estar tipadas y compartidas.
- Un solo repositorio elimina desincronización entre tipos de request/response y la DB.
- Turborepo permite builds incrementales: solo se rebuilda lo que cambió.

**Tooling:**

| Herramienta | Rol |
|---|---|
| `pnpm workspaces` | Gestión de dependencias entre packages |
| `Turborepo` | Pipeline de build, lint, test con caché |
| `TypeScript project references` | Type-checking incremental cross-package |

---

## Árbol de carpetas

```
orderflow/
├── apps/
│   ├── web/
│   └── worker/
├── packages/
│   ├── types/
│   ├── validators/
│   ├── supabase/
│   ├── ai/
│   └── config/
├── supabase/
│   ├── migrations/
│   └── seed/
├── docs/
├── .env.example
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

---

## Apps

### `apps/web` — Next.js 15 (App Router)

**Responsabilidad:** Todo lo que corre en el browser o en el servidor de Next.js.

- Autenticación (Supabase Auth SDK)
- CRM de tenant: propiedades, unidades, contactos, conversaciones, reservas, tareas
- Panel de Platform Admin: gestión de tenants, usuarios de plataforma, impersonación
- Sitio público por tenant: catálogo de propiedades, widget de chat web
- Todas las rutas de API definidas en `12-api-spec.md` (implementadas como Next.js Route Handlers bajo `src/app/api/v1/`)
- Middleware de auth: verifica JWT, extrae claims, redirige según rol

**Estructura interna:**

```
apps/web/
├── src/
│   ├── app/
│   │   ├── (auth)/                  # Login, forgot-password, callback
│   │   │   ├── login/
│   │   │   └── reset-password/
│   │   ├── (platform)/              # Super Admin — acceso a app.orderflow.app
│   │   │   ├── layout.tsx
│   │   │   ├── dashboard/
│   │   │   ├── tenants/
│   │   │   ├── platform-users/
│   │   │   └── impersonation/
│   │   ├── (tenant)/                # CRM — acceso a {tenant}.orderflow.app
│   │   │   ├── layout.tsx
│   │   │   ├── dashboard/
│   │   │   ├── properties/
│   │   │   ├── contacts/
│   │   │   ├── conversations/
│   │   │   ├── reservations/
│   │   │   ├── tasks/
│   │   │   ├── branches/
│   │   │   ├── users/
│   │   │   └── settings/
│   │   ├── (public)/                # Sitio público sin auth
│   │   │   ├── layout.tsx
│   │   │   ├── propiedades/
│   │   │   ├── contacto/
│   │   │   └── chat/               # Widget de chat web
│   │   └── api/
│   │       └── v1/                  # Route Handlers — contratos de 12-api-spec.md
│   │           ├── auth/
│   │           ├── tenants/
│   │           ├── branches/
│   │           ├── users/
│   │           ├── properties/
│   │           ├── contacts/
│   │           ├── conversations/
│   │           ├── messages/
│   │           ├── reservations/
│   │           ├── tasks/
│   │           ├── notes/
│   │           ├── notifications/
│   │           ├── audit-logs/
│   │           ├── dashboard/
│   │           ├── impersonation/
│   │           ├── whatsapp/
│   │           │   └── webhooks/    # Meta webhook
│   │           ├── internal/        # Endpoints INTERNAL (IP allowlist)
│   │           │   └── ai/
│   │           └── public/          # Endpoints PUBLIC (sin auth)
│   ├── components/
│   │   ├── ui/                      # Componentes base (shadcn/ui)
│   │   ├── platform/                # Componentes exclusivos de Platform Admin
│   │   ├── tenant/                  # Componentes de CRM
│   │   └── public/                  # Componentes del sitio público
│   ├── lib/
│   │   ├── auth.ts                  # Helpers de Supabase Auth para server components
│   │   ├── claims.ts                # Extracción de claims del JWT
│   │   └── tenant-resolution.ts    # Resolución de tenant desde hostname
│   ├── hooks/                       # React hooks del cliente
│   ├── stores/                      # Zustand stores (estado UI)
│   └── middleware.ts                # Edge middleware: auth + tenant routing
├── public/
├── next.config.ts
├── tailwind.config.ts
└── package.json
```

**Variables de entorno propias:**

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
INTERNAL_API_SECRET
META_WEBHOOK_VERIFY_TOKEN
META_APP_SECRET
ANTHROPIC_API_KEY        # Solo para endpoints /internal/ai — no exponer al cliente
```

---

### `apps/worker` — Node.js (proceso standalone)

**Responsabilidad:** Procesamiento asíncrono de mensajes WhatsApp y pipeline de IA.

- Escucha `pg_notify` en el canal `new_message_queue` (vía `pg` node driver)
- Consume `message_queue` con `FOR UPDATE SKIP LOCKED`
- Envía mensajes a la Meta Cloud API
- Llama a Anthropic API para generar respuestas de IA
- Ejecuta las 7 herramientas whitelisted contra Supabase (service_role)
- Llama a `POST /internal/ai/tools/execute` (validación adicional vía API)
- Registra uso de IA en `ai_usage_log`

**Estructura interna:**

```
apps/worker/
├── src/
│   ├── index.ts                     # Entry point — arranca listeners
│   ├── queue/
│   │   ├── listener.ts              # pg_notify → event emitter
│   │   └── consumer.ts              # Consume message_queue row a row
│   ├── whatsapp/
│   │   ├── client.ts                # Meta Cloud API: send, template
│   │   └── formatter.ts             # Transforma DB message → payload Meta
│   ├── ai/
│   │   ├── pipeline.ts              # Orquesta llamada a Anthropic + tools
│   │   ├── prompts.ts               # System prompts por tipo de conversación
│   │   └── parser.ts                # Parsea tool_use blocks de Claude
│   ├── tools/
│   │   ├── index.ts                 # Whitelist + dispatch
│   │   ├── search-properties.ts
│   │   ├── check-availability.ts
│   │   ├── get-property-details.ts
│   │   ├── create-pre-reservation.ts
│   │   ├── get-contact-history.ts
│   │   ├── create-task.ts
│   │   └── escalate-to-human.ts
│   └── lib/
│       ├── supabase.ts              # Service role client del worker
│       ├── logger.ts                # Structured logging (pino)
│       └── metrics.ts               # Contadores de uso
├── Dockerfile
└── package.json
```

**Variables de entorno propias:**

```
DATABASE_URL                         # Postgres directo para pg_notify
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
ANTHROPIC_API_KEY
META_CLOUD_API_TOKEN
META_PHONE_NUMBER_ID
INTERNAL_API_URL                     # URL de apps/web (para /internal/ai/tools/execute)
INTERNAL_API_SECRET
```

---

## Packages

### `packages/types` — Tipos TypeScript compartidos

**Responsabilidad:** Única fuente de verdad de los tipos del dominio.

```
packages/types/
├── src/
│   ├── database.ts      # Generado por Supabase CLI (supabase gen types)
│   ├── api.ts           # Request y response de cada endpoint (de 12-api-spec.md)
│   ├── domain.ts        # Tipos de negocio que no son 1:1 con la DB
│   ├── enums.ts         # Re-export de los enums de la DB
│   └── index.ts
└── package.json
```

**Regla crítica:** `database.ts` se genera automáticamente — **nunca editar a mano**. Toda derivación de tipos usa `Pick`, `Omit`, o tipos auxiliares en `domain.ts`.

---

### `packages/validators` — Schemas de validación (Zod)

**Responsabilidad:** Validar requests en la API y formularios del frontend.

```
packages/validators/
├── src/
│   ├── auth.ts
│   ├── tenants.ts
│   ├── branches.ts
│   ├── users.ts
│   ├── properties.ts
│   ├── units.ts
│   ├── availability.ts
│   ├── contacts.ts
│   ├── conversations.ts
│   ├── messages.ts
│   ├── reservations.ts
│   ├── tasks.ts
│   ├── notes.ts
│   └── index.ts
└── package.json
```

**Regla:** Cada schema de Zod exporta dos variantes: `CreateXSchema` (campos requeridos para INSERT) y `UpdateXSchema` (todo `partial()`). Los Route Handlers de `apps/web` y los formularios de React usan **el mismo schema** — una sola fuente de validación.

---

### `packages/supabase` — Clientes de Supabase

**Responsabilidad:** Instancias pre-configuradas del cliente de Supabase por contexto de ejecución.

```
packages/supabase/
├── src/
│   ├── browser.ts       # createBrowserClient — para componentes client-side
│   ├── server.ts        # createServerClient — para Server Components y Route Handlers
│   ├── admin.ts         # createServiceRoleClient — solo para uso server-side con SUPABASE_SERVICE_ROLE_KEY
│   └── index.ts
└── package.json
```

**Regla crítica:** `admin.ts` (service role) **nunca** se importa en componentes de React ni en código que pueda llegar al browser. Solo se usa en Route Handlers, middleware, y worker.

---

### `packages/ai` — Integración con IA

**Responsabilidad:** Definiciones de herramientas, prompts y cliente de Anthropic compartidos entre el worker y la API.

```
packages/ai/
├── src/
│   ├── client.ts        # Anthropic SDK setup
│   ├── tools.ts         # Definiciones de las 7 herramientas (formato Anthropic tool_use)
│   ├── prompts.ts       # System prompt base + variables de tenant
│   └── index.ts
└── package.json
```

**Las 7 herramientas definidas aquí (no ejecutadas aquí):**

1. `search_properties`
2. `check_availability`
3. `get_property_details`
4. `create_pre_reservation`
5. `get_contact_history`
6. `create_task`
7. `escalate_to_human`

La *definición* del tool (nombre, descripción, parámetros) vive aquí. La *implementación* (SQL contra Supabase) vive en `apps/worker/src/tools/`.

---

### `packages/config` — Configuración compartida

**Responsabilidad:** Archivos de configuración base reutilizables.

```
packages/config/
├── tsconfig/
│   ├── base.json
│   ├── nextjs.json
│   └── node.json
├── eslint/
│   └── base.js
└── tailwind/
    └── base.ts
```

---

## `supabase/` — Migraciones y seed

**Responsabilidad:** Estado versionado de la base de datos. Esta carpeta es la única fuente de verdad del esquema.

```
supabase/
├── migrations/
│   ├── 20260622000001_schema_v2.sql        # 10-supabase-schema-v2.sql
│   └── 20260622000002_rls_policies.sql     # 11-rls-policies.sql
├── seed/
│   └── dev_seed.sql                         # Datos de desarrollo (no correr en prod)
└── config.toml
```

**Regla:** Ningún cambio de esquema se aplica directamente. Todo pasa por un archivo en `supabase/migrations/`. Las migraciones son **irreversibles en producción** — cada cambio es una migración nueva, no una edición de archivos existentes.

---

## `docs/` — Documentación de diseño

```
docs/
├── 01-vision.md
├── 02-mvp.md
├── 03-roles.md
├── 04-flows.md
├── 05-architecture.md
├── 10-supabase-schema.sql          # V1 (referencia histórica)
├── 10-supabase-schema-v2.sql       # V2 (vigente)
├── 11-schema-audit.md
├── 11-rls-policies.sql
├── 12-api-spec.md
├── 13-project-structure.md         # Este archivo
└── 14-development-roadmap.md
```

---

## Grafo de dependencias

### Permitidas

```
packages/config     ← (ninguna)
packages/types      ← packages/config
packages/validators ← packages/types, packages/config
packages/supabase   ← packages/types, packages/config
packages/ai         ← packages/types, packages/config
apps/web            ← packages/types, packages/validators, packages/supabase, packages/ai, packages/config
apps/worker         ← packages/types, packages/validators, packages/supabase, packages/ai, packages/config
```

### Prohibidas

| Dependencia prohibida | Razón |
|---|---|
| `packages/*` → `apps/*` | Los packages son librerías — no pueden depender de aplicaciones |
| `packages/types` → `packages/supabase` | Evita ciclo circular |
| `packages/supabase` → `packages/validators` | Evita ciclo circular |
| `apps/web` → `apps/worker` | El worker es un proceso separado |
| `apps/worker` → `apps/web` | Igual |
| `packages/ai` → `packages/supabase` | La AI no ejecuta queries — solo define tools |
| Cualquier código de browser → `packages/supabase/admin.ts` | Service role key no puede llegar al browser |
| Route Handlers → `apps/worker/src/tools/` | Los tools del worker son solo para el worker |

### Comunicación entre apps/web y apps/worker

La única comunicación permitida es a través de Supabase:

```
apps/web  →  INSERT en message_queue  →  pg_notify  →  apps/worker
apps/worker  →  UPDATE en message_queue  →  INSERT en messages
apps/web  ←  Supabase Realtime (subscripción)  ←  changes en messages
```

No hay llamadas HTTP directas de `apps/web` a `apps/worker` excepto el health check interno (`GET /internal/worker/health`), que va de `apps/web` hacia el worker, no al revés.

---

## Convenciones de código

### Naming

| Elemento | Convención |
|---|---|
| Archivos | `kebab-case.ts` |
| Componentes React | `PascalCase.tsx` |
| Funciones, variables | `camelCase` |
| Constantes globales | `UPPER_SNAKE_CASE` |
| Tablas DB (referencia) | `snake_case` (generado) |
| Rutas de API | `kebab-case` |

### Estructura de un Route Handler

Cada Route Handler en `apps/web/src/app/api/v1/` sigue este orden:

1. Validación de auth (JWT + claims)
2. Validación del request body/params con el schema Zod correspondiente de `packages/validators`
3. Lógica de negocio (query a Supabase via `packages/supabase`)
4. Formato de respuesta según spec `12-api-spec.md`
5. Manejo de errores con códigos HTTP definidos en la spec

### Variables de entorno

Prefijo `NEXT_PUBLIC_` solo para valores que deben llegar al browser. Toda clave sensible (service role, Anthropic, Meta token) vive sin prefijo y solo se accede en server-side code.

---

## Infraestructura de despliegue

| Componente | Plataforma recomendada |
|---|---|
| `apps/web` | Vercel (Next.js nativo) |
| `apps/worker` | Railway / Render / Docker en VPS |
| Base de datos | Supabase Pro |
| Storage (imágenes) | Supabase Storage |
| Realtime | Supabase Realtime |

**Requerimiento crítico:** El worker necesita una conexión persistente a PostgreSQL (pg_notify). No puede correr en un entorno serverless sin conexión persistente (Lambda, Vercel Functions). Debe ser un proceso de larga duración (Always-on).
