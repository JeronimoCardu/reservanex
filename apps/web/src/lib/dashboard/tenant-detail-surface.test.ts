import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { limitUsage } from '@/lib/tenant-limits'
import { planLimitsForTenantKind } from '@orderflow/validators'

// ════════════════════════════════════════════════════════════════════════════
// La ficha de cliente en /platform/tenants/[id], para los tres tipos.
//
// Sin entorno DOM: lo puro se prueba puro (limitUsage, topes por tipo) y lo de
// React se fija con aserciones estructurales sobre el fuente, con comentarios
// descartados — el mismo criterio del resto de los tests de superficie.
// ════════════════════════════════════════════════════════════════════════════

const SRC  = path.resolve(import.meta.dirname, '..', '..')
const leer = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8')

function soloCodigo(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

const FICHA    = soloCodigo(leer('app', '(platform)', 'platform', 'tenants', '[id]', 'page.tsx'))
const ACCIONES = soloCodigo(leer('app', '(platform)', 'platform', 'tenants', '[id]', 'tenant-detail-actions.tsx'))
const PLAN_ACT = soloCodigo(leer('actions', 'platform.ts'))

// ── 2. Copy ─────────────────────────────────────────────────────────────────

describe('2. copy de la ficha', () => {
  it('el breadcrumb dice Clientes, no Inmobiliarias', () => {
    expect(FICHA).toContain('← Clientes')
    expect(FICHA).not.toContain('← Inmobiliarias')
  })

  it('el título de la pestaña es neutral', () => {
    expect(FICHA).toContain("title: 'Cliente — ReservaNex'")
  })

  it('no queda copy inmobiliario suelto en la ficha genérica', () => {
    expect(FICHA).not.toMatch(/inmobiliaria/i)
  })

  it('18. el tipo del cliente es visible en el header, por su label', () => {
    expect(FICHA).toContain('tenantKindLabel(tenant.vertical, tenant.client_type)')
    expect(FICHA).toContain('{kindLabel}')
  })
})

// ── 3 y 13. Checklist derivado por tipo ─────────────────────────────────────

describe('3 y 13. checklist', () => {
  it('la ficha NO hardcodea "Propiedades": el título del catálogo viene del checklist', () => {
    expect(FICHA).toContain('label: checklist.catalogTitle')
    expect(FICHA).not.toContain("label: 'Propiedades'")
    expect(FICHA).not.toContain('checklist.properties')
  })

  it('la pista del catálogo también viene del checklist, en el idioma del rubro', () => {
    expect(FICHA).toContain("checklist.state === 'no_catalog'")
    expect(FICHA).toContain('{checklist.catalogHint}')
    expect(FICHA).not.toContain('no_properties')
  })

  it('13. la fuente de verdad server-side entiende de rubros', () => {
    // No es sólo la UI: la acción que calcula el checklist pasa el tipo.
    const accion = soloCodigo(leer('actions', 'platform-tenant-setup.ts'))
    expect(accion).toContain('kind:                   tenantKindFrom(tenant.vertical, tenant.client_type)')
    expect(accion).toContain('publishedMenuItemCount: signals.publishedMenuItemCount')
  })

  it('13. y la señal de menú se lee con el mismo criterio que el catálogo público', () => {
    const repo = soloCodigo(leer('lib', 'repositories', 'platform.repository.ts'))
    expect(repo).toContain("admin.from('menu_items').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('published', true).is('deleted_at', null)")
  })

  it('WhatsApp y Android siguen en el checklist para todos', () => {
    expect(FICHA).toContain("{ label: 'WhatsApp',")
    expect(FICHA).toContain("{ label: 'Android',")
  })
})

// ── 4, 10, 11. Plan y límites ───────────────────────────────────────────────

describe('4, 10 y 11. plan y límites', () => {
  it('ya no hay defaults legacy `?? 1 / ?? 4 / ?? 5`', () => {
    expect(FICHA).not.toMatch(/max_owners[^\n]*\?\? 1/)
    expect(FICHA).not.toMatch(/max_receptionists[^\n]*\?\? 4/)
    expect(FICHA).not.toMatch(/max_users[^\n]*\?\? 5/)
  })

  it('los topes pasan por limitUsage: NULL = sin límite, no un número', () => {
    expect(FICHA).toContain('limitUsage(counts.total,         tenant.max_users)')
    expect(FICHA).toContain('limitUsage(propertyCount,        tenant.max_properties)')
  })

  it('11. sin tope se muestra el número solo, nunca "/∞"', () => {
    expect(FICHA).toContain('String(counts.total)')
    expect(FICHA).not.toContain('∞')
    expect(FICHA).not.toContain('/ ∞')
  })

  it('4. "Agentes" no se usa para gastronomía', () => {
    expect(FICHA).toContain("kind === 'food_business' ? 'Equipo' : 'Agentes'")
  })

  it('10. el particular muestra propiedades X de 5 sólo si hay tope', () => {
    // El renglón existe condicionado al uso, y el uso es null sin tope.
    expect(FICHA).toContain('{usoPropiedades && (')
    const l = planLimitsForTenantKind('private_owner')
    expect(limitUsage(3, l.maxProperties)).toEqual({ used: 3, max: 5, remaining: 2, reached: false })
    expect(limitUsage(5, l.maxProperties)!.reached).toBe(true)
    expect(limitUsage(2, l.maxUsers)).toEqual({ used: 2, max: 3, remaining: 1, reached: false })
  })

  it('11 y 12. agency y gastronomía no tienen uso de tope: limitUsage devuelve null', () => {
    for (const kind of ['agency', 'food_business'] as const) {
      const l = planLimitsForTenantKind(kind)
      expect(limitUsage(0, l.maxProperties), kind).toBeNull()
      expect(limitUsage(0, l.maxUsers), kind).toBeNull()
    }
  })

  it('el conteo de propiedades usa el mismo criterio que el trigger (deleted_at IS NULL)', () => {
    const repo = soloCodigo(leer('lib', 'repositories', 'platform.repository.ts'))
    const i = repo.indexOf('export async function countActiveProperties')
    expect(i).toBeGreaterThan(-1)
    expect(repo.slice(i, i + 400)).toContain(".is('deleted_at', null)")
  })
})

// ── 5. Plan comercial ───────────────────────────────────────────────────────

describe('5. plan comercial', () => {
  it('los botones de planes de agentes sólo se muestran a agency', () => {
    expect(ACCIONES).toContain("{isSuperAdmin && kind === 'agency' && (")
    const i = ACCIONES.indexOf("kind === 'agency'")
    expect(ACCIONES.slice(i, i + 200)).toContain('Plan comercial')
  })

  it('la AUTORIDAD es el servidor: la acción rechaza planes fuera de agency', () => {
    const i = PLAN_ACT.indexOf('export async function updateTenantPlanAction')
    const cuerpo = PLAN_ACT.slice(i, PLAN_ACT.indexOf('export async function', i + 10))
    expect(cuerpo).toContain("tenantKindFrom(tenant.vertical, tenant.client_type) !== 'agency'")
    expect(cuerpo).toContain('Los planes de agentes son solo para inmobiliarias.')
    // Y antes de tocar nada: el rechazo precede al updateTenantPlan.
    expect(cuerpo.indexOf("!== 'agency'")).toBeLessThan(cuerpo.indexOf('repo.updateTenantPlan'))
  })

  it('no se inventó un plan gastronómico', () => {
    const plans = soloCodigo(leer('lib', 'plans.ts'))
    expect(plans).not.toMatch(/food|gastro|menu|restaurant/i)
  })
})

// ── 6. Meta legacy ──────────────────────────────────────────────────────────

describe('6. estado meta_setup', () => {
  it('el VALOR persistido no cambia: sigue siendo meta_setup en todos lados', () => {
    expect(ACCIONES).toContain("value: 'meta_setup'")
    expect(PLAN_ACT).toContain("'meta_setup'")
    const badge = soloCodigo(leer('components', 'platform', 'onboarding-badge.tsx'))
    expect(badge).toContain('meta_setup:')
  })

  it('el LABEL ya no dice Meta en ninguna superficie de plataforma', () => {
    for (const [nombre, fuente] of [
      ['acciones', ACCIONES],
      ['badge',    soloCodigo(leer('components', 'platform', 'onboarding-badge.tsx'))],
      ['metrics',  soloCodigo(leer('app', '(platform)', 'platform', 'metrics', 'page.tsx'))],
    ] as const) {
      expect(fuente, nombre).not.toContain('Config. Meta')
      expect(fuente, nombre).toContain('Configuración técnica')
    }
  })
})

// ── 8. Capacidades en la ficha ──────────────────────────────────────────────

describe('8. servicios del local', () => {
  it('se muestran sólo para gastronomía, y son informativos', () => {
    expect(FICHA).toContain("{kind === 'food_business' && (")
    const i = FICHA.indexOf('title="Servicios"')
    expect(i).toBeGreaterThan(-1)
    const bloque = FICHA.slice(i, i + 700)
    expect(bloque).toContain('caps.delivery')
    expect(bloque).toContain('caps.takeaway')
    expect(bloque).toContain('caps.tableReservations')
    // Nada de formularios: no se duplica la Configuración del owner.
    expect(bloque).not.toContain('<form')
    expect(bloque).not.toContain('onChange')
  })

  it('las capacidades se leen del tenant con el helper canónico', () => {
    expect(FICHA).toContain('foodCapabilitiesFrom(tenant)')
  })
})

// ── 7. Owner ────────────────────────────────────────────────────────────────

describe('7. owner prospecto ≠ owner activo', () => {
  it('la tarjeta de prospecto y el renglón de owner del checklist son cosas distintas', () => {
    expect(FICHA).toContain('title="Owner prospecto"')
    expect(FICHA).toContain("{ label: 'Owner',")
    // El checklist no mira primary_owner_email: lo mira la acción, y ésta
    // sólo pasa ownerActive (tenant_users). Se fija en la acción.
    const accion = soloCodigo(leer('actions', 'platform-tenant-setup.ts'))
    expect(accion).toContain('ownerActive:            signals.ownerActive')
    expect(accion).not.toContain('primary_owner_email')
  })
})

// ── Setup operator: no aplica a gastronomía ─────────────────────────────────

describe('setup operator — no aplica a food_service', () => {
  const REPO = soloCodigo(leer('lib', 'repositories', 'platform.repository.ts'))

  it('1. la ficha no dibuja la tarjeta Setup operator para gastronomía', () => {
    expect(FICHA).toContain(`{ctx.isSuperAdmin && kind !== 'food_business' && (`)
    const i = FICHA.indexOf(`kind !== 'food_business' && (`)
    expect(FICHA.slice(i, i + 120)).toContain('title="Setup operator"')
    // Y no hay un "No aplica" de reemplazo.
    expect(FICHA).not.toMatch(/No aplica/)
  })

  it('1. agency y private_owner conservan la tarjeta: la condición es sólo food_business', () => {
    // La tarjeta se condiciona por exclusión de gastronomía, no por inclusión
    // de agency: private_owner sigue siendo inmobiliario y la sigue viendo.
    expect(FICHA).not.toMatch(/kind === 'agency' && \(\s*<InfoCard title="Setup operator"/)
  })

  it('1. la sección de asignar/revocar tampoco se ofrece a gastronomía', () => {
    expect(ACCIONES).toContain(`{isSuperAdmin && kind !== 'food_business' && operators.length > 0 && (`)
  })

  it('2. assignSetupOperatorAction rechaza a un tenant que no es real_estate', () => {
    const i = PLAN_ACT.indexOf('export async function assignSetupOperatorAction')
    const cuerpo = PLAN_ACT.slice(i, PLAN_ACT.indexOf('export async function', i + 10))
    expect(cuerpo).toContain("if (tenant.vertical !== 'real_estate') {")
    expect(cuerpo).toContain('El setup por operator sólo aplica a clientes inmobiliarios.')
    // Antes de escribir la asignación.
    expect(cuerpo.indexOf("!== 'real_estate'")).toBeLessThan(cuerpo.indexOf('repo.createSetupAssignment'))
  })

  it('3. startSetupImpersonationAction rechaza food_service sólo en la rama de operator', () => {
    const i = PLAN_ACT.indexOf('export async function startSetupImpersonationAction')
    const cuerpo = PLAN_ACT.slice(i, PLAN_ACT.indexOf('export async function', i + 10))
    // El guard lee el vertical junto con el estado del tenant…
    expect(cuerpo).toContain("select('status, onboarding_status, deleted_at, vertical')")
    expect(cuerpo).toContain("if (tenant.vertical !== 'real_estate') {")
    // …dentro de `if (ctx.isOperator)`: el super_admin no pasa por ahí.
    const opBranch = cuerpo.indexOf('if (ctx.isOperator) {')
    const guard    = cuerpo.indexOf("tenant.vertical !== 'real_estate'")
    const cierre   = cuerpo.indexOf('const existing = await repo.getActiveImpersonationSession')
    expect(opBranch).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(opBranch)
    expect(guard).toBeLessThan(cierre)
  })

  it('4. la cola "Mis setups" filtra gastronomía al leer, sin borrar nada', () => {
    const i = REPO.indexOf('export async function listSetupAssignmentsByOperator')
    const cuerpo = REPO.slice(i, REPO.indexOf('export async function', i + 10))
    expect(cuerpo).toContain('vertical')
    expect(cuerpo).toContain("?.vertical === 'real_estate')")
    expect(cuerpo).not.toMatch(/\.delete\(/)
  })

  it('6. el super_admin sigue configurando AutoResponder para cualquier rubro', () => {
    // Ninguna acción de platform-autoresponder.ts discrimina por vertical.
    const ar = soloCodigo(leer('actions', 'platform-autoresponder.ts'))
    expect(ar).toContain('requireSuperAdmin()')
    expect(ar).not.toMatch(/vertical|food_service|real_estate/)
  })

  it('5. el workflow gastronómico no menciona operator en la ficha de acciones para food', () => {
    // Las transiciones de estado siguen siendo las mismas siete: no se agregó
    // ni quitó ninguna por este cambio.
    const valores = [...ACCIONES.matchAll(/value: '(\w+)',\s+label:/g)].map((m) => m[1])
    expect(valores).toEqual(expect.arrayContaining([
      'pending_review', 'approved', 'meta_setup', 'testing', 'ready_to_deliver', 'delivered', 'rejected',
    ]))
  })
})

// ── setup_status: semántica de operator, oculta para gastronomía ────────────

describe('setup_status — no se expone a food_service', () => {
  it('1. el badge sólo se dibuja fuera de food_business', () => {
    expect(FICHA).toContain(`{setupStatus && kind !== 'food_business' && <SetupStatusBadge status={setupStatus} />}`)
  })

  it('1. y no hay reemplazo tipo "No aplica"', () => {
    expect(FICHA).not.toMatch(/No aplica/)
  })

  it('3. agency y private_owner lo conservan: la condición excluye sólo gastronomía', () => {
    // No es `kind === 'agency'`: private_owner sigue siendo inmobiliario.
    expect(FICHA).not.toMatch(/kind === 'agency' && <SetupStatusBadge/)
    expect(FICHA).not.toMatch(/kind === 'private_owner' && <SetupStatusBadge/)
  })

  it('5. onboarding_status sigue visible para todos, sin condición de rubro', () => {
    expect(FICHA).toContain('<StatusBadge status={tenant.onboarding_status} type="onboarding" />')
    const i = FICHA.indexOf('<StatusBadge status={tenant.onboarding_status}')
    expect(FICHA.slice(Math.max(0, i - 80), i)).not.toMatch(/food_business/)
  })

  it('5. "Configuración técnica" sigue representando meta_setup', () => {
    const badge = soloCodigo(leer('components', 'platform', 'onboarding-badge.tsx'))
    expect(badge).toMatch(/meta_setup:\s+\{ label: 'Configuración técnica'/)
  })

  it('1. setup_status es exclusivamente del flujo de operator: sólo lo escriben sus dos acciones', () => {
    const escritores = [...PLAN_ACT.matchAll(/repo\.updateTenantSetupStatus\([^)]*'(\w+)'\)/g)].map((m) => m[1])
    expect(escritores.sort()).toEqual(['assigned', 'completed'])
    // Y ninguna lógica productiva decide algo leyéndolo.
    expect(PLAN_ACT).not.toMatch(/setup_status\s*[!=]==/)
  })

  it('6. ocultarlo no toca la base: no hay migración ni update de setup_status para gastronomía', () => {
    const migs = fs.readdirSync(path.join(SRC, '..', '..', '..', 'supabase', 'migrations'))
    const hoy = migs.filter((m) => m.startsWith('202609'))
    for (const m of hoy) {
      const sql = fs.readFileSync(path.join(SRC, '..', '..', '..', 'supabase', 'migrations', m), 'utf8')
      if (m < '20260821') continue
      expect(sql, m).not.toMatch(/setup_status[^\n]*food_service|food_service[^\n]*setup_status/)
    }
    // La ficha tampoco lo escribe: sólo lo lee para decidir si dibujarlo.
    expect(FICHA).not.toMatch(/setup_status:\s/)
  })
})
