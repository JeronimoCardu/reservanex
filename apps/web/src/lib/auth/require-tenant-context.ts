import { redirect } from 'next/navigation'
import { createClient } from '@orderflow/supabase/server'
import { createAdminClient } from '@orderflow/supabase/admin'
import { parseAccessTokenClaims } from '@/lib/claims'
import type { TenantRole } from '@orderflow/types'
import { tenantVerticalSchema, type TenantVertical } from '@orderflow/validators'

export type AccessMode = 'tenant_user' | 'setup_operator'

export type TenantContext = {
  userId:                  string
  tenantId:                string
  role:                    TenantRole
  workspaceIds:            string[] | null
  canAccessSettings:       boolean
  canAssignConversations:  boolean
  canCreateProperties:     boolean
  canConfirmReservations:  boolean
  canManageInquiries:      boolean
  canManageVisits:         boolean
  canManageTableReservations: boolean
  canManageMenu:           boolean
  // Fase 3E-C3A1 — el rubro del tenant. Decide qué MÓDULOS existen para este
  // tenant, que es un eje distinto de los permisos de arriba: esos deciden qué
  // puede hacer ESTE USUARIO dentro de un módulo que ya existe.
  vertical:                TenantVertical
  accessMode:              AccessMode
}

// El rubro del tenant.
//
// La base YA lo garantiza, verificado contra el proyecto deployado:
//
//   tenants.vertical  TEXT  NOT NULL  DEFAULT 'real_estate'
//   CHECK (vertical = ANY (ARRAY['real_estate'::text, 'food_service'::text]))
//
// (TEXT + CHECK y no un enum de PG, como el resto de las taxonomías del repo,
// para que los tipos generados no cambien de forma en cada valor nuevo.)
//
// O sea que para una fila real este fallback es INALCANZABLE: no puede ser NULL
// ni traer otro valor. Se mantiene igual porque la firma recibe `unknown` —
// supabase-js entrega TEXT como string sin validar el CHECK— y porque un fallback
// que nunca se ejecuta cuesta nada, mientras que su ausencia obligaría a un `as`.
//
// Cae en 'real_estate', que además es el propio DEFAULT de la columna: si algún
// día se agregara una vertical nueva sin actualizar tenantVerticalSchema, ese
// tenant vería los módulos inmobiliarios en vez de todos. Falla cerrado hacia el
// rubro histórico, no hacia el acceso total.
function parseVertical(raw: unknown): TenantVertical {
  const parsed = tenantVerticalSchema.safeParse(raw)
  return parsed.success ? parsed.data : 'real_estate'
}

// Tenant statuses that allow normal CRM access.
const ACTIVE_STATUSES = new Set(['trial', 'active'])

// Devuelve el rubro, que ya viene gratis en esta query: el acceso al tenant se
// verifica en todos los caminos, así que es el único lugar donde leerlo sin
// agregar un roundtrip.
async function checkTenantAccess(tenantId: string): Promise<TenantVertical> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('tenants')
    .select('status, vertical')
    .eq('id', tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!data || !ACTIVE_STATUSES.has(data.status)) {
    redirect('/account-suspended')
  }

  return parseVertical(data.vertical)
}

export async function requireTenantContext(): Promise<TenantContext> {
  const supabase = await createClient()

  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) redirect('/login')

  // Belt-and-suspenders: middleware handles this redirect for most requests,
  // but Server Actions and direct RSC invocations bypass the middleware.
  if (!user.email_confirmed_at) redirect('/auth/confirm-email')

  const { data: { session } } = await supabase.auth.getSession()
  const claims = parseAccessTokenClaims(session?.access_token)

  if (!claims) redirect('/login')

  // ── Platform user in setup mode ───────────────────────────────────────────
  // SA or operator with an active impersonation session can enter the CRM.
  if (claims.user_type === 'platform_user') {
    if (claims.role !== 'super_admin' && claims.role !== 'operator') {
      // Sellers and unknown roles have no CRM access.
      redirect('/platform')
    }

    const admin = createAdminClient()

    // Find the active impersonation session for this user.
    const { data: imp } = await admin
      .from('impersonation_sessions')
      .select('id, target_tenant_id')
      .eq('platform_user_id', user.id)
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!imp) {
      // Platform user without active session → back to platform.
      redirect('/platform')
    }

    // For operators (not SA): verify assignment is valid AND tenant is still in setup.
    if (claims.role === 'operator') {
      const { data: assignment } = await admin
        .from('tenant_setup_assignments')
        .select('id')
        .eq('tenant_id', imp.target_tenant_id)
        .eq('operator_id', user.id)
        .in('status', ['active', 'completed'])
        .is('revoked_at', null)
        .limit(1)
        .maybeSingle()

      if (!assignment) {
        await admin
          .from('impersonation_sessions')
          .update({ ended_at: new Date().toISOString() })
          .eq('id', imp.id)
        redirect('/platform/setup')
      }

      // Operators are blocked once onboarding_status moves to ready_to_deliver or delivered,
      // or when the tenant is live (status = 'active').
      const { data: tenantState } = await admin
        .from('tenants')
        .select('status, onboarding_status, deleted_at, vertical')
        .eq('id', imp.target_tenant_id)
        .maybeSingle()

      const SETUP_DONE_ONBOARDING = new Set(['ready_to_deliver', 'delivered'])

      if (
        !tenantState ||
        tenantState.deleted_at != null ||
        tenantState.status !== 'trial' ||
        SETUP_DONE_ONBOARDING.has(tenantState.onboarding_status ?? '')
      ) {
        await admin
          .from('impersonation_sessions')
          .update({ ended_at: new Date().toISOString() })
          .eq('id', imp.id)
        redirect('/platform/setup')
      }

      return {
        userId:                  user.id,
        tenantId:                imp.target_tenant_id,
        role:                    'owner',
        workspaceIds:            null,
        canAccessSettings:       true,
        canAssignConversations:  false,
        canCreateProperties:     true,
        canConfirmReservations:  false,
        canManageInquiries:      false,
        canManageVisits:         false,
        canManageTableReservations: false,
        canManageMenu:           false,
        vertical:                parseVertical(tenantState.vertical),
        accessMode:              'setup_operator',
      }
    }

    // SA: verify the tenant is accessible (not suspended/cancelled/deleted).
    const saVertical = await checkTenantAccess(imp.target_tenant_id)

    return {
      userId:                  user.id,
      tenantId:                imp.target_tenant_id,
      role:                    'owner',
      workspaceIds:            null,
      canAccessSettings:       true,
      canAssignConversations:  false,
      canCreateProperties:     true,
      canConfirmReservations:  false,
      canManageInquiries:      false,
      canManageVisits:         false,
      canManageTableReservations: false,
      canManageMenu:           false,
      vertical:                saVertical,
      accessMode:              'setup_operator',
    }
  }

  // ── Normal tenant user ────────────────────────────────────────────────────
  if (claims.user_type !== 'tenant_user') redirect('/login')

  // Block suspended/cancelled tenants from accessing the CRM.
  const vertical = await checkTenantAccess(claims.tenant_id)

  // Owners always have all permissions — no extra DB query needed.
  if (claims.role === 'owner') {
    return {
      userId:                  user.id,
      tenantId:                claims.tenant_id,
      role:                    claims.role,
      workspaceIds:            claims.workspace_ids,
      canAccessSettings:       true,
      canAssignConversations:  true,
      canCreateProperties:     true,
      canConfirmReservations:  true,
      canManageInquiries:      true,
      canManageVisits:         true,
      canManageTableReservations: true,
      canManageMenu:           true,
      vertical,
      accessMode:              'tenant_user',
    }
  }

  // Receptionists: fetch granular permissions from DB.
  const { data: perms, error: permsErr } = await supabase
    .from('tenant_users')
    .select('can_access_settings, can_assign_conversations, can_create_properties, can_confirm_reservations, can_manage_inquiries, can_manage_visits, can_manage_table_reservations, can_manage_menu')
    .eq('id', user.id)
    .eq('tenant_id', claims.tenant_id)
    .maybeSingle()

  if (permsErr) {
    console.warn('[requireTenantContext] perms lookup error', { code: permsErr.code, message: permsErr.message })
  }

  return {
    userId:                  user.id,
    tenantId:                claims.tenant_id,
    role:                    claims.role,
    workspaceIds:            claims.workspace_ids,
    canAccessSettings:       perms?.can_access_settings       ?? false,
    canAssignConversations:  perms?.can_assign_conversations  ?? false,
    canCreateProperties:     perms?.can_create_properties     ?? false,
    canConfirmReservations:  perms?.can_confirm_reservations  ?? false,
    canManageInquiries:      perms?.can_manage_inquiries      ?? false,
    canManageVisits:         perms?.can_manage_visits         ?? false,
    canManageTableReservations: perms?.can_manage_table_reservations ?? false,
    canManageMenu:           perms?.can_manage_menu           ?? false,
    vertical,
    accessMode:              'tenant_user',
  }
}

// Minimal helper for pages that must render even when the tenant is suspended
// (e.g. /dashboard/account-suspended). Only confirms the user is an
// authenticated tenant_user — intentionally does NOT check tenant.status.
export async function requireTenantUser(): Promise<{ userId: string; tenantId: string }> {
  const supabase = await createClient()

  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) redirect('/login')
  if (!user.email_confirmed_at) redirect('/auth/confirm-email')

  const { data: { session } } = await supabase.auth.getSession()
  const claims = parseAccessTokenClaims(session?.access_token)

  if (!claims || claims.user_type !== 'tenant_user') redirect('/login')

  return { userId: user.id, tenantId: claims.tenant_id }
}
