'use server'

import { revalidatePath } from 'next/cache'
import { requireSuperAdmin } from '@/lib/auth/require-platform-context'
import { createAdminClient } from '@orderflow/supabase/admin'
import type { ActionResult } from '@/lib/action-result'

// Sanitized — never includes access_token_encrypted
export type WhatsAppPlatformData = {
  id:                   string
  tenant_id:            string
  phone_number:         string
  business_account_id:  string
  display_phone_number: string | null
  active:               boolean
  has_token:            boolean
  last_verified_at:     string | null
  created_at:           string
  updated_at:           string
}

export type SaveWhatsAppPlatformInput = {
  phone_number:         string
  business_account_id:  string
  display_phone_number: string
  access_token?:        string
  webhook_secret?:      string
}

export type SubscriptionStatus = 'subscribed' | 'subscribed_now' | 'failed' | 'unknown'

export type TestConnectionResult = {
  ok:                    boolean
  display_phone_number?: string
  verified_name?:        string
  quality_rating?:       string
  platform_type?:        string
  error?:                string
  // WABA / webhook checks
  phone_number_in_waba?: boolean
  subscription_status?:  SubscriptionStatus
  subscription_error?:   string
}

// ── A) Get WhatsApp settings for a tenant (SA only) ──────────────────────────
export async function getTenantWhatsAppSettingsForPlatformAction(
  tenantId: string,
): Promise<ActionResult<WhatsAppPlatformData | null>> {
  await requireSuperAdmin()

  const admin = createAdminClient()

  const { data: tenant } = await admin
    .from('tenants')
    .select('id')
    .eq('id', tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!tenant) return { success: false, error: 'Tenant no encontrado.' }

  const { data, error } = await admin
    .from('whatsapp_accounts')
    .select('id, tenant_id, phone_number, business_account_id, display_phone_number, active, access_token_encrypted, last_verified_at, created_at, updated_at')
    .eq('tenant_id', tenantId)
    .eq('provider', 'meta') // this page configures Meta Cloud API only — never surface an autoresponder row here
    .eq('active', true)
    .maybeSingle()

  if (error) return { success: false, error: error.message }
  if (!data)  return { success: true, data: null }

  return {
    success: true,
    data: {
      id:                   data.id,
      tenant_id:            data.tenant_id,
      phone_number:         data.phone_number,
      // whatsapp_accounts_provider_fields_check guarantees this is non-null
      // for provider='meta' rows (the filter above) — the '' fallback is
      // purely to satisfy TypeScript, which can't see that DB constraint.
      business_account_id:  data.business_account_id ?? '',
      display_phone_number: data.display_phone_number ?? null,
      active:               data.active,
      has_token:            Boolean(data.access_token_encrypted),
      last_verified_at:     data.last_verified_at ?? null,
      created_at:           data.created_at,
      updated_at:           data.updated_at,
    },
  }
}

// ── B) Save settings (SA only) ───────────────────────────────────────────────
export async function saveWhatsAppSettingsBySuperAdminAction(
  tenantId: string,
  input: SaveWhatsAppPlatformInput,
): Promise<ActionResult<{ id: string }>> {
  await requireSuperAdmin()

  if (!input.phone_number?.trim())        return { success: false, error: 'El Phone Number ID es requerido.' }
  if (!input.business_account_id?.trim()) return { success: false, error: 'El WABA ID es requerido.' }

  const admin = createAdminClient()

  const { data: tenant } = await admin
    .from('tenants')
    .select('id, onboarding_status')
    .eq('id', tenantId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!tenant) return { success: false, error: 'Tenant no encontrado.' }

  const phoneNumber = input.phone_number.trim()
  const wabaId      = input.business_account_id.trim()

  // Look up existing account by the 3-way key (tenant_id, business_account_id, phone_number)
  const { data: exactMatch } = await admin
    .from('whatsapp_accounts')
    .select('id, access_token_encrypted')
    .eq('tenant_id', tenantId)
    .eq('business_account_id', wabaId)
    .eq('phone_number', phoneNumber)
    .maybeSingle()

  const incomingToken = input.access_token?.trim()
  const tokenToStore  = incomingToken || exactMatch?.access_token_encrypted || ''

  if (!tokenToStore) {
    return { success: false, error: 'El access token es requerido para la configuración inicial.' }
  }

  const defaultWebhookSecret = process.env.META_WEBHOOK_VERIFY_TOKEN ?? 'reservanex-dev-2026'
  const webhookSecret         = input.webhook_secret?.trim() || defaultWebhookSecret

  const payload = {
    display_phone_number:   input.display_phone_number?.trim() || null,
    phone_number:           phoneNumber,
    business_account_id:    wabaId,
    webhook_secret:         webhookSecret,
    access_token_encrypted: tokenToStore,
    active:                 true,
  }

  let savedId: string

  if (exactMatch) {
    const { error } = await admin
      .from('whatsapp_accounts')
      .update(payload)
      .eq('id', exactMatch.id)

    if (error) return { success: false, error: error.message }
    savedId = exactMatch.id
  } else {
    // Deactivate any other active accounts for this tenant before inserting
    await admin
      .from('whatsapp_accounts')
      .update({ active: false })
      .eq('tenant_id', tenantId)
      .eq('active', true)

    const { data: created, error: insertErr } = await admin
      .from('whatsapp_accounts')
      .insert({ tenant_id: tenantId, ...payload })
      .select('id')
      .single()

    if (insertErr?.code === '23505') {
      return { success: false, error: 'Ya existe una cuenta activa con ese número. Actualizá la configuración existente.' }
    }
    if (insertErr || !created) {
      return { success: false, error: insertErr?.message ?? 'No se pudo crear la configuración.' }
    }
    savedId = created.id
  }

  // Advance onboarding_status if still in early stages
  if (['pending_review', 'approved'].includes(tenant.onboarding_status)) {
    await admin
      .from('tenants')
      .update({ onboarding_status: 'meta_setup' })
      .eq('id', tenantId)
  }

  revalidatePath(`/platform/tenants/${tenantId}/whatsapp`)
  revalidatePath(`/platform/tenants/${tenantId}`)
  return { success: true, data: { id: savedId } }
}

// ── C) Deactivate an account (SA only) ──────────────────────────────────────
export async function deactivateTenantWhatsAppAccountBySAAction(
  accountId: string,
): Promise<ActionResult> {
  await requireSuperAdmin()

  const admin = createAdminClient()

  // Fetch first to get tenant_id for revalidation
  const { data: account } = await admin
    .from('whatsapp_accounts')
    .select('id, tenant_id')
    .eq('id', accountId)
    .maybeSingle()

  if (!account) return { success: false, error: 'Cuenta no encontrada.' }

  const { error } = await admin
    .from('whatsapp_accounts')
    .update({ active: false })
    .eq('id', accountId)

  if (error) return { success: false, error: error.message }

  revalidatePath(`/platform/tenants/${account.tenant_id}/whatsapp`)
  revalidatePath(`/platform/tenants/${account.tenant_id}`)
  return { success: true }
}

// ── D) Test WhatsApp connection via Graph API (SA only) ──────────────────────
export async function testTenantWhatsAppConnectionAction(
  accountId: string,
): Promise<ActionResult<TestConnectionResult>> {
  await requireSuperAdmin()

  const admin = createAdminClient()

  const { data: account } = await admin
    .from('whatsapp_accounts')
    .select('id, tenant_id, phone_number, business_account_id, access_token_encrypted, active')
    .eq('id', accountId)
    .maybeSingle()

  if (!account)                        return { success: false, error: 'Cuenta no encontrada.' }
  if (!account.active)                 return { success: false, error: 'La cuenta está inactiva.' }
  if (!account.access_token_encrypted) return { success: false, error: 'No hay token configurado.' }

  const token        = account.access_token_encrypted
  const phoneId      = account.phone_number
  const wabaId       = account.business_account_id
  const BASE         = 'https://graph.facebook.com/v23.0'
  const authHeader   = { Authorization: `Bearer ${token}` }
  const timeoutSig   = () => AbortSignal.timeout(10_000)

  // ── 1. Parallel: phone number details + WABA phone list + subscription check ──
  const phoneFields = 'id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type'

  let phoneResp: Response, wabaPhoneResp: Response, subResp: Response
  try {
    ;[phoneResp, wabaPhoneResp, subResp] = await Promise.all([
      fetch(`${BASE}/${phoneId}?fields=${phoneFields}`, { headers: authHeader, signal: timeoutSig() }),
      fetch(`${BASE}/${wabaId}/phone_numbers?fields=id`, { headers: authHeader, signal: timeoutSig() }),
      fetch(`${BASE}/${wabaId}/subscribed_apps`,          { headers: authHeader, signal: timeoutSig() }),
    ])
  } catch (err) {
    return { success: true, data: { ok: false, error: err instanceof Error ? err.message : 'Error de red.' } }
  }

  // ── 2. Phone number details ───────────────────────────────────────────────────
  type GraphError = { error?: { message?: string } }
  type PhoneBody  = { id?: string; display_phone_number?: string; verified_name?: string; quality_rating?: string; platform_type?: string }
  type WabaPhoneBody = { data?: { id: string }[] }
  type SubBody    = { data?: { id: string; name?: string }[] }

  if (!phoneResp.ok) {
    const body   = await phoneResp.json().catch(() => ({})) as GraphError
    const errMsg = body.error?.message ?? `HTTP ${phoneResp.status}`
    return { success: true, data: { ok: false, error: errMsg } }
  }

  const phoneBody = await phoneResp.json() as PhoneBody

  // ── 3. WABA contains the Phone Number ID? ────────────────────────────────────
  let phoneNumberInWaba: boolean | undefined
  try {
    if (wabaPhoneResp.ok) {
      const wabaBody = await wabaPhoneResp.json() as WabaPhoneBody
      phoneNumberInWaba = (wabaBody.data ?? []).some((p) => p.id === phoneId)
    }
  } catch {
    // Non-blocking — leave undefined if the check fails
  }

  if (phoneNumberInWaba === false) {
    return {
      success: true,
      data: {
        ok:    false,
        error: `El Phone Number ID ${phoneId} no pertenece al WABA ${wabaId}. Verificá los IDs.`,
        phone_number_in_waba: false,
      },
    }
  }

  // ── 4. Webhook subscription ───────────────────────────────────────────────────
  let subscriptionStatus: SubscriptionStatus = 'unknown'
  let subscriptionError: string | undefined

  try {
    if (subResp.ok) {
      const subBody = await subResp.json() as SubBody
      const isSubscribed = (subBody.data ?? []).length > 0

      if (isSubscribed) {
        subscriptionStatus = 'subscribed'
      } else {
        // Try to subscribe
        let postResp: Response
        try {
          postResp = await fetch(`${BASE}/${wabaId}/subscribed_apps`, {
            method:  'POST',
            headers: authHeader,
            signal:  timeoutSig(),
          })
        } catch (err) {
          subscriptionStatus = 'failed'
          subscriptionError  = err instanceof Error ? err.message : 'Error de red al suscribir.'
          postResp           = new Response(null, { status: 0 })
        }

        if (postResp.status > 0 && postResp.ok) {
          // Verify subscription after POST
          const verifyResp = await fetch(`${BASE}/${wabaId}/subscribed_apps`, {
            headers: authHeader,
            signal:  timeoutSig(),
          }).catch(() => null)

          if (verifyResp?.ok) {
            const verifyBody = await verifyResp.json() as SubBody
            subscriptionStatus = (verifyBody.data ?? []).length > 0 ? 'subscribed_now' : 'failed'
            if (subscriptionStatus === 'failed') {
              subscriptionError = 'La suscripción se registró pero no se confirmó en la verificación.'
            }
          } else {
            subscriptionStatus = 'subscribed_now' // POST was ok, assume success
          }
        } else if (postResp.status > 0 && !postResp.ok) {
          const errBody      = await postResp.json().catch(() => ({})) as GraphError
          subscriptionStatus = 'failed'
          subscriptionError  = errBody.error?.message ?? `HTTP ${postResp.status} al suscribir.`
        }
      }
    }
  } catch {
    subscriptionStatus = 'unknown'
  }

  // ── 5. Persist verification timestamp + advance onboarding ───────────────────
  await admin
    .from('whatsapp_accounts')
    .update({ last_verified_at: new Date().toISOString() })
    .eq('id', accountId)

  const { data: tenant } = await admin
    .from('tenants')
    .select('onboarding_status')
    .eq('id', account.tenant_id)
    .maybeSingle()

  if (tenant?.onboarding_status === 'meta_setup') {
    await admin
      .from('tenants')
      .update({ onboarding_status: 'testing' })
      .eq('id', account.tenant_id)
  }

  revalidatePath(`/platform/tenants/${account.tenant_id}/whatsapp`)
  revalidatePath(`/platform/tenants/${account.tenant_id}`)

  return {
    success: true,
    data: {
      ok:                   true,
      display_phone_number: phoneBody.display_phone_number,
      verified_name:        phoneBody.verified_name,
      quality_rating:       phoneBody.quality_rating,
      platform_type:        phoneBody.platform_type,
      phone_number_in_waba: phoneNumberInWaba,
      subscription_status:  subscriptionStatus,
      subscription_error:   subscriptionError,
    },
  }
}
