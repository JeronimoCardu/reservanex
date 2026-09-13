import type { TenantVertical } from '@orderflow/validators'
import { verticalsForRoute } from './module-verticals'

// Fase 3E-C3A1 — qué permisos de recepcionista tiene sentido mostrarle a un owner.
//
// ── EL PROBLEMA ─────────────────────────────────────────────────────────────
//
// El diálogo de permisos mostraba los 8 sin filtrar, así que un owner
// inmobiliario veía "Gestionar reservas de mesa" y "Gestionar menú", y un owner
// gastronómico veía "Crear propiedades", "Confirmar reservas" y "Gestionar
// visitas". Cinco toggles que no gobiernan nada en ese tenant.
//
// No era un problema de seguridad —el nav los esconde, las rutas dan 404, las
// actions rechazan y el catálogo lo frena un trigger— pero sí de confianza en la
// UI: un interruptor que no hace nada enseña a desconfiar de los que sí hacen.
//
// ── EL RUBRO NO SE DECLARA ACÁ, SE DERIVA ───────────────────────────────────
//
// Cada permiso declara el MÓDULO que gobierna, que es información real y propia
// de este archivo. El rubro sale de verticalsForRoute(), o sea de
// MODULE_VERTICALS, el mismo mapa que filtra el nav y corta las rutas.
//
// Por eso no hay una segunda taxonomía: el día que un módulo cambie de rubro, o
// que aparezca una vertical nueva, se toca UN mapa y esto lo sigue solo. Si acá
// se repitieran los rubros a mano, la próxima divergencia sería silenciosa.

export type ReceptionistPermissionKey =
  | 'can_assign_conversations'
  | 'can_access_settings'
  | 'can_create_properties'
  | 'can_confirm_reservations'
  | 'can_manage_inquiries'
  | 'can_manage_visits'
  | 'can_manage_table_reservations'
  | 'can_manage_menu'

export interface PermissionField {
  key:         ReceptionistPermissionKey
  label:       string
  description: string
  /**
   * La ruta del módulo que este permiso gobierna. El RUBRO se deriva de
   * MODULE_VERTICALS; una ruta sin entrada ahí es transversal.
   */
  module:      string
}

export const PERMISSION_FIELDS: readonly PermissionField[] = [
  {
    key:         'can_assign_conversations',
    label:       'Asignar conversaciones',
    description: 'Puede auto-asignarse y liberar conversaciones',
    module:      '/dashboard/conversations',
  },
  {
    key:         'can_access_settings',
    label:       'Acceder a Configuración',
    description: 'Puede ver y editar la configuración del tenant',
    module:      '/dashboard/settings',
  },
  {
    key:         'can_create_properties',
    label:       'Crear propiedades',
    description: 'Puede crear y editar propiedades',
    module:      '/dashboard/properties',
  },
  {
    key:         'can_confirm_reservations',
    label:       'Confirmar reservas',
    description: 'Puede confirmar y gestionar reservas',
    module:      '/dashboard/reservations',
  },
  // Fase 3E-B1 — permiso propio. Antes, quien tenía 'Confirmar reservas'
  // también podía gestionar consultas, que es otra cosa.
  //
  // TRANSVERSAL, y no es un descuido: el kind `inquiry` cubre property_inquiry y
  // monthly_rental_inquiry (inmobiliarias) Y general_inquiry (gastronomía). Sale
  // solo de que /dashboard/requests no tiene rubro en MODULE_VERTICALS.
  {
    key:         'can_manage_inquiries',
    label:       'Gestionar consultas',
    description: 'Puede gestionar o descartar consultas recibidas',
    module:      '/dashboard/requests',
  },
  // Fase 3E-B2 — antes, 'Confirmar reservas' habilitaba visitas por herencia.
  {
    key:         'can_manage_visits',
    label:       'Gestionar visitas',
    description: 'Puede agendar, reagendar, completar o cancelar visitas',
    module:      '/dashboard/visits',
  },
  // Fase 3E-C2 — gastronomía. can_confirm_reservations es de alquiler
  // temporal y no aplica a un restaurante.
  {
    key:         'can_manage_table_reservations',
    label:       'Gestionar reservas de mesa',
    description: 'Puede confirmar, modificar, completar, cancelar y marcar ausencias',
    module:      '/dashboard/table-reservations',
  },
  // Fase 3E-C3A1 — el catálogo fija PRECIOS, así que no cuelga de
  // can_create_properties (inmobiliario) ni de la agenda del salón.
  {
    key:         'can_manage_menu',
    label:       'Gestionar menú',
    description: 'Puede crear y editar categorías, productos, precios y disponibilidad del menú',
    module:      '/dashboard/menu',
  },
]

export type SavedPermissions = Record<ReceptionistPermissionKey, boolean>

/**
 * Todos los permisos en false.
 *
 * Se construye desde PERMISSION_FIELDS para que no pueda quedar desalineada: un
 * permiso nuevo entra solo. Antes el estado inicial del diálogo era un objeto
 * literal con `can_confirm_reservations: true` —copiando el viejo DEFAULT de la
 * columna, que en 3E-C3A1 pasó a false—, y un placeholder que concede algo es la
 * misma clase de error que ese default.
 */
export function emptyPermissions(): SavedPermissions {
  return PERMISSION_FIELDS.reduce((acc, f) => {
    acc[f.key] = false
    return acc
  }, {} as SavedPermissions)
}

/** Si el permiso pertenece al rubro del tenant. */
export function permissionBelongsToVertical(
  field: PermissionField,
  vertical: TenantVertical,
): boolean {
  const allowed = verticalsForRoute(field.module)
  return allowed === null || allowed.includes(vertical)
}

/**
 * Los permisos que el diálogo debe RENDERIZAR.
 *
 * Regla: los del rubro, más los que estén fuera de rubro pero actualmente
 * CONCEDIDOS.
 *
 * Esa segunda parte es el punto. Ocultar un permiso que vale true dejaría un
 * "concedido pero invisible": el owner no podría verlo ni apagarlo, y quedaría
 * ahí para siempre. Así que se sigue mostrando hasta que quede en false, y recién
 * entonces desaparece.
 *
 * `saved` son los valores GUARDADOS, no el estado del formulario. Si mirara el
 * estado en vivo, la fila se esfumaría en el mismo click en que se apaga —y
 * volver a encenderla antes de guardar sería imposible. Desaparece en el render
 * siguiente, después de guardar.
 *
 * Solo filtra PRESENTACIÓN: no cambia ningún valor, no apaga nada al abrir el
 * diálogo, y los permisos ocultos conservan lo que tenían.
 */
export function visiblePermissionFields(
  vertical: TenantVertical,
  saved: SavedPermissions,
): PermissionField[] {
  return PERMISSION_FIELDS.filter(
    (f) => permissionBelongsToVertical(f, vertical) || saved[f.key] === true,
  )
}
