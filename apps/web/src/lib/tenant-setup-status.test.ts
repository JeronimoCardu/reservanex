import { describe, expect, it } from 'vitest'
import { deriveTenantSetupChecklist } from './tenant-setup-status'

const READY_BASE = {
  tenantActive:           true,
  ownerActive:            true,
  aiConfigured:           false,
  whatsappStatus:         'ready' as const,
  deviceStatus:           'online' as const,
  publishedPropertyCount: 1,
}

describe('deriveTenantSetupChecklist', () => {
  it('a brand-new tenant with nothing configured is not_started', () => {
    const result = deriveTenantSetupChecklist({
      tenantActive:           true,
      ownerActive:            false,
      aiConfigured:           false,
      whatsappStatus:         'not_configured',
      deviceStatus:           'not_configured',
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
    const result = deriveTenantSetupChecklist({ ...READY_BASE, whatsappStatus: 'incomplete', deviceStatus: 'not_configured' })
    expect(result.state).toBe('setup_incomplete')
    expect(result.whatsapp.ok).toBe(false)
  })

  it('Android never seen (but WhatsApp configured) is setup_incomplete, not android_offline', () => {
    const result = deriveTenantSetupChecklist({ ...READY_BASE, deviceStatus: 'never_seen' })
    expect(result.state).toBe('setup_incomplete')
  })

  it('Android stale/offline after having been seen at least once is android_offline', () => {
    expect(deriveTenantSetupChecklist({ ...READY_BASE, deviceStatus: 'stale' }).state).toBe('android_offline')
    expect(deriveTenantSetupChecklist({ ...READY_BASE, deviceStatus: 'offline' }).state).toBe('android_offline')
  })

  it('everything ready except properties is no_properties', () => {
    const result = deriveTenantSetupChecklist({ ...READY_BASE, publishedPropertyCount: 0 })
    expect(result.state).toBe('no_properties')
    expect(result.properties.ok).toBe(false)
  })

  it('all requirements met → ready', () => {
    const result = deriveTenantSetupChecklist(READY_BASE)
    expect(result.state).toBe('ready')
    expect(result.stateLabel).toBe('Listo para piloto')
    expect(result.tenant.ok).toBe(true)
    expect(result.owner.ok).toBe(true)
    expect(result.whatsapp.ok).toBe(true)
    expect(result.android.ok).toBe(true)
    expect(result.properties.ok).toBe(true)
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

  it('properties count pluralizes the label correctly', () => {
    const one  = deriveTenantSetupChecklist({ ...READY_BASE, publishedPropertyCount: 1 })
    const many = deriveTenantSetupChecklist({ ...READY_BASE, publishedPropertyCount: 3 })
    expect(one.properties.label).toBe('1 propiedad publicada')
    expect(many.properties.label).toBe('3 propiedades publicadas')
  })
})
