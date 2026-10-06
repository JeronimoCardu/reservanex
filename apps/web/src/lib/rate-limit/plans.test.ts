import { describe, expect, it } from 'vitest'
import { formIntentSchema } from '@orderflow/validators'
import type { ClientIdentity } from './client-ip'
import { RATE_LIMIT_MAX_BUCKETS_PER_CALL } from './limiter'
import { contactRateLimitPlan, formsRateLimitPlan, normalizeTenantSlugForRateLimit } from './plans'
import {
  PROPOSED_CONTACT_PER_IP_LIMITS,
  PROPOSED_FORM_GROUP_LIMITS,
  PROPOSED_FORMS_PER_IP_LIMITS,
} from './policy'

const IP: ClientIdentity = { kind: 'ip', value: '203.0.113.7' }

describe('formsRateLimitPlan', () => {
  it('IP+endpoint public_forms con el límite global, y IP+tenant+grupo con el del grupo', () => {
    expect(formsRateLimitPlan({ identity: IP, tenantSlug: 'pizzeria-demo', intent: 'table_reservation' })).toEqual([
      { spec: { scope: 'ip_endpoint', identity: IP, endpoint: 'public_forms' }, limits: PROPOSED_FORMS_PER_IP_LIMITS },
      {
        spec:   { scope: 'ip_tenant_group', identity: IP, tenant: 'pizzeria-demo', group: 'reservas' },
        limits: PROPOSED_FORM_GROUP_LIMITS.reservas,
      },
    ])
  })

  it('ningún plan tiene un bucket por tenant solo ni uno global sin IP', () => {
    for (const intent of formIntentSchema.options) {
      for (const entry of formsRateLimitPlan({ identity: IP, tenantSlug: 'x', intent })) {
        expect(entry.spec.identity).toBe(IP)
        expect(['ip_endpoint', 'ip_tenant_group']).toContain(entry.spec.scope)
      }
    }
  })

  it('todo intent produce como mucho los buckets que acepta la RPC', () => {
    for (const intent of formIntentSchema.options) {
      const total = formsRateLimitPlan({ identity: IP, tenantSlug: 'x', intent })
        .reduce((n, e) => n + e.limits.length, 0)
      expect(total, intent).toBeLessThanOrEqual(RATE_LIMIT_MAX_BUCKETS_PER_CALL)
    }
  })
})

describe('contactRateLimitPlan', () => {
  it('sólo IP+endpoint contact', () => {
    expect(contactRateLimitPlan({ identity: IP })).toEqual([
      { spec: { scope: 'ip_endpoint', identity: IP, endpoint: 'contact' }, limits: PROPOSED_CONTACT_PER_IP_LIMITS },
    ])
  })
})

describe('normalizeTenantSlugForRateLimit', () => {
  it.each([
    ['pizzeria-demo', 'pizzeria-demo'],
    ['Pizzeria-Demo', 'pizzeria-demo'],
    ['  pizzeria-demo\n', 'pizzeria-demo'],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeTenantSlugForRateLimit(raw)).toBe(expected)
  })
})
