import { createClient } from '../lib/supabase'
import type { LLMTool } from '../lib/llm'
import { customerSiteUrl, PUBLIC_PATHS } from '../lib/customer-site-url'

// ════════════════════════════════════════════════════════════════════════════
// Reservar mesa — el link al formulario, no una reserva.
//
// El contrato de reservas de mesa es form-first (Fase 3B): el cliente completa
// /site/<slug>/formulario/table_reservation, recibe una referencia SUB-XXXXXX,
// la pega en WhatsApp, y ahí runSubmissionFlow() —determinístico, sin LLM— le
// resume los datos y le pide que confirme. Eso crea una operation_request
// PENDIENTE que el negocio decide. Recién entonces existe una table_reservation.
//
// El asistente NO toma fecha, hora ni personas por chat: no hay tool para eso
// a propósito, y este tampoco lo es. Lo único que hace es mandar el link
// correcto —el del formulario, no la raíz de la carta— y dejar claro que la
// reserva la confirma el negocio.
// ════════════════════════════════════════════════════════════════════════════

export const sendTableReservationLinkTool: LLMTool = {
  type: 'function',
  function: {
    name: 'send_table_reservation_link',
    description:
      'Envía al cliente el link al formulario de reserva de mesa del local. ' +
      'Usá esta herramienta cuando el cliente quiere reservar una mesa, pregunta cómo reservar, o menciona fecha/hora/personas para ir a comer. ' +
      'La reserva NO queda confirmada por este chat: el cliente completa el formulario y el local la confirma después. ' +
      'No requiere parámetros.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
}

export async function executeSendTableReservationLink(
  tenantId: string,
  _rawArgs: Record<string, unknown>,
): Promise<string> {
  const supabase = createClient()

  const { data: tenant } = await supabase
    .from('tenants')
    .select('slug, public_slug, vertical, table_reservations_enabled, public_site_enabled')
    .eq('id', tenantId)
    .single()

  if (!tenant?.slug) {
    return JSON.stringify({ error: 'No se pudo construir el link: tenant sin slug configurado.' })
  }
  // Autoridad server-side, no sólo el prompt: un restaurante con reservas
  // apagadas no manda este link aunque el modelo lo intente.
  if (tenant.vertical !== 'food_service' || tenant.table_reservations_enabled === false) {
    return JSON.stringify({ error: 'Este local no toma reservas de mesa. Decile al cliente que no se toman reservas.' })
  }
  if (tenant.public_site_enabled === false) {
    return JSON.stringify({ error: 'El sitio público del local no está habilitado. Derivá a una persona con escalate_to_human.' })
  }

  const url = customerSiteUrl(PUBLIC_PATHS.tableReservation(tenant.public_slug ?? tenant.slug))
  if (!url) {
    return JSON.stringify({ error: 'No hay una URL pública alcanzable configurada. No mandes ningún link; derivá a una persona con escalate_to_human.' })
  }

  console.log('[send_table_reservation_link]', { tenantId, url })

  return `Podés reservar tu mesa completando este formulario: ${url}\nCuando lo envíes vas a recibir una referencia; mandámela por acá y confirmamos los datos. El local te confirma la reserva después.`
}
