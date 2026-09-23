'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requirePlatformContext } from '@/lib/auth/require-platform-context'
import { createAdminClient } from '@orderflow/supabase/admin'
import * as repo from '@/lib/repositories/platform.repository'
import type { ActionResult } from '@/lib/action-result'
import {
  issueAccessLink,
  ACCESS_LINK_RATE_LIMIT,
  ACCESS_LINK_REDIRECT_INVALID,
  type AccessLink,
} from '@/lib/auth/issue-access-link'
import { sendAccessEmail } from '@/lib/auth/send-access-email'
import { PLANS, getPlanConfig } from '@/lib/plans'
import { DEFAULT_COUNTRY_CODE, defaultsForCountry } from '@/lib/tenant-provisioning'
import { getAuthRedirectTo } from '@/lib/site-url'
import {
  tenantKindSchema,
  foodCapabilitiesSchema,
  mappingForTenantKind,
  planLimitsForTenantKind,
  tenantKindFrom,
  DEFAULT_FOOD_CAPABILITIES,
} from '@orderflow/validators'

const PLATFORM_PATH    = '/platform'
const TENANTS_PATH     = '/platform/tenants'
const SELLERS_PATH     = '/platform/sellers'

const VALID_ONBOARDING = new Set([
  'pending_review', 'approved', 'meta_setup', 'testing',
  'ready_to_deliver', 'delivered', 'rejected',
])
const VALID_TENANT_STATUS = new Set(['trial', 'active', 'suspended', 'cancelled', 'churned'])

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  // El TIPO de cliente, no el vertical. El vertical se deriva: así no existe
  // forma de mandar un par (vertical, client_type) incoherente desde el
  // cliente, porque el cliente nunca elige el vertical.
  //
  // Es requerido y falla cerrado: un valor desconocido no cae en un default
  // permisivo, corta en la validación. Antes el alta ni siquiera nombraba el
  // vertical y todo nacía real_estate por el default de la columna.
  kind:                tenantKindSchema,
  // Sólo se usan si kind === 'food_business'. Si no vienen, el alta toma el
  // default del producto (los tres habilitados).
  capabilities:        foodCapabilitiesSchema.optional(),
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

  // El tipo decide TODO lo demás: en qué vertical cae, qué topes tiene y si
  // las capacidades gastronómicas aplican. Un solo lugar de traducción.
  const { vertical, clientType } = mappingForTenantKind(d.kind)
  const limits = planLimitsForTenantKind(d.kind)

  const capabilities = d.kind === 'food_business'
    ? (d.capabilities ?? DEFAULT_FOOD_CAPABILITIES)
    : null

  try {
    const tenant = await repo.createTenant({
      vertical,
      client_type:  clientType,
      limits,
      capabilities,
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

  // Se valida la configuración temprano para fallar con un mensaje útil; la
  // URL en sí la arma issueAccessLink.
  try {
    getAuthRedirectTo()
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
    // El owner ya tiene su fila de tenant_users: acá no hay nada que persistir
    // antes, así que se emite el acceso y se manda el email de ReservaNex.
    // issueAccessLink decide invite vs recovery, y el copy lo acompaña.
    let emailSent = false
    let kind: AccessLink['kind'] | undefined
    try {
      const link = await issueAccessLink(normalizedEmail, { allowRecoveryForConfirmed: true })
      kind = link.kind
      const envio = await sendAccessEmail({
        to: normalizedEmail, role: 'owner', kind: link.kind, accessUrl: link.url,
        businessName: tenant.name, recipientName: tenant.primary_owner_name,
      })
      emailSent = envio.ok

      console.log('[platform:invite-owner] resend', {
        tenantId, email: normalizedEmail, authUserId: existingTU.id, kind, emailSent,
      })
    } catch (resendErr) {
      const errMsg = resendErr instanceof Error ? resendErr.message : String(resendErr)
      console.warn('[platform:invite-owner] issueAccessLink failed during resend (non-fatal)', {
        tenantId,
        email: normalizedEmail,
        error: errMsg,
      })
    }

    // owner_invited_at/by significan "se generó la invitación", no "el email se
    // entregó": hoy se marcan igual aunque el envío falle, y esa semántica se
    // conserva. Reinterpretarla sería cambiar el significado de una columna
    // histórica sin migración.
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
      return {
        success: true,
        warning: 'No se pudo enviar el email automáticamente. Revisá la configuración de Resend (RESEND_API_KEY y dominio verificado) y volvé a intentar.',
      }
    }

    // 'recovery' significa que el owner YA había confirmado su cuenta alguna
    // vez: decirle "te invitamos de nuevo" sería engañoso, y el email que
    // recibió tampoco lo dice.
    if (kind === 'recovery') {
      return { success: true, warning: 'El owner ya había confirmado su cuenta anteriormente — se le envió un email de acceso, no una invitación nueva.' }
    }
    return { success: true }
  }

  // ── Step 2: Primera invitación — emitir el acceso (NO envía email) ───────
  // El email sale recién en el Step 5, con tenant_users ya persistido.
  let link: AccessLink
  try {
    link = await issueAccessLink(normalizedEmail, { allowRecoveryForConfirmed: true })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : ''
    console.error('[platform:invite-owner] issueAccessLink failed', {
      tenantId,
      email: normalizedEmail,
      error: errMsg,
    })
    if (errMsg === ACCESS_LINK_RATE_LIMIT) {
      return { success: false, error: 'Supabase limitó la generación de accesos temporalmente. Esperá unos minutos.' }
    }
    if (errMsg === ACCESS_LINK_REDIRECT_INVALID) {
      return { success: false, error: 'La URL de redirección de Auth no está habilitada en Supabase. Revisá Authentication → URL Configuration → Redirect URLs.' }
    }
    return { success: false, error: 'Error al generar la invitación. Intentá de nuevo.' }
  }

  const authUserId = link.userId
  const isNewUser  = link.isNewUser

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
  // Semántica conservada: marca que la invitación se GENERÓ, no que el email
  // se entregó. Por eso va antes del envío y no depende de su resultado.
  try {
    await repo.markOwnerInvited(tenantId, ctx.userId)
  } catch (markErr) {
    console.error('[platform:invite-owner] markOwnerInvited failed (non-fatal)', {
      tenantId,
      email: normalizedEmail,
      error: markErr instanceof Error ? markErr.message : String(markErr),
    })
  }

  // ── Step 5: recién ahora, el email ───────────────────────────────────────
  const envio = await sendAccessEmail({
    to: normalizedEmail, role: 'owner', kind: link.kind, accessUrl: link.url,
    businessName: tenant.name, recipientName: tenant.primary_owner_name,
  })

  revalidatePath(`${TENANTS_PATH}/${tenantId}`)

  console.log('[platform:invite-owner]', {
    tenantId,
    email:                 normalizedEmail,
    authUserId,
    kind:                  link.kind,
    emailSent:             envio.ok,
    tenantUserCreated:     true,
    ownerInvitedAtUpdated: true,
  })

  if (!envio.ok) {
    return {
      success: true,
      warning: 'El owner fue registrado, pero no se pudo enviar el email automáticamente. Revisá la configuración de Resend (RESEND_API_KEY y dominio verificado) y reenviá la invitación.',
    }
  }

  if (link.kind === 'recovery') {
    return { success: true, warning: 'El owner ya había confirmado su cuenta anteriormente — se le envió un email de acceso, no una invitación nueva.' }
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

  // Se valida la configuración temprano para fallar con un mensaje útil antes
  // de tocar la base; la URL en sí la arma issueAccessLink.
  try {
    getAuthRedirectTo()
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
    // Seller inactivo: se reactiva y se le reenvía el acceso.
    await admin
      .from('platform_users')
      .update({ active: true, name, updated_at: new Date().toISOString() })
      .eq('id', existingPU.id)
    await admin.auth.admin.updateUserById(existingPU.id, { ban_duration: 'none' }).catch(() => {})

    // El email va DESPUÉS de reactivar la fila: si el envío falla, el seller
    // ya quedó utilizable y el reenvío manual alcanza.
    const reenvio = await issueAndSendSellerAccess(normalizedEmail, name)
    console.log('[platform:create-seller] seller reactivated', {
      email: normalizedEmail, authUserId: existingPU.id, emailSent: reenvio.emailSent,
    })
    revalidatePath(SELLERS_PATH)
    return reenvio.emailSent
      ? { success: true, data: { id: existingPU.id } }
      : { success: true, data: { id: existingPU.id }, warning: SELLER_EMAIL_WARNING }
  }

  // ── Step 2: emitir el link de acceso (NO envía email) ─────────────────────
  // generateLink acuña el token y crea el usuario de Auth si no existe; el
  // email lo arma ReservaNex y lo entrega Resend, después de persistir.
  let link: AccessLink
  try {
    link = await issueAccessLink(normalizedEmail, { allowRecoveryForConfirmed: true })
  } catch (err) {
    const code = err instanceof Error ? err.message : ''
    console.error('[platform:create-seller] issueAccessLink failed', { email: normalizedEmail, code })
    if (code === ACCESS_LINK_RATE_LIMIT) {
      return { success: false, error: 'Supabase limitó la generación de accesos. Esperá unos minutos.' }
    }
    if (code === ACCESS_LINK_REDIRECT_INVALID) {
      return { success: false, error: 'La URL de redirección de Auth no está habilitada en Supabase. Revisá Authentication → URL Configuration → Redirect URLs.' }
    }
    return { success: false, error: 'Error al generar el acceso del seller. Intentá de nuevo.' }
  }

  // ── Step 3: Upsert platform_users with auth user ID ───────────────────────
  // Upsert handles re-invite scenarios where a previous attempt created the
  // auth user but failed before writing platform_users.
  const { data: pu, error: puError } = await admin
    .from('platform_users')
    .upsert(
      { id: link.userId, name, email: normalizedEmail, role: 'seller' as const, active: true },
      { onConflict: 'id' },
    )
    .select()
    .single()

  if (puError || !pu) {
    console.error('[platform:create-seller] platform_users upsert failed', {
      email:        normalizedEmail,
      authUserId:   link.userId,
      errorCode:    puError?.code,
      errorMessage: puError?.message,
    })
    return { success: false, error: 'Error al registrar el seller en la base de datos. Intentá de nuevo.' }
  }

  // ── Step 4: recién ahora, el email ────────────────────────────────────────
  const envio = await sendAccessEmail({
    to: normalizedEmail, role: 'seller', kind: link.kind, accessUrl: link.url, recipientName: name,
  })

  console.log('[platform:create-seller] seller created', {
    email:     normalizedEmail,
    authUserId: link.userId,
    kind:      link.kind,
    emailSent: envio.ok,
  })

  revalidatePath(SELLERS_PATH)
  revalidatePath(PLATFORM_PATH)

  if (!envio.ok) {
    return { success: true, data: { id: pu.id }, warning: SELLER_EMAIL_WARNING }
  }

  return { success: true, data: { id: pu.id } }
}

const SELLER_EMAIL_WARNING =
  'El seller quedó creado, pero no se pudo enviar el email de acceso. Revisá la configuración de Resend ' +
  '(RESEND_API_KEY y dominio verificado) y reenviá la invitación desde el listado.'

/**
 * Emite el acceso y manda el email del seller. Se usa en los caminos donde la
 * fila de platform_users YA existe (reactivación y reenvío), así que el orden
 * persistir-antes-de-enviar ya está garantizado por quien llama.
 */
async function issueAndSendSellerAccess(
  email: string,
  name?: string | null,
): Promise<{ emailSent: boolean; kind?: AccessLink['kind'] }> {
  try {
    const link = await issueAccessLink(email, { allowRecoveryForConfirmed: true })
    const sent = await sendAccessEmail({
      to: email, role: 'seller', kind: link.kind, accessUrl: link.url, recipientName: name ?? null,
    })
    return { emailSent: sent.ok, kind: link.kind }
  } catch (err) {
    console.error('[platform:seller-access] no se pudo emitir el acceso', {
      email, code: err instanceof Error ? err.message : String(err),
    })
    return { emailSent: false }
  }
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

  // El seller ya existe en platform_users, así que acá no hay nada que
  // persistir antes: se emite el acceso y se manda el email de ReservaNex.
  // Si la cuenta ya está confirmada, issueAccessLink devuelve kind 'recovery'
  // y el email cambia de copy — nunca dice "te invitaron" a quien ya entró.
  let link: AccessLink
  try {
    link = await issueAccessLink(normalizedEmail, { allowRecoveryForConfirmed: true })
  } catch (err) {
    const code = err instanceof Error ? err.message : ''
    console.error('[platform:resend-seller] issueAccessLink failed', { sellerId, code })
    if (code === ACCESS_LINK_RATE_LIMIT) {
      return { success: false, error: 'Supabase limitó la generación de accesos temporalmente. Esperá unos minutos.' }
    }
    if (code === ACCESS_LINK_REDIRECT_INVALID) {
      return { success: false, error: 'La URL de redirección de Auth no está habilitada en Supabase.' }
    }
    return { success: false, error: 'Error al reenviar la invitación. Intentá de nuevo.' }
  }

  const envio = await sendAccessEmail({
    to: normalizedEmail, role: 'seller', kind: link.kind, accessUrl: link.url, recipientName: seller.name,
  })

  console.log('[platform:resend-seller]', { sellerId, email: normalizedEmail, kind: link.kind, emailSent: envio.ok })

  revalidatePath(SELLERS_PATH)

  if (!envio.ok) {
    return {
      success: true,
      warning: 'No se pudo enviar el email automáticamente. Revisá la configuración de Resend; el seller también puede pedir acceso desde el login.',
    }
  }
  return { success: true }
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
  if (!tenant) return { success: false, error: 'Cliente no encontrado.' }

  // Los planes de agentes son inmobiliarios. Aplicarlos a un Particular
  // pisaría su regla de 5 propiedades / 3 usuarios con los topes del plan; y
  // gastronomía no tiene pricing definido, así que no se le adjudica uno
  // prestado. La UI ya no ofrece los botones fuera de agency, pero la
  // autoridad es esta: un POST armado a mano tiene que fallar igual.
  if (tenantKindFrom(tenant.vertical, tenant.client_type) !== 'agency') {
    return { success: false, error: 'Los planes de agentes son solo para inmobiliarias.' }
  }

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

  if (!tenant) return { success: false, error: 'Cliente no encontrado.' }
  if (!operator || operator.role !== 'operator') {
    return { success: false, error: 'Operator no encontrado.' }
  }

  // El setup por operator es del flujo inmobiliario. Un restaurante se
  // configura entre el super_admin (AutoResponder, Android) y el owner
  // (menú, negocio, IA): no hay tarea de operator en el medio, y el modo
  // setup_operator ni siquiera puede tocar la carta. La UI ya no ofrece el
  // select para gastronomía; la autoridad es esta.
  if (tenant.vertical !== 'real_estate') {
    return { success: false, error: 'El setup por operator sólo aplica a clientes inmobiliarios.' }
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
      .select('status, onboarding_status, deleted_at, vertical')
      .eq('id', tenantId)
      .maybeSingle()

    const SETUP_DONE_ONBOARDING = new Set(['ready_to_deliver', 'delivered'])

    if (!tenant || tenant.deleted_at != null || tenant.status !== 'trial') {
      return { success: false, error: 'Este tenant no está disponible para setup.' }
    }
    // Aunque exista una asignación histórica: un operator no entra en modo
    // setup a un restaurante. Sólo la rama de operator — la impersonación
    // normal del super_admin no pasa por acá y no cambia.
    if (tenant.vertical !== 'real_estate') {
      return { success: false, error: 'El setup por operator sólo aplica a clientes inmobiliarios.' }
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
