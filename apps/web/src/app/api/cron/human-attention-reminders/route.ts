import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@orderflow/supabase/admin'
import { getSiteUrl } from '@/lib/site-url'
import { createResendEmailSender, isTransactionalEmailConfigured } from '@/lib/email/send-email'
import { runHumanAttentionReminders } from '@/lib/human-attention/reminders'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

// ════════════════════════════════════════════════════════════════════════════
// GET /api/cron/human-attention-reminders
//
// Lo dispara Vercel Cron cada 10 minutos (apps/web/vercel.json). Protegido por
// `Authorization: Bearer ${CRON_SECRET}`: Vercel manda ese header solo a los
// crons declarados. Sin CRON_SECRET configurado el endpoint no corre (503):
// fail-closed, nunca abierto por omisión.
//
// El endpoint es idempotente por diseño (ver lib/human-attention/reminders.ts):
// no acumula estado, y dos ticks solapados no duplican un email.
//
// Sin RESEND_API_KEY no se claimea nada: responde `email_not_configured` y los
// candidatos siguen elegibles para cuando exista proveedor.
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_LIMIT = 50

function isAuthorized(request: NextRequest): 'ok' | 'unconfigured' | 'forbidden' {
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) return 'unconfigured'
  const header = request.headers.get('authorization') ?? ''
  return header === `Bearer ${secret}` ? 'ok' : 'forbidden'
}

export async function GET(request: NextRequest) {
  const auth = isAuthorized(request)
  if (auth === 'unconfigured') {
    console.error('[cron:human-attention-reminders] CRON_SECRET no está configurada — el cron no corre')
    return NextResponse.json({ ok: false, error: 'cron_not_configured' }, { status: 503 })
  }
  if (auth === 'forbidden') {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 401 })
  }

  if (!isTransactionalEmailConfigured()) {
    console.warn('[cron:human-attention-reminders] RESEND_API_KEY ausente — no se claimea nada')
    return NextResponse.json({ ok: true, skipped: 'email_not_configured' })
  }

  let attentionUrl: string
  try {
    attentionUrl = `${getSiteUrl()}/dashboard/attention`
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'site_url_not_configured' },
      { status: 503 },
    )
  }

  try {
    const report = await runHumanAttentionReminders({
      admin:  createAdminClient(),
      sender: createResendEmailSender(),
      attentionUrl,
      limit:  DEFAULT_LIMIT,
    })
    console.log('[cron:human-attention-reminders] tick', {
      scanned: report.scanned, sent: report.sent.length, skipped: report.skipped.length, failed: report.failed.length,
    })
    return NextResponse.json({ ok: true, ...report })
  } catch (err) {
    console.error('[cron:human-attention-reminders] tick failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ ok: false, error: 'tick_failed' }, { status: 500 })
  }
}
