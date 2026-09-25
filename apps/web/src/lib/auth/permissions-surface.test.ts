import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { canAttendCustomers, requireAttendCustomers } from './attend-customers'
import {
  PERMISSION_FIELDS,
  emptyPermissions,
  visiblePermissionFields,
  permissionEnabledByCapabilities,
  capabilityForPermission,
  type SavedPermissions,
} from '@/lib/dashboard/permission-fields'

// ════════════════════════════════════════════════════════════════════════════
// Permisos V2 — lo que no se puede comprobar mirando una función sola.
//
// El hallazgo que motivó esta fase fue que las actions chequeaban el permiso y
// la base no: un receptionist con el switch apagado podía escribir igual
// llamando a PostgREST con su propio token. Estos tests fijan las dos capas y
// el copy; el validator físico prueba la base contra el proyecto real.
// ════════════════════════════════════════════════════════════════════════════

const DIR = import.meta.dirname
const WEB = path.resolve(DIR, '..', '..', '..')
const RAIZ = path.resolve(WEB, '..', '..')
const leer = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8')
const leerRaiz = (rel: string) => fs.readFileSync(path.join(RAIZ, rel), 'utf8')

function soloCodigo(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')
}

const MIGRACION = 'supabase/migrations/20260924000001_permissions_v2_rls.sql'

// ── 1. El permiso "Atender clientes" ────────────────────────────────────────

describe('canAttendCustomers', () => {
  it('el owner siempre puede, tenga el flag que tenga', () => {
    expect(canAttendCustomers({ role: 'owner', canAssignConversations: false })).toBe(true)
    expect(canAttendCustomers({ role: 'owner', canAssignConversations: true })).toBe(true)
  })

  it('el receptionist sólo con el permiso', () => {
    expect(canAttendCustomers({ role: 'receptionist', canAssignConversations: true })).toBe(true)
    expect(canAttendCustomers({ role: 'receptionist', canAssignConversations: false })).toBe(false)
  })

  it('devuelve un ActionResult de rechazo, no lanza', () => {
    const denied = requireAttendCustomers({ role: 'receptionist', canAssignConversations: false })
    expect(denied).toEqual({ success: false, error: expect.stringContaining('No tenés permiso') })
    expect(requireAttendCustomers({ role: 'owner', canAssignConversations: false })).toBeNull()
  })
})

// ── 2. Guards de server actions ─────────────────────────────────────────────

describe('las mutaciones sensibles exigen el permiso', () => {
  const contacts      = soloCodigo(leer('src/actions/contacts.ts'))
  const tasks         = soloCodigo(leer('src/actions/tasks.ts'))
  const conversations = soloCodigo(leer('src/actions/conversations.ts'))

  it('contactos: crear y editar sí; leer no está gateado', () => {
    expect((contacts.match(/requireAttendCustomers[<(]/g) ?? []).length).toBe(2)
    for (const fn of ['createContactAction', 'updateContactAction']) {
      const i = contacts.indexOf(`export async function ${fn}`)
      const cuerpo = contacts.slice(i, contacts.indexOf('export async function', i + 10))
      expect(cuerpo, fn).toContain('requireAttendCustomers')
    }
  })

  it('contactos: archivar sigue siendo owner-only', () => {
    const i = contacts.indexOf('export async function archiveContactAction')
    expect(contacts.slice(i, i + 500)).toContain("ctx.role !== 'owner'")
  })

  it('tareas: las cuatro mutaciones exigen el permiso', () => {
    for (const fn of ['createTaskAction', 'updateTaskAction', 'updateTaskStatusAction', 'deleteTaskAction']) {
      const i = tasks.indexOf(`export async function ${fn}`)
      expect(i, fn).toBeGreaterThan(-1)
      const cuerpo = tasks.slice(i, tasks.indexOf('export async function', i + 10))
      expect(cuerpo, fn).toContain('requireAttendCustomers')
    }
  })

  it('conversaciones: TODAS las mutaciones exigen el permiso, incluidas las que no tienen UI', () => {
    const fns = conversations.match(/export async function (\w+)/g) ?? []
    expect(fns.length).toBeGreaterThanOrEqual(10)
    for (const decl of fns) {
      const fn = decl.replace('export async function ', '')
      const i = conversations.indexOf(decl)
      const next = conversations.indexOf('export async function', i + 10)
      const cuerpo = conversations.slice(i, next === -1 ? undefined : next)
      expect(cuerpo, fn).toContain('requireAttendCustomers')
    }
  })

  it('ya no queda el guard viejo de sólo-rol en conversaciones', () => {
    expect(conversations).not.toContain("ctx.role !== 'owner' && ctx.role !== 'receptionist'")
  })

  it('la bandeja se puede VER sin permiso: la página no bloquea, sólo oculta el botón', () => {
    const page = soloCodigo(leer('src/app/(tenant)/dashboard/attention/page.tsx'))
    expect(page).toContain('canAttendCustomers(ctx)')
    expect(page).not.toMatch(/redirect\([^)]*\)\s*$/m.source.replace(/\$$/, ''))
    expect(page).toContain('canAttend={puedeAtender}')
    const list = soloCodigo(leer('src/app/(tenant)/dashboard/attention/attention-list.tsx'))
    expect(list).toContain('{canAttend && (')
    // Abrir WhatsApp NO depende del permiso.
    const i = list.indexOf('Abrir WhatsApp')
    expect(list.slice(Math.max(0, i - 400), i)).not.toContain('canAttend')
  })
})

// ── 3. La migración de RLS ──────────────────────────────────────────────────

describe('RLS: las policies de receptionist dejan de ser FOR ALL sin permiso', () => {
  const sql = leerRaiz(MIGRACION)

  it.each([
    'receptionist_all_properties',
    'receptionist_all_units',
    'receptionist_all_contacts',
    'receptionist_all_tasks',
    'receptionist_all_conversations',
  ])('%s se elimina', (p) => {
    expect(sql).toContain(`DROP POLICY IF EXISTS ${p}`)
  })

  it('properties y units: escritura con can_create_properties', () => {
    for (const t of ['properties', 'units']) {
      for (const cmd of ['insert', 'update', 'delete']) {
        const i = sql.indexOf(`CREATE POLICY receptionist_${cmd}_${t}`)
        expect(i, `${cmd} ${t}`).toBeGreaterThan(-1)
        const cuerpo = sql.slice(i, sql.indexOf('CREATE POLICY', i + 10))
        expect(cuerpo, `${cmd} ${t}`).toContain('receptionist_can_manage_properties()')
      }
    }
  })

  it('contacts, tasks y conversations: escritura con can_assign_conversations', () => {
    for (const p of ['insert_contacts', 'update_contacts', 'insert_tasks', 'update_tasks', 'delete_tasks', 'update_conversations']) {
      const i = sql.indexOf(`CREATE POLICY receptionist_${p}`)
      expect(i, p).toBeGreaterThan(-1)
      const cuerpo = sql.slice(i, sql.indexOf('CREATE POLICY', i + 10))
      expect(cuerpo, p).toContain('receptionist_can_attend_customers()')
    }
  })

  it('la LECTURA no exige permiso en ninguna de las cinco tablas', () => {
    for (const t of ['properties', 'units', 'contacts', 'tasks', 'conversations']) {
      const i = sql.indexOf(`CREATE POLICY receptionist_select_${t}`)
      expect(i, t).toBeGreaterThan(-1)
      const cuerpo = sql.slice(i, sql.indexOf('CREATE POLICY', i + 10))
      expect(cuerpo, t).not.toContain('receptionist_can_')
    }
  })

  it('el soft delete queda cubierto: archivar es UPDATE', () => {
    const i = sql.indexOf('CREATE POLICY receptionist_update_properties')
    expect(sql.slice(i, sql.indexOf('CREATE POLICY', i + 10))).toContain('deleted_at IS NULL')
  })

  it('no toca owner, service_role, impersonación ni tenant_users', () => {
    expect(sql).not.toMatch(/DROP POLICY[^\n]*owner_all/)
    expect(sql).not.toMatch(/DROP POLICY[^\n]*sa_imp/)
    expect(sql).not.toMatch(/DROP POLICY[^\n]*operator_setup/)
    expect(sql).not.toMatch(/(DROP|CREATE) POLICY[^\n]*tenant_users/)
    expect(sql).not.toMatch(/ALTER TABLE|DROP TABLE|DELETE FROM|UPDATE public\./)
  })

  it('el receptionist no recibe INSERT ni DELETE sobre conversaciones', () => {
    expect(sql).not.toContain('receptionist_insert_conversations')
    expect(sql).not.toContain('receptionist_delete_conversations')
  })
})

// ── 4. Labels ───────────────────────────────────────────────────────────────

describe('labels: el vocabulario viejo desapareció', () => {
  const labels = PERMISSION_FIELDS.map((f) => f.label)

  it.each([
    'Asignar conversaciones',
    'Crear propiedades',
    'Confirmar reservas',
    'Acceder a Configuración',
  ])('%s ya no se muestra', (viejo) => {
    expect(labels).not.toContain(viejo)
  })

  it('los nuevos están', () => {
    for (const nuevo of [
      'Atender clientes', 'Ver datos del negocio', 'Gestionar propiedades',
      'Gestionar reservas y pagos', 'Gestionar consultas', 'Gestionar visitas',
      'Gestionar reservas de mesa', 'Gestionar menú', 'Gestionar pedidos',
    ]) {
      expect(labels).toContain(nuevo)
    }
  })

  it('ninguna descripción usa jerga técnica', () => {
    for (const f of PERMISSION_FIELDS) {
      expect(f.description, f.key).not.toMatch(/\bCRM\b|AI mode|operation request|capabilit|tenant\b|RLS/i)
    }
  })

  it('"Ver datos del negocio" no promete editar', () => {
    const f = PERMISSION_FIELDS.find((x) => x.key === 'can_access_settings')!
    expect(f.description).not.toMatch(/editar|modificar/i)
  })
})

// ── 5. Vertical y capacidades ───────────────────────────────────────────────

describe('el modal muestra lo que corresponde', () => {
  const nada: SavedPermissions = emptyPermissions()
  const todas = { delivery: true, takeaway: true, tableReservations: true }
  const keys = (v: 'food_service' | 'real_estate', saved = nada, caps = todas) =>
    visiblePermissionFields(v, saved, caps).map((f) => f.key)

  it('food: seis permisos, ninguno inmobiliario', () => {
    const k = keys('food_service')
    expect(k).toEqual([
      'can_assign_conversations', 'can_access_settings', 'can_manage_inquiries',
      'can_manage_table_reservations', 'can_manage_menu', 'can_manage_orders',
    ])
  })

  it('real_estate: seis permisos, ninguno gastronómico', () => {
    const k = keys('real_estate', nada, { delivery: false, takeaway: false, tableReservations: false })
    expect(k).toEqual([
      'can_assign_conversations', 'can_access_settings', 'can_create_properties',
      'can_confirm_reservations', 'can_manage_inquiries', 'can_manage_visits',
    ])
  })

  it('capacidad apagada: el permiso NO se ofrece', () => {
    expect(keys('food_service', nada, { ...todas, tableReservations: false }))
      .not.toContain('can_manage_table_reservations')
    expect(keys('food_service', nada, { delivery: false, takeaway: false, tableReservations: true }))
      .not.toContain('can_manage_orders')
  })

  it('pedidos sobrevive si queda UNA vía de pedido', () => {
    expect(keys('food_service', nada, { delivery: true, takeaway: false, tableReservations: true })).toContain('can_manage_orders')
    expect(keys('food_service', nada, { delivery: false, takeaway: true, tableReservations: true })).toContain('can_manage_orders')
  })

  it('capacidad apagada PERO permiso concedido: se muestra, marcado como inactivo', () => {
    const saved = { ...nada, can_manage_table_reservations: true }
    const campos = visiblePermissionFields('food_service', saved, { ...todas, tableReservations: false })
    const campo = campos.find((f) => f.key === 'can_manage_table_reservations')
    expect(campo, 'no puede quedar concedido e invisible').toBeDefined()
    expect(campo!.disabledByCapability).toBe(true)
  })

  it('con la capacidad encendida nada queda marcado como inactivo', () => {
    for (const f of visiblePermissionFields('food_service', nada, todas)) {
      expect(f.disabledByCapability, f.key).toBe(false)
    }
  })

  it('un tenant sin capacidades (inmobiliario) no desactiva nada', () => {
    for (const f of visiblePermissionFields('real_estate', nada, null)) {
      expect(f.disabledByCapability, f.key).toBe(false)
    }
  })

  it('sólo reservas de mesa y pedidos dependen de una capacidad', () => {
    const conGate = PERMISSION_FIELDS.filter((f) => capabilityForPermission(f) !== null).map((f) => f.key)
    expect(conGate).toEqual(['can_manage_table_reservations', 'can_manage_orders'])
    for (const f of PERMISSION_FIELDS) {
      if (capabilityForPermission(f) === null) {
        expect(permissionEnabledByCapabilities(f, { delivery: false, takeaway: false, tableReservations: false }), f.key).toBe(true)
      }
    }
  })

  it('el diálogo recibe las capacidades desde el owner, sin consulta extra', () => {
    expect(soloCodigo(leer('src/lib/auth/require-owner.ts'))).toContain('capabilities: ctx.capabilities')
    expect(soloCodigo(leer('src/components/tenant/users/receptionist-permissions-dialog.tsx'))).toContain('}, capabilities)')
  })
})

// ── 6. Defaults y escalada ──────────────────────────────────────────────────

describe('defaults y privilegios', () => {
  it('un receptionist nuevo arranca sin ningún permiso', () => {
    const vacio = emptyPermissions()
    expect(Object.values(vacio).every((v) => v === false)).toBe(true)
    expect(Object.keys(vacio).length).toBe(PERMISSION_FIELDS.length)
  })

  it('administrar usuarios sigue siendo exclusivo del owner', () => {
    const users = soloCodigo(leer('src/actions/users.ts'))
    for (const fn of [
      'createTenantUserAction', 'updateTenantUserAction', 'updateReceptionistPermissionsAction',
      'deactivateTenantUserAction', 'resendUserAccessAction', 'assignWorkspacesAction',
    ]) {
      const i = users.indexOf(`export async function ${fn}`)
      expect(i, fn).toBeGreaterThan(-1)
      const cuerpo = users.slice(i, users.indexOf('export async function', i + 10))
      expect(cuerpo, fn).toContain('requireOwner()')
    }
  })

  it('la migración no le da al receptionist forma de tocar tenant_users', () => {
    expect(leerRaiz(MIGRACION)).not.toMatch(/POLICY[^\n]*tenant_users/)
  })
})
