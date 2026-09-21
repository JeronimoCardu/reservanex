// Pure, DB-independent tenant-readiness derivation (Fase 8 §2/§9) — turns raw
// signals already computed elsewhere (AutoResponderStatus, DeviceStatus,
// owner/catalog counts) into ONE non-technical checklist + overall state a
// platform admin can read without knowing JWT/RLS/RPC/Supabase/WABA
// internals. Nothing here is persisted — recomputed at read time, same
// rationale as autoresponder-device-health.ts's derived (never stored)
// status. Deliberately NOT the same concept as the existing SetupStatusBadge
// on the tenant detail page (that one tracks the operator-assignment
// lifecycle: not_started/assigned/in_progress/completed/approved/revoked) —
// this module answers "is the tenant itself ready for pilot?", not "did an
// operator finish their assigned task?".
//
// ── Multi-tipo (cierre de onboarding) ───────────────────────────────────────
//
// Hasta acá el checklist exigía "propiedades publicadas" a todo el mundo, así
// que un restaurante NUNCA salía de "Configuración incompleta": no tiene
// propiedades y no va a tenerlas. La condición de "hay algo que ofrecer" es
// del rubro, no del producto:
//
//   real_estate  (Inmobiliaria / Particular)  →  ≥1 propiedad publicada
//   food_service (Gastronomía)                →  ≥1 producto publicado
//
// Y nada más. NO se exige delivery, retiro ni reservas: son capacidades
// opcionales, y un local con las tres apagadas opera perfectamente como carta
// digital con consultas. Exigirlas habría dejado a ese local bloqueado por
// una decisión comercial que es suya.
//
// Owner, IA, WhatsApp AutoResponder y Android son COMPARTIDOS: ReservaNex V2
// atiende WhatsApp por AutoResponder en los dos rubros.
//
// ── Android: verificado por prueba E2E, no por heartbeat ────────────────────
//
// Hasta acá el renglón Android exigía deviceStatus === 'online': actividad en
// los últimos 5 minutos. Eso presuponía un heartbeat periódico, y el único
// emisor de ese heartbeat era MacroDroid, que se retiró en Fase 1B/2A.
// AutoResponder for WA no puede emitir un HTTP sin mensaje entrante. Así que
// un Android perfectamente instalado se veía "incompleto" cinco minutos
// después de cualquier prueba, para siempre.
//
// La pregunta del ONBOARDING es "¿este Android se instaló y autenticó alguna
// vez?", y eso lo responde un hecho persistente: last_device_seen_at, que el
// inbound autenticado escribe (markDeviceSeen, Fase 7). El primer "Hola" que
// vuelve respondido es la prueba. No se vuelve atrás por silencio.
//
// La pregunta del MONITOREO —"¿cuándo fue la última actividad?"— es otra, es
// informativa, y vive en autoresponder-device-health.ts con sus umbrales.
// Acá sólo se muestra como dato secundario.

import type { AutoResponderStatus } from './autoresponder-platform'
import type { DeviceStatus } from './autoresponder-device-health'
import type { TenantKind } from '@orderflow/validators'

export type TenantReadinessState =
  | 'not_started'       // nothing configured yet beyond the tenant row itself
  | 'setup_incomplete'  // owner and/or WhatsApp missing, or Android never verified
  | 'no_catalog'        // fully configured + verified, but nothing to show/sell yet
  | 'ready'              // ready for pilot

// Section 9 wants exactly two visible end states — "Configuración
// incompleta" or "Listo para piloto" — with no technical jargon. The finer
// TenantReadinessState values above stay available for internal use (list
// badges, filtering) without contradicting that simple final label.
export const TENANT_READINESS_LABEL: Record<TenantReadinessState, string> = {
  not_started:      'Configuración incompleta',
  setup_incomplete: 'Configuración incompleta',
  no_catalog:       'Configuración incompleta',
  ready:            'Listo para piloto',
}

export interface TenantSetupChecklistItem {
  ok:    boolean
  label: string
}

export interface TenantSetupChecklist {
  tenant:   TenantSetupChecklistItem
  owner:    TenantSetupChecklistItem
  ai:       TenantSetupChecklistItem
  whatsapp: TenantSetupChecklistItem
  android:  TenantSetupChecklistItem
  /**
   * "Hay algo que ofrecer". Propiedades en inmobiliario, productos en
   * gastronómico. La etiqueta corta que lo nombra viene aparte en
   * `catalogTitle`, para que la ficha no tenga que saber de rubros.
   */
  catalog:      TenantSetupChecklistItem
  catalogTitle: string
  /** Una pista de qué hacer cuando falta el catálogo, en el idioma del rubro. */
  catalogHint:  string
  state:      TenantReadinessState
  stateLabel: string
}

const plural = (n: number, uno: string, varios: string) => (n === 1 ? uno : varios)

/** La señal de catálogo, según el rubro. */
function deriveCatalog(kind: TenantKind, params: {
  publishedPropertyCount: number
  publishedMenuItemCount: number
}): Pick<TenantSetupChecklist, 'catalog' | 'catalogTitle' | 'catalogHint'> {
  if (kind === 'food_business') {
    const n  = params.publishedMenuItemCount
    const ok = n > 0
    return {
      catalogTitle: 'Menú',
      catalog: {
        ok,
        label: ok
          ? `${n} ${plural(n, 'producto publicado', 'productos publicados')}`
          : 'Sin productos publicados',
      },
      catalogHint: 'Menú: lo carga el owner desde su panel una vez que inició sesión.',
    }
  }

  const n  = params.publishedPropertyCount
  const ok = n > 0
  return {
    catalogTitle: 'Propiedades',
    catalog: {
      ok,
      label: ok
        ? `${n} ${plural(n, 'propiedad publicada', 'propiedades publicadas')}`
        : 'Sin propiedades publicadas',
    },
    catalogHint: 'Propiedades: las carga el owner desde su panel una vez que inició sesión.',
  }
}

export function deriveTenantSetupChecklist(params: {
  kind:                   TenantKind
  tenantActive:           boolean  // tenants.status IN ('trial','active')
  ownerActive:            boolean  // >=1 tenant_users row, role=owner, active=true
  aiConfigured:           boolean  // an ai_settings row exists (informational only)
  whatsappStatus:         AutoResponderStatus
  /** Sólo informativo ahora: alimenta "última actividad", no el ✓. */
  deviceStatus:           DeviceStatus
  /** La evidencia persistente: la escribe el inbound autenticado. */
  lastDeviceSeenAt:       string | null
  publishedPropertyCount: number
  publishedMenuItemCount: number
  /** Inyectable para tests; default: ahora. */
  now?:                   Date
}): TenantSetupChecklist {
  const {
    kind, tenantActive, ownerActive, aiConfigured,
    whatsappStatus, deviceStatus, lastDeviceSeenAt,
  } = params

  const whatsappOk = whatsappStatus === 'ready'

  // "Verificado" es un hecho, no un estado derivado: hay un timestamp porque
  // un request con device token válido llegó alguna vez. No se enumeran
  // valores de deviceStatus para deducirlo — si mañana aparece uno nuevo, esto
  // no se rompe en silencio.
  const everSeen  = lastDeviceSeenAt !== null
  const androidOk = everSeen

  const { catalog, catalogTitle, catalogHint } = deriveCatalog(kind, params)
  const catalogOk = catalog.ok

  const tenant: TenantSetupChecklistItem = {
    ok:    tenantActive,
    label: tenantActive ? 'Datos básicos completos' : 'Cliente inactivo o suspendido',
  }
  // "Owner activo" es un tenant_users con role=owner y active=true, es decir,
  // alguien que aceptó la invitación. Tener primary_owner_email cargado es un
  // PROSPECTO y no cuenta: el checklist no se marca por un mail anotado.
  const owner: TenantSetupChecklistItem = {
    ok:    ownerActive,
    label: ownerActive ? 'Owner activo' : 'Sin owner activo todavía',
  }
  // Always ok — ai_settings is genuinely optional (see tenant-provisioning.ts
  // §7 decision: worker code falls back to safe DeepSeek defaults when no
  // row exists), so a missing row is never itself a readiness blocker.
  const ai: TenantSetupChecklistItem = {
    ok:    true,
    label: aiConfigured ? 'Configurada' : 'Configurada (valores por defecto)',
  }
  const whatsapp: TenantSetupChecklistItem = {
    ok:    whatsappOk,
    label: whatsappOk ? 'AutoResponder configurado' : 'AutoResponder sin configurar',
  }
  // "Verificado", no "conectado": conectividad actual no se puede afirmar
  // sin heartbeat. La última actividad va como dato secundario.
  const android: TenantSetupChecklistItem = {
    ok: androidOk,
    label: !everSeen
      ? (deviceStatus === 'not_configured' || deviceStatus === 'disabled'
          ? 'Sin verificar'
          : 'Sin verificar — todavía no llegó ningún mensaje autenticado')
      : `Verificado · última actividad ${relativeTimeEs(lastDeviceSeenAt!, params.now)}`,
  }

  let state: TenantReadinessState
  if (!ownerActive && whatsappStatus === 'not_configured' && !catalogOk) {
    state = 'not_started'
  } else if (!tenantActive || !ownerActive || !whatsappOk || !everSeen) {
    state = 'setup_incomplete'
  } else if (!catalogOk) {
    state = 'no_catalog'
  } else {
    state = 'ready'
  }

  return {
    tenant, owner, ai, whatsapp, android,
    catalog, catalogTitle, catalogHint,
    state, stateLabel: TENANT_READINESS_LABEL[state],
  }
}

/**
 * "hace 3 min" / "hace 2 h" / "hace 5 días". Puro, sin locale ni librería:
 * es un dato secundario y no vale una dependencia.
 */
export function relativeTimeEs(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'recién'
  const min = Math.floor(ms / 60_000)
  if (min < 1)  return 'recién'
  if (min < 60) return `hace ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24)   return `hace ${h} h`
  const d = Math.floor(h / 24)
  return `hace ${d} día${d === 1 ? '' : 's'}`
}
