import { createClient } from '../lib/supabase'
import type { LLMTool } from '../lib/llm'
import { computeHumanUntilIso, getHumanHandoffTimeoutMs, type HandoffMode } from '../lib/human-handoff'

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
  // Fase 2B — DEFAULTS TO 'permanent', i.e. exactly the pre-Fase-2B
  // behaviour. The sliding HUMAN window is opt-in per call site
  // (handoffModeForProvider), so no caller — Meta's audio fallback, a future
  // one, anything — can acquire the temporal semantics merely by reusing
  // this helper. See §20 and the Fase 2B correction.
  handoffMode:    HandoffMode = 'permanent',
): Promise<string> {
  const supabase = createClient()

  const nowMs = Date.now()
  const now   = new Date(nowMs).toISOString()
  // 'temporary' opens the sliding window; 'permanent' explicitly clears it,
  // so a permanent escalation over a conversation that happened to be in a
  // temporary window wins and stops the auto-revert.
  const humanUntil = handoffMode === 'temporary'
    ? computeHumanUntilIso(nowMs, getHumanHandoffTimeoutMs())
    : null

  const { error } = await supabase
    .from('conversations')
    .update({
      ai_mode:                       'manual',
      needs_human_attention:         true,
      human_attention_requested_at:  now,
      ai_handoff_reason:             reason,
      ai_handoff_at:                 now,
      human_until:                   humanUntil,
    })
    .eq('id', conversationId)
    .eq('tenant_id', tenantId)

  if (error) {
    throw new Error(`[escalate_to_human] Failed to update conversation: ${error.message}`)
  }

  console.log('[escalate_to_human] conversation set to manual mode:', conversationId, { reason, handoffMode, humanUntil })

  return 'OK. La conversación fue transferida a atención humana. El modo de IA está desactivado.'
}
