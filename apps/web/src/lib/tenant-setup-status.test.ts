import { describe, expect, it } from 'vitest'
import { deriveTenantSetupChecklist, relativeTimeEs } from './tenant-setup-status'
import { deriveDeviceStatus } from './autoresponder-device-health'
import type { TenantKind } from '@orderflow/validators'

// ════════════════════════════════════════════════════════════════════════════
// El readiness entiende de rubros, y verifica el Android por un hecho.
//
// Lo compartido (owner, IA, WhatsApp, tenant activo) se comporta igual para los
// tres tipos. El CATÁLOGO cambia por rubro. Y el Android se marca ✓ por
// evidencia persistente —last_device_seen_at, que escribe el inbound
// autenticado— no por un heartbeat que nadie emite desde que MacroDroid se
// retiró.
// ════════════════════════════════════════════════════════════════════════════

const AHORA = new Date('2026-09-17T12:00:00Z')
const hace  = (min: number) => new Date(AHORA.getTime() - min * 60_000).toISOString()

const READY_BASE = {
  kind:                   'agency' as TenantKind,
  tenantActive:           true,
  ownerActive:            true,
  aiConfigured:           false,
  whatsappStatus:         'ready' as const,
  deviceStatus:           'online' as const,
  lastDeviceSeenAt:       hace(1),
  publishedPropertyCount: 1,
  publishedMenuItemCount: 0,
  now:                    AHORA,
}

const FOOD_READY = {
  ...READY_BASE,
  kind:                   'food_business' as TenantKind,
  publishedPropertyCount: 0,
  publishedMenuItemCount: 1,
}

/** El estado derivado tal como lo calcula la acción real, a partir del timestamp. */
const conActividad = (min: number | null) => ({
  lastDeviceSeenAt: min === null ? null : hace(min),
  deviceStatus:     deriveDeviceStatus({
    configStatus: 'ready', lastDeviceSeenAt: min === null ? null : hace(min), now: AHORA,
  }),
})

describe('deriveTenantSetupChecklist — compartido', () => {
  it('a brand-new tenant with nothing configured is not_started', () => {
    const result = deriveTenantSetupChecklist({
      ...READY_BASE,
      ownerActive:            false,
      whatsappStatus:         'not_configured',
      deviceStatus:           'not_configured',
      lastDeviceSeenAt:       null,
      publishedPropertyCount: 0,
    })
    expect(result.state).toBe('not_started')
    expect(result.stateLabel).toBe('Configuración incompleta')
  })

  it('missing owner alone is setup_incomplete', () => {
    const result = deriveTenantSetupChecklist({ ...READY_BASE, ownerActive: false })
    expect(result.state).toBe('setup_incomplete')
    expect(result.owner.ok).toBe(false)
  })

  it('WhatsApp not ready (incomplete config) is setup_incomplete', () => {
    const result = deriveTenantSetupChecklist({
      ...READY_BASE, whatsappStatus: 'incomplete', deviceStatus: 'not_configured', lastDeviceSeenAt: null,
    })
    expect(result.state).toBe('setup_incomplete')
    expect(result.whatsapp.ok).toBe(false)
  })

  it('all requirements met → ready', () => {
    const result = deriveTenantSetupChecklist(READY_BASE)
    expect(result.state).toBe('ready')
    expect(result.stateLabel).toBe('Listo para piloto')
    expect(result.tenant.ok).toBe(true)
    expect(result.owner.ok).toBe(true)
    expect(result.whatsapp.ok).toBe(true)
    expect(result.android.ok).toBe(true)
    expect(result.catalog.ok).toBe(true)
  })

  it('ai_settings is always "ok" even without a row — safe defaults always apply', () => {
    const withRow    = deriveTenantSetupChecklist({ ...READY_BASE, aiConfigured: true })
    const withoutRow = deriveTenantSetupChecklist({ ...READY_BASE, aiConfigured: false })
    expect(withRow.ai.ok).toBe(true)
    expect(withoutRow.ai.ok).toBe(true)
    expect(withRow.ai.label).not.toBe(withoutRow.ai.label)
  })

  it('a suspended tenant (tenantActive=false) is never "ready" even if everything else is', () => {
    const result = deriveTenantSetupChecklist({ ...READY_BASE, tenantActive: false })
    expect(result.state).toBe('setup_incomplete')
    expect(result.tenant.ok).toBe(false)
  })

  it('el copy del tenant inactivo es neutral, no inmobiliario', () => {
    const result = deriveTenantSetupChecklist({ ...FOOD_READY, tenantActive: false })
    expect(result.tenant.label).toBe('Cliente inactivo o suspendido')
  })

  it('7. owner activo es un tenant_user, no un prospecto: ownerActive=false nunca da ok', () => {
    const result = deriveTenantSetupChecklist({ ...FOOD_READY, ownerActive: false })
    expect(result.owner.ok).toBe(false)
    expect(result.owner.label).toBe('Sin owner activo todavía')
  })
})

// ── Android: verificado por evidencia, no por heartbeat ─────────────────────

describe('Android — verificado por prueba E2E', () => {
  it('0. everSeen deriva de last_device_seen_at, y para los cuatro estados da lo esperado', () => {
    // nunca visto → false; online → true; stale → true; offline → true.
    // No depende de enumerar strings de deviceStatus.
    expect(deriveTenantSetupChecklist({ ...READY_BASE, ...conActividad(null) }).android.ok).toBe(false)
    expect(deriveTenantSetupChecklist({ ...READY_BASE, ...conActividad(1)    }).android.ok).toBe(true)   // online
    expect(deriveTenantSetupChecklist({ ...READY_BASE, ...conActividad(10)   }).android.ok).toBe(true)   // stale
    expect(deriveTenantSetupChecklist({ ...READY_BASE, ...conActividad(600)  }).android.ok).toBe(true)   // offline
  })

  it('A. nunca hubo last_device_seen_at → Android incompleto', () => {
    const result = deriveTenantSetupChecklist({ ...READY_BASE, ...conActividad(null) })
    expect(result.android.ok).toBe(false)
    expect(result.android.label).toMatch(/Sin verificar/)
    expect(result.state).toBe('setup_incomplete')
  })

  it('A. nunca visto con AutoResponder sin configurar dice "Sin verificar", sin más', () => {
    const result = deriveTenantSetupChecklist({
      ...READY_BASE, whatsappStatus: 'not_configured', deviceStatus: 'not_configured', lastDeviceSeenAt: null,
    })
    expect(result.android.label).toBe('Sin verificar')
  })

  it('B. primer inbound autenticado → Android verificado', () => {
    const result = deriveTenantSetupChecklist({ ...READY_BASE, ...conActividad(0) })
    expect(result.android.ok).toBe(true)
    expect(result.android.label).toMatch(/^Verificado/)
    expect(result.state).toBe('ready')
  })

  it('C. actividad de hace más de 5 min → sigue verificado', () => {
    const result = deriveTenantSetupChecklist({ ...READY_BASE, ...conActividad(7) })
    expect(result.android.ok).toBe(true)
    expect(result.state).toBe('ready')
  })

  it('D. actividad de hace más de 15 min (y de días) → sigue verificado', () => {
    for (const min of [16, 120, 60 * 24 * 3]) {
      const result = deriveTenantSetupChecklist({ ...READY_BASE, ...conActividad(min) })
      expect(result.android.ok, `hace ${min} min`).toBe(true)
      expect(result.state, `hace ${min} min`).toBe('ready')
    }
  })

  it('E. el health puede decir "sin actividad" y el checklist no vuelve rojo', () => {
    const dev = conActividad(600)
    expect(dev.deviceStatus).toBe('offline')                       // el monitoreo lo ve
    const result = deriveTenantSetupChecklist({ ...READY_BASE, ...dev })
    expect(result.android.ok).toBe(true)                           // el onboarding no
    expect(result.android.label).toBe('Verificado · última actividad hace 10 h')
  })

  it('2. el label nunca afirma "conectado"', () => {
    for (const min of [0, 1, 10, 600]) {
      const label = deriveTenantSetupChecklist({ ...READY_BASE, ...conActividad(min) }).android.label
      expect(label, `hace ${min} min`).not.toMatch(/conectad|online/i)
    }
  })

  it('android_offline ya no existe como estado', () => {
    const estados = new Set<string>()
    for (const min of [null, 0, 7, 16, 9999]) {
      estados.add(deriveTenantSetupChecklist({ ...READY_BASE, ...conActividad(min) }).state)
    }
    expect([...estados]).not.toContain('android_offline')
  })

  it('WhatsApp AutoResponder y la verificación del Android siguen siendo requisito en los tres rubros', () => {
    for (const kind of ['agency', 'private_owner', 'food_business'] as TenantKind[]) {
      const base = kind === 'food_business' ? FOOD_READY : { ...READY_BASE, kind }
      expect(deriveTenantSetupChecklist({
        ...base, whatsappStatus: 'not_configured', deviceStatus: 'not_configured', lastDeviceSeenAt: null,
      }).state, kind).not.toBe('ready')
      expect(deriveTenantSetupChecklist({ ...base, ...conActividad(null) }).state, kind).toBe('setup_incomplete')
    }
  })
})

describe('relativeTimeEs', () => {
  it('formatea minutos, horas y días', () => {
    expect(relativeTimeEs(hace(0),    AHORA)).toBe('recién')
    expect(relativeTimeEs(hace(3),    AHORA)).toBe('hace 3 min')
    expect(relativeTimeEs(hace(59),   AHORA)).toBe('hace 59 min')
    expect(relativeTimeEs(hace(60),   AHORA)).toBe('hace 1 h')
    expect(relativeTimeEs(hace(600),  AHORA)).toBe('hace 10 h')
    expect(relativeTimeEs(hace(1440), AHORA)).toBe('hace 1 día')
    expect(relativeTimeEs(hace(4320), AHORA)).toBe('hace 3 días')
  })

  it('un timestamp en el futuro o inválido no rompe', () => {
    expect(relativeTimeEs(new Date(AHORA.getTime() + 60_000).toISOString(), AHORA)).toBe('recién')
    expect(relativeTimeEs('no-es-fecha', AHORA)).toBe('recién')
  })
})

// ── Catálogo por rubro ──────────────────────────────────────────────────────

describe('catálogo — inmobiliario (agency y private_owner)', () => {
  it.each(['agency', 'private_owner'] as TenantKind[])('%s: sin propiedades publicadas es no_catalog', (kind) => {
    const result = deriveTenantSetupChecklist({ ...READY_BASE, kind, publishedPropertyCount: 0 })
    expect(result.state).toBe('no_catalog')
    expect(result.catalog.ok).toBe(false)
    expect(result.catalogTitle).toBe('Propiedades')
    expect(result.catalog.label).toBe('Sin propiedades publicadas')
  })

  it.each(['agency', 'private_owner'] as TenantKind[])('%s: los productos de menú NO cuentan como catálogo', (kind) => {
    const result = deriveTenantSetupChecklist({ ...READY_BASE, kind, publishedPropertyCount: 0, publishedMenuItemCount: 7 })
    expect(result.state).toBe('no_catalog')
  })

  it('properties count pluralizes the label correctly', () => {
    expect(deriveTenantSetupChecklist({ ...READY_BASE, publishedPropertyCount: 1 }).catalog.label).toBe('1 propiedad publicada')
    expect(deriveTenantSetupChecklist({ ...READY_BASE, publishedPropertyCount: 3 }).catalog.label).toBe('3 propiedades publicadas')
  })

  it('la pista de qué hacer habla de propiedades', () => {
    expect(deriveTenantSetupChecklist({ ...READY_BASE, publishedPropertyCount: 0 }).catalogHint).toMatch(/Propiedades/)
  })
})

describe('catálogo — gastronomía', () => {
  it('NO exige propiedades: con productos publicados está listo', () => {
    const result = deriveTenantSetupChecklist(FOOD_READY)
    expect(result.state).toBe('ready')
    expect(result.catalogTitle).toBe('Menú')
    expect(result.catalog.label).toBe('1 producto publicado')
  })

  it('las propiedades NO cuentan como catálogo de un restaurante', () => {
    const result = deriveTenantSetupChecklist({ ...FOOD_READY, publishedMenuItemCount: 0, publishedPropertyCount: 9 })
    expect(result.state).toBe('no_catalog')
    expect(result.catalog.label).toBe('Sin productos publicados')
  })

  it('el checklist no nombra "Propiedades" en ningún lado', () => {
    const result = deriveTenantSetupChecklist({ ...FOOD_READY, publishedMenuItemCount: 0 })
    const todo = [result.catalogTitle, result.catalog.label, result.catalogHint, result.tenant.label].join(' ')
    expect(todo).not.toMatch(/propiedad/i)
  })

  it('pluraliza productos', () => {
    expect(deriveTenantSetupChecklist({ ...FOOD_READY, publishedMenuItemCount: 3 }).catalog.label).toBe('3 productos publicados')
  })

  it('NO depende de delivery, retiro ni reservas', () => {
    expect(deriveTenantSetupChecklist(FOOD_READY).state).toBe('ready')
    expect(Object.keys(FOOD_READY)).not.toContain('delivery')
  })
})
