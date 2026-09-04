# ReservaNex — Environment Variables Specification

**Versión:** 1.1  
**Fecha:** 2026-08-08  
**Basado en:** 13-project-structure.md, 16-supabase-schema-v3.sql  

---

## Archivo canónico local

**`/.env.local`** (raíz del monorepo) es el único archivo de variables de entorno para desarrollo local.

- `apps/worker` lo carga vía `dotenv` en `src/index.ts` (ruta `../../../.env.local`)
- `apps/web` lo carga vía `fs.readFileSync` en `next.config.ts` (ruta `../../.env.local`)
- `apps/web/.env.local` está obsoleto — contiene solo un comentario; no agregar variables ahí
- En producción las variables se configuran en **Vercel** (web) y **Render/Railway** (worker), no en este archivo
- **NUNCA commitear `.env.local`** — ya está en `.gitignore`

---

## Convenciones

- `NEXT_PUBLIC_*` — Expuesto al browser. Solo para valores no sensibles.
- Sin prefijo — Solo servidor / worker. Nunca exponer al cliente.
- **Obligatoria** — El sistema no funciona sin este valor.
- **Opcional** — El sistema tiene un default o la feature es prescindible en desarrollo.
- Los valores de ejemplo son ficticios. Nunca commitear valores reales.

---

## # Frontend (`apps/web`)

Variables para el servidor de Next.js y el browser.

---

### Supabase

| Variable | Obligatoria | Ejemplo | Descripción |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **Sí** | `https://abcdef.supabase.co` | URL pública del proyecto Supabase. Visible en browser. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Sí** | `eyJhbGciOiJIUzI1NiIsInR...` | Anon key de Supabase. Visible en browser. Usado por el cliente JS. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Sí** | `eyJhbGciOiJIUzI1NiIsInR...` | Service role key. **Solo servidor.** Bypasses RLS. Nunca exponer al cliente. |

**Dónde se usan:**
- `NEXT_PUBLIC_*` → `packages/supabase/browser.ts`, middleware de auth
- `SUPABASE_SERVICE_ROLE_KEY` → Route Handlers que necesitan service role (webhooks, admin ops)

---

### Auth

| Variable | Obligatoria | Ejemplo | Descripción |
|---|---|---|---|
| `NEXTAUTH_URL` | **Sí** | `https://app.orderflow.app` | URL base de la app. Supabase Auth usa esto para redirects. En desarrollo: `http://localhost:3000` |
| `NEXTAUTH_SECRET` | **Sí** | `super-secret-32-chars-minimum` | Secret para firmar cookies de sesión de Next.js. Generar con `openssl rand -base64 32`. |
| `NEXT_PUBLIC_SITE_URL` | **Sí** | `https://app.reservanex.com` | URL pública de la app, visible en browser. Usada para construir el `redirectTo` en los flows de invitación y recuperación de contraseña de Supabase Auth. En desarrollo: `http://localhost:3001`. En producción: el dominio canónico sin trailing slash. |

---

### Webhook Meta WhatsApp

| Variable | Obligatoria | Ejemplo | Descripción |
|---|---|---|---|
| `META_WEBHOOK_VERIFY_TOKEN` | **Sí** | `reservanex-dev-2026` | Token de verificación de webhook de Meta. Definido por nosotros, registrado en Meta Dashboard. |
| `META_APP_SECRET` | **Sí** | `a1b2c3d4e5f6...` | App Secret de la Meta App. Usado para verificar firma HMAC `X-Hub-Signature-256`. |
| `WHATSAPP_SKIP_SIGNATURE_VALIDATION` | No (solo dev) | `false` | Si `true`, omite la verificación de firma HMAC en entornos no-production. Útil para probar con ngrok sin app secret configurado. **Nunca usar en producción** — la app lo ignora cuando `NODE_ENV=production`. |

**Dónde se usan:** `apps/web/src/app/api/webhooks/whatsapp/route.ts`

---

### Comunicación interna

| Variable | Obligatoria | Ejemplo | Descripción |
|---|---|---|---|
| `INTERNAL_API_SECRET` | **Sí** | `random-secret-for-worker-auth` | Shared secret entre `apps/web` y `apps/worker`. Enviado como `X-Internal-Secret` header. Generar con `openssl rand -hex 32`. |

---

### IA / LLM

| Variable | Obligatoria | Ejemplo | Descripción |
|---|---|---|---|
| `OPENROUTER_API_KEY` | **Sí** | `sk-or-v1-...` | API Key de OpenRouter. Usado por el worker para llamadas al LLM. |
| `OPENROUTER_BASE_URL` | **S��** | `https://openrouter.ai/api/v1` | Base URL de OpenRouter. Default: `https://openrouter.ai/api/v1`. |
| `OPENROUTER_DEFAULT_MODEL` | **Sí** | `anthropic/claude-sonnet-4` | Modelo LLM usado por el worker para generar respuestas. |
| `OPENROUTER_SITE_URL` | No | `https://reservanex.com` | Enviado como `HTTP-Referer` en llamadas a OpenRouter. |
| `OPENROUTER_APP_NAME` | No | `ReservaNex` | Enviado como `X-Title` en llamadas a OpenRouter. |
| `GROQ_API_KEY` | No* | `gsk_...` | API Key de Groq. Habilita la transcripción de audios entrantes de WhatsApp via Whisper. *Sin esta key, los audios se guardan igualmente pero `transcription_status` queda en `'skipped'` y la IA no puede leer el audio. |

**Transcripción de audio (Sprint 2B-2):**
- Proveedor: **Groq Whisper** (`whisper-large-v3-turbo`), via REST sin paquetes extra.
- Sin `GROQ_API_KEY`: audios se almacenan en `whatsapp-media`, player funciona en CRM, `transcription_status = 'skipped'`.
- Con `GROQ_API_KEY`: `transcription_status = 'completed'`, el texto se guarda en `messages.content` y el LLM lo usa como input.

---

## # Backend — API (`apps/web` — Server-Only)

Variables que solo existen en el servidor de Next.js. No tienen prefijo `NEXT_PUBLIC_`.

(Estas variables ya están en la sección Frontend arriba. No hay variables adicionales exclusivas del backend Next.js que no sean las ya listadas.)

---

## # Worker (`apps/worker`)

Variables del proceso Node.js standalone.

---

### Base de Datos

| Variable | Obligatoria | Ejemplo | Descripción |
|---|---|---|---|
| `DATABASE_URL` | **Sí** | `postgresql://postgres.abcdef:password@aws-0-us-east-1.pooler.supabase.com:6543/postgres` | Conexión directa a PostgreSQL para pg_notify listener. Usar el **connection pooler** de Supabase en modo Transaction o la URI directa de la DB. El listener pg_notify requiere una conexión persistente — no usar pooler en modo Session. |

**Importante:** `DATABASE_URL` es para la conexión persistente de pg_notify. Para queries normales, el worker usa `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` vía el cliente JS de Supabase.

---

### Supabase

| Variable | Obligatoria | Ejemplo | Descripción |
|---|---|---|---|
| `SUPABASE_URL` | **Sí** | `https://abcdef.supabase.co` | URL del proyecto Supabase (mismo valor que NEXT_PUBLIC_SUPABASE_URL). |
| `SUPABASE_SERVICE_ROLE_KEY` | **Sí** | `eyJhbGciOiJIUzI1NiIsInR...` | Service role key para queries del worker. Mismo valor que en apps/web. |

---

### IA / LLM

Ver sección "IA / LLM" en Frontend — mismas variables.

---

### WhatsApp Meta

| Variable | Obligatoria | Ejemplo | Descripción |
|---|---|---|---|
| `META_CLOUD_API_TOKEN` | **Sí** | `EAABs...` | Bearer token para la Meta Graph API. Generado en Meta Business Dashboard. Tiene expiración — monitorear `token_expires_at` en `whatsapp_accounts`. |
| `META_PHONE_NUMBER_ID` | **Sí** | `123456789012345` | Phone Number ID del número de WhatsApp registrado en Meta. Uno por número de negocio. |

**Nota:** En producción, estos valores vienen de `whatsapp_accounts.access_token_encrypted` (cifrado en DB). Las variables de entorno son el fallback para development y para el número principal del tenant demo.

---

### Comunicación interna

| Variable | Obligatoria | Ejemplo | Descripción |
|---|---|---|---|
| `INTERNAL_API_URL` | **Sí** | `https://app.orderflow.app/api/v1/internal` | URL base para llamadas del worker a los endpoints internos de apps/web. En desarrollo: `http://localhost:3000/api/v1/internal`. |
| `INTERNAL_API_SECRET` | **Sí** | `random-secret-for-worker-auth` | Mismo valor que en apps/web. Enviado como `X-Internal-Secret`. |

---

### Worker Config

| Variable | Obligatoria | Ejemplo | Descripción |
|---|---|---|---|
| `WORKER_MAX_CONCURRENT_JOBS` | No | `5` | Máximo de items de `message_queue` procesados en paralelo. Default: 5. Ajustar según carga. |
| `WORKER_STUCK_ITEM_MINUTES` | No | `5` | Minutos para considerar un item como "stuck" en `processing`. Default: 5. |
| `LOG_LEVEL` | No | `info` | Nivel de log (pino). Valores: `trace`, `debug`, `info`, `warn`, `error`. Default: `info`. |

---

## # Supabase

Variables configuradas directamente en el Dashboard de Supabase, no en `.env`.

---

### Auth Hook (Supabase Dashboard)

| Configuración | Valor | Descripción |
|---|---|---|
| **Hook type** | Custom Access Token | Solo disponible en Supabase Pro. |
| **Function** | `public.custom_access_token_hook` | Función definida en `16-supabase-schema-v3.sql`. |
| **Enabled** | `true` | Sin esto, el JWT no tiene claims de rol y RLS bloquea todo. |

**Verificación:** Ejecutar `SELECT public.verify_hook_configured()` desde la consola SQL de Supabase. Debe retornar `true` para cualquier usuario autenticado.

---

### Supabase Vault (para tokens cifrados)

| Secret | Descripción |
|---|---|
| `whatsapp_token_encryption_key` | Clave AES-256-GCM para cifrar `whatsapp_accounts.access_token_encrypted`. Crear en Supabase Vault (Dashboard → Settings → Vault). |

---

### pg_cron Jobs (Supabase Dashboard → Database → Cron)

Registrar manualmente. Ver instrucciones al final de `16-supabase-schema-v3.sql`.

| Job | Schedule | Descripción |
|---|---|---|
| `expire-pre-reservations` | `*/15 * * * *` | Cancela pre-reservas con `expires_at < now()` |
| `reclaim-stuck-queue-items` | `*/10 * * * *` | Resetea items de queue atascados en `processing` |
| `purge-old-queue-items` | `0 3 * * *` | Elimina items completados/fallidos con más de 7 días |

---

## # WhatsApp Meta

Configuración en Meta Business Suite / Meta Developer Dashboard.

| Configuración | Valor | Descripción |
|---|---|---|
| **App Type** | Business | Para Cloud API |
| **Webhook URL** | `https://your-domain.com/api/webhooks/whatsapp` | URL de recepción de eventos |
| **Verify Token** | `META_WEBHOOK_VERIFY_TOKEN` | El mismo valor de la variable de entorno |
| **Webhook fields** | `messages` | Suscribir solo a `messages` para recibir mensajes entrantes |
| **Phone Number** | Número aprobado | Proceso de aprobación puede tomar 1-3 días hábiles — iniciar temprano |

---

## # Producción

Variables adicionales requeridas en el entorno de producción.

| Variable | App | Obligatoria | Ejemplo | Descripción |
|---|---|---|---|---|
| `NODE_ENV` | web, worker | **Sí** | `production` | Next.js y Node.js usan esto para optimizaciones. |
| `PORT` | worker | No | `8080` | Puerto del proceso worker para health checks. Default: 8080. |
| `SENTRY_DSN` | web, worker | No | `https://xxx@o000.ingest.sentry.io/000` | DSN de Sentry para error tracking. Altamente recomendado en producción. |
| `SENTRY_ENVIRONMENT` | web, worker | No | `production` | Ambiente en Sentry para filtrar errores. |

---

## Checklist de Deployment

Marcar antes de cada deploy a producción:

### Pre-deploy

- [ ] Supabase Pro plan activo en el proyecto de producción
- [ ] Auth Hook registrado y habilitado en Dashboard → Authentication → Hooks
- [ ] `SELECT public.verify_hook_configured()` retorna `true` para un usuario de prueba
- [ ] Migraciones SQL aplicadas (`16-supabase-schema-v3.sql`, `17-rls-policies-v2.sql`)
- [ ] Tipos TypeScript generados: `supabase gen types typescript --project-id <id> > packages/types/src/database.ts`
- [ ] pg_cron jobs registrados (3 jobs — ver schema v3 final)
- [ ] Supabase Vault configurado con `whatsapp_token_encryption_key`

### Variables de entorno

- [ ] `apps/web`: todas las variables obligatorias configuradas en Vercel
- [ ] `apps/worker`: todas las variables obligatorias configuradas en Railway/Render
- [ ] `DATABASE_URL` del worker apunta a la DB de producción correcta
- [ ] `INTERNAL_API_URL` del worker apunta al dominio de producción de apps/web
- [ ] `META_WEBHOOK_VERIFY_TOKEN` coincide con el registrado en Meta Dashboard
- [ ] `META_APP_SECRET` es el correcto para la Meta App de producción

### Meta WhatsApp

- [ ] Número de WhatsApp aprobado en Meta Business Suite
- [ ] Webhook URL registrada y verificada en Meta Developer Dashboard
- [ ] Suscripción al campo `messages` activa
- [ ] `whatsapp_accounts` en DB tiene el registro del número de producción

### Post-deploy

- [ ] Enviar mensaje de prueba al número de WhatsApp y verificar que llega al worker
- [ ] Verificar que el mensaje aparece en `messages` con `sender_type = 'customer'`
- [ ] Verificar que la IA responde (check `ai_usage_log`)
- [ ] Verificar que el webhook Meta recibe ACK 200 en menos de 1 segundo
- [ ] Monitorear `message_queue` por 15 minutos: no deben quedar items en `processing`

---

## Setup local para nuevos desarrolladores

1. Crear `/.env.local` en la raíz del repo con todas las variables listadas arriba.
2. No crear `apps/web/.env.local` ni `apps/worker/.env.local` — son ignorados.
3. `pnpm --filter @orderflow/web dev` y `pnpm --filter @orderflow/worker dev` leen automáticamente `/.env.local`.
4. El worker logea al arrancar: `[worker] GROQ_API_KEY configured: true|false`.
5. NUNCA commitear `.env.local`.
