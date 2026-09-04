'use server'

import { revalidatePath } from 'next/cache'
import { z }              from 'zod'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { requireOwner }         from '@/lib/auth/require-owner'
import { createClient }         from '@orderflow/supabase/server'
import type { ActionResult }    from '@/lib/action-result'

// ── URL helper — empty/null collapses to null ─────────────────────────────────

const urlOrNull = z
  .string()
  .max(500, 'URL demasiado larga.')
  .optional()
  .nullable()
  .or(z.literal(''))
  .transform(v => (v === '' || v == null ? null : v.trim()))

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type BusinessSettings = {
  name:                  string
  public_phone:          string | null
  public_email:          string | null
  public_website_url:    string | null
  public_instagram_url:  string | null
  public_facebook_url:   string | null
  public_tiktok_url:     string | null
  public_about_html:     string | null
  public_wa_pretext:     string | null
  business_hours:        Record<string, string>
}

export type PaymentConfig = {
  payment_alias:           string | null
  payment_cbu:             string | null
  payment_account_holder:  string | null
  payment_bank:            string | null
  payment_notes:           string | null
  payment_request_message: string | null
  receipt_footer_text:     string | null
  receipt_show_logo:       boolean
}

export type BotSettings = {
  active:                           boolean
  assistant_name:                   string
  bot_tone:                         'professional' | 'friendly' | 'premium' | 'casual'
  bot_use_emojis:                   boolean
  bot_send_property_links:          boolean
  escalation_keywords:              string[]
  response_delay_ms:                number
  max_context_messages:             number
  max_turns_before_escalation:      number
  pending_reservation_hold_minutes: number
}

// ─────────────────────────────────────────────────────────────────────────────
// A) BUSINESS SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

export async function getBusinessSettingsAction(): Promise<ActionResult<BusinessSettings>> {
  const ctx = await requireTenantContext()

  if (ctx.role !== 'owner' && !ctx.canAccessSettings) {
    return { success: false, error: 'Sin acceso a la configuración.' }
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from('tenants')
    .select('name, public_phone, public_email, public_website_url, public_instagram_url, public_facebook_url, public_tiktok_url, public_about_html, public_wa_pretext, business_hours')
    .eq('id', ctx.tenantId)
    .single()

  if (error || !data) return { success: false, error: 'No se pudo cargar la configuración.' }

  return {
    success: true,
    data: {
      name:                 data.name                 ?? '',
      public_phone:         data.public_phone          ?? null,
      public_email:         data.public_email          ?? null,
      public_website_url:   data.public_website_url    ?? null,
      public_instagram_url: data.public_instagram_url  ?? null,
      public_facebook_url:  data.public_facebook_url   ?? null,
      public_tiktok_url:    data.public_tiktok_url     ?? null,
      public_about_html:    data.public_about_html     ?? null,
      public_wa_pretext:    data.public_wa_pretext      ?? null,
      // business_hours is Json in generated types; cast to the expected shape
      business_hours:       (data.business_hours as Record<string, string>) ?? {},
    },
  }
}

const businessInfoSchema = z.object({
  public_phone:         z.string().max(30).optional().nullable()
    .transform(v => v?.trim() || null),
  public_email:         z.string().email('Email inválido.').max(200).optional().nullable()
    .or(z.literal('')).transform(v => (v === '' ? null : v?.trim() || null)),
  public_website_url:   urlOrNull,
  public_instagram_url: urlOrNull,
  public_facebook_url:  urlOrNull,
  public_tiktok_url:    urlOrNull,
  public_about_html:    z.string().max(5000, 'Texto demasiado largo (máx. 5000 caracteres).').optional().nullable()
    .transform(v => v?.trim() || null),
  public_wa_pretext:    z.string().max(300, 'Máximo 300 caracteres.').optional().nullable()
    .transform(v => v?.trim() || null),
  business_hours:       z.record(z.string().max(50)).optional().default({}),
})

export async function updateBusinessInfoAction(input: unknown): Promise<ActionResult> {
  const { tenantId } = await requireOwner()

  const parsed = businessInfoSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos.' }
  }

  const d = parsed.data
  const supabase = await createClient()

  const { error } = await supabase
    .from('tenants')
    .update({
      public_phone:         d.public_phone,
      public_email:         d.public_email,
      public_website_url:   d.public_website_url,
      public_instagram_url: d.public_instagram_url,
      public_facebook_url:  d.public_facebook_url,
      public_tiktok_url:    d.public_tiktok_url,
      public_about_html:    d.public_about_html,
      public_wa_pretext:    d.public_wa_pretext,
      business_hours:       d.business_hours,
      updated_at:           new Date().toISOString(),
    })
    .eq('id', tenantId)

  if (error) return { success: false, error: error.message }

  revalidatePath('/dashboard/settings/business')
  return { success: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// B) PAYMENT CONFIG
// ─────────────────────────────────────────────────────────────────────────────

export async function getPaymentConfigAction(): Promise<ActionResult<PaymentConfig>> {
  const { tenantId } = await requireOwner()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('tenants')
    .select('payment_alias, payment_cbu, payment_account_holder, payment_bank, payment_notes, payment_request_message, receipt_footer_text, receipt_show_logo')
    .eq('id', tenantId)
    .single()

  if (error || !data) return { success: false, error: 'No se pudo cargar la configuración de pagos.' }

  return {
    success: true,
    data: {
      payment_alias:           data.payment_alias           ?? null,
      payment_cbu:             data.payment_cbu             ?? null,
      payment_account_holder:  data.payment_account_holder  ?? null,
      payment_bank:            data.payment_bank            ?? null,
      payment_notes:           data.payment_notes           ?? null,
      payment_request_message: data.payment_request_message ?? null,
      receipt_footer_text:     data.receipt_footer_text     ?? null,
      receipt_show_logo:       data.receipt_show_logo       ?? true,
    },
  }
}

const paymentConfigSchema = z.object({
  payment_alias:           z.string().max(100).optional().nullable()
    .transform(v => v?.trim() || null),
  payment_cbu:             z.string().max(30).optional().nullable()
    .transform(v => v?.trim() || null),
  payment_account_holder:  z.string().max(200).optional().nullable()
    .transform(v => v?.trim() || null),
  payment_bank:            z.string().max(100).optional().nullable()
    .transform(v => v?.trim() || null),
  payment_notes:           z.string().max(1000, 'Máximo 1000 caracteres.').optional().nullable()
    .transform(v => v?.trim() || null),
  payment_request_message: z.string().max(500, 'Máximo 500 caracteres.').optional().nullable()
    .transform(v => v?.trim() || null),
  receipt_footer_text:     z.string().max(500, 'Máximo 500 caracteres.').optional().nullable()
    .transform(v => v?.trim() || null),
  receipt_show_logo:       z.boolean().default(true),
})

export async function updatePaymentConfigAction(input: unknown): Promise<ActionResult> {
  const { tenantId } = await requireOwner()

  const parsed = paymentConfigSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos.' }
  }

  const d = parsed.data
  const supabase = await createClient()

  const { error } = await supabase
    .from('tenants')
    .update({
      payment_alias:           d.payment_alias,
      payment_cbu:             d.payment_cbu,
      payment_account_holder:  d.payment_account_holder,
      payment_bank:            d.payment_bank,
      payment_notes:           d.payment_notes,
      payment_request_message: d.payment_request_message,
      receipt_footer_text:     d.receipt_footer_text,
      receipt_show_logo:       d.receipt_show_logo,
      updated_at:              new Date().toISOString(),
    })
    .eq('id', tenantId)

  if (error) return { success: false, error: error.message }

  revalidatePath('/dashboard/settings/payments')
  return { success: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// C) BOT SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

const BOT_DEFAULTS: BotSettings = {
  active:                           true,
  assistant_name:                   'Asistente',
  bot_tone:                         'professional',
  bot_use_emojis:                   false,
  bot_send_property_links:          true,
  escalation_keywords:              [
    'quiero ayuda',
    'necesito ayuda',
    'necesito que me ayuden',
    'quiero hablar con alguien',
    'quiero hablar con un humano',
    'hablar con humano',
    'persona real',
    'asesor',
    'asesora',
    'atención humana',
    'me pueden llamar',
    'llamame',
    'llámenme',
  ],
  response_delay_ms:                1500,
  max_context_messages:             10,
  max_turns_before_escalation:      20,
  pending_reservation_hold_minutes: 1440,
}

const VALID_TONES = ['professional', 'friendly', 'premium', 'casual'] as const

export async function getBotSettingsAction(): Promise<ActionResult<BotSettings>> {
  const { tenantId } = await requireOwner()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('ai_settings')
    .select('active, assistant_name, bot_tone, bot_use_emojis, bot_send_property_links, escalation_keywords, response_delay_ms, max_context_messages, max_turns_before_escalation, pending_reservation_hold_minutes')
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (error) return { success: false, error: error.message }

  // No row yet → return safe defaults (row is created on first upsert)
  if (!data) return { success: true, data: BOT_DEFAULTS }

  // bot_tone is typed as string in the DB — narrow to the known union
  const tone: BotSettings['bot_tone'] = VALID_TONES.includes(data.bot_tone as BotSettings['bot_tone'])
    ? (data.bot_tone as BotSettings['bot_tone'])
    : 'professional'

  return {
    success: true,
    data: {
      active:                           data.active                           ?? true,
      assistant_name:                   data.assistant_name                   ?? 'Asistente',
      bot_tone:                         tone,
      bot_use_emojis:                   data.bot_use_emojis                   ?? false,
      bot_send_property_links:          data.bot_send_property_links          ?? true,
      escalation_keywords:              (data.escalation_keywords as string[]) ?? [],
      response_delay_ms:                data.response_delay_ms                ?? 1500,
      max_context_messages:             data.max_context_messages             ?? 10,
      max_turns_before_escalation:      data.max_turns_before_escalation      ?? 20,
      pending_reservation_hold_minutes: data.pending_reservation_hold_minutes ?? 1440,
    },
  }
}

const botSettingsSchema = z.object({
  active:          z.boolean(),
  assistant_name:  z.string().min(1, 'Requerido.').max(60, 'Máximo 60 caracteres.').trim(),
  bot_tone:        z.enum(['professional', 'friendly', 'premium', 'casual'], {
    errorMap: () => ({ message: 'Tono inválido.' }),
  }),
  bot_use_emojis:          z.boolean(),
  bot_send_property_links: z.boolean(),
  escalation_keywords:     z
    .array(z.string().max(50).trim())
    .max(20, 'Máximo 20 palabras clave.')
    .default([]),
  response_delay_ms:                z.number().int().min(0).max(5000),
  max_context_messages:             z.number().int().min(5).max(30),
  max_turns_before_escalation:      z.number().int().min(2).max(8),
  pending_reservation_hold_minutes: z.number().int().min(15).max(10080).optional(),
})

export async function updateBotSettingsAction(input: unknown): Promise<ActionResult> {
  const { tenantId } = await requireOwner()

  const parsed = botSettingsSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos.' }
  }

  const d = parsed.data
  const supabase = await createClient()

  const { error } = await supabase
    .from('ai_settings')
    .upsert(
      {
        tenant_id:                   tenantId,
        active:                      d.active,
        assistant_name:              d.assistant_name,
        bot_tone:                    d.bot_tone,
        bot_use_emojis:              d.bot_use_emojis,
        bot_send_property_links:     d.bot_send_property_links,
        escalation_keywords:         d.escalation_keywords.filter(Boolean),
        response_delay_ms:           d.response_delay_ms,
        max_context_messages:        d.max_context_messages,
        max_turns_before_escalation: d.max_turns_before_escalation,
        updated_at:                  new Date().toISOString(),
        ...(d.pending_reservation_hold_minutes !== undefined && {
          pending_reservation_hold_minutes: d.pending_reservation_hold_minutes,
        }),
      },
      { onConflict: 'tenant_id' },
    )

  if (error) return { success: false, error: error.message }

  revalidatePath('/dashboard/settings/bot')
  return { success: true }
}
