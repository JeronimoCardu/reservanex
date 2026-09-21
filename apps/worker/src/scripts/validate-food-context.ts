/**
 * Aislamiento multi-tenant del contexto de WhatsApp + rubro del tenant.
 *
 * El bug real: un restaurante respondía como inmobiliaria. Se demostró que el
 * webhook había resuelto el tenant correcto y que la causa era el prompt, no
 * el ruteo. Pero como el mismo Android/número se usó antes en pruebas
 * inmobiliarias, este validador fija ADEMÁS que el ruteo no pueda cruzarse:
 *
 *   tenant A (real_estate) y tenant B (food_service), el MISMO teléfono de
 *   cliente en los dos. Un mensaje al token de B tiene que resolver contacto,
 *   conversación y contexto de B — y nunca ver nombre, propiedad ni
 *   lead_context de A.
 *
 * Corre contra el proyecto real con buildContext(), el mismo camino que usa el
 * worker para cada inbound. Sin LLM. Purga sus fixtures al final.
 *
 * Uso:  pnpm --filter @orderflow/worker validate:food-context
 */
import path from 'path'
import { config } from 'dotenv'
config({ path: path.resolve(__dirname, '../../../../.env.local') })
import { randomUUID, randomBytes } from 'node:crypto'
import { createClient } from '../lib/supabase'
import { assertSafeSupabaseTarget } from '../lib/assert-safe-target'
import { hashDeviceToken } from '../lib/device-token'
import { buildContext } from '../context/builder'
import { foodCapabilitiesFromTenant, isFoodService } from '../context/food-domain'
import { executeSendPublicCatalogLink } from '../tools/send-public-catalog-link'
import { executeSendTableReservationLink } from '../tools/send-table-reservation-link'
import { AUTORESPONDER_APP_PACKAGE, WHATSAPP_BUSINESS_PACKAGE } from '../providers/autoresponder/inbound'
import type { Database } from '@orderflow/types'

type QueueRow = Database['public']['Tables']['message_queue']['Row']

const HR = '─'.repeat(78)
let passed = 0, failed = 0
const ok  = (s: string) => { console.log(`  ✓ ${s}`); passed++ }
const nok = (s: string, d?: string) => { console.error(`  ✗ ${s}`); if (d) console.error(`      ${d}`); failed++ }

const RUN = `${Date.now()}`

function queueRowFor(tenantId: string, accountId: string, sender: string, message: string): QueueRow {
  const now = new Date().toISOString()
  return {
    id: randomUUID(), tenant_id: tenantId, whatsapp_account_id: accountId,
    raw_payload: {
      appPackageName: AUTORESPONDER_APP_PACKAGE, messengerPackageName: WHATSAPP_BUSINESS_PACKAGE,
      provider: 'autoresponder', _internal_event_id: randomUUID(),
      query: { sender, message, isGroup: false, groupParticipant: '', ruleId: 1, isTestMessage: false },
    } as QueueRow['raw_payload'],
    status: 'processing', attempts: 0, last_error: null, processed_at: null,
    processing_started_at: now, scheduled_at: now, created_at: now, updated_at: now,
  }
}

async function main(): Promise<void> {
  console.log(HR)
  console.log('  ReservaNex — aislamiento de contexto WhatsApp entre tenants + rubro')
  console.log(HR)
  assertSafeSupabaseTarget()
  const db = createClient()

  const tenantIds: string[] = []
  const phoneBase = 4_100_000_000 + Math.floor(Math.random() * 800_000_000)
  const CLIENTE   = '549' + String(phoneBase).padStart(10, '0')  // el MISMO en A y en B

  async function tenant(kind: 'agency' | 'food', n: string) {
    const food = kind === 'food'
    const { data, error } = await db.from('tenants').insert({
      name: `[TEST] ctx-${kind} ${RUN}`, slug: `test-ctx-${kind}-${RUN}`, status: 'active',
      vertical: food ? 'food_service' : 'real_estate', client_type: food ? null : 'agency',
      currency: 'ARS',
      delivery_enabled: true, takeaway_enabled: false, table_reservations_enabled: true,
      // Con sitio público: los tools de links se niegan (correctamente) si está apagado.
      public_slug: `test-ctx-${kind}-${RUN}`, public_site_enabled: true,
    } as never).select('id').single()
    if (error || !data) throw new Error(`tenant ${n}: ${error?.message}`)
    tenantIds.push(data.id)

    const { data: acc, error: e2 } = await db.from('whatsapp_accounts').insert({
      tenant_id: data.id, provider: 'autoresponder',
      phone_number: '549' + String(phoneBase + 1000 + tenantIds.length).padStart(10, '0'),
      inbound_token_hash: hashDeviceToken(randomBytes(24).toString('hex')), active: true,
    } as never).select('id').single()
    if (e2 || !acc) throw new Error(`account ${n}: ${e2?.message}`)
    return { id: data.id, accountId: acc.id }
  }

  try {
    const A = await tenant('agency', 'A')
    const B = await tenant('food',   'B')

    // ── Tenant A ya conoce a este cliente, con nombre y contexto inmobiliario ──
    const { data: contactoA } = await db.from('contacts').insert({
      tenant_id: A.id, phone: CLIENTE, name: 'Ana Inmobiliaria', source: 'whatsapp',
    } as never).select('id').single()
    const { data: convA } = await db.from('conversations').insert({
      tenant_id: A.id, contact_id: contactoA!.id, whatsapp_account_id: A.accountId,
      channel: 'whatsapp', status: 'open',
      lead_context: { property_public_code: 'OF-INMO-1', property_operation_type: 'sale' },
    } as never).select('id').single()
    await db.from('messages').insert({
      tenant_id: A.id, conversation_id: convA!.id, sender_type: 'customer',
      content: 'Quiero comprar un departamento', content_type: 'text',
    } as never)
    ok('setup: tenant A (real_estate) conoce al cliente con nombre, propiedad y mensajes')

    // ── 5 y 6. El mismo cliente escribe al token/cuenta de B ─────────────────
    const ctx = await buildContext(queueRowFor(B.id, B.accountId, CLIENTE, 'Hola hacen delivery?'))

    if (ctx.tenantId === B.id) ok('6. el token de la cuenta food resuelve el tenant food')
    else nok('6. tenantId equivocado', ctx.tenantId)

    if (ctx.whatsappAccountId === B.accountId) ok('6. y la cuenta es la de B')
    else nok('6. whatsappAccountId equivocado', String(ctx.whatsappAccountId))

    if (ctx.contactId !== contactoA!.id) ok('5. el contacto resuelto NO es el de A (mismo teléfono, otro tenant)')
    else nok('5. CONTAMINACIÓN: se reutilizó el contacto de A')

    if (ctx.contactName === null) ok('5. el nombre "Ana Inmobiliaria" de A NO se filtró: B lo ve como desconocido')
    else nok('5. CONTAMINACIÓN: nombre de A visible en B', String(ctx.contactName))

    if (ctx.conversationId !== convA!.id) ok('5. la conversación NO es la de A')
    else nok('5. CONTAMINACIÓN: se reutilizó la conversación de A')

    const { data: convB } = await db.from('conversations')
      .select('tenant_id, contact_id, lead_context').eq('id', ctx.conversationId).single()
    if (convB?.tenant_id === B.id) ok('5. la conversación creada pertenece a B')
    else nok('5. la conversación no es de B', String(convB?.tenant_id))

    const lc = (convB?.lead_context ?? {}) as Record<string, unknown>
    if (!('property_public_code' in lc) && !('property_operation_type' in lc)) {
      ok('5. el lead_context inmobiliario de A NO se copió a B')
    } else nok('5. CONTAMINACIÓN: lead_context de A en B', JSON.stringify(lc))

    const { count: contactosB } = await db.from('contacts')
      .select('id', { count: 'exact', head: true }).eq('tenant_id', B.id).eq('phone', CLIENTE)
    if (contactosB === 1) ok('5. B tiene su propio contacto para ese teléfono (1, nuevo)')
    else nok('5. contactos en B', String(contactosB))

    // ── El rubro que el responder va a usar ───────────────────────────────────
    const { data: rowB } = await db.from('tenants')
      .select('vertical, delivery_enabled, takeaway_enabled, table_reservations_enabled').eq('id', B.id).single()
    const caps = foodCapabilitiesFromTenant(rowB!)
    if (isFoodService(rowB!) && caps.delivery && !caps.takeaway && caps.tableReservations) {
      ok('1. el tenant B se lee como gastronómico con D=true T=false R=true — lo que el prompt va a afirmar')
    } else nok('1. rubro/capacidades de B', JSON.stringify({ v: rowB?.vertical, caps }))

    const { data: rowA } = await db.from('tenants').select('vertical').eq('id', A.id).single()
    if (!isFoodService(rowA!)) ok('4. el tenant A sigue siendo inmobiliario para el responder')
    else nok('4. A se leyó como food')

    // ── Los tools reales, contra la base ──────────────────────────────────────
    const envAntes = { c: process.env.CUSTOMER_SITE_BASE_URL, s: process.env.SITE_URL, n: process.env.NEXT_PUBLIC_SITE_URL }
    try {
      // Simula el .env de desarrollo: sólo el navegador local configurado.
      delete process.env.CUSTOMER_SITE_BASE_URL
      delete process.env.SITE_URL
      process.env.NEXT_PUBLIC_SITE_URL = 'http://localhost:3001'

      // Carta vacía: aunque el modelo llame al tool, no sale nada.
      const vacio = await executeSendPublicCatalogLink(B.id, {})
      if (vacio.includes('todavía no tiene productos publicados') && !vacio.includes('http')) {
        ok('1. send_public_catalog_link con 0 productos: NO manda link y dice que la carta no está')
      } else nok('1. catálogo vacío mandó algo', vacio)

      // Con un producto publicado pero base = localhost: tampoco sale nada.
      const { data: cat } = await db.from('menu_categories').insert({ tenant_id: B.id, name: 'Pizzas' } as never).select('id').single()
      await db.from('menu_items').insert({
        tenant_id: B.id, category_id: cat!.id, name: 'Muzzarella', base_price: 10000, published: true, available: true,
      } as never)
      const local = await executeSendPublicCatalogLink(B.id, {})
      if (!local.includes('localhost') && local.includes('No hay una URL pública alcanzable')) {
        ok('3. con NEXT_PUBLIC_SITE_URL=localhost el tool NO manda localhost: falla cerrado')
      } else nok('3. localhost llegó al cliente', local)

      // Con la base pública explícita: sale la carta, con copy gastronómico.
      process.env.CUSTOMER_SITE_BASE_URL = 'https://tunel-de-prueba.ngrok-free.app'
      const conCarta = await executeSendPublicCatalogLink(B.id, {})
      if (conCarta.includes('https://tunel-de-prueba.ngrok-free.app/site/') && conCarta.includes('carta') && !conCarta.includes('propiedades')) {
        ok('2. con productos y base pública: manda la carta con copy gastronómico')
      } else nok('2. carta con productos', conCarta)

      // Reserva de mesa: el link al FORMULARIO, no a la raíz.
      const mesa = await executeSendTableReservationLink(B.id, {})
      if (mesa.includes('/formulario/table_reservation') && mesa.includes('El local te confirma la reserva después')) {
        ok('5. send_table_reservation_link manda el formulario específico y aclara que confirma el local')
      } else nok('5. link de reserva', mesa)

      // R=false: el tool se niega aunque lo llamen.
      await db.from('tenants').update({ table_reservations_enabled: false } as never).eq('id', B.id)
      const sinMesa = await executeSendTableReservationLink(B.id, {})
      if (sinMesa.includes('no toma reservas') && !sinMesa.includes('http')) {
        ok('8. con table_reservations_enabled=false el tool NO manda el formulario')
      } else nok('8. reserva con capacidad apagada', sinMesa)
      await db.from('tenants').update({ table_reservations_enabled: true } as never).eq('id', B.id)

      // Y la inmobiliaria sigue recibiendo su copy y su base.
      const inmo = await executeSendPublicCatalogLink(A.id, {})
      if (inmo.includes('propiedades') && inmo.includes('https://tunel-de-prueba.ngrok-free.app/site/')) {
        ok('7. real_estate: send_public_catalog_link conserva "propiedades" y la misma base canónica')
      } else nok('7. catálogo inmobiliario', inmo)
    } finally {
      if (envAntes.c === undefined) delete process.env.CUSTOMER_SITE_BASE_URL; else process.env.CUSTOMER_SITE_BASE_URL = envAntes.c
      if (envAntes.s === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = envAntes.s
      if (envAntes.n === undefined) delete process.env.NEXT_PUBLIC_SITE_URL; else process.env.NEXT_PUBLIC_SITE_URL = envAntes.n
    }

    // ── Y en sentido inverso: un mensaje a A no ve nada de B ──────────────────
    const ctxA = await buildContext(queueRowFor(A.id, A.accountId, CLIENTE, 'Sigo interesado'))
    if (ctxA.tenantId === A.id && ctxA.conversationId === convA!.id && ctxA.contactName === 'Ana Inmobiliaria') {
      ok('5. A recupera SU conversación y SU nombre: el aislamiento es simétrico')
    } else nok('5. A perdió su contexto', JSON.stringify({ t: ctxA.tenantId, c: ctxA.conversationId, n: ctxA.contactName }))

  } catch (err) {
    nok('fatal', err instanceof Error ? err.message : String(err))
  } finally {
    for (const id of tenantIds) {
      const { error } = await db.rpc('admin_purge_tenant', { p_tenant_id: id })
      if (error) nok(`purge ${id}`, error.message)
    }
    const { count } = await db.from('tenants').select('id', { count: 'exact', head: true }).like('name', '[TEST] ctx-%')
    if ((count ?? 0) === 0) ok('purge: 0 [TEST] restantes')
    else nok('purge: quedaron tenants', String(count))
  }

  console.log(`\n${HR}\n  RESULTADO: ${passed} ok · ${failed} fallaron\n${HR}`)
  if (failed > 0) process.exitCode = 1
}

main().catch((e) => { console.error('[validate-food-context] Fatal:', e instanceof Error ? e.message : e); process.exitCode = 1 })
