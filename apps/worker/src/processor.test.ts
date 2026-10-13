// MVP P0-A — processMessage de punta a punta, con sus módulos de I/O
// reemplazados: un cliente Supabase falso que registra cada lectura, escritura
// y RPC, y stubs del builder, el responder, la memoria y los formularios. Lo
// que se prueba es el ORDEN real del pipeline: puerta HUMAN → media (respuesta
// fija del bot, callada con el bot apagado) → confirmación determinística de
// formularios (funciona con el bot apagado) → bot desactivado → slot de IA →
// IA / fusible.
//
// La semántica de la sesión de 8 h y del límite 25 vive en la RPC
// claim_ai_auto_reply_slot (atómica, en la base): la prueba
// apps/web/scripts/validate-autoresponder-stability.ts la ejercita contra el
// lab. Acá se prueba qué hace el worker con cada outcome y cuándo NO la llama.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '@orderflow/types'

type QueueRow = Database['public']['Tables']['message_queue']['Row']

// ── Cliente Supabase falso ───────────────────────────────────────────────────

interface Call {
  table?:   string
  rpc?:     string
  op:       'select' | 'update' | 'insert' | 'rpc'
  payload?: unknown
  filters:  Array<[string, string, unknown]>
}
const fake = vi.hoisted(() => ({
  calls:   [] as Call[],
  respond: (_call: Call): { data: unknown; error: unknown } => ({ data: null, error: null }),
}))

vi.mock('./lib/supabase', () => {
  function chain(call: Call) {
    const result = () => Promise.resolve(fake.respond(call))
    const c: Record<string, unknown> = {}
    const self = () => c
    Object.assign(c, {
      select: () => self(),
      update: (payload: unknown) => { call.op = 'update'; call.payload = payload; return self() },
      insert: (payload: unknown) => { call.op = 'insert'; call.payload = payload; return self() },
      eq: (col: string, val: unknown) => { call.filters.push(['eq', col, val]); return self() },
      neq: (col: string, val: unknown) => { call.filters.push(['neq', col, val]); return self() },
      is: (col: string, val: unknown) => { call.filters.push(['is', col, val]); return self() },
      filter: (col: string, op: string, val: unknown) => { call.filters.push([op, col, val]); return self() },
      order: () => self(),
      limit: () => self(),
      maybeSingle: result,
      single: result,
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => result().then(res, rej),
    })
    return c
  }
  const client = {
    from(table: string) {
      const call: Call = { table, op: 'select', filters: [] }
      fake.calls.push(call)
      return chain(call)
    },
    rpc(name: string, args: unknown) {
      const call: Call = { rpc: name, op: 'rpc', payload: args, filters: [] }
      fake.calls.push(call)
      return Promise.resolve(fake.respond(call))
    },
  }
  return { createClient: () => client }
})

// ── Stubs de los demás módulos con I/O ───────────────────────────────────────

const stubs = vi.hoisted(() => ({
  ctx:               {} as Record<string, unknown>,
  generateAIReply:   vi.fn(),
  writeMemory:       vi.fn(async () => ({ aiMessageId: 'ai-msg-1' })),
  runSubmissionFlow: vi.fn(async () => ({ kind: 'skip' }) as { kind: 'skip' } | { kind: 'reply'; text: string }),
  escalate:          vi.fn(async () => undefined),
}))

vi.mock('./context/builder', () => ({ buildContext: vi.fn(async () => ({ ...stubs.ctx })) }))
vi.mock('./context/responder', () => ({ generateAIReply: stubs.generateAIReply }))
vi.mock('./memory/writer', () => ({ writeMemory: stubs.writeMemory, updateAiMessageWamid: vi.fn() }))
vi.mock('./submissions/handler', () => ({ runSubmissionFlow: stubs.runSubmissionFlow }))
vi.mock('./whatsapp/sender', () => ({ sendWhatsAppReply: vi.fn(async () => null) }))
vi.mock('./whatsapp/media', () => ({ downloadMetaMedia: vi.fn(), uploadWhatsAppMediaToStorage: vi.fn() }))
vi.mock('./whatsapp/transcribe', () => ({ transcribeAudio: vi.fn() }))
vi.mock('./tools/escalate-to-human', () => ({ executeEscalateToHuman: stubs.escalate }))

const { processMessage } = await import('./processor')
const { HUMAN_HANDOFF_MESSAGE } = await import('./lib/human-handoff')

// ── Escenario ────────────────────────────────────────────────────────────────

interface Scenario {
  conversation?: { ai_mode: string; human_until: string | null }
  botActive?:    boolean | null          // null = sin fila de ai_settings
  aiSettingsError?: boolean
  slot?:         { outcome: string; new_count: number; reply_limit: number; session_reset: boolean } | 'error'
}

function setScenario(s: Scenario) {
  fake.respond = (call) => {
    if (call.table === 'conversations' && call.op === 'select') {
      return { data: s.conversation ?? { ai_mode: 'autonomous', human_until: null }, error: null }
    }
    if (call.table === 'ai_settings') {
      if (s.aiSettingsError) return { data: null, error: { message: 'boom' } }
      return { data: s.botActive === null || s.botActive === undefined ? null : { active: s.botActive }, error: null }
    }
    if (call.table === 'messages') return { data: null, error: null } // nada respondido todavía
    if (call.rpc === 'claim_ai_auto_reply_slot') {
      if (s.slot === 'error') return { data: null, error: { message: 'rpc down' } }
      return { data: [s.slot ?? { outcome: 'claimed', new_count: 1, reply_limit: 25, session_reset: true }], error: null }
    }
    return { data: null, error: null }
  }
}

const QUEUE_ROW = { id: 'q1', tenant_id: 't1', whatsapp_account_id: null } as unknown as QueueRow
const SYNC = { timeoutMs: 5_000 }

beforeEach(() => {
  fake.calls.length = 0
  stubs.generateAIReply.mockReset()
  stubs.generateAIReply.mockResolvedValue({ text: 'Tenemos 2 propiedades en Palermo.', finishReason: 'stop', model: 'deepseek-chat' })
  stubs.writeMemory.mockClear()
  stubs.runSubmissionFlow.mockReset()
  stubs.runSubmissionFlow.mockResolvedValue({ kind: 'skip' })
  stubs.escalate.mockClear()
  stubs.ctx = {
    tenantId: 't1', conversationId: 'c1', messageId: 'm-inbound-1', whatsappMessageId: 'evt-1',
    whatsappAccountId: null, provider: 'autoresponder', contactPhone: '5491100000000',
    messageText: 'hola', mediaType: null, mediaId: null,
  }
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

const rpcCalls = () => fake.calls.filter((c) => c.rpc === 'claim_ai_auto_reply_slot')
const conversationWrites = () => fake.calls.filter((c) => c.table === 'conversations' && c.op !== 'select')
const aiSettingsReads = () => fake.calls.filter((c) => c.table === 'ai_settings')

// ── Bot desactivado = IA generativa desactivada (MVP P0-A.1) ─────────────────

describe('bot desactivado: la IA se calla, las confirmaciones determinísticas siguen', () => {
  // El contador vive en la base: si el worker no llama la RPC, no se mueve,
  // valga lo que valga (24, 25 o una conversación nueva).
  it.each([
    ['1 · mensaje libre, conversación nueva'],
    ['1 · mensaje libre, contador 24'],
  ])('%s → silencio (bot_disabled), sin slot, contador intacto', async () => {
    setScenario({ botActive: false })
    const result = await processMessage(QUEUE_ROW, SYNC)

    expect(result).toEqual({ replyText: null, reason: 'bot_disabled' })
    expect(rpcCalls()).toHaveLength(0)
    expect(stubs.generateAIReply).not.toHaveBeenCalled()
    expect(stubs.writeMemory).not.toHaveBeenCalled()
    expect(conversationWrites()).toHaveLength(0)
  })

  it('2 · contador 25 + mensaje libre → silencio, NO fusible, NO Atención Humana', async () => {
    // Si el slot se reclamara, la RPC dispararía el fusible: nunca se llama.
    setScenario({ botActive: false, slot: { outcome: 'fuse_tripped', new_count: 25, reply_limit: 25, session_reset: false } })
    const result = await processMessage(QUEUE_ROW, SYNC)

    expect(result).toEqual({ replyText: null, reason: 'bot_disabled' })
    expect(rpcCalls()).toHaveLength(0)
    expect(conversationWrites()).toHaveLength(0) // ni needs_human_attention ni requested_at
    expect(stubs.escalate).not.toHaveBeenCalled()
    expect(result?.replyText).not.toBe(HUMAN_HANDOFF_MESSAGE)
  })

  it('3 · pedido SUB-… válido → la confirmación determinística funciona; sin slot, sin leer ai_settings', async () => {
    stubs.ctx.messageText = 'Hola! Quiero confirmar mi pedido SUB-ABC123'
    stubs.runSubmissionFlow.mockResolvedValue({ kind: 'reply', text: 'Tu pedido SUB-ABC123: 2 pizzas. ¿Confirmás?' })
    setScenario({ botActive: false })
    const result = await processMessage(QUEUE_ROW, SYNC)

    expect(result).toEqual({ replyText: 'Tu pedido SUB-ABC123: 2 pizzas. ¿Confirmás?', reason: undefined })
    expect(stubs.writeMemory).toHaveBeenCalledTimes(1)
    expect(rpcCalls()).toHaveLength(0)
    expect(stubs.generateAIReply).not.toHaveBeenCalled()
    expect(aiSettingsReads()).toHaveLength(0)
  })

  it('4 · confirmación de formulario ("sí") → funciona; sin slot', async () => {
    stubs.ctx.messageText = 'sí'
    stubs.runSubmissionFlow.mockResolvedValue({ kind: 'reply', text: 'Listo, recibimos tu solicitud SUB-XYZ789.' })
    setScenario({ botActive: false })
    const result = await processMessage(QUEUE_ROW, SYNC)

    expect(result?.replyText).toBe('Listo, recibimos tu solicitud SUB-XYZ789.')
    expect(rpcCalls()).toHaveLength(0)
    expect(conversationWrites()).toHaveLength(0)
  })

  it('5 · media de AutoResponder → silencio (la respuesta fija habla como el bot)', async () => {
    stubs.ctx.mediaType = 'audio'
    setScenario({ botActive: false })
    expect(await processMessage(QUEUE_ROW, SYNC)).toEqual({ replyText: null, reason: 'bot_disabled' })
    expect(stubs.writeMemory).not.toHaveBeenCalled()
  })

  it('5 · audio de Meta sin transcribir → silencio, sin el aviso fijo ni la escalada', async () => {
    Object.assign(stubs.ctx, { provider: 'meta', mediaType: 'audio' })
    setScenario({ botActive: false })
    expect(await processMessage(QUEUE_ROW)).toBeUndefined()
    expect(stubs.writeMemory).not.toHaveBeenCalled()
    expect(stubs.escalate).not.toHaveBeenCalled()
  })

  it('una sola lectura de ai_settings por mensaje', async () => {
    setScenario({ botActive: false })
    await processMessage(QUEUE_ROW, SYNC)
    expect(aiSettingsReads()).toHaveLength(1)

    fake.calls.length = 0
    setScenario({ botActive: true })
    await processMessage(QUEUE_ROW, SYNC)
    expect(aiSettingsReads()).toHaveLength(1)
  })

  it('sin fila de ai_settings → activo (semántica de siempre)', async () => {
    setScenario({ botActive: null })
    expect((await processMessage(QUEUE_ROW, SYNC))?.replyText).toBe('Tenemos 2 propiedades en Palermo.')
  })

  it('error leyendo ai_settings → activo (el responder vuelve a mirar antes de gastar tokens)', async () => {
    setScenario({ aiSettingsError: true })
    expect((await processMessage(QUEUE_ROW, SYNC))?.replyText).toBe('Tenemos 2 propiedades en Palermo.')
  })
})

// ── Slot: outcomes de la RPC ─────────────────────────────────────────────────

describe('slot de auto-respuesta', () => {
  it('claimed → respuesta de IA; la RPC recibe el inbound actual y el human_until del fusible (AutoResponder)', async () => {
    setScenario({ botActive: true, slot: { outcome: 'claimed', new_count: 7, reply_limit: 25, session_reset: false } })
    const result = await processMessage(QUEUE_ROW, SYNC)

    expect(result).toEqual({ replyText: 'Tenemos 2 propiedades en Palermo.', reason: undefined })
    const [call] = rpcCalls()
    expect(call!.payload).toMatchObject({ p_conversation_id: 'c1', p_tenant_id: 't1', p_inbound_message_id: 'm-inbound-1' })
    expect(typeof (call!.payload as { p_human_until?: unknown }).p_human_until).toBe('string')
  })

  it('Meta: sin ventana deslizante → p_human_until se omite (NULL en la base)', async () => {
    stubs.ctx.provider = 'meta'
    setScenario({ botActive: true })
    await processMessage(QUEUE_ROW)
    expect((rpcCalls()[0]!.payload as { p_human_until?: unknown }).p_human_until).toBeUndefined()
  })

  it('D · fuse_tripped → mensaje de handoff determinístico, sin LLM (la RPC ya dejó la conversación en HUMAN)', async () => {
    setScenario({ botActive: true, slot: { outcome: 'fuse_tripped', new_count: 25, reply_limit: 25, session_reset: false } })
    const result = await processMessage(QUEUE_ROW, SYNC)

    expect(result).toEqual({ replyText: HUMAN_HANDOFF_MESSAGE, reason: undefined })
    expect(stubs.generateAIReply).not.toHaveBeenCalled()
    expect(conversationWrites()).toHaveLength(0) // el cambio de estado es de la RPC, atómico
  })

  it('not_autonomous (otro llamador ya disparó el fusible, o un humano tomó la conversación) → silencio', async () => {
    setScenario({ botActive: true, slot: { outcome: 'not_autonomous', new_count: 25, reply_limit: 25, session_reset: false } })
    expect(await processMessage(QUEUE_ROW, SYNC)).toEqual({ replyText: null, reason: undefined })
    expect(stubs.generateAIReply).not.toHaveBeenCalled()
    expect(stubs.writeMemory).not.toHaveBeenCalled()
  })

  it('not_found → silencio', async () => {
    setScenario({ botActive: true, slot: { outcome: 'not_found', new_count: 0, reply_limit: 0, session_reset: false } })
    expect((await processMessage(QUEUE_ROW, SYNC))?.replyText).toBeNull()
    expect(stubs.generateAIReply).not.toHaveBeenCalled()
  })

  it('error de la RPC → no fatal: sigue a la IA (comportamiento previo)', async () => {
    setScenario({ botActive: true, slot: 'error' })
    expect((await processMessage(QUEUE_ROW, SYNC))?.replyText).toBe('Tenemos 2 propiedades en Palermo.')
  })
})

// ── HUMAN y formularios no consumen slot ─────────────────────────────────────

describe('lo que nunca llega al slot', () => {
  it('J · conversación en HUMAN activo → silencio, sin RPC, sin IA', async () => {
    setScenario({ conversation: { ai_mode: 'manual', human_until: new Date(Date.now() + 60 * 60_000).toISOString() } })
    expect(await processMessage(QUEUE_ROW, SYNC)).toEqual({ replyText: null, reason: undefined })
    expect(rpcCalls()).toHaveLength(0)
    expect(stubs.generateAIReply).not.toHaveBeenCalled()
  })

  it.each([true, false])('6 · HUMAN conserva su precedencia (bot activo: %s): ni la confirmación determinística corre', async (botActive) => {
    stubs.runSubmissionFlow.mockResolvedValue({ kind: 'reply', text: 'Tu pedido SUB-ABC123…' })
    setScenario({ botActive, conversation: { ai_mode: 'manual', human_until: new Date(Date.now() + 60 * 60_000).toISOString() } })
    expect(await processMessage(QUEUE_ROW, SYNC)).toEqual({ replyText: null, reason: undefined })
    expect(stubs.runSubmissionFlow).not.toHaveBeenCalled()
    expect(aiSettingsReads()).toHaveLength(0)
  })

  it('Meta · audio sin transcribir con el bot activo → aviso fijo + escalada (sin regresión)', async () => {
    Object.assign(stubs.ctx, { provider: 'meta', mediaType: 'audio' })
    setScenario({ botActive: true })
    await processMessage(QUEUE_ROW)
    expect(stubs.escalate).toHaveBeenCalledTimes(1)
    expect(stubs.writeMemory).toHaveBeenCalledTimes(1)
    expect(rpcCalls()).toHaveLength(0)
  })

  it('7 / K · confirmación determinística de formularios (pedidos food) con el bot activo → responde sin consumir contador', async () => {
    stubs.runSubmissionFlow.mockResolvedValue({ kind: 'reply', text: 'Tu pedido SUB-ABC123: 2 pizzas. ¿Confirmás?' })
    setScenario({ botActive: true })
    const result = await processMessage(QUEUE_ROW, SYNC)

    expect(result?.replyText).toBe('Tu pedido SUB-ABC123: 2 pizzas. ¿Confirmás?')
    expect(rpcCalls()).toHaveLength(0)
    expect(stubs.generateAIReply).not.toHaveBeenCalled()
  })
})

// ── Presupuesto síncrono ─────────────────────────────────────────────────────

describe('presupuesto síncrono', () => {
  it('la IA termina después del deadline → nada entregado, reason deadline_exceeded', async () => {
    setScenario({ botActive: true })
    stubs.generateAIReply.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60))
      return { text: 'tarde', finishReason: 'stop', model: 'deepseek-chat' }
    })
    const result = await processMessage(QUEUE_ROW, { timeoutMs: 20 })

    expect(result).toEqual({ replyText: null, reason: 'deadline_exceeded' })
    expect(stubs.writeMemory).not.toHaveBeenCalled() // nunca se persiste algo que el cliente no recibió
  })
})
