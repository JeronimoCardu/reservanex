// Rate limiting — Fase 1B: qué buckets evalúa cada endpoint.
//
// Un "plan" es la lista de buckets de UN request, ya con su política: qué
// clave (scope + componentes) y qué ventanas/límites. El adapter (limiter.ts)
// lo convierte en claves HMAC y en la llamada a rate_limit_hit. Este módulo no
// habla con nadie.
//
// FORMS: dos familias de buckets, ambas por IP.
//   · IP + endpoint 'public_forms' (todos los tenants juntos). Es lo que impide
//     evadir el límite variando el slug: cada slug inventado abriría un bucket
//     nuevo de IP + tenant, pero todos suman en este.
//   · IP + tenant + grupo de intent, con sus dos ventanas.
// El tenant entra como SLUG NORMALIZADO, porque el limiter corre ANTES de
// getPublicTenant: resolver tenant_id sólo para limitar sería una consulta a
// la base por cada request, justo lo que el limiter tiene que evitar.
//
// CONTACT: IP + endpoint 'contact', con sus dos ventanas.
//
// Ningún plan tiene un bucket por tenant solo ni uno global: un tope así deja
// sin servicio a todos los clientes reales de un local (o de la plataforma)
// cuando lo agota un atacante.

import type { FormIntent } from '@orderflow/validators'
import type { ClientIdentity } from './client-ip'
import type { RateLimitKeySpec } from './keys'
import {
  groupForIntent,
  PROPOSED_CONTACT_PER_IP_LIMITS,
  PROPOSED_FORM_GROUP_LIMITS,
  PROPOSED_FORMS_PER_IP_LIMITS,
  type WindowLimit,
} from './policy'

export interface RateLimitPlanEntry {
  readonly spec:   RateLimitKeySpec
  readonly limits: readonly WindowLimit[]
}

/**
 * El slug tal como entra en la clave: sin espacios en los bordes y en
 * minúsculas. Así `Pizzeria-Demo` y `pizzeria-demo` comparten bucket.
 */
export function normalizeTenantSlugForRateLimit(slug: string): string {
  return slug.trim().toLowerCase()
}

export function formsRateLimitPlan(params: {
  identity:   ClientIdentity
  tenantSlug: string
  intent:     FormIntent
}): RateLimitPlanEntry[] {
  const group = groupForIntent(params.intent)
  return [
    {
      spec:   { scope: 'ip_endpoint', identity: params.identity, endpoint: 'public_forms' },
      limits: PROPOSED_FORMS_PER_IP_LIMITS,
    },
    {
      spec: {
        scope:    'ip_tenant_group',
        identity: params.identity,
        tenant:   normalizeTenantSlugForRateLimit(params.tenantSlug),
        group,
      },
      limits: PROPOSED_FORM_GROUP_LIMITS[group],
    },
  ]
}

export function contactRateLimitPlan(params: { identity: ClientIdentity }): RateLimitPlanEntry[] {
  return [
    {
      spec:   { scope: 'ip_endpoint', identity: params.identity, endpoint: 'contact' },
      limits: PROPOSED_CONTACT_PER_IP_LIMITS,
    },
  ]
}
