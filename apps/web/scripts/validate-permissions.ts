/**
 * Permisos V2 — validador físico de seguridad.
 *
 * Prueba lo que ninguna prueba de unidad puede probar: qué deja hacer la BASE
 * a un receptionist real, con su sesión real, hablando directo a PostgREST —
 * saltándose por completo las server actions.
 *
 * Ese es exactamente el ataque que motivó la fase: el permiso se chequeaba en
 * la action y no en la RLS, así que alcanzaba con abrir DevTools, tomar el
 * access_token y hacer un POST.
 *
 * Cubre properties, units, contacts, tasks y conversations, para un
 * receptionist SIN permiso, uno CON permiso, el owner y otro tenant.
 *
 * Usa tenants [TEST] descartables y purga todo en `finally`.
 *
 * Usage:  pnpm --filter @orderflow/web validate:permissions
 */

import path from 'path'
import { config } from 'dotenv'

config({ path: path.resolve(__dirname, '..', '..', '..', '.env.local') })

import { randomBytes } from 'node:crypto'
import { createAdminClient } from '@orderflow/supabase/admin'
import { createClient as createSupabaseJsClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@orderflow/types'
import { assertSafeSupabaseTarget } from './assert-safe-target'

const HR = '─'.repeat(78)
let passed = 0, failed = 0
function ok(l: string)  { console.log(`  ✓ ${l}`); passed++ }
function nok(l: string, d?: string) { console.error(`  ✗ ${l}`); if (d) console.error(`      ${d}`); failed++ }
function check(c: boolean, l: string, d?: string) { if (c) ok(l); else nok(l, d) }

/** Una escritura bloqueada por RLS: 0 filas afectadas o error de policy. */
function bloqueada(res: { data: unknown; error: { message: string; code?: string } | null }): boolean {
  if (res.error) return true
  return Array.isArray(res.data) ? res.data.length === 0 : res.data === null
}

async function main() {
  assertSafeSupabaseTarget()

  const admin   = createAdminClient()
  const RUN     = `${Date.now()}${Math.floor(Math.random() * 1000)}`
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  if (!anonUrl || !anonKey) { console.error('Faltan env de Supabase'); process.exit(1) }

  console.log(HR)
  console.log('  Permisos V2 — RLS contra PostgREST directo')
  console.log(`  target: ${anonUrl}`)
  console.log(HR)

  const tenantIds: string[] = []
  const authIds:   string[] = []

  try {
    // ── Fixture ────────────────────────────────────────────────────────────
    async function mkTenant(label: string) {
      const { data, error } = await admin.from('tenants').insert({
        name: `[TEST] PERM ${label} ${RUN}`, slug: `test-perm-${label.toLowerCase()}-${RUN}`,
        status: 'active', vertical: 'real_estate', client_type: 'agency',
      } as never).select('id').single()
      if (error || !data) throw new Error(`tenant ${label}: ${error?.message}`)
      tenantIds.push(data.id)
      return data.id as string
    }

    async function mkUser(
      tenantId: string, kind: string,
      role: 'owner' | 'receptionist',
      perms: { props?: boolean; attend?: boolean } = {},
    ) {
      const password = randomBytes(18).toString('hex')
      const email    = `${kind}-perm-${RUN}@example.test`
      const { data: au, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
      if (error || !au.user) throw new Error(`auth ${kind}: ${error?.message}`)
      authIds.push(au.user.id)
      const { error: tu } = await admin.from('tenant_users').insert({
        id: au.user.id, tenant_id: tenantId, name: kind, email, role, active: true,
        can_create_properties:    perms.props  ?? false,
        can_assign_conversations: perms.attend ?? false,
      } as never)
      if (tu) throw new Error(`tenant_users ${kind}: ${tu.message}`)
      return { id: au.user.id, email, password }
    }

    async function login(u: { email: string; password: string }): Promise<SupabaseClient<Database>> {
      const c = createSupabaseJsClient<Database>(anonUrl, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
      const { error } = await c.auth.signInWithPassword({ email: u.email, password: u.password })
      if (error) throw new Error(`login ${u.email}: ${error.message}`)
      return c
    }

    const A = await mkTenant('A')
    const B = await mkTenant('B')

    const owner  = await mkUser(A, 'owner',    'owner',        { props: false, attend: false })
    const sinP   = await mkUser(A, 'sin',      'receptionist', { props: false, attend: false })
    const conP   = await mkUser(A, 'con',      'receptionist', { props: true,  attend: true })
    const ownerB = await mkUser(B, 'ownerb',   'owner')
    ok('Fixture: tenant A (owner + recep SIN permisos + recep CON permisos) y tenant B')

    // Datos base creados con service_role (no pasa por RLS).
    const { data: prop } = await admin.from('properties').insert({
      tenant_id: A, title: '[TEST] Prop', city: 'CABA',
      operation_type: 'sale', pricing_mode: 'consult', currency: 'ARS', published: false,
    } as never).select('id').single()
    if (!prop) throw new Error('property fixture')

    const { data: unit } = await admin.from('units').insert({
      tenant_id: A, property_id: prop.id, name: '[TEST] Unidad', active: true,
    } as never).select('id').single()

    const { data: contact } = await admin.from('contacts').insert({
      tenant_id: A, name: '[TEST] Contacto', phone: `54911${RUN.slice(-8)}`,
    } as never).select('id').single()
    if (!contact) throw new Error('contact fixture')

    const { data: conv } = await admin.from('conversations').insert({
      tenant_id: A, contact_id: contact.id,
      human_attention_requested_at: new Date().toISOString(),
      needs_human_attention: true, ai_mode: 'manual',
    } as never).select('id').single()
    if (!conv) throw new Error('conversation fixture')

    const { data: task } = await admin.from('tasks').insert({
      tenant_id: A, title: '[TEST] Tarea', status: 'pending', created_by: owner.id,
    } as never).select('id').single()
    if (!task) throw new Error('task fixture')
    ok('Fixture: propiedad, unidad, contacto, conversación pendiente y tarea')

    const asOwner = await login(owner)
    const asSinP  = await login(sinP)
    const asConP  = await login(conP)
    const asOwnB  = await login(ownerB)
    ok('Logins reales de los cuatro usuarios')

    // ── PROPERTIES ─────────────────────────────────────────────────────────
    {
      const { data: leidas } = await asSinP.from('properties').select('id').eq('tenant_id', A)
      check((leidas?.length ?? 0) === 1, 'PROPERTIES · sin permiso: SELECT permitido (necesita ver para atender)')

      const ins = await asSinP.from('properties').insert({
        tenant_id: A, title: 'HACK', city: 'CABA', operation_type: 'sale', pricing_mode: 'consult', currency: 'ARS',
      } as never).select('id')
      check(bloqueada(ins), 'PROPERTIES · sin permiso: INSERT directo RECHAZADO', ins.error?.message ?? 'insertó')

      const upd = await asSinP.from('properties').update({ title: 'HACKEADO' } as never).eq('id', prop.id).select('id')
      check(bloqueada(upd), 'PROPERTIES · sin permiso: UPDATE directo RECHAZADO', upd.error?.message ?? 'actualizó')

      const soft = await asSinP.from('properties').update({ deleted_at: new Date().toISOString() } as never).eq('id', prop.id).select('id')
      check(bloqueada(soft), 'PROPERTIES · sin permiso: SOFT DELETE directo RECHAZADO', soft.error?.message ?? 'archivó')

      const del = await asSinP.from('properties').delete().eq('id', prop.id).select('id')
      check(bloqueada(del), 'PROPERTIES · sin permiso: DELETE directo RECHAZADO', del.error?.message ?? 'borró')

      const { data: intacta } = await admin.from('properties').select('title, deleted_at').eq('id', prop.id).single()
      check(intacta?.title === '[TEST] Prop' && intacta?.deleted_at === null, 'PROPERTIES · la fila quedó intacta tras los 4 intentos')

      const updOk = await asConP.from('properties').update({ title: '[TEST] Prop editada' } as never).eq('id', prop.id).select('id')
      check(!bloqueada(updOk), 'PROPERTIES · con permiso: UPDATE permitido', updOk.error?.message)

      const insOk = await asConP.from('properties').insert({
        tenant_id: A, title: '[TEST] Prop nueva', city: 'CABA', operation_type: 'sale', pricing_mode: 'consult', currency: 'ARS',
      } as never).select('id')
      check(!bloqueada(insOk), 'PROPERTIES · con permiso: INSERT permitido', insOk.error?.message)

      const ownerUpd = await asOwner.from('properties').update({ title: '[TEST] Prop owner' } as never).eq('id', prop.id).select('id')
      check(!bloqueada(ownerUpd), 'PROPERTIES · owner SIN flags: permitido igual (ignora los permisos por diseño)', ownerUpd.error?.message)

      const cross = await asOwnB.from('properties').update({ title: 'CROSS' } as never).eq('id', prop.id).select('id')
      check(bloqueada(cross), 'PROPERTIES · owner de OTRO tenant: RECHAZADO', cross.error?.message ?? 'cruzó tenants')
    }

    // ── UNITS ──────────────────────────────────────────────────────────────
    if (unit) {
      const upd = await asSinP.from('units').update({ name: 'HACK' } as never).eq('id', unit.id).select('id')
      check(bloqueada(upd), 'UNITS · sin permiso: UPDATE directo RECHAZADO', upd.error?.message ?? 'actualizó')
      const updOk = await asConP.from('units').update({ name: '[TEST] Unidad ok' } as never).eq('id', unit.id).select('id')
      check(!bloqueada(updOk), 'UNITS · con permiso: UPDATE permitido', updOk.error?.message)
    }

    // ── CONTACTS ───────────────────────────────────────────────────────────
    {
      const { data: leidos } = await asSinP.from('contacts').select('id, phone').eq('tenant_id', A)
      check((leidos?.length ?? 0) === 1 && Boolean(leidos?.[0]?.phone),
        'CONTACTS · sin permiso: SELECT permitido con teléfono (hace falta para operar)')

      const ins = await asSinP.from('contacts').insert({ tenant_id: A, name: 'HACK', phone: '5491100000000' } as never).select('id')
      check(bloqueada(ins), 'CONTACTS · sin permiso: INSERT directo RECHAZADO', ins.error?.message ?? 'insertó')

      const upd = await asSinP.from('contacts').update({ name: 'HACKEADO' } as never).eq('id', contact.id).select('id')
      check(bloqueada(upd), 'CONTACTS · sin permiso: UPDATE de PII RECHAZADO', upd.error?.message ?? 'actualizó')

      const updOk = await asConP.from('contacts').update({ name: '[TEST] Contacto ok' } as never).eq('id', contact.id).select('id')
      check(!bloqueada(updOk), 'CONTACTS · con permiso: UPDATE permitido', updOk.error?.message)

      const delRec = await asConP.from('contacts').delete().eq('id', contact.id).select('id')
      check(bloqueada(delRec), 'CONTACTS · ni con permiso: DELETE sigue fuera del alcance del receptionist', delRec.error?.message ?? 'borró')

      const cross = await asOwnB.from('contacts').select('id').eq('tenant_id', A)
      check((cross.data?.length ?? 0) === 0, 'CONTACTS · otro tenant no ve el PII de A')
    }

    // ── TASKS ──────────────────────────────────────────────────────────────
    {
      const { data: leidas } = await asSinP.from('tasks').select('id').eq('tenant_id', A)
      check((leidas?.length ?? 0) === 1, 'TASKS · sin permiso: SELECT permitido')

      const ins = await asSinP.from('tasks').insert({ tenant_id: A, title: 'HACK', status: 'pending', created_by: sinP.id } as never).select('id')
      check(bloqueada(ins), 'TASKS · sin permiso: INSERT directo RECHAZADO', ins.error?.message ?? 'insertó')

      const upd = await asSinP.from('tasks').update({ title: 'HACKEADA' } as never).eq('id', task.id).select('id')
      check(bloqueada(upd), 'TASKS · sin permiso: UPDATE directo RECHAZADO', upd.error?.message ?? 'actualizó')

      const del = await asSinP.from('tasks').delete().eq('id', task.id).select('id')
      check(bloqueada(del), 'TASKS · sin permiso: DELETE directo RECHAZADO', del.error?.message ?? 'borró')

      const updOk = await asConP.from('tasks').update({ title: '[TEST] Tarea ok' } as never).eq('id', task.id).select('id')
      check(!bloqueada(updOk), 'TASKS · con permiso: UPDATE permitido', updOk.error?.message)
    }

    // ── CONVERSATIONS / ATENCIÓN HUMANA ────────────────────────────────────
    {
      const { data: bandeja } = await asSinP.from('conversations').select('id').eq('human_attention_pending', true)
      check((bandeja?.length ?? 0) === 1, 'ATENCIÓN · sin permiso: VE la bandeja (ver es el trabajo, no un privilegio)')

      const cerrar = await asSinP.from('conversations').update({
        human_attention_resolved_at: new Date().toISOString(), human_attention_resolved_by: sinP.id,
        ai_mode: 'autonomous', needs_human_attention: false,
      } as never).eq('id', conv.id).select('id')
      check(bloqueada(cerrar), 'ATENCIÓN · sin permiso: marcar como atendido RECHAZADO', cerrar.error?.message ?? 'cerró')

      const ia = await asSinP.from('conversations').update({ ai_mode: 'manual' } as never).eq('id', conv.id).select('id')
      check(bloqueada(ia), 'ATENCIÓN · sin permiso: cambiar el modo de IA RECHAZADO', ia.error?.message ?? 'cambió')

      const asignar = await asSinP.from('conversations').update({ assigned_user_id: sinP.id } as never).eq('id', conv.id).select('id')
      check(bloqueada(asignar), 'ATENCIÓN · sin permiso: auto-asignarse RECHAZADO', asignar.error?.message ?? 'se asignó')

      const { data: sigue } = await admin.from('conversations').select('human_attention_pending, ai_mode').eq('id', conv.id).single()
      check(sigue?.human_attention_pending === true && sigue?.ai_mode === 'manual',
        'ATENCIÓN · la conversación quedó intacta tras los 3 intentos')

      const cerrarOk = await asConP.from('conversations').update({
        human_attention_resolved_at: new Date().toISOString(), human_attention_resolved_by: conP.id,
      } as never).eq('id', conv.id).select('id')
      check(!bloqueada(cerrarOk), 'ATENCIÓN · con permiso: marcar como atendido permitido', cerrarOk.error?.message)

      // Asignada a OTRO receptionist: fuera de alcance aunque tenga el permiso.
      await admin.from('conversations').update({ assigned_user_id: sinP.id } as never).eq('id', conv.id)
      const ajena = await asConP.from('conversations').update({ ai_mode: 'manual' } as never).eq('id', conv.id).select('id')
      check(bloqueada(ajena), 'ATENCIÓN · con permiso pero asignada a OTRO: sigue RECHAZADO', ajena.error?.message ?? 'tocó la ajena')

      const insConv = await asConP.from('conversations').insert({ tenant_id: A, contact_id: contact.id } as never).select('id')
      check(bloqueada(insConv), 'ATENCIÓN · ningún receptionist crea conversaciones (las crea el worker)', insConv.error?.message ?? 'insertó')
    }

    // ── ESCALADA DE PRIVILEGIOS ────────────────────────────────────────────
    {
      const self = await asSinP.from('tenant_users').update({
        can_create_properties: true, can_assign_conversations: true,
      } as never).eq('id', sinP.id).select('id')
      check(bloqueada(self), 'ESCALADA · un receptionist NO puede darse permisos a sí mismo', self.error?.message ?? 'se los dio')

      const toOwner = await asSinP.from('tenant_users').update({ role: 'owner' } as never).eq('id', sinP.id).select('id')
      check(bloqueada(toOwner), 'ESCALADA · no puede convertirse en owner', toOwner.error?.message ?? 'se convirtió')

      const otros = await asSinP.from('tenant_users').select('id').eq('tenant_id', A)
      check((otros.data?.length ?? 0) === 1 && otros.data?.[0]?.id === sinP.id,
        'ESCALADA · sólo ve su propia fila de tenant_users', JSON.stringify(otros.data))

      const { data: flags } = await admin.from('tenant_users')
        .select('can_create_properties, can_assign_conversations, role').eq('id', sinP.id).single()
      check(flags?.can_create_properties === false && flags?.can_assign_conversations === false && flags?.role === 'receptionist',
        'ESCALADA · sus flags y su rol quedaron intactos')
    }
  } catch (err) {
    nok('Error fatal', err instanceof Error ? err.message : String(err))
  } finally {
    console.log(`\n${HR}\n  limpieza`)
    for (const id of tenantIds) {
      for (const t of ['tasks', 'conversations', 'units', 'properties', 'contacts'] as const) {
        try { await admin.from(t).delete().eq('tenant_id', id) } catch { /* noop */ }
      }
      try { await admin.rpc('admin_purge_tenant', { p_tenant_id: id }) } catch { /* noop */ }
      try { await admin.from('tenants').delete().eq('id', id) } catch { /* noop */ }
    }
    for (const id of authIds) { try { await admin.auth.admin.deleteUser(id) } catch { /* noop */ } }
    const { count } = await admin.from('tenants').select('id', { count: 'exact', head: true }).like('name', '[TEST] PERM%')
    console.log(`  tenants: ${tenantIds.length} · usuarios: ${authIds.length} · [TEST] PERM restantes: ${count ?? '?'}`)
  }

  console.log(HR)
  console.log(`  RESULTADO: ${passed} ok · ${failed} fallaron`)
  console.log(HR)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('[validate-permissions] fatal:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})
