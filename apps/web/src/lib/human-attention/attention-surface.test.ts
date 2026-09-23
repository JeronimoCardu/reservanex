import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// ════════════════════════════════════════════════════════════════════════════
// Atención humana V2 — la superficie, fijada estructuralmente.
//
// 20. /dashboard/conversations dejó de existir en el frontend y nadie linkea
//     ni redirige ahí.
// 21. El backend de conversations/messages sigue: tablas, triggers, RLS,
//     repositorios, acciones, worker, memoria, handoff, AutoResponder.
//  4. La reactivación automática del worker NO resuelve la atención humana;
//     sólo "Marcar como atendido" escribe resolved_at/by.
// ════════════════════════════════════════════════════════════════════════════

const DIR  = import.meta.dirname
const WEB  = path.resolve(DIR, '..', '..', '..')
const RAIZ = path.resolve(WEB, '..', '..')
const leer = (rel: string) => fs.readFileSync(path.join(RAIZ, rel), 'utf8')
const existe = (rel: string) => fs.existsSync(path.join(RAIZ, rel))

function soloCodigo(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

const versionados = () =>
  execFileSync('git', ['ls-files', 'apps/web/src', 'apps/worker/src'], { cwd: RAIZ, encoding: 'utf8' })
    .split('\n').filter(Boolean)

const enDisco = (rel: string) => {
  const abs = path.join(RAIZ, rel)
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
}

describe('20. la surface /dashboard/conversations no existe', () => {
  it('no hay ruta, ni componentes exclusivos, ni carpeta messages', () => {
    expect(existe('apps/web/src/app/(tenant)/dashboard/conversations')).toBe(false)
    expect(existe('apps/web/src/components/tenant/conversations')).toBe(false)
    expect(existe('apps/web/src/components/tenant/messages')).toBe(false)
  })

  it('la nueva ruta existe: /dashboard/attention', () => {
    expect(existe('apps/web/src/app/(tenant)/dashboard/attention/page.tsx')).toBe(true)
    expect(existe('apps/web/src/app/(tenant)/dashboard/attention/attention-list.tsx')).toBe(true)
  })

  it('ningún href, Link, redirect ni revalidatePath apunta a /dashboard/conversations (código, no comentarios)', () => {
    // Se leen los archivos del working tree (no sólo el índice) para que el
    // test valga antes del commit.
    const archivos = [...new Set([
      ...versionados(),
      ...listar('apps/web/src'),
    ])].filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('attention-surface.test.ts'))
    const culpables: string[] = []
    for (const f of archivos) {
      const src = enDisco(f)
      if (src === null) continue
      if (/dashboard\/conversations/.test(soloCodigo(src))) culpables.push(f)
    }
    expect(culpables, `todavía referencian la ruta vieja: ${culpables.join(', ')}`).toEqual([])
  })

  it('nav: Atención humana reemplaza a Conversaciones, con badge', () => {
    const nav = soloCodigo(leer('apps/web/src/lib/dashboard/nav-items.ts'))
    expect(nav).toContain("label: 'Atención humana'")
    expect(nav).toContain("href: '/dashboard/attention'")
    expect(nav).toContain("badgeKey: 'attention'")
    expect(nav).not.toContain("'Conversaciones'")
  })

  it('el default del dashboard y los redirects de settings van a la bandeja', () => {
    expect(soloCodigo(leer('apps/web/src/app/(tenant)/dashboard/page.tsx'))).toContain("redirect('/dashboard/attention')")
    expect(soloCodigo(leer('apps/web/src/app/(tenant)/dashboard/workspaces/page.tsx'))).toContain("redirect('/dashboard/attention')")
  })

  it('can_assign_conversations apunta al módulo nuevo; no se inventó un permiso', () => {
    const pf = soloCodigo(leer('apps/web/src/lib/dashboard/permission-fields.ts'))
    expect(pf).toContain("module:      '/dashboard/attention'")
    const claves = pf.match(/key:\s+'can_[a-z_]+'/g) ?? []
    expect(claves.some((k) => /attention|human/.test(k))).toBe(false)
  })

  it('los componentes compartidos sobrevivieron en su nuevo lugar', () => {
    expect(existe('apps/web/src/components/tenant/reservations/reservation-status-badge.tsx')).toBe(true)
    expect(existe('apps/web/src/components/tenant/contacts/contact-conversations.tsx')).toBe(true)
    expect(soloCodigo(leer('apps/web/src/app/(tenant)/dashboard/contacts/[id]/page.tsx'))).toContain('ContactConversations')
  })

  it('el badge se calcula UNA vez en el layout y lo reciben los dos navs', () => {
    const layout = soloCodigo(leer('apps/web/src/app/(tenant)/dashboard/layout.tsx'))
    expect(layout.match(/countPendingHumanAttention\(/g)?.length).toBe(1)
    expect(layout.match(/badges=\{badges\}/g)?.length).toBe(2)
  })
})

describe('21. el backend de conversaciones sigue intacto', () => {
  it.each([
    'apps/web/src/lib/repositories/conversations.repository.ts',
    'apps/web/src/lib/repositories/messages.repository.ts',
    'apps/web/src/actions/conversations.ts',
    'apps/web/src/actions/messages.ts',
    'apps/web/src/lib/repositories/notifications.repository.ts',
    'apps/worker/src/processor.ts',
    'apps/worker/src/context/builder.ts',
    'apps/worker/src/lib/human-handoff.ts',
    'apps/worker/src/tools/escalate-to-human.ts',
    'apps/worker/src/memory',
    'apps/web/src/app/api/webhooks/autoresponder/route.ts',
  ])('%s existe', (rel) => {
    expect(existe(rel)).toBe(true)
  })

  it('la migración agrega columnas y NO toca conversations/messages más allá de eso', () => {
    const m = leer('supabase/migrations/20260922000001_human_attention_cycle.sql')
    for (const col of ['human_attention_resolved_at', 'human_attention_resolved_by', 'human_attention_email_sent_at', 'human_attention_pending']) {
      expect(m).toContain(col)
    }
    expect(m).toContain('REFERENCES public.tenant_users(id) ON DELETE SET NULL')
    expect(m).toContain('GENERATED ALWAYS AS')
    expect(m).not.toMatch(/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|DROP TRIGGER|DROP POLICY/i)
  })
})

describe('4 y 3. quién resuelve la atención humana', () => {
  it('el worker NUNCA escribe human_attention_resolved_at (la expiración de human_until no atiende a nadie)', () => {
    const worker = execFileSync('git', ['ls-files', 'apps/worker/src'], { cwd: RAIZ, encoding: 'utf8' })
      .split('\n').filter((f) => /\.ts$/.test(f) && !f.endsWith('.test.ts'))
    const culpables = worker.filter((f) => {
      const src = enDisco(f)
      return src !== null && /human_attention_resolved/.test(soloCodigo(src))
    })
    expect(culpables).toEqual([])
  })

  it('la reactivación por expiración sigue escribiendo el gate de IA, pero no resolved_at', () => {
    const p = soloCodigo(leer('apps/worker/src/processor.ts'))
    const i = p.indexOf("ai_mode:                'autonomous'")
    expect(i).toBeGreaterThan(-1)
    const bloque = p.slice(i, i + 600)
    expect(bloque).toContain('human_until:            null')
    expect(bloque).toContain('needs_human_attention:  false')
    expect(bloque).not.toContain('human_attention_resolved')
  })

  it('"Marcar como atendido" es la misma escritura que reactivar la IA, extendida', async () => {
    const { humanAttentionAttendedPatch } = await import('./semantics')
    const patch = humanAttentionAttendedPatch('user-1', '2026-09-21T10:00:00.000Z')
    expect(patch).toEqual({
      ai_mode:                     'autonomous',
      ai_auto_replies_count:       0,
      ai_handoff_reason:           null,
      ai_handoff_at:               null,
      ai_reactivated_at:           '2026-09-21T10:00:00.000Z',
      ai_reactivated_by:           'user-1',
      needs_human_attention:       false,
      human_until:                 null,
      ai_context_reset_at:         '2026-09-21T10:00:00.000Z',
      human_attention_resolved_at: '2026-09-21T10:00:00.000Z',
      human_attention_resolved_by: 'user-1',
    })
    // requested_at es historial: no se borra.
    expect(patch).not.toHaveProperty('human_attention_requested_at')

    // El repositorio usa ESE patch, no una copia.
    const repo = soloCodigo(leer('apps/web/src/lib/repositories/conversations.repository.ts'))
    const i = repo.indexOf('export async function reactivateConversationAi')
    const cuerpo = repo.slice(i, repo.indexOf('export', i + 10))
    expect(cuerpo).toContain('.update(humanAttentionAttendedPatch(userId, now))')

    const acciones = soloCodigo(leer('apps/web/src/actions/conversations.ts'))
    expect(acciones).toContain('export async function markHumanAttentionAttendedAction')
    // Un solo camino: la acción nueva llama al MISMO repositorio.
    expect(acciones.match(/repo\.reactivateConversationAi\(/g)?.length).toBe(2)
  })

  it('una pre-reserva inmobiliaria ya no abre un ciclo de atención humana', () => {
    const t = soloCodigo(leer('apps/worker/src/tools/create-pending-reservation.ts'))
    expect(t).not.toContain('human_attention_requested_at')
    expect(t).toContain('needs_human_attention: true')
  })

  it('los handoffs reales sí abren ciclo (escriben requested_at)', () => {
    for (const f of ['apps/worker/src/tools/escalate-to-human.ts', 'apps/worker/src/tools/send-payment-data.ts', 'apps/worker/src/processor.ts']) {
      expect(soloCodigo(leer(f)), f).toContain('human_attention_requested_at')
    }
  })
})

describe('bandeja y cron', () => {
  it('la bandeja filtra por la columna generada, nunca por ai_mode ni needs_human_attention', () => {
    const repo = soloCodigo(leer('apps/web/src/lib/repositories/conversations.repository.ts'))
    const i = repo.indexOf('export async function listPendingHumanAttention')
    const bloque = repo.slice(i, repo.indexOf('export async function countPendingHumanAttention'))
    expect(bloque).toContain(".eq('human_attention_pending', true)")
    expect(bloque).not.toMatch(/\.neq\('ai_mode'|\.eq\('needs_human_attention'/)
    expect(bloque).toContain("order('human_attention_requested_at', { ascending: true })")
  })

  it('la UI no tiene input de respuesta ni lista de mensajes', () => {
    const ui = soloCodigo(leer('apps/web/src/app/(tenant)/dashboard/attention/attention-list.tsx'))
    expect(ui).not.toMatch(/<textarea|<input|sendMessage|listMessages|MessageBubble/i)
    expect(ui).toContain('Abrir WhatsApp')
    expect(ui).toContain('Marcar como atendido')
    expect(ui).toContain('No hay clientes esperando atención humana.')
  })

  it('el cron exige CRON_SECRET, cada 10 minutos, y no mete Resend en el worker', () => {
    const route = soloCodigo(leer('apps/web/src/app/api/cron/human-attention-reminders/route.ts'))
    expect(route).toContain('process.env.CRON_SECRET')
    expect(route).toContain('Bearer ${secret}')
    const vercel = JSON.parse(leer('apps/web/vercel.json')) as { crons: { path: string; schedule: string }[] }
    expect(vercel.crons).toContainEqual({ path: '/api/cron/human-attention-reminders', schedule: '*/10 * * * *' })
    const workerPkg = JSON.parse(leer('apps/worker/package.json')) as { dependencies?: Record<string, string> }
    expect(workerPkg.dependencies?.resend).toBeUndefined()
  })

  it('el claim es un UPDATE condicional sobre email_sent_at con release seguro', () => {
    const r = soloCodigo(leer('apps/web/src/lib/human-attention/reminders.ts'))
    expect(r).toContain("human_attention_email_sent_at.is.null,human_attention_email_sent_at.lt.")
    expect(r).toContain(".eq('human_attention_requested_at', requestedRaw)")
    expect(r).toContain(".eq('human_attention_email_sent_at', claimedRaw)")
    expect(r).not.toMatch(/ai_mode/)
  })
})

function listar(rel: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(path.join(RAIZ, d), { withFileTypes: true })) {
      const p = `${d}/${ent.name}`
      if (ent.isDirectory()) walk(p)
      else out.push(p)
    }
  }
  walk(rel)
  return out
}
