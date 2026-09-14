import type { TenantVertical } from '@orderflow/validators'

// Fase 3E-C3A2 — copy y formato del sitio público, puros y testeables.
//
// Viven fuera del componente y de la página para que se puedan probar sin
// renderizar (el entorno de vitest es 'node', sin jsdom) y para que el título de
// la metadata y el del render no puedan divergir: los dos leen de acá.

/**
 * El precio de un item de la carta pública.
 *
 * 0 se muestra como "Gratis": es lo que significa y es lo que el cliente
 * entiende. El valor canónico en la base sigue siendo 0.00 — la palabra es
 * presentación, el dato no cambia. Cualquier otro monto va con la moneda del
 * TENANT, nunca con una calculada en el browser.
 */
export function formatPublicPrice(value: number, currency: string): string {
  if (value === 0) return 'Gratis'
  const n = new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
  return `${currency} ${n}`
}

/**
 * El título del sitio público, por rubro.
 *
 * Un restaurante NO puede decir "| Propiedades": era lo que pasaba cuando la
 * página no ramificaba y generateMetadata asumía inmobiliaria.
 */
export function publicSiteTitle(displayName: string, vertical: TenantVertical): string {
  return vertical === 'food_service'
    ? `${displayName} | Menú`
    : `${displayName} | Propiedades`
}

/** La descripción por defecto cuando el tenant no configuró una propia. */
export function publicSiteDescription(displayName: string, vertical: TenantVertical): string {
  return vertical === 'food_service'
    ? `Carta de ${displayName}`
    : `Propiedades de ${displayName}`
}
