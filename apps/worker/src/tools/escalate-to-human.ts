import { createClient } from '../lib/supabase'
import type { LLMTool } from '../lib/llm'

export const escalateToHumanTool: LLMTool = {
  type: 'function',
  function: {
    name: 'escalate_to_human',
    description:
      'Transfiere la conversación a un agente humano. ' +
      'Úsala cuando el cliente lo solicite explícitamente (quiere hablar con una persona, ' +
      'un asesor, un humano, etc.) o cuando la consulta esté fuera del alcance del asistente. ' +
      'Después de llamar esta tool, respondé al cliente confirmando la transferencia.',
    parameters: {
      type:                 'object',
      properties:           {},
      required:             [],
      additionalProperties: false,
    },
  },
}

export async function executeEscalateToHuman(
  tenantId:       string,
  conversationId: string,
  reason:         'human_requested' | 'error' | 'negotiation' | 'reservation_ready' = 'human_requested',
): Promise<string> {
  const supabase = createClient()

  const now = new Date().toISOString()
  const { error } = await supabase
    .from('conversations')
    .update({
      ai_mode:                       'manual',
      needs_human_attention:         true,
      human_attention_requested_at:  now,
      ai_handoff_reason:             reason,
      ai_handoff_at:                 now,
    })
    .eq('id', conversationId)
    .eq('tenant_id', tenantId)

  if (error) {
    throw new Error(`[escalate_to_human] Failed to update conversation: ${error.message}`)
  }

  console.log('[escalate_to_human] conversation set to manual mode:', conversationId, { reason })

  return 'OK. La conversación fue transferida a atención humana. El modo de IA está desactivado.'
}
