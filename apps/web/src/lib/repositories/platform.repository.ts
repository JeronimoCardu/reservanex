import { createAdminClient } from '@orderflow/supabase/admin'
import type { TenantRow, PlatformUserRow } from '@orderflow/types'
import { isSafePublicSlug, DEFAULT_WORKSPACE_NAME } from '@/lib/tenant-provisioning'

// All platform repository functions use the admin client and apply
// authorization checks at the action layer, not via RLS.
// Platform users (SA/Seller) perform writes that RLS would otherwise block.

export type TenantWithSeller = TenantRow & {
  seller?: { id: string; name: string; email: string } | null
}

export type PlatformStats = {
  totalSellers: number
  totalTenants: number
  pendingReview: number
  readyToDeliver: number
  delivered: number
  activeOrTrial: number
}

// ─── Tenants ──────────────────────────────────────────────────────────────────

export async function listAllTenants(): Promise<TenantWithSeller[]> {
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('tenants')
    .select('*, seller:assigned_seller_id(id, name, email)')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as TenantWithSeller[]
}

export async function listSellerTenants(sellerId: string): Promise<TenantWithSeller[]> {
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('tenants')
    .select('*, seller:assigned_seller_id(id, name, email)')
    .eq('assigned_seller_id', sellerId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as TenantWithSeller[]
}

export async function getTenantById(id: string): Promise<TenantWithSeller | null> {
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('tenants')
    .select('*, seller:assigned_seller_id(id, name, email)')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return data as unknown as TenantWithSeller | null
}

export async function createTenant(input: {
  name: string
  slug: string
  country: string
  language: string
  currency: string
  timezone: string
  activate_immediately: boolean
  onboarding_notes: string | null
  primary_owner_name: string | null
  primary_owner_email: string | null
  primary_owner_phone: string | null
  assigned_seller_id: string | null
  created_by_seller_id: string | null
}): Promise<TenantRow> {
  const admin = createAdminClient()

  // Fase 8 §11 — auto-provision the public site slug in the SAME insert
  // whenever the internal slug is itself a safe public slug (it almost
  // always is: same charset, just a looser length floor). If it happens to
  // collide with a reserved word or fail the stricter public-slug format,
  // leave public_slug unset (NULL, public_site_enabled defaults false)
  // rather than attempting an insert the DB's own CHECK constraint would
  // reject outright — the owner can still set one later from
  // /dashboard/settings/public-site, same mechanism as today.
  const publicSlugCandidate = isSafePublicSlug(input.slug) ? input.slug : null

  const { data, error } = await admin
    .from('tenants')
    .insert({
      name:                input.name,
      slug:                input.slug,
      country:             input.country,
      language:            input.language,
      currency:            input.currency,
      timezone:            input.timezone,
      status:              input.activate_immediately ? 'active' : 'trial',
      onboarding_status:   'pending_review',
      onboarding_started_at: new Date().toISOString(),
      assigned_seller_id:  input.assigned_seller_id,
      primary_owner_name:  input.primary_owner_name,
      primary_owner_email: input.primary_owner_email,
      primary_owner_phone: input.primary_owner_phone,
      onboarding_notes:    input.onboarding_notes,
      ...(publicSlugCandidate ? { public_slug: publicSlugCandidate, public_site_enabled: true } : {}),
    })
    .select()
    .single()

  if (error) throw new Error(error.message)

  // If a seller is assigned, also create the seller_clients entry
  // so the existing RLS seller visibility policy continues to work.
  if (input.assigned_seller_id) {
    await admin
      .from('seller_clients')
      .insert({
        seller_id:             input.assigned_seller_id,
        tenant_id:             data.id,
        commission_percentage: 0,
        active:                true,
      })
      .select()
      .maybeSingle()
    // Non-fatal: seller_clients entry may already exist if slug was reused
  }

  // Fase 8 §6 — default workspace. Confirmed via audit that no code path
  // requires a workspace to exist (workspace_id is nullable everywhere,
  // FK-consistency triggers short-circuit on NULL) — this is a best-effort
  // convenience so the owner never has to create internal structure before
  // using the CRM, matching the workspaces table's own (previously
  // unimplemented) doc comment. Never fails tenant creation itself.
  await createDefaultWorkspace(data.id)

  return data
}

// Idempotent: safe to call again for the same tenant (e.g. onboarding
// retried) — checks for an existing row by (tenant_id, name) first rather
// than relying solely on a DB constraint, matching the same defensive
// check-then-insert pattern already used for AutoResponder account
// creation (apps/web/src/actions/platform-autoresponder.ts).
export async function createDefaultWorkspace(tenantId: string): Promise<void> {
  const admin = createAdminClient()

  const { data: existing } = await admin
    .from('workspaces')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('name', DEFAULT_WORKSPACE_NAME)
    .maybeSingle()

  if (existing) return

  const { error } = await admin
    .from('workspaces')
    .insert({ tenant_id: tenantId, name: DEFAULT_WORKSPACE_NAME, active: true })

  if (error) {
    console.warn('[platform.repository] createDefaultWorkspace failed (non-fatal)', { tenantId, error: error.message })
  }
}

export async function updateTenantBasic(
  tenantId: string,
  patch: {
    name?: string
    onboarding_notes?: string | null
    primary_owner_name?: string | null
    primary_owner_email?: string | null
    primary_owner_phone?: string | null
  },
): Promise<void> {
  const admin = createAdminClient()

  const { error } = await admin
    .from('tenants')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', tenantId)
    .is('deleted_at', null)

  if (error) throw new Error(error.message)
}

export async function updateTenantOnboardingStatus(
  tenantId:          string,
  onboardingStatus:  string,
  updatedBy:         string,
): Promise<void> {
  const admin = createAdminClient()
  const now   = new Date().toISOString()

  const extra: Record<string, unknown> = { updated_at: now }

  if (onboardingStatus === 'approved')          { extra.approved_at = now; extra.approved_by = updatedBy }
  if (onboardingStatus === 'ready_to_deliver')  { extra.ready_to_deliver_at = now }
  if (onboardingStatus === 'delivered')         { extra.delivered_at = now; extra.delivered_by = updatedBy }
  if (onboardingStatus === 'rejected')          { extra.rejected_at = now; extra.rejected_by = updatedBy }

  const { error } = await admin
    .from('tenants')
    .update({ onboarding_status: onboardingStatus, ...extra })
    .eq('id', tenantId)

  if (error) throw new Error(error.message)
}

export async function updateTenantStatus(
  tenantId: string,
  status:   'trial' | 'active' | 'suspended' | 'cancelled' | 'churned',
): Promise<void> {
  const admin = createAdminClient()

  const { error } = await admin
    .from('tenants')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', tenantId)

  if (error) throw new Error(error.message)
}

export async function reassignTenantSeller(
  tenantId:      string,
  newSellerId:   string,
  oldSellerId:   string | null,
): Promise<void> {
  const admin = createAdminClient()
  const now   = new Date().toISOString()

  // Deactivate old seller_clients row
  if (oldSellerId) {
    await admin
      .from('seller_clients')
      .update({ active: false, updated_at: now })
      .eq('tenant_id', tenantId)
      .eq('seller_id', oldSellerId)
  }

  // Upsert new seller_clients row
  await admin
    .from('seller_clients')
    .upsert({
      seller_id:             newSellerId,
      tenant_id:             tenantId,
      commission_percentage: 0,
      active:                true,
      updated_at:            now,
    }, { onConflict: 'seller_id,tenant_id' })

  // Update denormalized column
  const { error } = await admin
    .from('tenants')
    .update({ assigned_seller_id: newSellerId, updated_at: now })
    .eq('id', tenantId)

  if (error) throw new Error(error.message)
}

export async function markOwnerInvited(
  tenantId:  string,
  invitedBy: string,
): Promise<void> {
  const admin = createAdminClient()

  const { error } = await admin
    .from('tenants')
    .update({
      owner_invited_at: new Date().toISOString(),
      owner_invited_by: invitedBy,
      updated_at:       new Date().toISOString(),
    })
    .eq('id', tenantId)

  if (error) throw new Error(error.message)
}

export async function getPlatformStats(): Promise<PlatformStats> {
  const admin = createAdminClient()

  const [sellers, tenants] = await Promise.all([
    admin.from('platform_users').select('id', { count: 'exact', head: true }).eq('role', 'seller').eq('active', true),
    admin.from('tenants').select('status, onboarding_status').is('deleted_at', null),
  ])

  const ts = tenants.data ?? []
  return {
    totalSellers:    sellers.count ?? 0,
    totalTenants:    ts.length,
    pendingReview:   ts.filter((t) => t.onboarding_status === 'pending_review').length,
    readyToDeliver:  ts.filter((t) => t.onboarding_status === 'ready_to_deliver').length,
    delivered:       ts.filter((t) => t.onboarding_status === 'delivered').length,
    activeOrTrial:   ts.filter((t) => t.status === 'active' || t.status === 'trial').length,
  }
}

// ─── Platform users / Sellers ─────────────────────────────────────────────────

export async function listSellers(): Promise<PlatformUserRow[]> {
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('platform_users')
    .select('*')
    .eq('role', 'seller')
    .order('created_at', { ascending: false })

  if (error) throw new Error(error.message)
  return data ?? []
}

export async function getPlatformUserById(id: string): Promise<PlatformUserRow | null> {
  const admin = createAdminClient()

  const { data } = await admin
    .from('platform_users')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  return data
}

export async function updateSellerActive(sellerId: string, active: boolean): Promise<void> {
  const admin = createAdminClient()

  const { error } = await admin
    .from('platform_users')
    .update({ active, updated_at: new Date().toISOString() })
    .eq('id', sellerId)
    .eq('role', 'seller')

  if (error) throw new Error(error.message)
}

export async function slugExists(slug: string, excludeId?: string): Promise<boolean> {
  const admin = createAdminClient()

  let q = admin
    .from('tenants')
    .select('id', { count: 'exact', head: true })
    .eq('slug', slug)
    .is('deleted_at', null)

  if (excludeId) q = q.neq('id', excludeId)

  const { count } = await q
  return (count ?? 0) > 0
}

export async function updateTenantPlan(
  tenantId:         string,
  planCode:         string,
  planLabel:        string,
  maxOwners:        number,
  maxReceptionists: number,
  maxTotalUsers:    number,
): Promise<void> {
  const admin = createAdminClient()

  const { error } = await admin
    .from('tenants')
    .update({
      plan_code:         planCode,
      plan_label:        planLabel,
      max_owners:        maxOwners,
      max_receptionists: maxReceptionists,
      max_users:         maxTotalUsers,
      updated_at:        new Date().toISOString(),
    })
    .eq('id', tenantId)
    .is('deleted_at', null)

  if (error) throw new Error(error.message)
}

export async function updateTenantSetupStatus(
  tenantId:    string,
  setupStatus: string,
): Promise<void> {
  const admin = createAdminClient()

  const { error } = await admin
    .from('tenants')
    .update({ setup_status: setupStatus, updated_at: new Date().toISOString() })
    .eq('id', tenantId)

  if (error) throw new Error(error.message)
}

// ─── Operators ────────────────────────────────────────────────────────────────

export async function listOperators(): Promise<PlatformUserRow[]> {
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('platform_users')
    .select('*')
    .eq('role', 'operator')
    .eq('active', true)
    .order('name', { ascending: true })

  if (error) throw new Error(error.message)
  return data ?? []
}

// ─── Setup assignments ────────────────────────────────────────────────────────

export type SetupAssignmentRow = {
  id:           string
  tenant_id:    string
  operator_id:  string
  status:       string
  assigned_by:  string | null
  assigned_at:  string
  started_at:   string | null
  completed_at: string | null
  completed_by: string | null
  revoked_at:   string | null
  revoked_by:   string | null
  notes:        string | null
  created_at:   string
  updated_at:   string
}

export type SetupAssignmentWithRelations = SetupAssignmentRow & {
  tenant:   { id: string; name: string; slug: string; setup_status: string | null; plan_code: string | null; plan_label: string | null; onboarding_status: string | null; status: string | null } | null
  operator: { id: string; name: string; email: string } | null
}

export async function listSetupAssignmentsByTenant(
  tenantId: string,
): Promise<SetupAssignmentWithRelations[]> {
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('tenant_setup_assignments')
    .select('*, tenant:tenant_id(id, name, slug, setup_status, plan_code, plan_label, onboarding_status, status), operator:operator_id(id, name, email)')
    .eq('tenant_id', tenantId)
    .order('assigned_at', { ascending: false })

  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as SetupAssignmentWithRelations[]
}

export async function listSetupAssignmentsByOperator(
  operatorId: string,
): Promise<SetupAssignmentWithRelations[]> {
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('tenant_setup_assignments')
    .select('*, tenant:tenant_id(id, name, slug, setup_status, plan_code, plan_label, onboarding_status, status), operator:operator_id(id, name, email)')
    .eq('operator_id', operatorId)
    .order('assigned_at', { ascending: false })

  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as SetupAssignmentWithRelations[]
}

export async function createSetupAssignment(input: {
  tenantId:    string
  operatorId:  string
  assignedBy:  string
  notes?:      string | null
}): Promise<SetupAssignmentRow> {
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('tenant_setup_assignments')
    .insert({
      tenant_id:   input.tenantId,
      operator_id: input.operatorId,
      assigned_by: input.assignedBy,
      notes:       input.notes ?? null,
      status:      'active',
    })
    .select()
    .single()

  if (error) throw new Error(error.message)
  return data as SetupAssignmentRow
}

export async function revokeSetupAssignment(
  assignmentId: string,
  revokedBy:    string,
): Promise<void> {
  const admin = createAdminClient()
  const now   = new Date().toISOString()

  const { error } = await admin
    .from('tenant_setup_assignments')
    .update({ status: 'revoked', revoked_at: now, revoked_by: revokedBy, updated_at: now })
    .eq('id', assignmentId)
    .eq('status', 'active')

  if (error) throw new Error(error.message)
}

export async function completeSetupAssignment(
  assignmentId: string,
  completedBy:  string,
): Promise<void> {
  const admin = createAdminClient()
  const now   = new Date().toISOString()

  const { error } = await admin
    .from('tenant_setup_assignments')
    .update({ status: 'completed', completed_at: now, completed_by: completedBy, updated_at: now })
    .eq('id', assignmentId)
    .eq('status', 'active')

  if (error) throw new Error(error.message)
}

// ─── Impersonation / Setup sessions ──────────────────────────────────────────

export type ImpersonationSessionRow = {
  id:               string
  target_tenant_id: string
  started_at:       string
  ended_at:         string | null
}

export async function createImpersonationSession(
  platformUserId: string,
  targetTenantId: string,
  reason:         string,
): Promise<{ id: string }> {
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('impersonation_sessions')
    .insert({ platform_user_id: platformUserId, target_tenant_id: targetTenantId, reason })
    .select('id')
    .single()

  if (error || !data) throw new Error(error?.message ?? 'Failed to create impersonation session')
  return { id: data.id }
}

export async function endImpersonationSession(sessionId: string): Promise<void> {
  const admin = createAdminClient()

  const { error } = await admin
    .from('impersonation_sessions')
    .update({ ended_at: new Date().toISOString() })
    .eq('id', sessionId)
    .is('ended_at', null)

  if (error) throw new Error(error.message)
}

export async function closeSetupSessionsForTenant(tenantId: string): Promise<void> {
  const admin = createAdminClient()

  const { error } = await admin
    .from('impersonation_sessions')
    .update({ ended_at: new Date().toISOString() })
    .eq('target_tenant_id', tenantId)
    .is('ended_at', null)

  if (error) throw new Error(error.message)
}

export async function closeSetupSessionsForTenantOperator(
  tenantId:   string,
  operatorId: string,
): Promise<void> {
  const admin = createAdminClient()

  const { error } = await admin
    .from('impersonation_sessions')
    .update({ ended_at: new Date().toISOString() })
    .eq('target_tenant_id', tenantId)
    .eq('platform_user_id', operatorId)
    .is('ended_at', null)

  if (error) throw new Error(error.message)
}

export async function getActiveImpersonationSession(
  platformUserId: string,
): Promise<ImpersonationSessionRow | null> {
  const admin = createAdminClient()

  const { data } = await admin
    .from('impersonation_sessions')
    .select('id, target_tenant_id, started_at, ended_at')
    .eq('platform_user_id', platformUserId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return data
}

export async function getActiveOperatorAssignment(
  operatorId: string,
  tenantId:   string,
): Promise<{ id: string } | null> {
  const admin = createAdminClient()

  const { data } = await admin
    .from('tenant_setup_assignments')
    .select('id')
    .eq('operator_id', operatorId)
    .eq('tenant_id', tenantId)
    .in('status', ['active', 'completed'])
    .is('revoked_at', null)
    .limit(1)
    .maybeSingle()

  return data
}

export async function getTenantUserCounts(tenantId: string): Promise<{
  owners:       number
  receptionists: number
  total:        number
}> {
  const admin = createAdminClient()

  const { data } = await admin
    .from('tenant_users')
    .select('role')
    .eq('tenant_id', tenantId)
    .eq('active', true)

  const rows = data ?? []
  return {
    owners:        rows.filter((r) => r.role === 'owner').length,
    receptionists: rows.filter((r) => r.role === 'receptionist').length,
    total:         rows.length,
  }
}

// Raw signals for the Fase 8 §2/§9 tenant-readiness checklist — one round
// trip per table, deliberately NOT joined into a single query since these
// four tables have no FK relationship the query builder could traverse in
// one shot. Callers (platform-tenant-setup.ts) run the pure derivation
// (deriveTenantSetupChecklist) on top of this; this function only fetches.
export async function getTenantSetupSignals(tenantId: string): Promise<{
  ownerActive:            boolean
  aiConfigured:           boolean
  whatsapp:               {
    phone_number:       string
    active:              boolean
    has_device_token:    boolean
    has_macrodroid_url:  boolean
  } | null
  lastDeviceSeenAt:       string | null
  publishedPropertyCount: number
}> {
  const admin = createAdminClient()

  const [ownersResult, aiResult, whatsappResult, propertiesResult] = await Promise.all([
    admin.from('tenant_users').select('id').eq('tenant_id', tenantId).eq('role', 'owner').eq('active', true).limit(1),
    admin.from('ai_settings').select('id').eq('tenant_id', tenantId).maybeSingle(),
    admin
      .from('whatsapp_accounts')
      .select('phone_number, active, inbound_token_hash, macrodroid_webhook_url, last_device_seen_at')
      .eq('tenant_id', tenantId)
      .eq('provider', 'autoresponder')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin.from('properties').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('published', true).is('deleted_at', null),
  ])

  const whatsappRow = whatsappResult.data

  return {
    ownerActive:            (ownersResult.data?.length ?? 0) > 0,
    aiConfigured:           Boolean(aiResult.data),
    whatsapp: whatsappRow
      ? {
          phone_number:      whatsappRow.phone_number,
          active:             whatsappRow.active,
          has_device_token:   Boolean(whatsappRow.inbound_token_hash),
          has_macrodroid_url: Boolean(whatsappRow.macrodroid_webhook_url),
        }
      : null,
    lastDeviceSeenAt:       whatsappRow?.last_device_seen_at ?? null,
    publishedPropertyCount: propertiesResult.count ?? 0,
  }
}
