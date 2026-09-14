import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { TenantVertical } from '@orderflow/validators'
import {
  PERMISSION_FIELDS,
  permissionBelongsToVertical,
  visiblePermissionFields,
  type ReceptionistPermissionKey,
  type SavedPermissions,
} from './permission-fields'
import { MODULE_VERTICALS, verticalsForRoute } from './module-verticals'
import { ALL_NAV_ITEMS } from './nav-items'
import type { ReceptionistPermissions } from '@/lib/repositories/users.repository'

// Comprobación en tiempo de COMPILACIÓN: las claves de la tabla de presentación y
// las que se escriben en la base son EXACTAMENTE el mismo conjunto.
//
// No es decorativa. Si alguien agrega un permiso a ReceptionistPermissions y se
// olvida de declararlo acá, nunca aparecería en el diálogo. Y al revés —una clave
// acá que no exista en la tabla— mandaría una columna inexistente en el update y
// fallaría en runtime, porque un Record con claves de más es estructuralmente
// asignable y TS no lo detectaría solo. Esta línea rompe el typecheck en los dos
// sentidos.
type MismasClaves<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const CLAVES_COINCIDEN: MismasClaves<keyof ReceptionistPermissions, ReceptionistPermissionKey> = true

// Fase 3E-C3A1 — visibilidad de permisos por rubro.
//
// La regla es pura y se prueba directo. Lo que no se puede renderizar acá (el
// entorno de vitest es 'node', sin jsdom) se cubre con tests de CABLEADO que leen
// el código fuente: son los que atrapan la regresión real —que alguien manede al
// servidor solo los permisos visibles, o que resuelva el rubro con otra query.

const REAL: TenantVertical = 'real_estate'
const FOOD: TenantVertical = 'food_service'

const TRANSVERSALES: ReceptionistPermissionKey[] = [
  'can_assign_conversations',
  'can_access_settings',
  'can_manage_inquiries',
]
const SOLO_INMOB: ReceptionistPermissionKey[] = [
  'can_create_properties',
  'can_confirm_reservations',
  'can_manage_visits',
]
const SOLO_GASTRO: ReceptionistPermissionKey[] = [
  'can_manage_table_reservations',
  'can_manage_menu',
  // Fase 3E-C3B0 — gastronómico por su override, no por su ruta: vive en
  // /dashboard/requests, que es transversal.
  'can_manage_orders',
]

/** Todos en false, que es el caso base de una recepcionista nueva. */
const TODO_FALSE: SavedPermissions = {
  can_assign_conversations:      false,
  can_access_settings:           false,
  can_create_properties:         false,
  can_confirm_reservations:      false,
  can_manage_inquiries:          false,
  can_manage_visits:             false,
  can_manage_table_reservations: false,
  can_manage_menu:               false,
  can_manage_orders:             false,
}

const visibles = (v: TenantVertical, saved: SavedPermissions = TODO_FALSE) =>
  visiblePermissionFields(v, saved).map((f) => f.key)

describe('visiblePermissionFields — A. real_estate', () => {
  it('muestra los transversales y los inmobiliarios', () => {
    expect(visibles(REAL)).toEqual([
      'can_assign_conversations',
      'can_access_settings',
      'can_create_properties',
      'can_confirm_reservations',
      'can_manage_inquiries',
      'can_manage_visits',
    ])
  })

  it('oculta los gastronómicos cuando están en false', () => {
    const vs = visibles(REAL)
    for (const k of SOLO_GASTRO) expect(vs, k).not.toContain(k)
  })

  it('muestra exactamente 6 de los 9', () => {
    expect(visibles(REAL)).toHaveLength(6)
  })
})

describe('visiblePermissionFields — B. food_service', () => {
  it('muestra los transversales y los gastronómicos', () => {
    expect(visibles(FOOD)).toEqual([
      'can_assign_conversations',
      'can_access_settings',
      'can_manage_inquiries',
      'can_manage_table_reservations',
      'can_manage_menu',
      'can_manage_orders',
    ])
  })

  it('oculta los inmobiliarios cuando están en false', () => {
    const vs = visibles(FOOD)
    for (const k of SOLO_INMOB) expect(vs, k).not.toContain(k)
  })

  it('muestra exactamente 6 de los 9', () => {
    expect(visibles(FOOD)).toHaveLength(6)
  })
})

describe('visiblePermissionFields — los transversales siempre', () => {
  it('aparecen en los dos rubros', () => {
    for (const k of TRANSVERSALES) {
      expect(visibles(REAL), k).toContain(k)
      expect(visibles(FOOD), k).toContain(k)
    }
  })

  it('can_manage_inquiries es transversal y no depende del rubro', () => {
    // El kind `inquiry` cubre property_inquiry y monthly_rental_inquiry
    // (inmobiliarias) Y general_inquiry (gastronomía).
    const campo = PERMISSION_FIELDS.find((f) => f.key === 'can_manage_inquiries')!
    expect(permissionBelongsToVertical(campo, REAL)).toBe(true)
    expect(permissionBelongsToVertical(campo, FOOD)).toBe(true)
  })
})

describe('visiblePermissionFields — C/D. permiso fuera de rubro ya encendido', () => {
  it('C. sigue visible si vale true, para poder apagarlo', () => {
    const saved: SavedPermissions = { ...TODO_FALSE, can_manage_menu: true }
    const vs = visibles(REAL, saved)
    expect(vs).toContain('can_manage_menu')
    // Y no arrastra al otro gastronómico, que sigue en false.
    expect(vs).not.toContain('can_manage_table_reservations')
    expect(vs).toHaveLength(7)
  })

  it('C. vale para cualquier permiso fuera de rubro, en los dos sentidos', () => {
    for (const k of SOLO_GASTRO) {
      expect(visibles(REAL, { ...TODO_FALSE, [k]: true }), k).toContain(k)
    }
    for (const k of SOLO_INMOB) {
      expect(visibles(FOOD, { ...TODO_FALSE, [k]: true }), k).toContain(k)
    }
  })

  it('D. una vez guardado en false, deja de mostrarse', () => {
    const encendido: SavedPermissions = { ...TODO_FALSE, can_manage_menu: true }
    expect(visibles(REAL, encendido)).toContain('can_manage_menu')

    // Esto es lo que devuelve el servidor en el render siguiente al guardado.
    const apagado: SavedPermissions = { ...encendido, can_manage_menu: false }
    expect(visibles(REAL, apagado)).not.toContain('can_manage_menu')
    expect(visibles(REAL, apagado)).toHaveLength(6)
  })

  it('un permiso DEL rubro se muestra igual esté en true o en false', () => {
    expect(visibles(FOOD, TODO_FALSE)).toContain('can_manage_menu')
    expect(visibles(FOOD, { ...TODO_FALSE, can_manage_menu: true })).toContain('can_manage_menu')
  })
})

describe('G/H/I. can_manage_orders (Fase 3E-C3B0)', () => {
  const campo = () => PERMISSION_FIELDS.find((f) => f.key === 'can_manage_orders')!

  it('G. un owner food_service ve "Gestionar pedidos"', () => {
    expect(visibles(FOOD)).toContain('can_manage_orders')
    expect(campo().label).toBe('Gestionar pedidos')
    expect(campo().description).toBe('Puede aceptar, rechazar y gestionar pedidos')
  })

  it('H. un owner real_estate NO lo ve cuando está en false', () => {
    expect(visibles(REAL)).not.toContain('can_manage_orders')
  })

  it('I. pero si la fila lo tiene en true, sigue visible para poder revocarlo', () => {
    const saved: SavedPermissions = { ...TODO_FALSE, can_manage_orders: true }
    expect(visibles(REAL, saved)).toContain('can_manage_orders')
  })

  it('I. y una vez apagado y guardado, desaparece', () => {
    const encendido: SavedPermissions = { ...TODO_FALSE, can_manage_orders: true }
    expect(visibles(REAL, encendido)).toContain('can_manage_orders')
    const apagado: SavedPermissions = { ...encendido, can_manage_orders: false }
    expect(visibles(REAL, apagado)).not.toContain('can_manage_orders')
  })

  it('es gastronómico por su override, no por su ruta', () => {
    // /dashboard/requests es transversal: sin `verticals` este permiso se
    // mostraría en los dos rubros.
    expect(campo().module).toBe('/dashboard/requests')
    expect(verticalsForRoute('/dashboard/requests')).toBeNull()
    expect(campo().verticals).toEqual(['food_service'])
    expect(permissionBelongsToVertical(campo(), FOOD)).toBe(true)
    expect(permissionBelongsToVertical(campo(), REAL)).toBe(false)
  })

  it('no se mezcla con can_manage_menu: son permisos distintos', () => {
    // Despachar pedidos es operación; la carta es una decisión comercial.
    const menu = PERMISSION_FIELDS.find((f) => f.key === 'can_manage_menu')!
    expect(menu.module).toBe('/dashboard/menu')
    expect(campo().module).not.toBe(menu.module)
  })
})

describe('visiblePermissionFields — solo filtra, no muta', () => {
  it('E. no toca el objeto de permisos que recibe', () => {
    const saved: SavedPermissions = { ...TODO_FALSE, can_manage_menu: true }
    const copia = { ...saved }
    visiblePermissionFields(REAL, saved)
    expect(saved).toEqual(copia)
  })

  it('E. no apaga nada: filtrar para real_estate no cambia ningún valor', () => {
    const saved: SavedPermissions = {
      ...TODO_FALSE, can_manage_menu: true, can_manage_table_reservations: true,
    }
    visiblePermissionFields(REAL, saved)
    expect(saved.can_manage_menu).toBe(true)
    expect(saved.can_manage_table_reservations).toBe(true)
  })
})

describe('la taxonomía de rubros no se duplica', () => {
  it('cada permiso declara un módulo que existe de verdad', () => {
    // Un typo en `module` («/dashboard/menus») caería en "transversal" y el
    // permiso se mostraría siempre. Esto lo atrapa.
    const rutasConocidas = new Set<string>(ALL_NAV_ITEMS.map((i) => i.href))
    for (const f of PERMISSION_FIELDS) {
      const ok = rutasConocidas.has(f.module) || f.module.startsWith('/dashboard/settings')
      expect(ok, `${f.key} → ${f.module}`).toBe(true)
    }
  })

  it('el rubro de cada permiso coincide con el del módulo en MODULE_VERTICALS', () => {
    for (const f of PERMISSION_FIELDS) {
      // Los que declaran `verticals` son la excepción documentada: su módulo es
      // transversal pero el permiso no lo es. Se verifican aparte, abajo.
      if (f.verticals) continue
      const delMapa = (MODULE_VERTICALS as Record<string, readonly TenantVertical[]>)[f.module]
      if (delMapa) {
        // Pertenece exactamente a los rubros que declara el mapa, ni uno más.
        expect(permissionBelongsToVertical(f, 'real_estate'), f.key)
          .toBe(delMapa.includes('real_estate'))
        expect(permissionBelongsToVertical(f, 'food_service'), f.key)
          .toBe(delMapa.includes('food_service'))
      } else {
        // Sin entrada en el mapa ⇒ transversal en los dos.
        expect(permissionBelongsToVertical(f, 'real_estate'), f.key).toBe(true)
        expect(permissionBelongsToVertical(f, 'food_service'), f.key).toBe(true)
      }
    }
  })

  it('las 9 claves están declaradas una sola vez', () => {
    const keys = PERMISSION_FIELDS.map((f) => f.key)
    expect(keys).toHaveLength(9)
    expect(new Set(keys).size).toBe(9)
  })

  it('el override de rubro es la excepción, no la regla', () => {
    // Si esto crece, la "excepción" dejó de serlo y conviene revisar el diseño
    // en vez de seguir agregando overrides.
    const conOverride = PERMISSION_FIELDS.filter((f) => f.verticals)
    expect(conOverride.map((f) => f.key)).toEqual(['can_manage_orders'])
  })

  it('un permiso con override solo se justifica si su módulo es transversal', () => {
    // Si el módulo YA tuviera rubro propio, el override sería una segunda
    // taxonomía redundante — justo lo que se quiere evitar.
    for (const f of PERMISSION_FIELDS) {
      if (!f.verticals) continue
      expect(verticalsForRoute(f.module), `${f.key} → ${f.module}`).toBeNull()
    }
  })

  it('las claves del diálogo y las de la base son el mismo conjunto', () => {
    // La garantía real es la comprobación de tipos de arriba, que corre en el
    // typecheck. Esto la deja visible en la salida de los tests.
    expect(CLAVES_COINCIDEN).toBe(true)
  })
})

// ─── Cableado ────────────────────────────────────────────────────────────────

const SRC = path.resolve(import.meta.dirname, '..', '..')

describe('cableado del filtro de permisos', () => {
  it('F. requireOwner no hace ninguna consulta para resolver el rubro', () => {
    const fuente = fs.readFileSync(path.join(SRC, 'lib', 'auth', 'require-owner.ts'), 'utf8')

    expect(fuente, 'require-owner debe exponer el rubro').toContain('vertical')
    expect(fuente, 'lo toma del ctx que ya tiene').toContain('ctx.vertical')

    // Ni cliente admin, ni cliente de servidor, ni una sola consulta: si alguien
    // agregara un roundtrip acá, este test falla.
    expect(fuente).not.toContain('createAdminClient')
    expect(fuente).not.toContain('createClient')
    expect(fuente).not.toContain(".from('tenants')")
    expect(fuente).not.toMatch(/\.from\(/)
  })

  it('F. la página de usuarios saca el rubro de requireOwner, no de otra fuente', () => {
    const fuente = fs.readFileSync(
      path.join(SRC, 'app', '(tenant)', 'dashboard', 'users', 'page.tsx'), 'utf8')
    expect(fuente).toMatch(/const \{[^}]*vertical[^}]*\} = await requireOwner\(\)/)
    expect(fuente).toContain('vertical={vertical}')
    expect(fuente).not.toContain('createAdminClient')
  })

  it('el rubro llega al diálogo a través de la tabla', () => {
    const tabla = fs.readFileSync(
      path.join(SRC, 'components', 'tenant', 'users', 'user-table.tsx'), 'utf8')
    expect(tabla).toContain('vertical: TenantVertical')
    expect(tabla).toContain('vertical={vertical}')
  })

  it('E. el update sigue mandando las 8 claves, no solo las visibles', () => {
    const dialogo = fs.readFileSync(
      path.join(SRC, 'components', 'tenant', 'users', 'receptionist-permissions-dialog.tsx'),
      'utf8')

    // La regresión que importa: mandar `campos` o un subconjunto en vez de `perms`
    // apagaría en silencio los permisos ocultos.
    expect(dialogo).toContain('updateReceptionistPermissionsAction(user!.id, perms)')

    // El estado se inicializa con las 8 claves desde la fila del usuario.
    for (const f of PERMISSION_FIELDS) {
      expect(dialogo, `${f.key} debe sincronizarse desde user`)
        .toContain(`user.${f.key}`)
    }

    // Y el filtrado se usa SOLO para renderizar.
    expect(dialogo).toContain('campos.map(')
    expect(dialogo).toContain('visiblePermissionFields(vertical, {')
  })

  it('la visibilidad se mide contra los valores GUARDADOS, no contra el estado del formulario', () => {
    const dialogo = fs.readFileSync(
      path.join(SRC, 'components', 'tenant', 'users', 'receptionist-permissions-dialog.tsx'),
      'utf8')
    const llamada = dialogo.slice(
      dialogo.indexOf('visiblePermissionFields(vertical, {'),
      dialogo.indexOf('function toggle('),
    )
    // Si midiera `perms`, la fila desaparecería en el mismo click en que se apaga.
    expect(llamada).toContain('user.can_manage_menu')
    expect(llamada).not.toContain('perms.')
  })
})
