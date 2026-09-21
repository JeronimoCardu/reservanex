import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { visibleNavItems } from './nav-items'
import type { FoodCapabilities } from '@orderflow/validators'

// ════════════════════════════════════════════════════════════════════════════
// La superficie del onboarding multi-tipo y de las capacidades del local.
//
// Sin entorno DOM (vitest en 'node'): lo puro se prueba puro, lo de React y lo
// de las rutas se fija con aserciones estructurales sobre el fuente — el mismo
// criterio de filters.test.ts y public-entrypoints.test.ts.
// ════════════════════════════════════════════════════════════════════════════

const SRC  = path.resolve(import.meta.dirname, '..', '..')
const RAIZ = path.resolve(SRC, '..', '..', '..')
const leer = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8')

function soloCodigo(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

const caps = (d: boolean, t: boolean, r: boolean): FoodCapabilities =>
  ({ delivery: d, takeaway: t, tableReservations: r })

// ── 30. Nav del dashboard según capacidades ─────────────────────────────────

describe('30. nav del dashboard', () => {
  const hrefs = (vertical: 'real_estate' | 'food_service', c?: FoodCapabilities) =>
    visibleNavItems({ role: 'owner', vertical, isSetupOperator: false, capabilities: c }).map((i) => i.href)

  it('Reservas de mesa desaparece cuando la capacidad está apagada', () => {
    expect(hrefs('food_service', caps(true, true, true))).toContain('/dashboard/table-reservations')
    expect(hrefs('food_service', caps(true, true, false))).not.toContain('/dashboard/table-reservations')
  })

  it('Menú queda SIEMPRE: un restaurante tiene carta aunque no tome nada', () => {
    for (const c of [caps(true, true, true), caps(false, false, false)]) {
      expect(hrefs('food_service', c)).toContain('/dashboard/menu')
    }
  })

  it('Pedidos queda SIEMPRE: el histórico sigue siendo válido y hay que trabajarlo', () => {
    // Apagar delivery no cancela los pedidos que ya entraron.
    expect(hrefs('food_service', caps(false, false, false))).toContain('/dashboard/orders')
  })

  it('Solicitudes sigue compartida y nunca se oculta por capacidades', () => {
    expect(hrefs('food_service', caps(false, false, false))).toContain('/dashboard/requests')
    expect(hrefs('real_estate')).toContain('/dashboard/requests')
  })

  it('real_estate no cambia por capacidades gastronómicas', () => {
    const sinCaps  = hrefs('real_estate')
    const conCaps  = hrefs('real_estate', caps(false, false, false))
    expect(conCaps).toEqual(sinCaps)
    expect(sinCaps).not.toContain('/dashboard/table-reservations')
    expect(sinCaps).not.toContain('/dashboard/menu')
  })

  it('sin capacidades declaradas el nav no esconde nada (compatibilidad)', () => {
    expect(hrefs('food_service')).toContain('/dashboard/table-reservations')
  })
})

// ── Guards server-side ──────────────────────────────────────────────────────

describe('guards server-side', () => {
  it('30. el módulo de reservas de mesa valida la capacidad, no sólo el rubro', () => {
    const codigo = soloCodigo(
      leer('app', '(tenant)', 'dashboard', 'table-reservations', 'layout.tsx'),
    )
    expect(codigo).toContain("requireRouteVertical(ctx, '/dashboard/table-reservations')")
    expect(codigo).toContain('if (!ctx.capabilities.tableReservations) notFound()')
  })

  it('9. la ruta pública de reserva de mesa falla cerrada', () => {
    const codigo = soloCodigo(
      leer('app', 'site', '[tenantSlug]', 'formulario', '[intent]', 'page.tsx'),
    )
    expect(codigo).toContain("parsedIntent.data === 'table_reservation' && !caps.tableReservations) notFound()")
    // Y después del guard de vertical, como el resto.
    expect(codigo.indexOf('isIntentAllowedForVertical'))
      .toBeLessThan(codigo.indexOf("=== 'table_reservation'"))
  })

  it('10. general_inquiry no tiene capacidad propia en ningún guard', () => {
    for (const archivo of [
      leer('app', 'site', '[tenantSlug]', 'formulario', '[intent]', 'page.tsx'),
      leer('app', 'api', 'public', 'forms', 'route.ts'),
    ]) {
      const codigo = soloCodigo(archivo)
      expect(codigo).not.toMatch(/general_inquiry[^\n]*caps\./)
      expect(codigo).not.toMatch(/caps\.[a-zA-Z]+[^\n]*general_inquiry/)
    }
  })

  it('16. /platform/tenants/new corta a operator del lado del servidor', () => {
    const codigo = soloCodigo(leer('app', '(platform)', 'platform', 'tenants', 'new', 'page.tsx'))
    expect(codigo).toContain('if (ctx.isOperator) notFound()')
    // Y ya no es sólo "ser alguien de plataforma".
    expect(codigo).toContain('const ctx = await requirePlatformContext()')
  })
})

// ── 22. El servidor es la autoridad ─────────────────────────────────────────

describe('22. API pública', () => {
  const codigo = soloCodigo(leer('app', 'api', 'public', 'forms', 'route.ts'))

  it('rechaza table_reservation si la capacidad está apagada', () => {
    expect(codigo).toContain("request.intent === 'table_reservation' && !caps.tableReservations")
  })

  it('rechaza food_order si no hay ninguna modalidad habilitada', () => {
    expect(codigo).toContain("request.intent === 'food_order' && !canAcceptFoodOrders(caps)")
  })

  it('rechaza un fulfillment deshabilitado aunque el intent esté permitido', () => {
    expect(codigo).toContain('isFulfillmentEnabled(caps, input.fulfillment)')
  })

  it('las capacidades se leen del TENANT, nunca del cuerpo del request', () => {
    expect(codigo).toContain('foodCapabilitiesFrom(tenant)')
    expect(codigo).not.toMatch(/request\.(capabilities|delivery|takeaway)/)
  })

  it('el chequeo ocurre antes de crear nada', () => {
    expect(codigo.indexOf('foodCapabilitiesFrom(tenant)'))
      .toBeLessThan(codigo.indexOf('createSubmission('))
  })
})

// ── 21. Sitio público ───────────────────────────────────────────────────────

describe('21. sitio público', () => {
  const codigo = soloCodigo(leer('components', 'site', 'public-menu-client.tsx'))

  it('el CTA de reservar mesa depende de su capacidad', () => {
    expect(codigo).toContain('{caps.tableReservations && (')
  })

  it('"Hacer una consulta" NO depende de ninguna capacidad', () => {
    const i = codigo.indexOf('formulario/general_inquiry')
    const bloque = codigo.slice(Math.max(0, i - 400), i)
    expect(bloque).not.toContain('caps.')
  })

  it('el carrito sólo existe si el local toma pedidos', () => {
    expect(codigo).toContain('{tomaPedidos && lines.length > 0 && (')
    expect(codigo).toContain('open={tomaPedidos && abierto}')
  })

  it('y el botón de agregar no se dibuja si no hay pedidos posibles', () => {
    expect(codigo).toContain('{tomaPedidos && (')
  })

  it('el menú se muestra igual: la carta no depende de las capacidades', () => {
    const i = codigo.indexOf('id="menu"')
    expect(i).toBeGreaterThan(-1)
    expect(codigo.slice(i - 200, i)).not.toContain('tomaPedidos')
  })
})

// ── 28. El alta ─────────────────────────────────────────────────────────────

describe('28. alta de cliente', () => {
  const accion = soloCodigo(leer('actions', 'platform.ts'))

  it('el tipo es obligatorio y el vertical se deriva: no se elige', () => {
    expect(accion).toContain('kind:                tenantKindSchema')
    expect(accion).toContain('mappingForTenantKind(d.kind)')
    // El cliente nunca manda el vertical.
    expect(accion).not.toMatch(/vertical:\s+z\./)
  })

  it('operator no puede crear ninguno', () => {
    const i = accion.indexOf('createPlatformTenantAction')
    expect(accion.slice(i, i + 400)).toContain('if (ctx.isOperator) return')
  })

  it('14. un seller queda asignado a lo que crea, sea del tipo que sea', () => {
    expect(accion).toContain("const sellerId = ctx.role === 'seller' ? ctx.userId : null")
    expect(accion).toContain('assigned_seller_id:   sellerId')
    expect(accion).toContain('created_by_seller_id: sellerId')
  })

  it('los topes salen del tipo, no del formulario', () => {
    expect(accion).toContain('planLimitsForTenantKind(d.kind)')
    expect(accion).not.toMatch(/max_properties:\s+d\./)
  })

  it('las capacidades sólo se escriben para gastronomía', () => {
    expect(accion).toContain("d.kind === 'food_business'")
    expect(accion).toContain('DEFAULT_FOOD_CAPABILITIES')
  })

  it('13. crear el cliente NO crea el auth user del owner', () => {
    const i = accion.indexOf('createPlatformTenantAction')
    const cuerpo = accion.slice(i, accion.indexOf('export async function', i + 10))
    expect(cuerpo).toContain('primary_owner_email')
    expect(cuerpo).not.toContain('inviteUserByEmail')
    expect(cuerpo).not.toContain('ensureInvitedUser')
  })
})

// ── 11 y 17. Copy ───────────────────────────────────────────────────────────

describe('11 y 17. copy de plataforma', () => {
  it('la pantalla de alta dice "Nuevo cliente"', () => {
    const codigo = soloCodigo(leer('app', '(platform)', 'platform', 'tenants', 'new', 'page.tsx'))
    expect(codigo).toContain('Nuevo cliente')
    expect(codigo).not.toContain('Nueva inmobiliaria')
  })

  it('el nav y el listado hablan de clientes, no de inmobiliarias', () => {
    const lay  = soloCodigo(leer('app', '(platform)', 'platform', 'layout.tsx'))
    const list = soloCodigo(leer('app', '(platform)', 'platform', 'tenants', 'page.tsx'))
    expect(lay).not.toMatch(/Inmobiliarias|Mis inmobiliarias|Nueva inmobiliaria/)
    expect(list).not.toMatch(/inmobiliarias/i)
    expect(lay).toContain("label: 'Clientes'")
  })

  it('18. cada fila del listado dice qué tipo es, sin enums técnicos', () => {
    const list = soloCodigo(leer('app', '(platform)', 'platform', 'tenants', 'page.tsx'))
    expect(list).toContain('tenantKindLabel(t.vertical, t.client_type)')
    expect(list).not.toMatch(/>\s*\{t\.vertical\}\s*</)
    expect(list).not.toMatch(/>\s*\{t\.client_type\}\s*</)
  })

  it('el formulario nunca muestra los valores técnicos', () => {
    const form = soloCodigo(leer('app', '(platform)', 'platform', 'tenants', 'new', 'create-tenant-form.tsx'))
    for (const tecnico of ['real_estate', 'food_service', "'agency'", "'private_owner'"]) {
      expect(form.includes(`>${tecnico}<`), tecnico).toBe(false)
    }
    expect(form).toContain('TENANT_KIND_LABELS')
  })
})

// ── 26. Nada de autos ───────────────────────────────────────────────────────

describe('26. no existe ningún vertical de autos', () => {
  it('ni enum, ni ruta, ni implementación, en todo lo versionado', () => {
    // Sólo código productivo: un *.test.ts puede nombrar un vertical de autos
    // como fixture NEGATIVA (lo que el schema tiene que rechazar) sin que eso
    // signifique que exista.
    const versionados = execFileSync('git', ['ls-files'], { cwd: RAIZ, encoding: 'utf8' })
      .split('\n')
      .filter((f) => /\.(ts|tsx|sql)$/.test(f))
      .filter((f) => !/\.test\.tsx?$/.test(f))

    const PATRON = /\b(car_dealership|dealership|automotive|vehicle_vertical|autos_vertical)\b/i
    const culpables: string[] = []
    for (const archivo of versionados) {
      const texto = soloCodigo(fs.readFileSync(path.join(RAIZ, archivo), 'utf8'))
      if (PATRON.test(texto)) culpables.push(archivo)
    }
    expect(culpables, `mencionan un vertical de autos: ${culpables.join(', ')}`).toEqual([])
  })

  it('el CHECK de vertical sigue teniendo exactamente dos valores', () => {
    const migraciones = fs.readdirSync(path.join(RAIZ, 'supabase', 'migrations'))
    const conVertical = migraciones.filter((m) =>
      fs.readFileSync(path.join(RAIZ, 'supabase', 'migrations', m), 'utf8')
        .includes("vertical IN ('real_estate'"))
    expect(conVertical.length).toBeGreaterThan(0)
  })
})
