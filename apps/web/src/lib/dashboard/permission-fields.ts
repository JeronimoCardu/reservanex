import type { TenantVertical, FoodCapabilities } from '@orderflow/validators'
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
  | 'can_manage_orders'

export interface PermissionField {
  key:         ReceptionistPermissionKey
  label:       string
  description: string
  /**
   * La ruta del módulo que este permiso gobierna. El RUBRO se deriva de
   * MODULE_VERTICALS; una ruta sin entrada ahí es transversal.
   */
  module:      string
  /**
   * Rubros del permiso, SOLO cuando no se pueden derivar de `module`.
   *
   * HOY NO LO USA NINGÚN PERMISO, y así debería quedarse. Existió para
   * can_manage_orders mientras /dashboard/orders no existía y su ruta natural
   * era la bandeja transversal de solicitudes; en 3E-C3C el módulo se creó y el
   * override se borró.
   *
   * Se conserva el mecanismo —no la excepción— porque el caso que lo motivó
   * puede repetirse: un permiso que gobierna un kind de un solo rubro dentro de
   * una ruta transversal. Si vuelve a hacer falta, que sea una decisión
   * explícita y no una taxonomía paralela; hay un test que exige que la lista de
   * overrides esté vacía.
   */
  verticals?:  readonly TenantVertical[]
}

export const PERMISSION_FIELDS: readonly PermissionField[] = [
  {
    key:         'can_assign_conversations',
    label:       'Atender clientes',
    description: 'Puede gestionar atenciones humanas y actualizar datos necesarios para atender clientes.',
    module:      '/dashboard/attention',
  },
  {
    key:         'can_access_settings',
    label:       'Ver datos del negocio',
    description: 'Puede consultar los datos del negocio y el estado de WhatsApp.',
    module:      '/dashboard/settings',
  },
  {
    key:         'can_create_properties',
    label:       'Gestionar propiedades',
    description: 'Puede crear, editar, publicar y administrar propiedades.',
    module:      '/dashboard/properties',
  },
  {
    key:         'can_confirm_reservations',
    label:       'Gestionar reservas y pagos',
    description: 'Puede gestionar reservas, pagos y recibos.',
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
  // Fase 3E-C3B0 — despachar pedidos es OPERACIÓN; administrar la carta es una
  // decisión COMERCIAL. Por eso no cuelga de can_manage_menu.
  //
  // Fase 3E-C3C — ya no lleva `verticals`. Cuando se creó, el módulo que
  // gobierna no existía y su ruta natural era /dashboard/requests, que es
  // transversal: el override era la única forma de decir "esto es
  // gastronómico". Ahora /dashboard/orders existe y está en MODULE_VERTICALS,
  // así que el rubro se DERIVA como en todos los demás permisos.
  {
    key:         'can_manage_orders',
    label:       'Gestionar pedidos',
    description: 'Puede aceptar, rechazar y gestionar pedidos',
    module:      '/dashboard/orders',
  },
]

export type SavedPermissions = Record<ReceptionistPermissionKey, boolean>

/**
 * Un permiso listo para renderizar. `disabledByCapability` es TRUE cuando el
 * permiso está concedido pero la capacidad que lo habilita está apagada: se
 * sigue mostrando para que el owner pueda verlo y apagarlo, marcado como
 * inactivo.
 */
export type VisiblePermissionField = PermissionField & { disabledByCapability: boolean }

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

/**
 * Si el permiso pertenece al rubro del tenant.
 *
 * Primero mira `verticals` si el campo lo declara; si no, deriva de
 * MODULE_VERTICALS a través de su `module`, que es el caso normal. El override
 * existe solo para permisos que gobiernan un kind vertical-specific dentro de una
 * ruta transversal — ver PermissionField.verticals.
 */
export function permissionBelongsToVertical(
  field: PermissionField,
  vertical: TenantVertical,
): boolean {
  const allowed = field.verticals ?? verticalsForRoute(field.module)
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
  capabilities?: FoodCapabilities | null,
): VisiblePermissionField[] {
  return PERMISSION_FIELDS
    .filter((f) => permissionBelongsToVertical(f, vertical) || saved[f.key] === true)
    .filter((f) => permissionEnabledByCapabilities(f, capabilities) || saved[f.key] === true)
    .map((f) => ({
      ...f,
      disabledByCapability: !permissionEnabledByCapabilities(f, capabilities),
    }))
}

// ── Permisos V2 — capacidades del local ─────────────────────────────────────
//
// El rubro dice si el módulo EXISTE; la capacidad, si ESTE negocio lo tiene
// encendido. Un restaurante sin reservas de mesa no debería ver el switch de
// reservas de mesa: el módulo no está en su nav y la ruta da 404.
//
// LA REGLA ANTE UN PERMISO CONCEDIDO Y UNA CAPACIDAD APAGADA
//
// Se muestra igual, marcado como desactivado, y NO se toca el valor guardado.
// Las otras dos salidas eran peores:
//
//   · Ocultarlo dejaría un permiso concedido e invisible — el owner no podría
//     verlo ni apagarlo. Es el mismo problema que ya resolvía la regla de
//     "mostrar si saved = true" para los permisos fuera de rubro.
//   · Apagarlo solo, al desactivar la capacidad, sería una escritura silenciosa
//     sobre los permisos de una persona, y volver a encender la capacidad NO
//     los devolvería. Prefiere perder un click antes que decidir por el owner.
//
// Encender de nuevo la capacidad restaura el switch tal como estaba.

/** Qué capacidad gobierna este permiso, o null si no depende de ninguna. */
export function capabilityForPermission(
  field: PermissionField,
): ((caps: FoodCapabilities) => boolean) | null {
  if (field.key === 'can_manage_table_reservations') return (c) => c.tableReservations
  // Pedidos existe si el local toma pedidos por ALGUNA vía.
  if (field.key === 'can_manage_orders') return (c) => c.delivery || c.takeaway
  return null
}

export function permissionEnabledByCapabilities(
  field: PermissionField,
  capabilities?: FoodCapabilities | null,
): boolean {
  const gate = capabilityForPermission(field)
  // Sin capacidades (tenant no gastronómico) no hay nada que apagar.
  if (gate === null || !capabilities) return true
  return gate(capabilities)
}
