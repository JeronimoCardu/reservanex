// Property Videos Fase 1 — la regla ÚNICA de "esto se puede ver en el sitio
// público". Antes vivía sólo en getPublicTenant (public-site.repository.ts) y
// la ruta /api/property-videos aplicaba una versión incompleta: miraba
// public_site_enabled pero no el status ni el borrado del tenant, así que un
// tenant suspendido seguía sirviendo sus videos.
//
// Las dos la usan ahora. public-site.repository.test.ts congela el
// comportamiento previo de getPublicTenant y verifica la paridad con la ruta.

/**
 * Estados de tenant con sitio público. Fase 8 §14: un tenant suspended o
 * churned no sirve su sitio aunque el owner lo tenga habilitado; la
 * preferencia se conserva y vuelve sola cuando se reactiva.
 */
export const PUBLIC_TENANT_STATUSES: readonly string[] = ['trial', 'active']

export interface TenantVisibilityFields {
  status:              string | null
  public_site_enabled: boolean | null
  deleted_at:          string | null
}

/** Tenant no borrado, en trial o active, y con el sitio público habilitado. */
export function isTenantPubliclyVisible(t: TenantVisibilityFields): boolean {
  if (t.deleted_at != null) return false
  if (!PUBLIC_TENANT_STATUSES.includes(t.status ?? '')) return false
  if (!t.public_site_enabled) return false
  return true
}

export interface PropertyVisibilityFields {
  tenant_id:  string
  published:  boolean | null
  deleted_at: string | null
}

/**
 * Propiedad publicada, no borrada y del tenant indicado. Es la misma regla que
 * las consultas del sitio público aplican en SQL (.eq('published', true)
 * .is('deleted_at', null) sobre el tenant resuelto).
 */
export function isPropertyPubliclyVisible(p: PropertyVisibilityFields, tenantId: string): boolean {
  return p.tenant_id === tenantId && p.published === true && p.deleted_at == null
}
