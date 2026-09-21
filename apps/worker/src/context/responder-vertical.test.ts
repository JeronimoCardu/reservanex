import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// ════════════════════════════════════════════════════════════════════════════
// El responder respeta el rubro del tenant.
//
// generateAIReply() pega a Supabase y al LLM, así que el cableado se fija con
// aserciones estructurales sobre el fuente (comentarios descartados). Lo que
// el prompt DICE está cubierto en food-domain.test.ts; acá se fija que el
// responder lo USE cuando corresponde, y que real_estate no cambie.
// ════════════════════════════════════════════════════════════════════════════

const DIR  = import.meta.dirname
const RAIZ = path.resolve(DIR, '..', '..', '..', '..')
const leer = (...p: string[]) => fs.readFileSync(path.join(DIR, ...p), 'utf8')

function soloCodigo(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

const R = soloCodigo(leer('responder.ts'))

describe('el responder lee el rubro y las capacidades del tenant', () => {
  it('6. el select del tenant trae vertical y las tres capacidades', () => {
    expect(R).toContain("vertical, delivery_enabled, takeaway_enabled, table_reservations_enabled")
    expect(R).toContain('const food = isFoodService(tenant ?? {})')
    expect(R).toContain('const caps = foodCapabilitiesFromTenant(tenant ?? {})')
  })

  it('7. no hay default gastronómico: sólo lo es si su vertical lo es', () => {
    // isFoodService() sobre {} es false — cubierto en food-domain.test.ts. Acá:
    // el responder no fuerza `food = true` en ningún camino.
    expect(R).not.toMatch(/const food\s*=\s*true/)
    expect(R).not.toMatch(/food\s*=\s*!/)
  })
})

describe('4. real_estate conserva su comportamiento', () => {
  it('la identidad inmobiliaria sigue existiendo, elegida por rubro', () => {
    expect(R).toContain('identityLine(assistantName, tenantName, food)')
    const fd = soloCodigo(leer('food-domain.ts'))
    expect(fd).toContain(`Representás a la inmobiliaria "\${tenantName}"`)
  })

  it('el bloque inmobiliario [Gestión de reservas] sigue intacto y es el que va cuando no es food', () => {
    expect(R).toContain("'ReservaNex gestiona tres tipos de operaciones inmobiliarias:'")
    expect(R).toContain('`[Gestión de reservas]\\n${reservationLine}`')
    // La rama no-food del ternario es exactamente el bloque de siempre.
    const i = R.indexOf('const domainSection = food')
    expect(i).toBeGreaterThan(-1)
    expect(R.slice(i, i + 320)).toContain(': `[Gestión de reservas]\\n${reservationLine}`')
  })

  it('las herramientas inmobiliarias completas siguen para real_estate', () => {
    const i = R.indexOf('const tools = food')
    const bloque = R.slice(i, i + 900)
    // Rama no-food: BASE_TOOLS + nombre + los dos links.
    expect(bloque).toContain('...BASE_TOOLS,')
    expect(bloque).toContain('[sendPublicCatalogLinkTool, sendPropertyLinkTool]')
  })

  it('el default del nombre sigue siendo "la inmobiliaria" para real_estate', () => {
    expect(R).toContain("tenant?.name ?? (food ? 'el negocio' : 'la inmobiliaria')")
  })
})

describe('gastronomía: tools y dominio propios', () => {
  it('un restaurante NO recibe herramientas de propiedades ni de reservas de estadía', () => {
    const i = R.indexOf('const tools = food')
    const ramaFood = R.slice(i, R.indexOf('...BASE_TOOLS', i))
    for (const tool of [
      'searchPropertiesForReservationTool', 'checkPropertyAvailabilityTool', 'findNextAvailableDatesTool',
      'searchPropertiesTool', 'createPendingReservationTool', 'cancelRecentReservationTool', 'sendPropertyLinkTool',
      'BASE_TOOLS',
    ]) {
      expect(ramaFood, tool).not.toContain(tool)
    }
  })

  it('y sí recibe escalar, pago, nombre y el link a la carta', () => {
    const i = R.indexOf('const tools = food')
    const ramaFood = R.slice(i, R.indexOf('...BASE_TOOLS', i))
    expect(ramaFood).toContain('escalateToHumanTool')
    expect(ramaFood).toContain('sendPaymentDataTool')
    expect(ramaFood).toContain('saveContactNameTool')
    expect(ramaFood).toContain('sendPublicCatalogLinkTool')
  })

  it('el dominio gastronómico se construye desde las capacidades del tenant', () => {
    expect(R).toContain('buildFoodDomainSection({ caps, publicCatalogUrl, canSendLinks: sendPropertyLinks, publishedMenuItemCount })')
    expect(R).toContain("from('menu_items')")
    expect(R).toContain('sendTableReservationLinkTool')
  })

  it('la regla de nombre y la de links son las gastronómicas', () => {
    expect(R).toContain(': food ? foodNameRule() : [')
    expect(R).toContain('? foodLinksRule(sendPropertyLinks, publicCatalogUrl)')
  })
})

describe('9. "Automatic reply" no lo emite el backend', () => {
  it('la cadena no existe en ningún archivo versionado de web ni worker', () => {
    const versionados = execFileSync('git', ['ls-files', 'apps/web/src', 'apps/worker/src'], { cwd: RAIZ, encoding: 'utf8' })
      .split('\n').filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('responder-vertical.test.ts'))
    const culpables = versionados.filter((f) =>
      /automatic reply|respuesta autom[aá]tica/i.test(soloCodigo(fs.readFileSync(path.join(RAIZ, f), 'utf8'))))
    expect(culpables).toEqual([])
  })

  it('el worker devuelve el texto del LLM tal cual en replies[], sin prefijo', () => {
    const srv = soloCodigo(leer('..', 'internal-server.ts'))
    expect(srv).not.toMatch(/message:\s*[`'"]\s*Automatic/i)
    expect(srv).not.toMatch(/`Automatic reply/)
  })
})
