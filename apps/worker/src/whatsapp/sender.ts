import { createClient } from '../lib/supabase'
import type { MessageContext } from '../context/builder'

const GRAPH_API_VERSION = 'v21.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`

interface SendResponse {
  messages?: Array<{ id: string }>
  error?:    { message: string; code?: number }
}

// Returns the outbound wamid from Meta on success, null on any failure.
// Never throws — a send failure must not cause the queue item to be retried,
// because the AI message is already persisted and a retry would send it again.
export async function sendWhatsAppReply(ctx: MessageContext, text: string): Promise<string | null> {
  if (!ctx.whatsappAccountId) {
    console.warn('[sender] no whatsapp_account_id on queue item — skipping send')
    return null
  }

  const supabase = createClient()

  const { data: account } = await supabase
    .from('whatsapp_accounts')
    .select('phone_number, access_token_encrypted, active')
    .eq('id', ctx.whatsappAccountId)
    .single()

  if (!account) {
    console.error('[sender] account not found:', ctx.whatsappAccountId)
    return null
  }

  if (!account.active) {
    console.warn('[sender] account inactive:', ctx.whatsappAccountId)
    return null
  }

  // phone_number stores the Meta Phone Number ID (e.g. "123456789012345").
  // access_token_encrypted is used as the Bearer token directly;
  // token decryption should be added before production.
  try {
    const res = await fetch(`${GRAPH_BASE}/${account.phone_number}/messages`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${account.access_token_encrypted}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:   ctx.contactPhone,
        type: 'text',
        text: { body: text },
      }),
      signal: AbortSignal.timeout(10_000),
    })

    const data = await res.json() as SendResponse

    if (!res.ok) {
      const detail = data.error?.message ?? res.statusText
      console.error('[sender] Meta API error', { status: res.status, detail, to: ctx.contactPhone })
      return null
    }

    const outboundWamid = data.messages?.[0]?.id ?? null

    if (outboundWamid) {
      console.log('[sender] sent', { outboundWamid, to: ctx.contactPhone })
    } else {
      console.warn('[sender] sent but Meta returned no wamid', { to: ctx.contactPhone })
    }

    return outboundWamid
  } catch (err) {
    // Network / timeout errors. Message is already persisted — do not rethrow.
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[sender] network error:', msg)
    return null
  }
}
