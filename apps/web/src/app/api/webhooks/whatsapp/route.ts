import { createHmac, timingSafeEqual } from 'node:crypto'
import { type NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@orderflow/supabase/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ─── GET — Meta webhook verification challenge ───────────────────────────────
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)

    const mode =
      searchParams.get('hub.mode') ??
      searchParams.get('hub_mode')

    const token =
      searchParams.get('hub.verify_token') ??
      searchParams.get('hub_verify_token')

    const challenge =
      searchParams.get('hub.challenge') ??
      searchParams.get('hub_challenge')

    const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN ?? ''

    console.log('[webhook GET]', {
      mode,
      hasChallenge: Boolean(challenge),
      receivedTokenLength: token?.length ?? 0,
      expectedTokenLength: verifyToken.length,
      tokenMatches: token === verifyToken,
    })

    if (mode === 'subscribe' && token === verifyToken && challenge) {
      return new Response(challenge, { status: 200 })
    }

    return new Response('Forbidden', { status: 403 })
  } catch (err) {
    console.error('[webhook GET fatal]', err)
    return new Response('Webhook verification error', { status: 500 })
  }
}

// ─── POST — Incoming message from Meta Cloud API ─────────────────────────────
export async function POST(req: NextRequest) {
  console.log('[whatsapp:webhook:post] received')

  try {
    // 1. Read raw bytes — arrayBuffer preserves exact bytes Meta signed.
    const rawBody         = Buffer.from(await req.arrayBuffer())
    const signatureHeader = req.headers.get('x-hub-signature-256') ?? ''
    const appSecret       = process.env.META_APP_SECRET?.trim()
    const isProd          = process.env.NODE_ENV === 'production'
    const skipValidation  = !isProd && process.env.WHATSAPP_SKIP_SIGNATURE_VALIDATION === 'true'

    // 2. Signature validation — compare hex digest bytes only.
    function isSignatureValid(secret: string): boolean {
      const receivedHash = signatureHeader.startsWith('sha256=')
        ? signatureHeader.slice(7)
        : null
      if (!receivedHash) return false
      const expectedHash = createHmac('sha256', secret).update(rawBody).digest('hex')
      const recvBuf      = Buffer.from(receivedHash, 'hex')
      const expBuf       = Buffer.from(expectedHash, 'hex')
      return recvBuf.length === expBuf.length && timingSafeEqual(recvBuf, expBuf)
    }

    if (isProd) {
      if (!appSecret) {
        console.error('[whatsapp:webhook:signature] META_APP_SECRET not configured in production')
        return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
      }
      if (!isSignatureValid(appSecret)) {
        console.warn('[whatsapp:webhook:signature] invalid')
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
      }
      console.log('[whatsapp:webhook:signature] valid')
    } else if (skipValidation) {
      console.warn('[whatsapp:webhook:signature] skipped in development')
    } else if (appSecret) {
      if (!isSignatureValid(appSecret)) {
        console.warn('[whatsapp:webhook:signature] invalid')
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
      }
      console.log('[whatsapp:webhook:signature] valid')
    } else {
      console.warn('[whatsapp:webhook:signature] META_APP_SECRET not set — skipping validation in development')
    }

    // 3. Parse JSON only after signature check.
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = payload.entry as any[] | undefined
    console.log('[whatsapp:webhook:payload]', {
      object:       payload.object,
      entriesCount: entries?.length ?? 0,
    })

    if (payload.object !== 'whatsapp_business_account') {
      return NextResponse.json({ ok: true })
    }

    const entry = entries?.[0] as Record<string, unknown> | undefined
    if (!entry) return NextResponse.json({ ok: true })

    const businessAccountId = entry.id as string | undefined
    if (!businessAccountId) return NextResponse.json({ ok: true })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const changes = (entry.changes as any[] | undefined)?.[0] as Record<string, unknown> | undefined
    const value   = changes?.value as Record<string, unknown> | undefined

    // 4. Test/status/non-message payloads → 200, no DB writes.
    const messages = value?.messages as Record<string, unknown>[] | undefined
    if (!messages || messages.length === 0) {
      console.log('[whatsapp:webhook] test/status/non-message payload received')
      return NextResponse.json({ ok: true })
    }

    // 5. Real message payload.
    const phoneNumberId = (value?.metadata as Record<string, unknown> | undefined)
      ?.phone_number_id as string | undefined

    const msg = messages[0]!
    console.log('[whatsapp:webhook:message]', {
      phoneNumberId,
      wamid: msg.id,
      from:  msg.from,
    })

    const supabase = createAdminClient()

    let accountQuery = supabase
      .from('whatsapp_accounts')
      .select('id, tenant_id')
      .eq('business_account_id', businessAccountId)
      .eq('active', true)

    if (phoneNumberId) {
      accountQuery = accountQuery.eq('phone_number', phoneNumberId)
    }

    const { data: account, error: lookupError } = await accountQuery.maybeSingle()

    if (lookupError) {
      console.error('[whatsapp:webhook:account] lookup error', {
        code:    lookupError.code,
        message: lookupError.message,
        businessAccountId,
        phoneNumberId,
      })
      return NextResponse.json({ ok: true })
    }

    if (!account) {
      console.warn('[whatsapp:webhook:account] not_found', { businessAccountId, phoneNumberId })
      return NextResponse.json({ ok: true })
    }

    console.log('[whatsapp:webhook:account] found', {
      whatsappAccountId: account.id,
      tenantId:          account.tenant_id,
    })

    const { data: queued, error: insertError } = await supabase
      .from('message_queue')
      .insert({
        tenant_id:           account.tenant_id,
        whatsapp_account_id: account.id,
        raw_payload:         payload as never,
      })
      .select('id')
      .single()

    if (insertError) {
      console.error('[whatsapp:webhook] queue insert error', {
        code:    insertError.code,
        message: insertError.message,
      })
      return NextResponse.json({ error: 'Queue error' }, { status: 500 })
    }

    console.log('[whatsapp:webhook] queued', {
      queueItemId:       queued?.id,
      tenantId:          account.tenant_id,
      whatsappAccountId: account.id,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[whatsapp:webhook] fatal error:', err)
    return NextResponse.json({ error: 'Webhook fatal error' }, { status: 500 })
  }
}