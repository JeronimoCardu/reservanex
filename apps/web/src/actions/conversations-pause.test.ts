// MVP P0-B — "Pausar IA": la persona toma la conversación para atenderla
// desde WhatsApp Business. Se fija:
//
//   · permisos: "Atender clientes" (owner siempre; recepcionista con permiso;
//     sin permiso → rechazo aunque el cliente llame la acción a mano);
//   · tenant: la conversación se busca con el tenant de la sesión;
//   · autónoma → persona, e idempotencia si ya estaba con una persona;
//   · el ciclo de Atención humana: se abre al pausar y se cierra con
//     "Marcar como atendido" (la misma escritura de siempre);
//   · no se toca ningún mensaje ni se manda nada al cliente;
//   · la UI: un botón en la ficha del contacto, sin bandeja ni composer.

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeSupabase } from '@/testing/fake-supabase'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth/require-tenant-context', () => ({ requireTenantContext: vi.fn() }))
vi.mock('@/lib/repositories/conversations.repository', () => ({
  getConversationById:  vi.fn(),
  pauseConversationAi:  vi.fn(),
}))

let db = new FakeSupabase()
vi.mock('@orderflow/supabase/server', () => ({ createClient: async () => db }))

import { revalidatePath } from 'next/cache'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { ATTEND_CUSTOMERS_DENIED } from '@/lib/auth/attend-customers'
import * as repo from '@/lib/repositories/conversations.repository'
import { humanAttentionAttendedPatch, isHumanAttentionPending, manualTakeoverPatch } from '@/lib/human-attention/semantics'
import { decideHumanMode } from '../../../worker/src/lib/human-handoff'
import { pauseConversationAiAction } from './conversations'

const realRepo = () => vi.importActual<typeof repo>('@/lib/repositories/conversations.repository')

const WEB = path.resolve(import.meta.dirname, '..', '..')
const leer = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8')
function soloCodigo(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
}

const TENANT_ID  = 'tenant-1'
const OTHER_TENANT = 'tenant-2'
const CONV_ID    = 'conv-1'
const CONTACT_ID = 'contact-1'

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1', tenantId: TENANT_ID, role: 'owner', workspaceIds: null,
    accessMode: 'tenant_user',
    canAccessSettings: true, canAssignConversations: false, canCreateProperties: true, canConfirmReservations: true,
    ...overrides,
  }
}

function conversation(overrides: Record<string, unknown> = {}) {
  return { id: CONV_ID, tenant_id: TENANT_ID, contact_id: CONTACT_ID, status: 'open', ai_mode: 'autonomous', ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireTenantContext).mockResolvedValue(ctx() as never)
  vi.mocked(repo.getConversationById).mockResolvedValue(conversation() as never)
  vi.mocked(repo.pauseConversationAi).mockResolvedValue(true)
})

describe('acción: permisos', () => {
  it('owner (aunque no tenga el flag) → pausa', async () => {
    const r = await pauseConversationAiAction(CONV_ID)
    expect(r).toEqual({ success: true, data: { alreadyPaused: false } })
    expect(repo.pauseConversationAi).toHaveBeenCalledWith(TENANT_ID, CONV_ID)
  })

  it('recepcionista con "Atender clientes" → pausa', async () => {
    vi.mocked(requireTenantContext).mockResolvedValue(ctx({ role: 'receptionist', canAssignConversations: true }) as never)
    const r = await pauseConversationAiAction(CONV_ID)
    expect(r.success).toBe(true)
    expect(repo.pauseConversationAi).toHaveBeenCalledOnce()
  })

  it('recepcionista sin permiso → rechazo, sin leer ni escribir (el cliente puede llamar la acción a mano)', async () => {
    vi.mocked(requireTenantContext).mockResolvedValue(ctx({ role: 'receptionist', canAssignConversations: false }) as never)
    const r = await pauseConversationAiAction(CONV_ID)
    expect(r).toEqual({ success: false, error: ATTEND_CUSTOMERS_DENIED })
    expect(repo.getConversationById).not.toHaveBeenCalled()
    expect(repo.pauseConversationAi).not.toHaveBeenCalled()
  })

  it('modo setup → rechazo, sin escribir', async () => {
    vi.mocked(requireTenantContext).mockResolvedValue(ctx({ accessMode: 'setup_operator' }) as never)
    const r = await pauseConversationAiAction(CONV_ID)
    expect(r.success).toBe(false)
    expect(repo.pauseConversationAi).not.toHaveBeenCalled()
  })
})

describe('acción: tenant y estados', () => {
  it('cross-tenant: se busca con el tenant de la sesión; si no es suyo, "no encontrada" y no se escribe', async () => {
    vi.mocked(repo.getConversationById).mockResolvedValue(null)
    const r = await pauseConversationAiAction('conv-de-otro-tenant')
    expect(r).toEqual({ success: false, error: 'Conversación no encontrada.' })
    expect(repo.getConversationById).toHaveBeenCalledWith(TENANT_ID, 'conv-de-otro-tenant')
    expect(repo.pauseConversationAi).not.toHaveBeenCalled()
  })

  it('autónoma → persona: escribe y refresca la bandeja, el layout y la ficha', async () => {
    const r = await pauseConversationAiAction(CONV_ID)
    expect(r).toEqual({ success: true, data: { alreadyPaused: false } })
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/attention')
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard', 'layout')
    expect(revalidatePath).toHaveBeenCalledWith(`/dashboard/contacts/${CONTACT_ID}`)
  })

  it('ya con una persona (manual o handoff de la IA) → idempotente: éxito, sin escribir nada', async () => {
    vi.mocked(repo.getConversationById).mockResolvedValue(conversation({ ai_mode: 'manual' }) as never)
    const r = await pauseConversationAiAction(CONV_ID)
    expect(r).toEqual({ success: true, data: { alreadyPaused: true } })
    expect(repo.pauseConversationAi).not.toHaveBeenCalled()
  })

  it('carrera: otro la tomó entre la lectura y el UPDATE → alreadyPaused, sin error', async () => {
    vi.mocked(repo.pauseConversationAi).mockResolvedValue(false)
    expect(await pauseConversationAiAction(CONV_ID)).toEqual({ success: true, data: { alreadyPaused: true } })
  })

  it('error de base → mensaje simple, sin detalles técnicos', async () => {
    vi.mocked(repo.pauseConversationAi).mockRejectedValue(new Error('permission denied for table conversations'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await pauseConversationAiAction(CONV_ID)
    log.mockRestore()
    expect(r).toEqual({ success: false, error: 'No se pudo pausar la IA. Intentá de nuevo.' })
  })
})

describe('repositorio: el UPDATE (FakeSupabase)', () => {
  const NOW = '2026-10-13T12:00:00.000Z'

  function seed(rows: Record<string, unknown>[]) {
    db = new FakeSupabase({ conversations: rows, messages: [], message_queue: [], messaging_outbox: [] })
  }
  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: CONV_ID, tenant_id: TENANT_ID, contact_id: CONTACT_ID, status: 'open', ai_mode: 'autonomous',
      needs_human_attention: false, human_until: null, ai_handoff_reason: null, ai_handoff_at: null,
      human_attention_requested_at: null, human_attention_resolved_at: null, human_attention_email_sent_at: null,
      ...overrides,
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(NOW))
  })
  afterEach(() => { vi.useRealTimers() })

  it('autónoma → manual sin vencimiento, Atención humana abierta, motivo "tomada manualmente"', async () => {
    seed([row()])
    expect(await (await realRepo()).pauseConversationAi(TENANT_ID, CONV_ID)).toBe(true)
    const [c] = db.rows('conversations')
    expect(c).toMatchObject({
      ai_mode: 'manual', human_until: null, needs_human_attention: true,
      human_attention_requested_at: NOW, ai_handoff_reason: 'manual_takeover', ai_handoff_at: NOW,
    })
    expect(isHumanAttentionPending(c as never)).toBe(true)
  })

  it('filtra por tenant, id y ai_mode = autonomous en el MISMO UPDATE', async () => {
    seed([row()])
    await (await realRepo()).pauseConversationAi(TENANT_ID, CONV_ID)
    expect(db.queriesOn('conversations')).toEqual([
      { table: 'conversations', op: 'update', filters: [`tenant_id=${TENANT_ID}`, `id=${CONV_ID}`, 'ai_mode=autonomous'] },
    ])
  })

  it('cross-tenant: la misma id en otro tenant no se toca', async () => {
    seed([row({ tenant_id: OTHER_TENANT })])
    expect(await (await realRepo()).pauseConversationAi(TENANT_ID, CONV_ID)).toBe(false)
    expect(db.rows('conversations')[0]).toMatchObject({ ai_mode: 'autonomous', human_attention_requested_at: null })
  })

  it('un handoff de la IA en curso no se reescribe: ni motivo, ni pedido, ni ventana', async () => {
    const handoff = row({
      ai_mode: 'manual', human_until: '2026-10-13T12:30:00.000Z', needs_human_attention: true,
      ai_handoff_reason: 'human_requested', ai_handoff_at: '2026-10-13T11:30:00.000Z',
      human_attention_requested_at: '2026-10-13T11:30:00.000Z',
    })
    seed([{ ...handoff }])
    expect(await (await realRepo()).pauseConversationAi(TENANT_ID, CONV_ID)).toBe(false)
    expect(db.rows('conversations')[0]).toEqual(handoff)
  })

  it('no toca mensajes ni encola nada para el cliente: una sola escritura, sobre conversations', async () => {
    seed([row()])
    await (await realRepo()).pauseConversationAi(TENANT_ID, CONV_ID)
    expect(db.queries.map((q) => q.table)).toEqual(['conversations'])
    expect(db.rows('messages')).toEqual([])
    expect(db.rows('message_queue')).toEqual([])
    expect(db.rows('messaging_outbox')).toEqual([])
  })

  it('ciclo completo: pausar → "Marcar como atendido" (IA vuelve, ciclo cerrado) → pausar otra vez abre un ciclo nuevo', async () => {
    const r = await realRepo()
    seed([row()])

    await r.pauseConversationAi(TENANT_ID, CONV_ID)
    expect(isHumanAttentionPending(db.rows('conversations')[0] as never)).toBe(true)

    vi.setSystemTime(new Date('2026-10-13T12:20:00.000Z'))
    await r.reactivateConversationAi(TENANT_ID, CONV_ID, 'user-1')
    const atendida = db.rows('conversations')[0]
    expect(atendida).toMatchObject({ ai_mode: 'autonomous', human_until: null, human_attention_resolved_by: 'user-1' })
    expect(isHumanAttentionPending(atendida as never)).toBe(false)

    vi.setSystemTime(new Date('2026-10-13T15:00:00.000Z'))
    expect(await r.pauseConversationAi(TENANT_ID, CONV_ID)).toBe(true)
    expect(isHumanAttentionPending(db.rows('conversations')[0] as never)).toBe(true)
  })
})

describe('semántica: la misma máquina de estados', () => {
  it('manualTakeoverPatch: manual, sin vencimiento, ciclo abierto; nunca resuelve ni toca contexto', () => {
    const p = manualTakeoverPatch('2026-10-13T12:00:00.000Z')
    expect(p).toEqual({
      ai_mode:                      'manual',
      needs_human_attention:        true,
      human_attention_requested_at: '2026-10-13T12:00:00.000Z',
      ai_handoff_reason:            'manual_takeover',
      ai_handoff_at:                '2026-10-13T12:00:00.000Z',
      human_until:                  null,
    })
    expect(p).not.toHaveProperty('human_attention_resolved_at')
    expect(p).not.toHaveProperty('ai_context_reset_at')
  })

  it('"Marcar como atendido" deshace exactamente lo que la pausa prendió', () => {
    const back = humanAttentionAttendedPatch('user-1', '2026-10-13T13:00:00.000Z')
    expect(back).toMatchObject({ ai_mode: 'autonomous', needs_human_attention: false, ai_handoff_reason: null, ai_handoff_at: null, human_until: null })
  })

  it('setAiMode("manual") y "Pausar IA" escriben el MISMO patch', () => {
    const repoSrc = soloCodigo(leer('src/lib/repositories/conversations.repository.ts'))
    expect(repoSrc).toContain("mode === 'manual' ? manualTakeoverPatch(now)")
    expect(repoSrc).toContain('.update(manualTakeoverPatch(new Date().toISOString()))')
  })
})

// ── P0-B.1 — manual explícito ≠ handoff temporal del bot ────────────────────
//
// Manual explícito (setAiMode('manual') / "Pausar IA"): human_until NULL, no
// vuelve sola, vuelve a la IA sólo con "Marcar como atendido".
// Handoff del bot (escalate_to_human 'temporary', fusible): ventana de 1 h
// que se desliza y vence. Lo fija apps/worker/src/tools/escalate-to-human.test.ts.
//
// La decisión es la REAL del worker (función pura, sin imports): así se prueba
// el contrato entre lo que escribe la web y lo que decide el worker.

describe('P0-B.1 — semántica manual canónica', () => {
  const T0 = '2026-10-13T12:00:00.000Z'
  const DIEZ_ANIOS = 10 * 365 * 24 * 3_600_000
  const handoffDelBot = {
    ai_mode: 'manual', human_until: '2026-10-13T12:40:00.000Z', needs_human_attention: true,
    ai_handoff_reason: 'human_requested', ai_handoff_at: '2026-10-13T11:40:00.000Z',
    human_attention_requested_at: '2026-10-13T11:40:00.000Z',
  }

  function fila(overrides: Record<string, unknown> = {}) {
    return {
      id: CONV_ID, tenant_id: TENANT_ID, contact_id: CONTACT_ID, status: 'open', ai_mode: 'autonomous',
      needs_human_attention: false, human_until: null, ai_handoff_reason: null, ai_handoff_at: null,
      human_attention_requested_at: null, human_attention_resolved_at: null, human_attention_email_sent_at: null,
      ...overrides,
    }
  }
  const decidir = (c: Record<string, unknown>, nowMs: number) =>
    decideHumanMode({ ai_mode: c.ai_mode as string, human_until: c.human_until as string | null }, nowMs).mode

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(T0))
  })
  afterEach(() => { vi.useRealTimers() })

  it('A. setAiMode("manual") sobre un handoff del bot con ventana → human_until queda null (el operador decidió)', async () => {
    db = new FakeSupabase({ conversations: [fila(handoffDelBot)] })
    await (await realRepo()).setAiMode(TENANT_ID, CONV_ID, 'manual')
    expect(db.rows('conversations')[0]).toMatchObject({ ai_mode: 'manual', human_until: null, ai_handoff_reason: 'manual_takeover' })
  })

  it('A. setAiMode("manual") con un human_until vencido que quedó stale → null', async () => {
    db = new FakeSupabase({ conversations: [fila({ human_until: '2026-10-01T00:00:00.000Z' })] })
    await (await realRepo()).setAiMode(TENANT_ID, CONV_ID, 'manual')
    expect(db.rows('conversations')[0]!.human_until).toBeNull()
  })

  it('B. "Pausar IA" → human_until null, aunque hubiera uno stale', async () => {
    db = new FakeSupabase({ conversations: [fila({ human_until: '2026-10-01T00:00:00.000Z' })] })
    expect(await (await realRepo()).pauseConversationAi(TENANT_ID, CONV_ID)).toBe(true)
    expect(db.rows('conversations')[0]).toMatchObject({ ai_mode: 'manual', human_until: null })
  })

  it('C. manual explícito no vuelve sola: para el worker es silencio sin vencimiento, hoy y en 10 años', () => {
    const p = manualTakeoverPatch(T0)
    expect(decidir(p, Date.parse(T0))).toBe('manual_no_expiry')
    expect(decidir(p, Date.parse(T0) + DIEZ_ANIOS)).toBe('manual_no_expiry')
  })

  it('C. sin el null, la misma toma se revertía sola (por qué importa)', () => {
    expect(decidir({ ...manualTakeoverPatch(T0), human_until: '2026-10-01T00:00:00.000Z' }, Date.parse(T0))).toBe('human_expired')
  })

  it('D. "Marcar como atendido" → vuelve a la IA y cierra el ciclo', async () => {
    const r = await realRepo()
    db = new FakeSupabase({ conversations: [fila()] })
    await r.setAiMode(TENANT_ID, CONV_ID, 'manual')
    vi.setSystemTime(new Date('2026-10-13T12:30:00.000Z'))
    await r.reactivateConversationAi(TENANT_ID, CONV_ID, 'user-1')
    const c = db.rows('conversations')[0]!
    expect(decidir(c, Date.now())).toBe('ai')
    expect(isHumanAttentionPending(c as never)).toBe(false)
  })

  it('E. el handoff del bot conserva su ventana: activa antes de vencer, vuelve sola después', () => {
    expect(decidir(handoffDelBot, Date.parse('2026-10-13T12:39:00.000Z'))).toBe('human_active')
    expect(decidir(handoffDelBot, Date.parse('2026-10-13T12:41:00.000Z'))).toBe('human_expired')
  })

  it('E. "Pausar IA" no pisa un handoff del bot en curso: queda su ventana y su motivo', async () => {
    db = new FakeSupabase({ conversations: [fila(handoffDelBot)] })
    expect(await (await realRepo()).pauseConversationAi(TENANT_ID, CONV_ID)).toBe(false)
    expect(db.rows('conversations')[0]).toMatchObject(handoffDelBot)
  })

  it('F. manualTakeoverPatch no llega al handoff automático: el worker no lo conoce y escribe su propio patch', () => {
    const RAIZ = path.resolve(WEB, '..', '..')
    const workerSrc = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return workerSrc(p)
      return /\.ts$/.test(e.name) && !e.name.endsWith('.test.ts') ? [p] : []
    })
    const culpables = workerSrc(path.join(RAIZ, 'apps/worker/src'))
      .filter((f) => /manualTakeoverPatch|manual_takeover|from ['"][^'"]*(apps\/web|human-attention\/semantics)/.test(soloCodigo(fs.readFileSync(f, 'utf8'))))
    expect(culpables).toEqual([])

    const escalate = soloCodigo(fs.readFileSync(path.join(RAIZ, 'apps/worker/src/tools/escalate-to-human.ts'), 'utf8'))
    expect(escalate).toContain("handoffMode === 'temporary'")
    expect(escalate).toContain('computeHumanUntilIso(nowMs, getHumanHandoffTimeoutMs())')
  })

  it('F. en la web, manualTakeoverPatch sólo lo usan la toma manual y "Pausar IA"', () => {
    const repoSrc = soloCodigo(leer('src/lib/repositories/conversations.repository.ts'))
    expect(repoSrc.match(/manualTakeoverPatch\(/g)).toHaveLength(2)
    const usos = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return usos(p)
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && /manualTakeoverPatch/.test(soloCodigo(fs.readFileSync(p, 'utf8'))) ? [p] : []
    })
    expect(usos(path.join(WEB, 'src')).map((p) => path.relative(WEB, p).replace(/\\/g, '/')).sort())
      .toEqual(['src/lib/human-attention/semantics.ts', 'src/lib/repositories/conversations.repository.ts'])
  })
})

// ── Superficie (estructural) ────────────────────────────────────────────────

describe('superficie', () => {
  it('la acción no manda nada ni toca mensajes', () => {
    const acciones = soloCodigo(leer('src/actions/conversations.ts'))
    const i = acciones.indexOf('export async function pauseConversationAiAction')
    const cuerpo = acciones.slice(i, acciones.indexOf('export async function', i + 10))
    expect(cuerpo).toContain('requireAttendCustomers')
    expect(cuerpo).toContain('repo.pauseConversationAi(ctx.tenantId, id)')
    expect(cuerpo).not.toMatch(/messages|outbox|message_queue|sendMessage|whatsapp|createAdminClient/i)
  })

  it('el botón vive en la ficha del contacto, sólo con permiso, IA activa y conversación abierta', () => {
    const lista = soloCodigo(leer('src/components/tenant/contacts/contact-conversations.tsx'))
    expect(lista).toMatch(/canAttend && conv\.ai_mode === 'autonomous' && conv\.status !== 'closed' && \(\s*<PauseAiButton conversationId=\{conv\.id\} \/>/)
    expect(lista).toContain('Abrir WhatsApp')
    expect(lista).not.toMatch(/<textarea|<input|sendMessage|listMessages|MessageBubble/i)

    const ficha = soloCodigo(leer('src/app/(tenant)/dashboard/contacts/[id]/page.tsx'))
    expect(ficha).toContain('canAttend={canAttendCustomers(ctx)}')
  })

  it('el botón dice "Pausar IA", llama a la acción y no tiene composer ni jerga', () => {
    const boton = soloCodigo(leer('src/components/tenant/contacts/pause-ai-button.tsx'))
    expect(boton).toContain('Pausar IA')
    expect(boton).toContain('pauseConversationAiAction(conversationId)')
    expect(boton).not.toMatch(/<textarea|<input|sendMessage|ai_mode|heartbeat|provider|inbound/i)
  })
  // Que no exista una bandeja de conversaciones ya lo fija attention-surface.test.ts (20).
})
