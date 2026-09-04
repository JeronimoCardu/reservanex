'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requirePlatformContext } from '@/lib/auth/require-platform-context'
import { createAdminClient } from '@orderflow/supabase/admin'
import * as repo from '@/lib/repositories/platform.repository'
import type { ActionResult } from '@/lib/action-result'
import {
  ensureInvitedUser,
  ENSURE_RATE_LIMIT,
  ENSURE_REDIRECT_INVALID,
} from '@/lib/auth/ensure-invited-user'
import type { EnsureInvitedStatus } from '@/lib/auth/ensure-invited-user'
import { PLANS, getPlanConfig } from '@/lib/plans'
import { DEFAULT_COUNTRY_CODE, defaultsForCountry } from '@/lib/tenant-provisioning'
import { getAuthRedirectTo } from '@/lib/site-url'

const PLATFORM_PATH    = '/platform'
const TENANTS_PATH     = '/platform/tenants'
const SELLERS_PATH     = '/platform/sellers'

const VALID_ONBOARDING = new Set([
  'pending_review', 'approved', 'meta_setup', 'testing',
  'ready_to_deliver', 'delivered', 'rejected',
])
const VALID_TENANT_STATUS = new Set(['trial', 'active', 'suspended', 'cancelled', 'churned'])

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Auth errors from Supabase have non-enumerable properties (name, message, status, code),
// so JSON.stringify(error) returns '{}'. This function reads them explicitly.
function serializeAuthError(err: unknown): Record<string, unknown> {
  if (err == null) return { raw: null }
  const e = err as Record<string, unknown>
  const out: Record<string, unknown> = {
    name:    e['name'],
    message: e['message'],
    status:  e['status'],
    code:    e['code'],
  }
  // Pick up any additional enumerable or own-property fields
  try {
    const names = Object.getOwnPropertyNames(err)
    for (const key of names) {
      if (!(key in out)) out[key] = e[key]
    }
  } catch { /* ignore */ }
  return out
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

// ─── Create tenant ────────────────────────────────────────────────────────────

const createTenantSchema = z.object({
  name:                z.string().min(2, 'El nombre debe tener al menos 2 caracteres').max(100),
  country:             z.string().length(2).optional(),
  currency:            z.string().length(3).optional(),
  activate_immediately: z.boolean().optional(),
  primary_owner_name:  z.string().max(100).nullable().optional(),
  primary_owner_email: z.string().email('Email inválido').nullable().optional(),
  primary_owner_phone: z.string().max(30).nullable().optional(),
  onboarding_notes:    z.string().max(2000).nullable().optional(),
})

export async function createPlatformTenantAction(
  input: unknown,
): Promise<ActionResult<{ id: string; slug: string }>> {
  const ctx = await requirePlatformContext()
  if (ctx.isOperator) return { success: false, error: 'No tenés permiso para realizar esta acción.' }

  const parsed = createTenantSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const d = parsed.data

  // Generate and deduplicate slug
  let slug = slugify(d.name)
  if (!slug || slug.length < 4) slug = `tenant-${Date.now()}`

  if (await repo.slugExists(slug)) {
    slug = `${slug}-${Date.now().toString().slice(-4)}`
  }

  const sellerId = ctx.role === 'seller' ? ctx.userId : null

  const country  = d.country ?? DEFAULT_COUNTRY_CODE
  const currency = d.currency ?? defaultsForCountry(country).currency

  try {
    const tenant = await repo.createTenant({
      name:                 d.name,
      slug,
      country,
      language:             'es', // único idioma implementado hoy — ver Fase 8 report
      currency,
      timezone:             defaultsForCountry(country).timezone,
      activate_immediately: d.activate_immediately ?? false,
      onboarding_notes:     d.onboarding_notes ?? null,
      primary_owner_name:   d.primary_owner_name ?? null,
      primary_owner_email:  d.primary_owner_email ?? null,
      primary_owner_phone:  d.primary_owner_phone ?? null,
      assigned_seller_id:   sellerId,
      created_by_seller_id: sellerId,
    })

    revalidatePath(TENANTS_PATH)
    revalidatePath(PLATFORM_PATH)
    return { success: true, data: { id: tenant.id, slug: tenant.slug } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg.includes('tenants_slug') || msg.includes('unique')) {
      return { success: false, error: 'Ya existe una inmobiliaria con ese nombre/slug. Cambiá el nombre.' }
    }
    return { success: false, error: 'Error al crear la inmobiliaria. Intentá de nuevo.' }
  }
}

// ─── Update tenant basic (seller can edit while not delivered) ────────────────

const updateBasicSchema = z.object({
  name:                z.string().min(2).max(100).optional(),
  primary_owner_name:  z.string().max(100).nullable().optional(),
  primary_owner_email: z.string().email('Email inválido').nullable().optional(),
  primary_owner_phone: z.string().max(30).nullable().optional(),
  onboarding_notes:    z.string().max(2000).nullable().optional(),
})

export async function updateTenantBasicAction(
  tenantId: string,
  input: unknown,
): Promise<ActionResult> {
  const ctx = await requirePlatformContext()
  if (ctx.isOperator) return { success: false, error: 'No tenés permiso para realizar esta acción.' }

  const parsed = updateBasicSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const tenant = await repo.getTenantById(tenantId)
  if (!tenant) return { success: false, error: 'Inmobiliaria no encontrada.' }

  // Seller: can only edit own tenants that are not yet delivered
  if (ctx.role === 'seller') {
    if (tenant.assigned_seller_id !== ctx.userId) {
      return { success: false, error: 'No tenés acceso a esta inmobiliaria.' }
    }
    if (tenant.onboarding_status === 'delivered') {
      return { success: false, error: 'No podés editar una inmobiliaria ya entregada.' }
    }
  }

  try {
    await repo.updateTenantBasic(tenantId, parsed.data)
    revalidatePath(`${TENANTS_PATH}/${tenantId}`)
    revalidatePath(TENANTS_PATH)
    return { success: true }
  } catch {
    return { success: false, error: 'Error al actualizar. Intentá de nuevo.' }
  }
}

// ─── Update onboarding status (SA only) ──────────────────────────────────────

export async function updateTenantOnboardingStatusAction(
  tenantId: string,
  status:   string,
): Promise<ActionResult> {
  const ctx = await requirePlatformContext()

  if (ctx.role !== 'super_admin') {
    return { success: false, error: 'Solo el Super Admin puede cambiar el estado de onboarding.' }
  }

  if (!VALID_ONBOARDING.has(status)) {
    return { success: false, error: 'Estado de onboarding inválido.' }
  }

  const tenant = await repo.getTenantById(tenantId)
  if (!tenant) return { success: false, error: 'Inmobiliaria no encontrada.' }

  try {
    await repo.updateTenantOnboardingStatus(tenantId, status, ctx.userId)
  } catch {
    return { success: false, error: 'Error al actualizar el estado. Intentá de nuevo.' }
  }

  const SETUP_TERMINAL_ONBOARDING = new Set(['ready_to_deliver', 'delivered'])
  if (SETUP_TERMINAL_ONBOARDING.has(status)) {
    try {
      await repo.closeSetupSessionsForTenant(tenantId)
    } catch (e) {
      console.error('[updateTenantOnboardingStatusAction] closeSetupSessionsForTenant failed:', e)
    }
  }

  revalidatePath(`${TENANTS_PATH}/${tenantId}`)
  revalidatePath(TENANTS_PATH)
  revalidatePath(PLATFORM_PATH)
  return { success: true }
}

// ─── Update tenant status (SA only) ──────────────────────────────────────────

export async function updateTenantStatusAction(
  tenantId: string,
  status:   string,
): Promise<ActionResult> {
  const ctx = await requirePlatformContext()

  if (ctx.role !== 'super_admin') {
    return { success: false, error: 'Solo el Super Admin puede cambiar el estado del tenant.' }
  }

  if (!VALID_TENANT_STATUS.has(status)) {
    return { success: false, error: 'Estado de tenant inválido.' }
  }

  const tenant = await repo.getTenantById(tenantId)
  if (!tenant) return { success: false, error: 'Inmobiliaria no encontrada.' }

  try {
    await repo.updateTenantStatus(tenantId, status as 'trial' | 'active' | 'suspended' | 'cancelled' | 'churned')
  } catch {
    return { success: false, error: 'Error al cambiar el estado. Intentá de nuevo.' }
  }

  if (status === 'active') {
    try {
      await repo.closeSetupSessionsForTenant(tenantId)
    } catch (e) {
      console.error('[updateTenantStatusAction] closeSetupSessionsForTenant failed:', e)
    }
  }

  revalidatePath(`${TENANTS_PATH}/${tenantId}`)
  revalidatePath(TENANTS_PATH)
  revalidatePath(PLATFORM_PATH)
  return { success: true }
}

// ─── Reassign seller (SA only) ────────────────────────────────────────────────

export async function reassignTenantSellerAction(
  tenantId:    string,
  newSellerId: string,
): Promise<ActionResult> {
  const ctx = await requirePlatformContext()

  if (ctx.role !== 'super_admin') {
    return { success: false, error: 'Solo el Super Admin puede reasignar sellers.' }
  }

  const [tenant, seller] = await Promise.all([
    repo.getTenantById(tenantId),
    repo.getPlatformUserById(newSellerId),
  ])

  if (!tenant) return { success: false, error: 'Inmobiliaria no encontrada.' }
  if (!seller || seller.role !== 'seller') return { success: false, error: 'Seller no encontrado.' }

  try {
    await repo.reassignTenantSeller(tenantId, newSellerId, tenant.assigned_seller_id)
    revalidatePath(`${TENANTS_PATH}/${tenantId}`)
    revalidatePath(TENANTS_PATH)
    return { success: true }
  } catch {
    return { success: false, error: 'Error al reasignar el seller. Intentá de nuevo.' }
  }
}

// ─── Mark delivered (seller when ready_to_deliver) ───────────────────────────

export async function markTenantDeliveredAction(tenantId: string): Promise<ActionResult> {
  const ctx = await requirePlatformContext()
  if (ctx.isOperator) return { success: false, error: 'No tenés permiso para realizar esta acción.' }

  const tenant = await repo.getTenantById(tenantId)
  if (!tenant) return { success: false, error: 'Inmobiliaria no encontrada.' }

  if (ctx.role === 'seller') {
    if (tenant.assigned_seller_id !== ctx.userId) {
      return { success: false, error: 'No tenés acceso a esta inmobiliaria.' }
    }
    if (tenant.onboarding_status !== 'ready_to_deliver') {
      return { success: false, error: 'La inmobiliaria debe estar en "Lista para entregar" antes de marcarla como entregada.' }
    }
  }

  try {
    await repo.updateTenantOnboardingStatus(tenantId, 'delivered', ctx.userId)
  } catch {
    return { success: false, error: 'Error al marcar como entregada. Intentá de nuevo.' }
  }

  try {
    await repo.closeSetupSessionsForTenant(tenantId)
  } catch (e) {
    console.error('[markTenantDeliveredAction] closeSetupSessionsForTenant failed:', e)
  }

  revalidatePath(`${TENANTS_PATH}/${tenantId}`)
  revalidatePath(TENANTS_PATH)
  return { success: true }
}

// ─── Invite primary tenant owner (SA only) ────────────────────────────────────
//
// Uses createAdminClient() for ALL DB operations because the SA has no tenant
// session — createClient() would be blocked by RLS on tenant_users.

export async function invitePrimaryTenantOwnerAction(tenantId: string): Promise<ActionResult<{ inviteLink?: string }>> {
  const ctx = await requirePlatformContext()

  if (ctx.role !== 'super_admin') {
    return { success: false, error: 'Solo el Super Admin puede enviar la invitación al owner.' }
  }

  const tenant = await repo.getTenantById(tenantId)
  if (!tenant) return { success: false, error: 'Inmobiliaria no encontrada.' }

  if (!tenant.primary_owner_email) {
    return { success: false, error: 'La inmobiliaria no tiene email de owner cargado. Completá los datos antes de invitar.' }
  }

  if (!['ready_to_deliver', 'delivered'].includes(tenant.onboarding_status)) {
    return { success: false, error: 'Solo se puede invitar al owner cuando el onboarding está en "Lista para entregar" o "Entregada".' }
  }

  const normalizedEmail = tenant.primary_owner_email.toLowerCase().trim()
  const admin           = createAdminClient()

  let redirectTo: string
  try {
    redirectTo = getAuthRedirectTo()
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Error de configuración del servidor.' }
  }

  // ── Step 1: Check if owner already exists in tenant_users (idempotent re-invite) ──
  // Must use admin client — SA has no tenant session so createClient() is RLS-blocked.
  const { data: existingTU, error: existingTUErr } = await admin
    .from('tenant_users')
    .select('id, email, active')
    .eq('tenant_id', tenantId)
    .eq('email', normalizedEmail)
    .maybeSingle()

  if (existingTUErr) {
    console.error('[platform:invite-owner] tenant_users lookup failed', {
      tenantId,
      email:        normalizedEmail,
      errorCode:    existingTUErr.code,
      errorMessage: existingTUErr.message,
    })
    return { success: false, error: 'Error al verificar el estado del owner. Intentá de nuevo.' }
  }

  if (existingTU) {
    // Owner already has a tenant_users record — resend via ensureInvitedUser.
    // This handles both unconfirmed (resend invite) and confirmed (recovery email) cases.
    let emailSent  = false
    let inviteLink: string | undefined
    let status: EnsureInvitedStatus | undefined
    let lastErrorCode: string | undefined
    let lastErrorMessage: string | undefined
    try {
      const result = await ensureInvitedUser(normalizedEmail, redirectTo)
      status     = result.status
      emailSent  = result.status !== 'email_not_sent'
      inviteLink = result.inviteLink
      lastErrorCode    = result.lastErrorCode
      lastErrorMessage = result.lastErrorMessage

      console.log('[platform:invite-owner] resend', {
        tenantId,
        email:             normalizedEmail,
        authUserId:        existingTU.id,
        mode:              result.status,
        emailSent,
        lastErrorCode,
        lastErrorMessage,
      })
    } catch (resendErr) {
      const errMsg = resendErr instanceof Error ? resendErr.message : String(resendErr)
      console.warn('[platform:invite-owner] ensureInvitedUser failed during resend (non-fatal)', {
        tenantId,
        email: normalizedEmail,
        error: errMsg,
      })
    }

    try {
      await repo.markOwnerInvited(tenantId, ctx.userId)
    } catch (markErr) {
      console.error('[platform:invite-owner] markOwnerInvited failed during resend (non-fatal)', {
        tenantId,
        email: normalizedEmail,
        error: markErr instanceof Error ? markErr.message : String(markErr),
      })
    }

    revalidatePath(`${TENANTS_PATH}/${tenantId}`)

    if (!emailSent) {
      const reason = lastErrorMessage ? ` (motivo: ${lastErrorMessage})` : ''
      return {
        success: true,
        data:    { inviteLink },
        warning: inviteLink
          ? `No se pudo enviar el email automáticamente${reason}. Copiá el link de invitación y envíaselo al owner por otro medio.`
          : `No se pudo enviar el email ni generar un link de invitación${reason}. Intentá de nuevo en unos minutos.`,
      }
    }

    // status === 'invited' means a genuine fresh invite went out; 'recovery_sent'
    // means the owner had ALREADY confirmed their email at some point (e.g.
    // mid-flow on /auth/accept-invite, or fully onboarded already) — sending
    // another "invite" would be misleading, so this is worded differently.
    if (status === 'recovery_sent') {
      return { success: true, warning: 'El owner ya había confirmado su cuenta anteriormente — se le envió un email de acceso, no una invitación nueva.' }
    }
    return { success: true }
  }

  // ── Step 2: First-time invite — use ensureInvitedUser to create + send ───
  let authUserId: string | null = null
  let isNewUser  = false
  let emailSent  = false
  let inviteLink: string | undefined
  let lastErrorMessage: string | undefined

  try {
    const result = await ensureInvitedUser(normalizedEmail, redirectTo)
    authUserId = result.authUserId
    isNewUser  = result.isNewUser
    emailSent  = result.status !== 'email_not_sent'
    inviteLink = result.inviteLink
    lastErrorMessage = result.lastErrorMessage
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : ''
    console.error('[platform:invite-owner] ensureInvitedUser failed', {
      tenantId,
      email: normalizedEmail,
      error: errMsg,
    })
    if (errMsg === ENSURE_RATE_LIMIT) {
      return { success: false, error: 'Supabase limitó el envío de emails temporalmente. Esperá unos minutos.' }
    }
    if (errMsg === ENSURE_REDIRECT_INVALID) {
      return { success: false, error: 'La URL de redirección de Auth no está habilitada en Supabase. Revisá Authentication → URL Configuration → Redirect URLs.' }
    }
    return { success: false, error: 'Error al generar la invitación. Intentá de nuevo.' }
  }

  if (!authUserId) {
    return { success: false, error: 'No se pudo obtener el ID del usuario de Supabase Auth.' }
  }

  // ── Step 2.5: Guard against overwriting a user who belongs to another tenant ──
  const { data: existingAnyTenant } = await admin
    .from('tenant_users')
    .select('tenant_id')
    .eq('id', authUserId)
    .maybeSingle()

  if (existingAnyTenant && existingAnyTenant.tenant_id !== tenantId) {
    return {
      success: false,
      error: 'Este email ya pertenece a otra inmobiliaria. Contactá a soporte.',
    }
  }

  // ── Step 3: Upsert tenant_users via admin client (bypasses RLS) ──────────
  const { data: tenantUser, error: tuErr } = await admin
    .from('tenant_users')
    .upsert(
      {
        id:        authUserId,
        tenant_id: tenantId,
        name:      tenant.primary_owner_name ?? normalizedEmail,
        email:     normalizedEmail,
        role:      'owner' as const,
        active:    true,
      },
      { onConflict: 'id' },
    )
    .select()
    .single()

  if (tuErr || !tenantUser) {
    console.error('[platform:invite-owner] tenant_users upsert failed', {
      tenantId,
      email:        normalizedEmail,
      authUserId,
      errorCode:    tuErr?.code,
      errorMessage: tuErr?.message,
    })
    // Rollback: delete auth user only if we created it in this request
    if (isNewUser) {
      await admin.auth.admin.deleteUser(authUserId).catch((delErr: unknown) => {
        console.warn('[platform:invite-owner] rollback deleteUser failed', {
          authUserId,
          error: delErr instanceof Error ? delErr.message : String(delErr),
        })
      })
    }
    return { success: false, error: 'Error al registrar el owner en la base de datos. Intentá de nuevo.' }
  }

  // ── Step 4: Mark owner invited on tenant ─────────────────────────────────
  try {
    await repo.markOwnerInvited(tenantId, ctx.userId)
  } catch (markErr) {
    console.error('[platform:invite-owner] markOwnerInvited failed (non-fatal)', {
      tenantId,
      email: normalizedEmail,
      error: markErr instanceof Error ? markErr.message : String(markErr),
    })
  }

  revalidatePath(`${TENANTS_PATH}/${tenantId}`)

  console.log('[platform:invite-owner]', {
    tenantId,
    email:                 normalizedEmail,
    authUserId,
    emailSent,
    tenantUserCreated:     true,
    ownerInvitedAtUpdated: true,
  })

  if (!emailSent) {
    const reason = lastErrorMessage ? ` (motivo: ${lastErrorMessage})` : ''
    return {
      success: true,
      data:    { inviteLink },
      warning: inviteLink
        ? `El owner fue registrado, pero no se pudo enviar el email automáticamente${reason}. Copiá el link de invitación y envíaselo por otro medio.`
        : `El owner fue registrado, pero no se pudo enviar el email ni generar un link de invitación${reason}. Intentá de nuevo en unos minutos.`,
    }
  }

  return { success: true }
}

// ─── Create seller (SA only) ──────────────────────────────────────────────────

const createSellerSchema = z.object({
  name:  z.string().min(2, 'El nombre debe tener al menos 2 caracteres').max(100),
  email: z.string().email('Email inválido'),
})

export async function createSellerAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const ctx = await requirePlatformContext()

  if (ctx.role !== 'super_admin') {
    return { success: false, error: 'Solo el Super Admin puede crear sellers.' }
  }

  const parsed = createSellerSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  const { name, email } = parsed.data
  const normalizedEmail = email.toLowerCase().trim()
  const admin           = createAdminClient()

  let redirectTo: string
  try {
    redirectTo = getAuthRedirectTo()
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Error de configuración del servidor.' }
  }

  // ── Step 1: Check existing platform_users entry ───────────────────────────
  const { data: existingPU } = await admin
    .from('platform_users')
    .select('id, role, active')
    .eq('email', normalizedEmail)
    .maybeSingle()

  if (existingPU) {
    if (existingPU.role !== 'seller') {
      return { success: false, error: 'Este email ya pertenece a un usuario de plataforma con otro rol.' }
    }
    if (existingPU.active) {
      return { success: false, error: 'Ya existe un seller activo con este email.' }
    }
    // Inactive seller: reactivate and resend invite (fire-and-forget on email error)
    await admin
      .from('platform_users')
      .update({ active: true, name, updated_at: new Date().toISOString() })
      .eq('id', existingPU.id)
    await admin.auth.admin.updateUserById(existingPU.id, { ban_duration: 'none' }).catch(() => {})
    await admin.auth.admin.inviteUserByEmail(normalizedEmail, { redirectTo }).catch(() => {})
    console.log('[platform:create-seller] seller reactivated', { email: normalizedEmail, authUserId: existingPU.id })
    revalidatePath(SELLERS_PATH)
    return { success: true, data: { id: existingPU.id } }
  }

  // ── Step 2: Invite via Supabase Auth → get auth user ID ──────────────────
  // Primary: inviteUserByEmail (creates user + sends email).
  // Fallback: generateLink (gets user ID without sending email — used when the
  //           user already exists in auth.users from a previous attempt).
  let authUserId: string | null = null
  let emailSent = false

  const { data: inviteData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(
    normalizedEmail,
    { redirectTo },
  )

  if (!inviteError && inviteData?.user?.id) {
    authUserId = inviteData.user.id
    emailSent  = true
  } else {
    // Log full error — auth errors often have non-enumerable properties,
    // so we explicitly read every known field plus all own property names.
    const errDetail = serializeAuthError(inviteError)
    console.warn('[platform:create-seller] inviteUserByEmail failed, falling back to generateLink', {
      email: normalizedEmail,
      error: errDetail,
    })

    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type:    'invite',
      email:   normalizedEmail,
      options: { redirectTo },
    })

    if (!linkError && linkData?.user?.id) {
      authUserId = linkData.user.id
      // emailSent remains false — generateLink does NOT send an email

      // Dev-only: log local_confirm_link for manual testing (never in production)
      if (process.env.NODE_ENV !== 'production' && linkData.properties?.hashed_token) {
        const localConfirmLink = `${new URL(redirectTo).origin}/auth/confirm?token_hash=${linkData.properties.hashed_token}&type=invite`
        console.log('[platform:create-seller] [DEV] local_confirm_link (no email sent):', localConfirmLink)
      }
    } else {
      console.error('[platform:create-seller] both invite and generateLink failed', {
        email:       normalizedEmail,
        inviteError: serializeAuthError(inviteError),
        linkError:   serializeAuthError(linkError),
      })
      if (
        inviteError?.message?.toLowerCase().includes('rate limit') ||
        inviteError?.code === 'over_email_send_rate_limit' ||
        inviteError?.code === 'over_request_rate_limit'
      ) {
        return { success: false, error: 'Supabase limitó el envío de emails. Esperá unos minutos.' }
      }
      return { success: false, error: 'Error al enviar la invitación al seller. Intentá de nuevo.' }
    }
  }

  if (!authUserId) {
    return { success: false, error: 'No se pudo obtener el ID del usuario de Supabase Auth.' }
  }

  // ── Step 3: Upsert platform_users with auth user ID ───────────────────────
  // Upsert handles re-invite scenarios where a previous attempt created the
  // auth user but failed before writing platform_users.
  const { data: pu, error: puError } = await admin
    .from('platform_users')
    .upsert(
      { id: authUserId, name, email: normalizedEmail, role: 'seller' as const, active: true },
      { onConflict: 'id' },
    )
    .select()
    .single()

  if (puError || !pu) {
    console.error('[platform:create-seller] platform_users upsert failed', {
      email:        normalizedEmail,
      authUserId,
      errorCode:    puError?.code,
      errorMessage: puError?.message,
    })
    return { success: false, error: 'Error al registrar el seller en la base de datos. Intentá de nuevo.' }
  }

  console.log('[platform:create-seller] seller created', {
    email:     normalizedEmail,
    authUserId,
    emailSent,
  })

  revalidatePath(SELLERS_PATH)
  revalidatePath(PLATFORM_PATH)

  if (!emailSent) {
    return {
      success: true,
      data:    { id: pu.id },
      warning: 'El seller fue creado, pero no se pudo enviar el email de invitación automáticamente. Revisá la configuración de SMTP en Supabase, o enviá el link manualmente usando el script dev:invite-link.',
    }
  }

  return { success: true, data: { id: pu.id } }
}

// ─── Resend seller invite (SA only) ──────────────────────────────────────────

export async function resendSellerInviteAction(sellerId: string): Promise<ActionResult> {
  const ctx = await requirePlatformContext()

  if (ctx.role !== 'super_admin') {
    return { success: false, error: 'Solo el Super Admin puede reenviar invitaciones de sellers.' }
  }

  const seller = await repo.getPlatformUserById(sellerId)
  if (!seller || seller.role !== 'seller') {
    return { success: false, error: 'Seller no encontrado.' }
  }
  if (!seller.active) {
    return { success: false, error: 'El seller está inactivo. Reactivalo primero desde el botón de estado.' }
  }

  const normalizedEmail = seller.email.toLowerCase().trim()

  let redirectTo: string
  try {
    redirectTo = getAuthRedirectTo()
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Error de configuración del servidor.' }
  }

  try {
    const result = await ensureInvitedUser(normalizedEmail, redirectTo)

    console.log('[platform:resend-seller]', {
      sellerId,
      email:  normalizedEmail,
      mode:   result.status,
    })

    revalidatePath(SELLERS_PATH)

    if (result.status === 'email_not_sent') {
      return {
        success: true,
        warning: 'No se pudo enviar el email automáticamente. El seller puede solicitar acceso desde el login.',
      }
    }
    return { success: true }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : ''
    if (errMsg === ENSURE_RATE_LIMIT) {
      return { success: false, error: 'Supabase limitó el envío de emails temporalmente. Esperá unos minutos.' }
    }
    if (errMsg === ENSURE_REDIRECT_INVALID) {
      return { success: false, error: 'La URL de redirección de Auth no está habilitada en Supabase.' }
    }
    return { success: false, error: 'Error al reenviar la invitación. Intentá de nuevo.' }
  }
}

// ─── Toggle seller active (SA only) ──────────────────────────────────────────

export async function toggleSellerActiveAction(
  sellerId: string,
  active:   boolean,
): Promise<ActionResult> {
  const ctx = await requirePlatformContext()

  if (ctx.role !== 'super_admin') {
    return { success: false, error: 'Solo el Super Admin puede activar/desactivar sellers.' }
  }

  const seller = await repo.getPlatformUserById(sellerId)
  if (!seller || seller.role !== 'seller') {
    return { success: false, error: 'Seller no encontrado.' }
  }

  try {
    await repo.updateSellerActive(sellerId, active)
    // Sync ban state in auth
    const admin = createAdminClient()
    await admin.auth.admin.updateUserById(sellerId, {
      ban_duration: active ? 'none' : '876000h',
    })
    revalidatePath(SELLERS_PATH)
    return { success: true }
  } catch {
    return { success: false, error: 'Error al cambiar el estado del seller.' }
  }
}

// ─── Update tenant plan (SA only) ─────────────────────────────────────────────

const updatePlanSchema = z.object({
  plan_code: z.string(),
})

export async function updateTenantPlanAction(
  tenantId: string,
  input:    unknown,
): Promise<ActionResult> {
  const ctx = await requirePlatformContext()

  if (ctx.role !== 'super_admin') {
    return { success: false, error: 'Solo el Super Admin puede cambiar el plan.' }
  }

  const parsed = updatePlanSchema.safeParse(input)
  if (!parsed.success || !(parsed.data.plan_code in PLANS)) {
    return { success: false, error: 'Plan inválido.' }
  }

  const tenant = await repo.getTenantById(tenantId)
  if (!tenant) return { success: false, error: 'Inmobiliaria no encontrada.' }

  const planCfg = getPlanConfig(parsed.data.plan_code)

  // Guard: downgrade blocked if tenant already exceeds new limits
  const counts = await repo.getTenantUserCounts(tenantId)

  if (counts.receptionists > planCfg.maxReceptionists) {
    return {
      success: false,
      error:   `No podés bajar al ${planCfg.label}: el tenant ya tiene ${counts.receptionists} agentes y el nuevo plan permite hasta ${planCfg.maxReceptionists}.`,
    }
  }
  if (counts.total > planCfg.maxTotalUsers) {
    return {
      success: false,
      error:   `No podés bajar al ${planCfg.label}: el tenant ya tiene ${counts.total} usuarios y el nuevo plan permite hasta ${planCfg.maxTotalUsers}.`,
    }
  }

  try {
    await repo.updateTenantPlan(
      tenantId,
      parsed.data.plan_code,
      planCfg.label,
      planCfg.maxOwners,
      planCfg.maxReceptionists,
      planCfg.maxTotalUsers,
    )
    revalidatePath(`${TENANTS_PATH}/${tenantId}`)
    revalidatePath(TENANTS_PATH)
    return { success: true }
  } catch {
    return { success: false, error: 'Error al actualizar el plan. Intentá de nuevo.' }
  }
}

// ─── Setup operator assignment (SA only) ──────────────────────────────────────

export async function assignSetupOperatorAction(
  tenantId:   string,
  operatorId: string,
): Promise<ActionResult> {
  const ctx = await requirePlatformContext()

  if (ctx.role !== 'super_admin') {
    return { success: false, error: 'Solo el Super Admin puede asignar operators.' }
  }

  const [tenant, operator] = await Promise.all([
    repo.getTenantById(tenantId),
    repo.getPlatformUserById(operatorId),
  ])

  if (!tenant) return { success: false, error: 'Inmobiliaria no encontrada.' }
  if (!operator || operator.role !== 'operator') {
    return { success: false, error: 'Operator no encontrado.' }
  }

  try {
    await repo.createSetupAssignment({ tenantId, operatorId, assignedBy: ctx.userId })
    await repo.updateTenantSetupStatus(tenantId, 'assigned')
    revalidatePath(`${TENANTS_PATH}/${tenantId}`)
    return { success: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg.includes('unique') || msg.includes('idx_tsa_unique')) {
      return { success: false, error: 'Este operator ya tiene un assignment activo para este tenant.' }
    }
    return { success: false, error: 'Error al asignar el operator. Intentá de nuevo.' }
  }
}

export async function revokeSetupOperatorAction(
  assignmentId: string,
): Promise<ActionResult> {
  const ctx = await requirePlatformContext()

  if (ctx.role !== 'super_admin') {
    return { success: false, error: 'Solo el Super Admin puede revocar operators.' }
  }

  // Fetch assignment before revoking so we can close the operator's open sessions.
  const adminClient = createAdminClient()
  const { data: assignment } = await adminClient
    .from('tenant_setup_assignments')
    .select('tenant_id, operator_id')
    .eq('id', assignmentId)
    .maybeSingle()

  if (!assignment) {
    return { success: false, error: 'Assignment no encontrado.' }
  }

  try {
    await repo.revokeSetupAssignment(assignmentId, ctx.userId)
  } catch {
    return { success: false, error: 'Error al revocar el operator. Intentá de nuevo.' }
  }

  // Non-fatal: close open sessions for this operator+tenant.
  try {
    await repo.closeSetupSessionsForTenantOperator(assignment.tenant_id, assignment.operator_id)
  } catch (e) {
    console.error('[revokeSetupOperatorAction] closeSetupSessionsForTenantOperator failed:', e)
  }

  revalidatePath(TENANTS_PATH)
  return { success: true }
}

// ─── Setup impersonation — enter / exit CRM in setup mode ────────────────────

export async function startSetupImpersonationAction(
  tenantId: string,
): Promise<ActionResult> {
  if (!tenantId) return { success: false, error: 'tenant_id requerido.' }

  const ctx = await requirePlatformContext()

  if (!ctx.isOperator && !ctx.isSuperAdmin) {
    return { success: false, error: 'Sin permiso para acceder al CRM en modo setup.' }
  }

  // Operators must have a valid assignment AND the tenant must still be in setup.
  if (ctx.isOperator) {
    const assignment = await repo.getActiveOperatorAssignment(ctx.userId, tenantId)
    if (!assignment) {
      return { success: false, error: 'No tenés un assignment activo para este tenant.' }
    }

    const adminClient = createAdminClient()
    const { data: tenant } = await adminClient
      .from('tenants')
      .select('status, onboarding_status, deleted_at')
      .eq('id', tenantId)
      .maybeSingle()

    const SETUP_DONE_ONBOARDING = new Set(['ready_to_deliver', 'delivered'])

    if (!tenant || tenant.deleted_at != null || tenant.status !== 'trial') {
      return { success: false, error: 'Este tenant no está disponible para setup.' }
    }
    if (SETUP_DONE_ONBOARDING.has(tenant.onboarding_status ?? '')) {
      return { success: false, error: 'Este tenant ya fue entregado. El acceso de setup ya no está disponible.' }
    }
  }

  // End any existing open session for this platform user (only one at a time).
  const existing = await repo.getActiveImpersonationSession(ctx.userId)
  if (existing) {
    await repo.endImpersonationSession(existing.id)
  }

  const reason = ctx.isOperator ? 'setup_initial_data' : 'sa_setup_support'

  try {
    await repo.createImpersonationSession(ctx.userId, tenantId, reason)
    return { success: true }
  } catch {
    return { success: false, error: 'Error al iniciar el modo setup. Intentá de nuevo.' }
  }
}

export async function endSetupImpersonationAction(): Promise<ActionResult> {
  const ctx = await requirePlatformContext()

  const session = await repo.getActiveImpersonationSession(ctx.userId)
  if (!session) return { success: true }

  try {
    await repo.endImpersonationSession(session.id)
    return { success: true }
  } catch {
    return { success: false, error: 'Error al cerrar el modo setup. Intentá de nuevo.' }
  }
}

// ─── Complete setup assignment (operator marks own work done) ─────────────────

export async function completeSetupAssignmentAction(
  assignmentId: string,
): Promise<ActionResult> {
  const ctx = await requirePlatformContext()

  if (ctx.role !== 'operator') {
    return { success: false, error: 'Solo un operator puede marcar el setup como completado.' }
  }

  const admin = createAdminClient()
  const { data: assignment } = await admin
    .from('tenant_setup_assignments')
    .select('tenant_id, operator_id, status')
    .eq('id', assignmentId)
    .maybeSingle()

  if (!assignment) return { success: false, error: 'Assignment no encontrado.' }
  if (assignment.operator_id !== ctx.userId) {
    return { success: false, error: 'No podés completar un assignment que no es tuyo.' }
  }
  if (assignment.status !== 'active') {
    return { success: false, error: 'El assignment ya no está activo.' }
  }

  try {
    await repo.completeSetupAssignment(assignmentId, ctx.userId)
    await repo.updateTenantSetupStatus(assignment.tenant_id, 'completed')
    revalidatePath('/platform/setup')
    return { success: true }
  } catch {
    return { success: false, error: 'Error al marcar el setup como completado. Intentá de nuevo.' }
  }
}
