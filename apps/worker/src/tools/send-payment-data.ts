import { createClient } from '../lib/supabase'
import type { LLMTool } from '../lib/llm'

export const sendPaymentDataTool: LLMTool = {
  type: 'function',
  function: {
    name: 'send_payment_data',
    description:
      'Envía los datos bancarios del tenant al cliente para que pueda hacer una transferencia. ' +
      'Usá esta herramienta SOLO cuando el cliente pide explícitamente: alias, CBU/CVU, datos para transferir, datos de pago, ' +
      'o menciona que va a hacer un pago o transferencia. ' +
      'NO usar cuando el cliente solo pregunta precio, disponibilidad, ubicación o requisitos.',
    parameters: {
      type:                 'object',
      properties:           {},
      required:             [],
      additionalProperties: false,
    },
  },
}

type TenantPaymentRow = {
  payment_alias:           string | null
  payment_cbu:             string | null
  payment_account_holder:  string | null
  payment_bank:            string | null
  payment_notes:           string | null
  payment_request_message: string | null
}

export function hasTenantPaymentData(tenant: TenantPaymentRow | null): boolean {
  // Requires alias, CBU, or a custom request_message — holder/bank alone are not enough to complete a transfer
  return !!(
    tenant?.payment_request_message?.trim() ||
    tenant?.payment_alias?.trim()           ||
    tenant?.payment_cbu?.trim()
  )
}

export function buildTenantPaymentMessage(tenant: TenantPaymentRow): string {
  const {
    payment_request_message,
    payment_account_holder,
    payment_bank,
    payment_alias,
    payment_cbu,
    payment_notes,
  } = tenant

  const lines: string[] = []

  if (payment_request_message) {
    lines.push(payment_request_message, '')
  } else {
    lines.push('Estos son los datos para transferir:', '')
  }

  if (payment_account_holder) lines.push(`Titular: ${payment_account_holder}`)
  if (payment_bank)           lines.push(`Banco: ${payment_bank}`)
  if (payment_alias)          lines.push(`Alias: ${payment_alias}`)
  if (payment_cbu)            lines.push(`CBU/CVU: ${payment_cbu}`)

  if (!payment_request_message) {
    lines.push('', 'Cuando hagas la transferencia, enviame el comprobante por acá.')
    lines.push('La reserva queda sujeta a confirmación de la inmobiliaria.')
  }

  if (payment_notes) lines.push('', payment_notes)

  return lines.join('\n').trim()
}

export async function executeSendPaymentData(
  tenantId:       string,
  conversationId: string,
  _rawArgs:       Record<string, unknown>,
): Promise<string> {
  const supabase = createClient()

  const { data: tenant } = await supabase
    .from('tenants')
    .select('payment_alias, payment_cbu, payment_account_holder, payment_bank, payment_notes, payment_request_message')
    .eq('id', tenantId)
    .maybeSingle()

  if (!hasTenantPaymentData(tenant)) {
    // Mark conversation as needing human attention since we can't provide payment data
    await supabase
      .from('conversations')
      .update({
        ai_mode:                      'manual',
        needs_human_attention:        true,
        human_attention_requested_at: new Date().toISOString(),
      })
      .eq('id', conversationId)
      .eq('tenant_id', tenantId)

    console.log('[send_payment_data] no payment data configured — escalating', { tenantId, conversationId })
    return 'Por ahora no tengo los datos de pago configurados. Te derivo con un asesor para que te los pase correctamente.'
  }

  const msg = buildTenantPaymentMessage(tenant!)
  console.log('[send_payment_data] sending payment info', { tenantId, hasAlias: !!tenant?.payment_alias, hasCbu: !!tenant?.payment_cbu })
  return msg
}
