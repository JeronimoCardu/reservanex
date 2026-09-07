/**
 * Fase 3A — validación del motor de formularios dinámicos contra el Supabase
 * REAL enlazado (supabase/migrations/20260906000001_forms_engine.sql).
 *
 * Ejercita el Route Handler público de verdad — importa POST de
 * src/app/api/public/forms/route.ts y lo invoca con NextRequest — así que
 * cubre el camino completo (parseo, resolución del tenant por slug, gating por
 * rubro, validación por intent, idempotencia, contexto de publicación) sin
 * necesidad de levantar Next.js. Misma técnica que validate-onboarding.ts.
 *
 * Construye DOS tenants aislados y desechables (nunca el demo):
 *   · REAL   → vertical real_estate, con una propiedad publicada y public_code
 *   · FOOD   → vertical food_service
 * y los borra al final, pasen o fallen los checks.
 *
 * Usage:  pnpm --filter @orderflow/web validate:forms
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { randomBytes, randomUUID } from 'node:crypto'
import { createAdminClient } from '@orderflow/supabase/admin'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import type { Database } from '@orderflow/types'
import { assertSafeSupabaseTarget } from './assert-safe-target'
import { POST } from '../src/app/api/public/forms/route'
import {
  SUBMISSION_REFERENCE_REGEX,
  generateSubmissionReference,
} from '../src/lib/forms/submission-reference'
import { isSubmissionExpired, SUBMISSION_TTL_MS } from '../src/lib/forms/submissions.repository'

const HR   = '─'.repeat(78)
const PASS = '  ✓'
const FAIL = '  ✗'

let failures = 0
// Precondición del proyecto (no del código): ver la sección J.
let hookMissing = false
function ok(msg: string)                { console.log(`${PASS} ${msg}`) }
function nok(msg: string, extra?: string) {
  failures++
  console.log(`${FAIL} ${msg}${extra ? `\n      ${extra}` : ''}`)
}

// Invoca el Route Handler real como lo haría el browser.
async function postForm(body: unknown): Promise<{ status: number; json: any }> {
  const { NextRequest } = await import('next/server')
  const req = new NextRequest('http://localhost:3001/api/public/forms', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
  const res  = await POST(req)
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function main() {
  // SIEMPRE primero: este script escribe con la service-role key.
  assertSafeSupabaseTarget()

  const admin = createAdminClient()
  const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`

  console.log(HR)
  console.log('  Fase 3A — motor de formularios dinámicos')
  console.log(`  target: ${(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()}`)
  console.log(`  run:    ${RUN_ID}`)
  console.log(HR)

  const tenantIds:   string[] = []
  const authUserIds: string[] = []

  type TenantFixture = {
    tenantId: string
    slug:     string
    email:    string
    password: string
  }

  async function buildTenant(label: string, vertical: 'real_estate' | 'food_service'): Promise<TenantFixture> {
    const slug = `test-forms-${label.toLowerCase()}-${RUN_ID}`
    const { data: tenant, error } = await admin.from('tenants').insert({
      name:                `[TEST] Forms ${label} ${RUN_ID}`,
      slug,
      status:              'active',
      vertical,
      public_slug:         slug,
      public_site_enabled: true,
    }).select('id, vertical').single()
    if (error || !tenant) throw new Error(`tenant insert failed: ${error?.message}`)
    tenantIds.push(tenant.id)

    if (tenant.vertical !== vertical) {
      nok(`Fixture: tenant ${label} guardó vertical="${tenant.vertical}" en vez de "${vertical}"`)
    }

    const password = randomBytes(18).toString('hex')
    const email    = `owner-forms-${label.toLowerCase()}-${RUN_ID}@example.test`
    const { data: authUser, error: authErr } =
      await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (authErr || !authUser.user) throw new Error(`createUser failed: ${authErr?.message}`)
    authUserIds.push(authUser.user.id)

    const { error: tuErr } = await admin.from('tenant_users').insert({
      id: authUser.user.id, tenant_id: tenant.id, name: `Owner ${label}`, email, role: 'owner', active: true,
    })
    if (tuErr) throw new Error(`tenant_users insert failed: ${tuErr.message}`)

    return { tenantId: tenant.id, slug, email, password }
  }

  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  if (!anonUrl || !anonKey) {
    nok('Setup: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY son obligatorias')
    process.exit(1)
  }
  const anon = createSupabaseJsClient<Database>(anonUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  async function signInAs(email: string, password: string) {
    const client = createSupabaseJsClient<Database>(anonUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data, error } = await client.auth.signInWithPassword({ email, password })
    if (error || !data.session) throw new Error(`signInWithPassword(${email}) failed: ${error?.message}`)
    return client
  }

  try {
    const REAL = await buildTenant('REAL', 'real_estate')
    const FOOD = await buildTenant('FOOD', 'food_service')
    ok('Fixture: dos tenants aislados (REAL=real_estate, FOOD=food_service) con owner real')

    // Propiedad publicada con public_code, para el contexto de publicación.
    const publicCode = `OF-${RUN_ID.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`
    const { data: property, error: propErr } = await admin.from('properties').insert({
      tenant_id: REAL.tenantId, title: `[TEST] Forms Property ${RUN_ID}`, city: 'Buenos Aires',
      published: true, operation_type: 'temporary_rental', pricing_mode: 'consult', currency: 'ARS',
      public_code: publicCode,
    }).select('id').single()
    if (propErr || !property) throw new Error(`properties insert failed: ${propErr?.message}`)
    ok(`Fixture: propiedad publicada con public_code=${publicCode}`)

    // ═══ A. Alta real — temporary_rental ═══════════════════════════════════
    let rentalReference = ''
    {
      const { status, json } = await postForm({
        tenant_slug: REAL.slug, intent: 'temporary_rental', source: 'public_site',
        idempotency_key: randomUUID(),
        payload: {
          name: 'Ana Gómez', check_in: '2026-12-01', check_out: '2026-12-05',
          adults: '2', children: '1', has_pets: true, pet_details: 'un perro chico',
          notes: 'Llegamos de noche',
        },
      })
      if (status === 201 && json?.ok && SUBMISSION_REFERENCE_REGEX.test(json.reference ?? '')) {
        rentalReference = json.reference
        ok(`A. temporary_rental creada (201) con referencia ${json.reference}`)
      } else {
        nok('A. temporary_rental no se creó', `status=${status} body=${JSON.stringify(json)}`)
      }
    }

    // La fila real, tal como quedó en la DB.
    if (rentalReference) {
      const { data: row } = await admin.from('form_submissions')
        .select('*').eq('reference', rentalReference).single()

      if (!row) {
        nok('A. la submission no está en la DB')
      } else {
        const payload = row.payload as Record<string, unknown>
        if (row.tenant_id === REAL.tenantId) ok('A. tenant_id = el tenant resuelto por slug (no vino del cliente)')
        else nok('A. tenant_id incorrecto', String(row.tenant_id))

        if (row.status === 'submitted') ok(`A. status inicial = "submitted"`)
        else nok('A. status inicial inesperado', String(row.status))

        // La coerción de Zod tiene que haber corrido ANTES de persistir: el
        // browser manda strings y la DB no debe guardar "2" como texto.
        if (payload.adults === 2 && payload.children === 1) ok('A. números coercionados antes de persistir (adults=2, children=1)')
        else nok('A. los números se guardaron sin coercionar', JSON.stringify({ adults: payload.adults, children: payload.children }))

        if (payload.has_pets === true && payload.pet_details === 'un perro chico') ok('A. campo condicional persistido')
        else nok('A. campo condicional mal persistido', JSON.stringify(payload))

        const ttl = new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()
        if (Math.abs(ttl - SUBMISSION_TTL_MS) < 5_000) ok(`A. expires_at = created_at + 24h (${Math.round(ttl / 3_600_000)}h)`)
        else nok('A. ventana de expiración inesperada', `${ttl}ms`)

        if (!isSubmissionExpired(row)) ok('A. la submission recién creada NO está vencida')
        else nok('A. la submission nace vencida')
      }
    }

    // ═══ B. Alta real — property_visit ═════════════════════════════════════
    {
      const { status, json } = await postForm({
        tenant_slug: REAL.slug, intent: 'property_visit', source: 'public_site',
        idempotency_key: randomUUID(),
        payload: { name: 'Bruno Díaz', preferred_date: '2026-12-10', preferred_time_range: 'morning' },
      })
      if (status === 201 && json?.ok) ok(`B. property_visit creada (${json.reference})`)
      else nok('B. property_visit no se creó', `status=${status} body=${JSON.stringify(json)}`)
    }

    // ═══ C. Alta real — table_reservation (otro rubro) ══════════════════════
    {
      const { status, json } = await postForm({
        tenant_slug: FOOD.slug, intent: 'table_reservation', source: 'public_site',
        idempotency_key: randomUUID(),
        payload: { name: 'Carla Ruiz', date: '2026-12-20', time: '21:30', people: '4' },
      })
      if (status === 201 && json?.ok) ok(`C. table_reservation creada en el tenant food_service (${json.reference})`)
      else nok('C. table_reservation no se creó', `status=${status} body=${JSON.stringify(json)}`)
    }

    // ═══ D. Gating por rubro ═══════════════════════════════════════════════
    {
      const { status, json } = await postForm({
        tenant_slug: REAL.slug, intent: 'table_reservation', source: 'public_site',
        idempotency_key: randomUUID(),
        payload: { name: 'Ana', date: '2026-12-20', time: '21:30', people: '4' },
      })
      if (status === 422 && json?.reason === 'intent_not_available') {
        ok('D. una inmobiliaria RECHAZA table_reservation (422 intent_not_available)')
      } else {
        nok('D. el gating por rubro no bloqueó un intent ajeno', `status=${status} body=${JSON.stringify(json)}`)
      }
    }
    {
      const { status, json } = await postForm({
        tenant_slug: FOOD.slug, intent: 'temporary_rental', source: 'public_site',
        idempotency_key: randomUUID(),
        payload: { name: 'Ana', check_in: '2026-12-01', check_out: '2026-12-05', adults: '2' },
      })
      if (status === 422 && json?.reason === 'intent_not_available') {
        ok('D. un restaurante RECHAZA temporary_rental (422 intent_not_available)')
      } else {
        nok('D. el gating por rubro no bloqueó un intent ajeno', `status=${status} body=${JSON.stringify(json)}`)
      }
    }

    // ═══ E. Validación server-side ═════════════════════════════════════════
    {
      const { status, json } = await postForm({
        tenant_slug: REAL.slug, intent: 'temporary_rental', source: 'public_site',
        idempotency_key: randomUUID(),
        payload: { name: 'Ana', check_in: '2026-12-05', check_out: '2026-12-01', adults: '2' },
      })
      if (status === 422 && json?.reason === 'invalid_fields' && json?.errors?.check_out) {
        ok('E. check_out anterior al check_in → 422 con el error en el campo correcto')
      } else {
        nok('E. no se rechazó un rango de fechas inválido', `status=${status} body=${JSON.stringify(json)}`)
      }
    }
    {
      const { status, json } = await postForm({
        tenant_slug: FOOD.slug, intent: 'food_order', source: 'public_site',
        idempotency_key: randomUUID(),
        payload: { name: 'Ana', fulfillment: 'delivery', payment_method: 'cash' },
      })
      if (status === 422 && json?.errors?.address) ok('E. delivery sin dirección → 422 con el error en address')
      else nok('E. no se exigió la dirección en un delivery', `status=${status} body=${JSON.stringify(json)}`)
    }
    {
      const { status, json } = await postForm({
        tenant_slug: REAL.slug, intent: 'nonexistent_intent', source: 'public_site',
        idempotency_key: randomUUID(), payload: { name: 'Ana' },
      })
      if (status === 422 && json?.reason === 'invalid_request') ok('E. intent inexistente → 422 invalid_request')
      else nok('E. se aceptó un intent inexistente', `status=${status} body=${JSON.stringify(json)}`)
    }
    {
      const { status, json } = await postForm({
        tenant_slug: `no-existe-${RUN_ID}`, intent: 'property_inquiry', source: 'public_site',
        idempotency_key: randomUUID(), payload: { name: 'Ana', message: 'hola' },
      })
      if (status === 404 && json?.reason === 'not_found') ok('E. slug de tenant inexistente → 404')
      else nok('E. un slug inexistente no dio 404', `status=${status} body=${JSON.stringify(json)}`)
    }

    // El browser no puede elegir el tenant: aunque mande tenant_id, se ignora.
    {
      const { status, json } = await postForm({
        tenant_slug: REAL.slug, tenant_id: FOOD.tenantId,
        intent: 'property_inquiry', source: 'public_site',
        idempotency_key: randomUUID(), payload: { name: 'Ana', message: 'hola' },
      })
      if (status === 201 && json?.ok) {
        const { data: row } = await admin.from('form_submissions')
          .select('tenant_id').eq('reference', json.reference).single()
        if (row?.tenant_id === REAL.tenantId) ok('E. un tenant_id mandado por el cliente se IGNORA (gana el slug)')
        else nok('E. el cliente logró elegir el tenant por id', String(row?.tenant_id))
      } else {
        nok('E. la request con tenant_id espurio no se procesó', `status=${status}`)
      }
    }

    // ═══ F. Idempotencia ═══════════════════════════════════════════════════
    {
      const key = randomUUID()
      const body = {
        tenant_slug: REAL.slug, intent: 'property_inquiry', source: 'public_site',
        idempotency_key: key, payload: { name: 'Doble Tap', message: 'una sola vez' },
      }
      const first  = await postForm(body)
      const second = await postForm(body)

      if (first.status === 201 && second.status === 200 && first.json?.reference === second.json?.reference) {
        ok(`F. doble envío con la misma clave → misma referencia (${first.json.reference}), 201 y luego 200`)
      } else {
        nok('F. la idempotencia no devolvió la misma submission',
          `first=${first.status}/${first.json?.reference} second=${second.status}/${second.json?.reference}`)
      }

      const { count } = await admin.from('form_submissions')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', REAL.tenantId).eq('idempotency_key', key)
      if (count === 1) ok('F. quedó UNA sola fila en la DB para esa clave')
      else nok('F. la idempotencia dejó filas duplicadas', `count=${count}`)
    }

    // Concurrencia real: dos requests simultáneas con la misma clave.
    {
      const key = randomUUID()
      const body = {
        tenant_slug: REAL.slug, intent: 'property_inquiry', source: 'public_site',
        idempotency_key: key, payload: { name: 'Carrera', message: 'en paralelo' },
      }
      const [a, b] = await Promise.all([postForm(body), postForm(body)])
      const { count } = await admin.from('form_submissions')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', REAL.tenantId).eq('idempotency_key', key)

      if (count === 1 && a.json?.ok && b.json?.ok && a.json.reference === b.json.reference) {
        ok('F. dos requests EN PARALELO con la misma clave → una sola fila, misma referencia')
      } else {
        nok('F. la carrera de idempotencia creó filas de más',
          `count=${count} a=${a.json?.reference} b=${b.json?.reference}`)
      }
    }

    // La clave es por tenant: la misma clave en otro tenant es otra submission.
    {
      const key = randomUUID()
      const first = await postForm({
        tenant_slug: REAL.slug, intent: 'property_inquiry', source: 'public_site',
        idempotency_key: key, payload: { name: 'Ana', message: 'hola' },
      })
      const second = await postForm({
        tenant_slug: FOOD.slug, intent: 'general_inquiry', source: 'public_site',
        idempotency_key: key, payload: { name: 'Ana', message: 'hola' },
      })
      if (first.json?.ok && second.json?.ok && first.json.reference !== second.json.reference) {
        ok('F. la misma clave en OTRO tenant crea otra submission (la clave es por tenant)')
      } else {
        nok('F. la clave de idempotencia cruzó el límite de tenant',
          `a=${first.json?.reference} b=${second.json?.reference}`)
      }
    }

    // ═══ G. Referencia pública ═════════════════════════════════════════════
    {
      const { data: rows } = await admin.from('form_submissions')
        .select('reference').in('tenant_id', [REAL.tenantId, FOOD.tenantId])
      const refs = (rows ?? []).map((r) => r.reference)

      if (refs.length > 0 && refs.every((r) => SUBMISSION_REFERENCE_REGEX.test(r))) {
        ok(`G. las ${refs.length} referencias creadas respetan el formato SUB-XXXXXX`)
      } else {
        nok('G. hay referencias con formato inválido', JSON.stringify(refs))
      }
      if (new Set(refs).size === refs.length) ok('G. no hay referencias repetidas')
      else nok('G. se repitió una referencia', JSON.stringify(refs))

      // El UNIQUE es global, no por tenant: dos tenants no pueden compartir
      // código, porque en 3B un WhatsApp llega con el código y nada más.
      if (rentalReference) {
        const { error } = await admin.from('form_submissions').insert({
          tenant_id: FOOD.tenantId, reference: rentalReference, intent: 'general_inquiry',
          status: 'submitted', source: 'public_site', payload: { name: 'X', message: 'X' },
          idempotency_key: randomUUID(),
          expires_at: new Date(Date.now() + SUBMISSION_TTL_MS).toISOString(),
        })
        if (error?.code === '23505') ok('G. la DB rechaza la MISMA referencia en otro tenant (UNIQUE global)')
        else nok('G. se pudo duplicar una referencia entre tenants', error?.message ?? 'insert exitoso')
      }

      const { error: fmtErr } = await admin.from('form_submissions').insert({
        tenant_id: REAL.tenantId, reference: 'SUB-abc', intent: 'property_inquiry',
        status: 'submitted', source: 'public_site', payload: { name: 'X', message: 'X' },
        idempotency_key: randomUUID(),
        expires_at: new Date(Date.now() + SUBMISSION_TTL_MS).toISOString(),
      })
      if (fmtErr) ok('G. la DB rechaza una referencia mal formada (CHECK de formato)')
      else nok('G. la DB aceptó una referencia con formato inválido')
    }

    // ═══ H. Contexto de publicación ════════════════════════════════════════
    {
      const { status, json } = await postForm({
        tenant_slug: REAL.slug, intent: 'property_inquiry', source: 'public_site',
        publication_ref: publicCode.toLowerCase(),   // el visitante puede traerlo en minúscula
        idempotency_key: randomUUID(),
        payload: { name: 'Ana', message: '¿Sigue disponible?' },
      })
      if (status !== 201 || !json?.ok) {
        nok('H. no se creó la submission con contexto', `status=${status}`)
      } else {
        const { data: row } = await admin.from('form_submissions')
          .select('publication_ref, entity_type, entity_id').eq('reference', json.reference).single()
        if (row?.entity_type === 'property' && row.entity_id === property.id && row.publication_ref === publicCode) {
          ok(`H. el formulario quedó asociado a la propiedad (entity_id correcto, ref normalizada a ${publicCode})`)
        } else {
          nok('H. el contexto de publicación no se resolvió', JSON.stringify(row))
        }
      }
    }
    {
      // Un código de OTRO tenant no debe resolver: si resolviera, un tenant
      // vería sus formularios apuntando a propiedades ajenas.
      const { status, json } = await postForm({
        tenant_slug: FOOD.slug, intent: 'general_inquiry', source: 'public_site',
        publication_ref: publicCode,
        idempotency_key: randomUUID(), payload: { name: 'Ana', message: 'hola' },
      })
      if (status === 201 && json?.ok) {
        const { data: row } = await admin.from('form_submissions')
          .select('publication_ref, entity_type, entity_id').eq('reference', json.reference).single()
        if (row?.entity_type === null && row.entity_id === null && row.publication_ref === publicCode) {
          ok('H. un public_code de otro tenant NO resuelve (se guarda el código, sin entidad)')
        } else {
          nok('H. un public_code cruzó el límite de tenant', JSON.stringify(row))
        }
      } else {
        nok('H. no se procesó la request con código ajeno', `status=${status}`)
      }
    }
    {
      const { status, json } = await postForm({
        tenant_slug: REAL.slug, intent: 'property_inquiry', source: 'public_site',
        idempotency_key: randomUUID(), payload: { name: 'Ana', message: 'sin contexto' },
      })
      if (status === 201 && json?.ok) {
        const { data: row } = await admin.from('form_submissions')
          .select('publication_ref, entity_type').eq('reference', json.reference).single()
        if (row?.publication_ref === null && row.entity_type === null) {
          ok('H. un formulario SIN contexto de publicación sigue siendo válido')
        } else {
          nok('H. un formulario sin contexto quedó mal', JSON.stringify(row))
        }
      } else {
        nok('H. no se aceptó un formulario sin contexto', `status=${status}`)
      }
    }

    // ═══ I. Expiración (§18) ═══════════════════════════════════════════════
    {
      const { data: expired, error } = await admin.from('form_submissions').insert({
        tenant_id: REAL.tenantId, reference: generateSubmissionReference(),
        intent: 'property_inquiry', status: 'submitted', source: 'public_site',
        payload: { name: 'Vencida', message: 'de ayer' }, idempotency_key: randomUUID(),
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      }).select('id, expires_at').single()

      if (error || !expired) {
        nok('I. no se pudo insertar una submission vencida de prueba', error?.message)
      } else if (isSubmissionExpired(expired)) {
        ok('I. una fila con expires_at pasado se lee como vencida (expiración lazy, sin cron)')
        // Y sigue existiendo: la expiración no borra nada.
        const { data: still } = await admin.from('form_submissions').select('id').eq('id', expired.id).maybeSingle()
        if (still) ok('I. la fila vencida NO se borra — solo se considera vencida al leerla')
        else nok('I. la fila vencida desapareció de la DB')
      } else {
        nok('I. una fila vencida se leyó como vigente')
      }
    }

    // ═══ J. RLS / aislamiento entre tenants ════════════════════════════════
    {
      const { data, error } = await anon.from('form_submissions').select('id, payload').limit(5)
      if ((data ?? []).length === 0) ok(`J. anon NO puede leer form_submissions (0 filas${error ? ', con error' : ''})`)
      else nok('J. un visitante anónimo puede leer submissions', JSON.stringify(data))
    }
    {
      const { data } = await anon.from('form_submissions').insert({
        tenant_id: REAL.tenantId, reference: 'SUB-ANON99', intent: 'property_inquiry',
        status: 'submitted', source: 'public_site', payload: { name: 'anon' },
        idempotency_key: randomUUID(),
        expires_at: new Date(Date.now() + SUBMISSION_TTL_MS).toISOString(),
      }).select('id')
      if ((data ?? []).length === 0) ok('J. anon NO puede insertar directo en form_submissions (solo el service role)')
      else nok('J. anon insertó una fila directamente', JSON.stringify(data))
    }
    {
      const asReal = await signInAs(REAL.email, REAL.password)
      const asFood = await signInAs(FOOD.email, FOOD.password)

      // PRECONDICIÓN, no un check del motor de formularios.
      //
      // Todas las policies tenant-scoped del producto (no solo las de
      // form_submissions) dependen de auth_tenant_id(), que lee el claim
      // app_metadata.tenant_id. Ese claim lo pone custom_access_token_hook,
      // que se registra en el Dashboard (Authentication → Hooks), NO en una
      // migración. Si el hook no está registrado en el proyecto, auth_tenant_id()
      // devuelve NULL y TODA policy tenant-scoped niega todo.
      //
      // Sin esto, los checks de "el owner ve lo suyo" no pueden pasar, y los de
      // "no ve lo ajeno" pasan por la razón equivocada (niegan todo). Por eso se
      // distingue explícitamente en vez de contarlos como fallas del formulario.
      const { data: hookOn } = await asReal.rpc('verify_hook_configured')

      if (hookOn !== true) {
        console.log('')
        console.log('  ⚠  PRECONDICIÓN NO CUMPLIDA — custom_access_token_hook NO está registrado')
        console.log('     en este proyecto Supabase. El JWT no trae app_metadata.tenant_id, así que')
        console.log('     auth_tenant_id() devuelve NULL y toda policy tenant-scoped niega todo.')
        console.log('     Es configuración del proyecto (Dashboard → Authentication → Hooks →')
        console.log('     Custom Access Token → public.custom_access_token_hook), no algo que')
        console.log('     arregle una migración ni el motor de formularios.')
        console.log('     Afecta a TODO el CRM autenticado, no solo a form_submissions.')
        console.log('')
        console.log('     → Las POLICIES en sí SÍ están verificadas, por otra vía que no')
        console.log('       depende del hook (simula el claim y corre como `authenticated`):')
        console.log('         supabase db query --linked -f supabase/27-rls-proof-form-submissions.sql')
        console.log('       Lo que queda sin verificar acá es que un LOGIN REAL lleve el claim,')
        console.log('       que es justamente lo que falta configurar en el proyecto.')
        console.log('')
        hookMissing = true
      } else {
        ok('J. precondición: custom_access_token_hook registrado (el JWT trae tenant_id)')

        const { data: own } = await asReal.from('form_submissions').select('id').eq('tenant_id', REAL.tenantId)
        if ((own ?? []).length > 0) ok(`J. el owner de REAL ve sus propias submissions (${own!.length})`)
        else nok('J. el owner no puede ver sus propias submissions')

        const { data: foreign } = await asReal.from('form_submissions').select('id').eq('tenant_id', FOOD.tenantId)
        if ((foreign ?? []).length === 0) ok('J. el owner de REAL NO ve las submissions de FOOD')
        else nok('J. fuga entre tenants: REAL lee submissions de FOOD', JSON.stringify(foreign))

        // Sin filtro explícito: RLS tiene que acotar igual.
        const { data: all } = await asFood.from('form_submissions').select('tenant_id')
        const leaked = (all ?? []).filter((r) => r.tenant_id !== FOOD.tenantId)
        if (leaked.length === 0) ok(`J. un SELECT sin WHERE del owner de FOOD devuelve solo lo suyo (${all?.length ?? 0})`)
        else nok('J. un SELECT sin WHERE cruzó tenants', JSON.stringify(leaked.slice(0, 3)))

        // Update permitido dentro del tenant, prohibido fuera.
        //
        // OJO con el valor de status: tiene que ser uno de los que permite
        // form_submissions_status_check (draft|submitted|confirmed|expired|
        // cancelled). Con un valor inventado la fila se rechaza por CHECK
        // (23514) y devuelve 0 filas — indistinguible de una denegación de
        // RLS si no se mira el error. Por eso acá el error se inspecciona
        // SIEMPRE: un fallo de constraint no puede hacerse pasar por
        // aislamiento entre tenants.
        if (rentalReference) {
          const { data: updated, error: updErr } = await asReal.from('form_submissions')
            .update({ status: 'confirmed' }).eq('reference', rentalReference).select('id, status')
          if (updErr) {
            nok('J. el UPDATE propio falló por error, no por RLS', `${updErr.code}: ${updErr.message}`)
          } else if ((updated ?? []).length === 1) {
            ok('J. el owner PUEDE actualizar el estado de una submission propia')
          } else {
            nok('J. el owner no pudo actualizar una submission propia (RLS lo negó)')
          }

          const { data: crossUpdated, error: crossErr } = await asFood.from('form_submissions')
            .update({ status: 'confirmed' }).eq('reference', rentalReference).select('id')
          if (crossErr) {
            // 0 filas por un ERROR no prueba aislamiento: sería un falso verde.
            nok('J. el UPDATE cruzado falló por error, no por RLS', `${crossErr.code}: ${crossErr.message}`)
          } else if ((crossUpdated ?? []).length === 0) {
            ok('J. el owner de FOOD NO puede actualizar una submission de REAL')
          } else {
            nok('J. un owner ajeno actualizó una submission', JSON.stringify(crossUpdated))
          }
        }

        const { data: deleted } = await asReal.from('form_submissions')
          .delete().eq('tenant_id', REAL.tenantId).select('id')
        if ((deleted ?? []).length === 0) ok('J. ni el owner puede BORRAR submissions (no hay policy de DELETE)')
        else nok('J. el owner borró submissions', JSON.stringify(deleted))
      }
    }

    // ═══ K. admin_purge_tenant incluye la tabla nueva ══════════════════════
    {
      const { count: before } = await admin.from('form_submissions')
        .select('id', { count: 'exact', head: true }).eq('tenant_id', FOOD.tenantId)

      const { error } = await admin.rpc('admin_purge_tenant', { p_tenant_id: FOOD.tenantId })
      if (error) {
        nok('K. admin_purge_tenant falló', error.message)
      } else {
        const { count: after } = await admin.from('form_submissions')
          .select('id', { count: 'exact', head: true }).eq('tenant_id', FOOD.tenantId)
        if ((before ?? 0) > 0 && after === 0) {
          ok(`K. admin_purge_tenant borra form_submissions (${before} → 0)`)
        } else {
          nok('K. admin_purge_tenant dejó submissions huérfanas', `before=${before} after=${after}`)
        }
      }
    }

  } finally {
    console.log(`\n${HR}\n  limpieza`)
    // La limpieza nunca debe tapar el error original que trajo el finally, así
    // que cada paso se traga su propia falla.
    for (const id of tenantIds) {
      try { await admin.rpc('admin_purge_tenant', { p_tenant_id: id }) } catch { /* ya purgado */ }
      try { await admin.from('tenants').delete().eq('id', id) } catch { /* ya borrado */ }
    }
    for (const uid of authUserIds) {
      try { await admin.auth.admin.deleteUser(uid) } catch { /* ya borrado */ }
    }
    // Confirmación real de que no quedó nada del run.
    const { count } = await admin.from('form_submissions')
      .select('id', { count: 'exact', head: true }).in('tenant_id', tenantIds)
    console.log(`  tenants borrados: ${tenantIds.length} · usuarios auth borrados: ${authUserIds.length} · submissions remanentes: ${count ?? 0}`)
    if ((count ?? 0) > 0) failures++
  }

  console.log(HR)
  if (failures > 0) {
    console.log(`  RESULTADO: ${failures} check(s) fallaron ✗`)
    console.log(HR)
    process.exit(1)
  }

  if (hookMissing) {
    // Verde a medias no es verde. El motor de formularios pasó todo lo que se
    // puede verificar sin el hook, pero la mitad positiva de RLS quedó sin
    // probar, así que el script sale distinto de 0 a propósito.
    console.log('  RESULTADO: los checks ejecutados pasaron, PERO el aislamiento por')
    console.log('             sesión quedó SIN VERIFICAR (custom_access_token_hook')
    console.log('             no registrado en este proyecto). No es verde.')
    console.log(HR)
    process.exit(2)
  }

  console.log('  RESULTADO: todo verde ✓')
  console.log(HR)
  process.exit(0)
}

main().catch((err) => {
  console.error('\n[validate-forms] error fatal:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
