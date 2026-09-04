'use server'

import { revalidatePath } from 'next/cache'
import { requireSuperAdmin } from '@/lib/auth/require-platform-context'
import { createAdminClient } from '@orderflow/supabase/admin'
import { createClient } from '@orderflow/supabase/server'
import { purgeTenantWithStorage } from '@/lib/repositories/tenant-storage.repository'
import { isGlobalTenantResetAllowed } from '@/lib/global-tenant-reset'
import type { ActionResult } from '@/lib/action-result'

// ── Types ─────────────────────────────────────────────────────────────────────

export type CleanupOverview = {
  tenants:       number
  sellers:       number
  tenantUsers:   number
  contacts:      number
  conversations: number
  messages:      number
  messageQueue:  number
  properties:    number
  whatsappAccts: number
  auditLogs:     number
  aiUsageLogs:   number
}

export type TenantDeletionCounts = {
  tenant_users:                    number
  contacts:                        number
  conversations:                   number
  messages:                        number
  message_queue:                   number
  properties:                      number
  property_images:                 number
  units:                           number
  unit_images:                     number
  reservations:                    number
  reservation_events:              number
  availability_blocks:             number
  property_availability_blocks:    number
  conversation_reservation_drafts: number
  whatsapp_accounts:               number
  ai_settings:                     number
  tasks:                           number
  notes:                           number
  documents:                       number
  notifications:                   number
  ai_usage_log:                    number
  audit_logs:                      number
  impersonation_sessions:          number
}

export type TenantDeletionPreview = {
  id:               string
  name:             string
  slug:             string
  status:           string
  onboardingStatus: string
  counts:           TenantDeletionCounts
}

export type CleanupTenantRow = {
  id:               string
  name:             string
  slug:             string
  status:           string
  onboarding_status: string
  deleted_at:       string | null
}

export type CleanupSellerRow = {
  id:     string
  name:   string
  email:  string
  active: boolean
}

// ── Internal helper ────────────────────────────────────────────────────────────

// Casts admin client for RPC calls to functions not yet in the generated types
type UntypedRpc = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{
    data:  unknown
    error: null | { message: string }
  }>
}
function asRpc(admin: ReturnType<typeof createAdminClient>): UntypedRpc {
  return admin as unknown as UntypedRpc
}

// ── Read actions ──────────────────────────────────────────────────────────────

export async function getCleanupOverviewAction(): Promise<ActionResult<CleanupOverview>> {
  await requireSuperAdmin()
  const admin = createAdminClient()

  const [
    tenants, sellers, tenantUsers, contacts, conversations,
    messages, queue, props, wa, audit, ai,
  ] = await Promise.all([
    admin.from('tenants').select('*', { count: 'exact', head: true }),
    admin.from('platform_users').select('*', { count: 'exact', head: true }).eq('role', 'seller'),
    admin.from('tenant_users').select('*', { count: 'exact', head: true }),
    admin.from('contacts').select('*', { count: 'exact', head: true }),
    admin.from('conversations').select('*', { count: 'exact', head: true }),
    admin.from('messages').select('*', { count: 'exact', head: true }),
    admin.from('message_queue').select('*', { count: 'exact', head: true }),
    admin.from('properties').select('*', { count: 'exact', head: true }),
    admin.from('whatsapp_accounts').select('*', { count: 'exact', head: true }),
    admin.from('audit_logs').select('*', { count: 'exact', head: true }),
    admin.from('ai_usage_log').select('*', { count: 'exact', head: true }),
  ])

  return {
    success: true,
    data: {
      tenants:       tenants.count ?? 0,
      sellers:       sellers.count ?? 0,
      tenantUsers:   tenantUsers.count ?? 0,
      contacts:      contacts.count ?? 0,
      conversations: conversations.count ?? 0,
      messages:      messages.count ?? 0,
      messageQueue:  queue.count ?? 0,
      properties:    props.count ?? 0,
      whatsappAccts: wa.count ?? 0,
      auditLogs:     audit.count ?? 0,
      aiUsageLogs:   ai.count ?? 0,
    },
  }
}

export async function listTenantsForCleanupAction(): Promise<ActionResult<CleanupTenantRow[]>> {
  await requireSuperAdmin()
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('tenants')
    .select('id, name, slug, status, onboarding_status, deleted_at')
    .order('created_at', { ascending: false })

  if (error) return { success: false, error: error.message }
  return { success: true, data: (data ?? []) as CleanupTenantRow[] }
}

export async function listSellersForCleanupAction(): Promise<ActionResult<CleanupSellerRow[]>> {
  await requireSuperAdmin()
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('platform_users')
    .select('id, name, email, active')
    .eq('role', 'seller')
    .order('created_at', { ascending: false })

  if (error) return { success: false, error: error.message }
  return { success: true, data: (data ?? []) as CleanupSellerRow[] }
}

export async function getTenantDeletionPreviewAction(
  tenantId: string,
): Promise<ActionResult<TenantDeletionPreview>> {
  await requireSuperAdmin()
  const admin = createAdminClient()

  const { data: tenant } = await admin
    .from('tenants')
    .select('id, name, slug, status, onboarding_status')
    .eq('id', tenantId)
    .maybeSingle()

  if (!tenant) return { success: false, error: 'Tenant no encontrado.' }

  // IDs needed for subquery-dependent counts
  const [propsRes, unitsRes] = await Promise.all([
    admin.from('properties').select('id').eq('tenant_id', tenantId),
    admin.from('units').select('id').eq('tenant_id', tenantId),
  ])
  const propIds = propsRes.data?.map((p) => p.id) ?? []
  const unitIds = unitsRes.data?.map((u) => u.id) ?? []

  const c = (n: number | null) => n ?? 0
  const [
    tenantUserCount, contactCount, convCount, msgCount, queueCount,
    propImgCount, unitImgCount,
    resCount, resEventCount, availCount, propAvailCount, draftCount,
    waCount, aiSetCount, taskCount, noteCount, docCount, notifCount,
    aiCount, auditCount, impCount,
  ] = await Promise.all([
    admin.from('tenant_users').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).then((r) => c(r.count)),
    admin.from('contacts').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).then((r) => c(r.count)),
    admin.from('conversations').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).then((r) => c(r.count)),
    admin.from('messages').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).then((r) => c(r.count)),
    admin.from('message_queue').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).then((r) => c(r.count)),
    propIds.length > 0
      ? admin.from('property_images').select('*', { count: 'exact', head: true }).in('property_id', propIds).then((r) => c(r.count))
      : Promise.resolve(0),
    unitIds.length > 0
      ? admin.from('unit_images').select('*', { count: 'exact', head: true }).in('unit_id', unitIds).then((r) => c(r.count))
      : Promise.resolve(0),
    admin.from('reservations').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).then((r) => c(r.count)),
    admin.from('reservation_events').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).then((r) => c(r.count)),
    admin.from('availability_blocks').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).then((r) => c(r.count)),
    admin.from('property_availability_blocks').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).then((r) => c(r.count)),
    admin.from('conversation_reservation_drafts').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).then((r) => c(r.count)),
    admin.from('whatsapp_accounts').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).then((r) => c(r.count)),
    admin.from('ai_settings').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).then((r) => c(r.count)),
    admin.from('tasks').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).then((r) => c(r.count)),
    admin.from('notes').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).then((r) => c(r.count)),
    admin.from('documents').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).then((r) => c(r.count)),
    admin.from('notifications').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).then((r) => c(r.count)),
    admin.from('ai_usage_log').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).then((r) => c(r.count)),
    admin.from('audit_logs').select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId).then((r) => c(r.count)),
    admin.from('impersonation_sessions').select('*', { count: 'exact', head: true }).eq('target_tenant_id', tenantId).then((r) => c(r.count)),
  ])

  return {
    success: true,
    data: {
      id:               tenant.id,
      name:             tenant.name,
      slug:             tenant.slug,
      status:           tenant.status,
      onboardingStatus: tenant.onboarding_status,
      counts: {
        tenant_users:                    tenantUserCount,
        contacts:                        contactCount,
        conversations:                   convCount,
        messages:                        msgCount,
        message_queue:                   queueCount,
        properties:                      propIds.length,
        property_images:                 propImgCount,
        units:                           unitIds.length,
        unit_images:                     unitImgCount,
        reservations:                    resCount,
        reservation_events:              resEventCount,
        availability_blocks:             availCount,
        property_availability_blocks:    propAvailCount,
        conversation_reservation_drafts: draftCount,
        whatsapp_accounts:               waCount,
        ai_settings:                     aiSetCount,
        tasks:                           taskCount,
        notes:                           noteCount,
        documents:                       docCount,
        notifications:                   notifCount,
        ai_usage_log:                    aiCount,
        audit_logs:                      auditCount,
        impersonation_sessions:          impCount,
      },
    },
  }
}

// ── Soft deactivations ────────────────────────────────────────────────────────

export async function deactivateSellerBySuperAdminAction(
  sellerId: string,
  confirmEmail: string,
): Promise<ActionResult> {
  await requireSuperAdmin()
  const admin = createAdminClient()

  const { data: seller } = await admin
    .from('platform_users')
    .select('id, email, role, active')
    .eq('id', sellerId)
    .maybeSingle()

  if (!seller) return { success: false, error: 'Seller no encontrado.' }
  if (seller.role !== 'seller') return { success: false, error: 'El usuario no es seller.' }
  if (seller.email.toLowerCase() !== confirmEmail.toLowerCase()) {
    return { success: false, error: 'Email de confirmación incorrecto.' }
  }
  if (!seller.active) return { success: false, error: 'El seller ya está inactivo.' }

  const { error } = await admin
    .from('platform_users')
    .update({ active: false })
    .eq('id', sellerId)

  if (error) return { success: false, error: error.message }

  await admin.auth.admin.updateUserById(sellerId, { ban_duration: '876000h' }).catch(() => {})

  revalidatePath('/platform/admin/cleanup')
  return { success: true }
}

export async function deactivateTenantBySuperAdminAction(
  tenantId: string,
  confirmName: string,
): Promise<ActionResult> {
  await requireSuperAdmin()
  const admin = createAdminClient()

  const { data: tenant } = await admin
    .from('tenants')
    .select('id, name, slug')
    .eq('id', tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!tenant) return { success: false, error: 'Tenant no encontrado o ya eliminado.' }
  if (tenant.name !== confirmName && tenant.slug !== confirmName) {
    return { success: false, error: 'Nombre de confirmación incorrecto.' }
  }

  const { error } = await admin
    .from('tenants')
    .update({ status: 'cancelled', deleted_at: new Date().toISOString() })
    .eq('id', tenantId)

  if (error) return { success: false, error: error.message }

  // Deactivate WhatsApp accounts
  await admin.from('whatsapp_accounts').update({ active: false }).eq('tenant_id', tenantId)

  // Ban all tenant users' auth accounts
  const { data: tUsers } = await admin.from('tenant_users').select('id').eq('tenant_id', tenantId)
  if (tUsers) {
    await Promise.all(
      tUsers.map((u) =>
        admin.auth.admin.updateUserById(u.id, { ban_duration: '876000h' }).catch(() => {}),
      ),
    )
  }

  revalidatePath('/platform/admin/cleanup')
  return { success: true }
}

export async function deactivateTenantUserBySuperAdminAction(
  userId: string,
  confirmEmail: string,
): Promise<ActionResult> {
  await requireSuperAdmin()
  const admin = createAdminClient()

  const { data: tu } = await admin
    .from('tenant_users')
    .select('id, email, active')
    .eq('id', userId)
    .maybeSingle()

  if (!tu) return { success: false, error: 'Usuario no encontrado.' }
  if (tu.email.toLowerCase() !== confirmEmail.toLowerCase()) {
    return { success: false, error: 'Email de confirmación incorrecto.' }
  }
  if (!tu.active) return { success: false, error: 'El usuario ya está inactivo.' }

  const { error } = await admin.from('tenant_users').update({ active: false }).eq('id', userId)
  if (error) return { success: false, error: error.message }

  await admin.auth.admin.updateUserById(userId, { ban_duration: '876000h' }).catch(() => {})

  return { success: true }
}

// ── Hard deletes ──────────────────────────────────────────────────────────────

export async function hardDeleteTenantBySuperAdminAction(input: {
  tenantId:             string
  confirmName:          string
  deleteAuthUsers:      boolean
  deleteStorageObjects: boolean
}): Promise<ActionResult<Record<string, number>>> {
  const { tenantId, confirmName, deleteAuthUsers, deleteStorageObjects } = input

  await requireSuperAdmin()
  const admin = createAdminClient()

  const { data: tenant } = await admin
    .from('tenants')
    .select('id, name, slug')
    .eq('id', tenantId)
    .maybeSingle()

  if (!tenant) return { success: false, error: 'Tenant no encontrado.' }
  if (tenant.name !== confirmName && tenant.slug !== confirmName) {
    return { success: false, error: 'Nombre/slug de confirmación incorrecto.' }
  }

  // Collect auth IDs before purge (needed after DB rows are deleted)
  let tenantUserAuthIds: string[] = []
  if (deleteAuthUsers) {
    const { data: tUsers } = await admin.from('tenant_users').select('id').eq('tenant_id', tenantId)
    tenantUserAuthIds = tUsers?.map((u) => u.id) ?? []
  }

  // Same shared helper used by resetQaDataExceptSuperAdminAction below — one
  // implementation, not two partial ones. Collects every real Storage object
  // (property images/videos, reservation-docs, whatsapp-media, tenant public
  // assets — see tenant-storage.repository.ts for the full inventory) BEFORE
  // the DB purge, since the purge deletes the very rows that hold those paths.
  let purgeData: Record<string, number> | null
  let storageWarning: string | undefined

  if (deleteStorageObjects) {
    const result = await purgeTenantWithStorage(tenantId)
    if (result.dbError) return { success: false, error: result.dbError }
    purgeData = result.dbResult
    if (result.storage.failures.length > 0) {
      storageWarning = `${result.storage.failures.length} archivo(s) de storage no se pudieron eliminar. Revisá los logs del servidor.`
    } else if (result.storage.warnings.length > 0) {
      storageWarning = `${result.storage.warnings.length} referencia(s) de storage excluidas por seguridad (path no coincidía con el tenant). Revisá los logs.`
    }
  } else {
    const { data, error } = await asRpc(admin).rpc('admin_purge_tenant', { p_tenant_id: tenantId })
    if (error) return { success: false, error: error.message }
    purgeData = data as Record<string, number>
  }

  // Delete auth users after successful DB purge
  if (deleteAuthUsers && tenantUserAuthIds.length > 0) {
    for (const uid of tenantUserAuthIds) {
      await admin.auth.admin.deleteUser(uid).catch(() => {})
    }
  }

  revalidatePath('/platform/admin/cleanup')
  revalidatePath('/platform/tenants')

  return {
    success: true,
    data:    purgeData ?? {},
    ...(storageWarning ? { warning: storageWarning } : {}),
  }
}

export async function hardDeleteSellerBySuperAdminAction(
  sellerId: string,
  confirmEmail: string,
): Promise<ActionResult> {
  await requireSuperAdmin()
  const admin = createAdminClient()

  const { data: seller } = await admin
    .from('platform_users')
    .select('id, email, role')
    .eq('id', sellerId)
    .maybeSingle()

  if (!seller) return { success: false, error: 'Seller no encontrado.' }
  if (seller.role !== 'seller') return { success: false, error: 'El usuario no es seller.' }
  if (seller.email.toLowerCase() !== confirmEmail.toLowerCase()) {
    return { success: false, error: 'Email de confirmación incorrecto.' }
  }

  // Null out assigned_seller_id on tenants
  await admin.from('tenants').update({ assigned_seller_id: null }).eq('assigned_seller_id', sellerId)

  // Delete seller_clients (cross-tenant rows referencing this seller)
  await admin.from('seller_clients').delete().eq('seller_id', sellerId)

  // Delete audit_logs that reference this seller via impersonated_by
  await admin.from('audit_logs').update({ impersonated_by: null }).eq('impersonated_by', sellerId)

  // Delete impersonation sessions initiated by this seller
  await admin.from('impersonation_sessions').delete().eq('platform_user_id', sellerId)

  // Delete platform_users row
  const { error } = await admin.from('platform_users').delete().eq('id', sellerId)
  if (error) return { success: false, error: error.message }

  // Delete auth user
  await admin.auth.admin.deleteUser(sellerId).catch(() => {})

  revalidatePath('/platform/admin/cleanup')
  revalidatePath('/platform/sellers')
  return { success: true }
}

export async function hardDeleteTenantUserBySuperAdminAction(
  userId: string,
  confirmEmail: string,
): Promise<ActionResult> {
  await requireSuperAdmin()
  const admin = createAdminClient()

  const { data: tu } = await admin
    .from('tenant_users')
    .select('id, email')
    .eq('id', userId)
    .maybeSingle()

  if (!tu) return { success: false, error: 'Usuario no encontrado.' }
  if (tu.email.toLowerCase() !== confirmEmail.toLowerCase()) {
    return { success: false, error: 'Email de confirmación incorrecto.' }
  }

  // Null out all FK references before deleting
  await Promise.all([
    admin.from('conversations').update({ assigned_user_id: null }).eq('assigned_user_id', userId),
    admin.from('messages').update({ sender_id: null }).eq('sender_id', userId),
    admin.from('notes').update({ created_by: null }).eq('created_by', userId),
    admin.from('tasks').update({ created_by: null }).eq('created_by', userId),
    admin.from('reservation_events').update({ actor_id: null }).eq('actor_id', userId),
    admin.from('availability_blocks').update({ created_by: null }).eq('created_by', userId),
    admin.from('property_availability_blocks').update({ created_by: null }).eq('created_by', userId),
  ])

  const { error } = await admin.from('tenant_users').delete().eq('id', userId)
  if (error) return { success: false, error: error.message }

  await admin.auth.admin.deleteUser(userId).catch(() => {})

  return { success: true }
}

// ── Global QA reset ───────────────────────────────────────────────────────────
//
// Fase 10 Paso 3: RESET RESERVANEX is a GLOBAL, unconditional wipe of every
// tenant in the project (confirmed via full trace — see the Fase 10 Paso 2
// report). It previously had no environment gate at all: superadmin auth +
// a typed confirmation phrase were the only barriers, identical in every
// deployment including production. `isGlobalTenantResetAllowed()` adds a
// fail-closed, server-only flag that must be explicitly `"true"` in EVERY
// environment (dev/staging included, by design — this avoids an accidental
// global wipe on a shared dev/staging database just as much as production).
// Checked LAST (after identity and intent) so a misconfigured flag never
// masks a more fundamental auth/confirmation failure — but any single
// failed check aborts before any destructive call runs. There is no
// client-side/UI equivalent of this gate: hiding a button or disabling it
// client-side is not a security boundary, only this server check is.
// isGlobalTenantResetAllowed() itself lives in lib/global-tenant-reset.ts,
// not here — this file has 'use server', which requires every export to be
// an async Server Action; a plain sync helper breaks the production build.

export async function resetQaDataExceptSuperAdminAction(
  confirmText: string,
): Promise<ActionResult<{
  tenantsDeleted:         number
  sellersDeleted:         number
  tenantAuthUsersDeleted: number
  storageObjectsDeleted:  number
  storageFailures:        number
}>> {
  // 1. Identity — verified server-side first, before any other logic runs.
  await requireSuperAdmin()

  // 2. Intent — the exact confirmation phrase.
  if (confirmText !== 'RESET RESERVANEX') {
    return { success: false, error: 'Texto de confirmación incorrecto. Escribí exactamente: RESET RESERVANEX' }
  }

  // 3. Explicit opt-in — fail-closed by default in every environment.
  if (!isGlobalTenantResetAllowed()) {
    return {
      success: false,
      error: 'Reset global deshabilitado por configuración. Requiere ALLOW_GLOBAL_TENANT_RESET=true en el entorno del servidor.',
    }
  }

  const admin = createAdminClient()

  // Identify current session user to never delete SA self
  const client = await createClient()
  const { data: { user: currentUser } } = await client.auth.getUser()
  if (!currentUser) return { success: false, error: 'No se pudo identificar al usuario actual.' }
  const currentSAId = currentUser.id

  // Guard: there must be at least 1 super_admin after the operation (the current user)
  const { count: saCount } = await admin
    .from('platform_users')
    .select('*', { count: 'exact', head: true })
    .eq('role', 'super_admin')
  if ((saCount ?? 0) <= 1) {
    // Only one SA — still safe to proceed since we never delete self
  }

  // Get all tenants and purge them
  const { data: tenants, error: tenantsErr } = await admin.from('tenants').select('id')
  if (tenantsErr) return { success: false, error: tenantsErr.message }

  let tenantsDeleted = 0
  let tenantAuthUsersDeleted = 0
  let storageObjectsDeleted = 0
  let storageFailures = 0
  for (const t of (tenants ?? [])) {
    // Collect tenant_users' auth IDs BEFORE the purge (the purge only
    // deletes the public.tenant_users row, never auth.users). Safe to
    // delete unconditionally here: tenant_users.id IS the auth user id, it's
    // the table's primary key (one row per auth user, ever), and the
    // check_user_profile_exclusivity trigger guarantees that same id can
    // never also be a platform_users row — so every id collected here was
    // exclusively a fixture of THIS tenant, never shared or a platform user.
    const { data: tUsers } = await admin.from('tenant_users').select('id').eq('tenant_id', t.id)
    const authIds = tUsers?.map((u) => u.id) ?? []

    // "RESET RESERVANEX" is a full QA wipe by design (unconditional, unlike
    // the opt-in checkbox on the per-tenant hard-delete UI) — Storage cleanup
    // runs unconditionally here too. See tenant-storage.repository.ts for the
    // DB-purge-fails-means-no-Storage-touch guarantee.
    const result = await purgeTenantWithStorage(t.id)
    if (result.dbError) return { success: false, error: `Error purgando tenant ${t.id}: ${result.dbError}` }
    tenantsDeleted++
    storageObjectsDeleted += result.storage.deletedCount
    storageFailures += result.storage.failures.length

    for (const uid of authIds) {
      await admin.auth.admin.deleteUser(uid).catch(() => {})
      tenantAuthUsersDeleted++
    }
  }

  // Clean global audit_logs and impersonation_sessions
  await admin.from('audit_logs').delete().is('tenant_id', null)
  await admin.from('impersonation_sessions').delete().not('id', 'is', null)

  // Delete all sellers (never delete SA, never delete self)
  const { data: sellers } = await admin
    .from('platform_users')
    .select('id')
    .eq('role', 'seller')

  let sellersDeleted = 0
  for (const s of (sellers ?? [])) {
    if (s.id === currentSAId) continue
    await admin.from('platform_users').delete().eq('id', s.id)
    await admin.auth.admin.deleteUser(s.id).catch(() => {})
    sellersDeleted++
  }

  revalidatePath('/platform/admin/cleanup')
  revalidatePath('/platform/tenants')
  revalidatePath('/platform/sellers')

  return {
    success: true,
    data: { tenantsDeleted, sellersDeleted, tenantAuthUsersDeleted, storageObjectsDeleted, storageFailures },
    // Never claim a clean "reset completo" if Storage cleanup left files
    // behind — DB/Auth are genuinely done at this point (that part is real),
    // but the caller must be able to tell the difference.
    ...(storageFailures > 0
      ? { warning: `${storageFailures} archivo(s) de storage no se pudieron eliminar. DB y Auth sí quedaron limpios — revisá los logs del servidor.` }
      : {}),
  }
}
