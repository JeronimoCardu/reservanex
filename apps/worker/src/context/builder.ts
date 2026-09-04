import { createClient } from '../lib/supabase'
import type { Database } from '@orderflow/types'
import { normalizePhoneForWhatsApp } from '../lib/phone'
import { isAutoResponderPayload, extractAutoResponderMessage } from '../providers/autoresponder/inbound'

type QueueRow = Database['public']['Tables']['message_queue']['Row']

export interface LeadContext {
  public_code?:              string
  property_slug?:            string
  property_operation_type?:  string  // 'sale' | 'long_term_rental' | 'temporary_rental'
  requested_start_date?:     string  // YYYY-MM-DD
  requested_end_date?:       string  // YYYY-MM-DD
  requested_guests?:         number
  requested_nights?:         number
}

export interface MessageContext {
  tenantId:           string
  conversationId:     string
  contactId:          string
  contactPhone:       string
  contactName:        string | null
  messageText:        string
  // For provider='meta' this is Meta's real wamid (safe for provider-level
  // retry dedup). For provider='autoresponder' this is an internally
  // generated event id (safe ONLY for our own queue-retry idempotency — see
  // apps/worker/src/providers/autoresponder/inbound.ts's doc comment on
  // ExtractedInboundMessage.whatsappMessageId).
  whatsappMessageId:  string
  // The conversation's CANONICAL/originating account (Fase 4.1 §2) — fixed
  // once at conversation creation, never reassigned by a later message, even
  // if the tenant has more than one active account (Meta + AutoResponder
  // simultaneously). Outbound sends must use this, not "the tenant's active
  // account" (ambiguous with 2+ active accounts). null only for legacy
  // conversations with no recoverable account — callers must fall back
  // safely (see apps/web/src/actions/messages.ts's sendViaWhatsApp).
  whatsappAccountId:  string | null
  provider:           'meta' | 'autoresponder'
  messageId:          string
  // Media fields — null for text messages. mediaId/mediaMimeType/mediaSha256
  // are Meta-only (an immediately-downloadable media reference); AutoResponder
  // never populates them (see providers/autoresponder/media-parser.ts) — its
  // media event lifecycle (Fase 6B) is tracked in media_events instead.
  mediaType:            'image' | 'document' | 'audio' | null
  mediaId:              string | null
  mediaMimeType:        string | null
  mediaFilename:        string | null
  mediaCaption:         string | null
  mediaSha256:          string | null
  // AutoResponder-only (Fase 6B) — from its placeholder text, not real bytes.
  mediaDurationSeconds: number | null
  mediaPages:           number | null
  // Lead context (populated when message comes from the public site)
  propertyId:         string | null
  propertyTitle:      string | null
  propertySlug:       string | null
  leadContext:        LeadContext
}

// Detects a contact name from a customer message using simple regex patterns.
// Only matches clear self-introductions to avoid false positives.
function detectContactName(text: string): string | null {
  const match = text.trim().match(
    /^(?:soy|me llamo|mi nombre es)\s+([A-Za-záéíóúüñÁÉÍÓÚÜÑ]+(?:\s+[A-Za-záéíóúüñÁÉÍÓÚÜÑ]+)?)\s*[.,!?]?\s*$/i,
  )
  if (!match?.[1]) return null
  const raw = match[1].trim()
  if (raw.length < 2 || raw.length > 50) return null
  return raw
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

export interface MediaExtract {
  type:     'image' | 'document' | 'audio'
  mediaId:  string
  mimeType: string
  filename: string | null
  sha256:   string | null
  caption:  string | null
}

// Extracts the first message from a Meta Cloud API webhook payload.
// Exported (Fase 3) for a Vitest unit test — pure function, no I/O, no
// refactor: this is the only change made to this file for testability.
export function extractMessage(payload: Record<string, unknown>) {
  const entry   = (payload.entry   as Record<string, unknown>[])[0]
  const changes = (entry.changes   as Record<string, unknown>[])[0]
  const value   = changes.value    as Record<string, unknown>
  const msg     = (value.messages  as Record<string, unknown>[])[0]

  const from              = msg.from as string
  const whatsappMessageId = msg.id   as string
  const type              = msg.type as string

  let messageText: string
  let mediaExtract: MediaExtract | null = null

  if (type === 'text') {
    messageText = (msg.text as Record<string, unknown>).body as string
  } else if (type === 'image' || type === 'document' || type === 'audio') {
    const obj      = msg[type] as Record<string, unknown> | undefined
    const mediaId  = typeof obj?.['id']        === 'string' ? obj['id']        : null
    const mimeType = typeof obj?.['mime_type'] === 'string' ? obj['mime_type'] : null
    const sha256   = typeof obj?.['sha256']    === 'string' ? obj['sha256']    : null
    const filename = type !== 'audio' && typeof obj?.['filename'] === 'string' ? obj['filename'] : null
    const caption  = type !== 'audio' && typeof obj?.['caption']  === 'string' ? obj['caption']  : null

    if (mediaId) {
      mediaExtract = {
        type:     type as 'image' | 'document' | 'audio',
        mediaId,
        mimeType: mimeType ?? 'application/octet-stream',
        filename,
        sha256,
        caption,
      }
    }

    if (type === 'image') {
      messageText = caption
        ? `[Imagen recibida. El equipo puede verla en el CRM.]\nCaption: ${caption}`
        : '[Imagen recibida. El equipo puede verla en el CRM.]'
    } else if (type === 'audio') {
      messageText = '[Audio recibido. Transcribiendo...]'
    } else {
      const base = filename
        ? `[Documento recibido: ${filename}. El equipo puede verlo en el CRM.]`
        : '[Documento recibido. El equipo puede verlo en el CRM.]'
      messageText = caption ? `${base}\nCaption: ${caption}` : base
    }
  } else {
    messageText = `[${type}]`
  }

  return { from, whatsappMessageId, messageText, messageType: type, mediaExtract }
}

// Dispatches to the right provider parser based on the payload's own shape —
// Meta's (`entry[].changes[]...`) vs AutoResponder's (top-level `query`
// object). Meta's parser (extractMessage, above) is untouched; this is the
// only new piece of routing logic buildContext needs.
//
// mediaDurationSeconds/mediaPages are AutoResponder-only (Fase 6B) — no
// bytes/mediaId available yet for that provider, only what its placeholder
// text reveals (see providers/autoresponder/media-parser.ts). Meta's branch
// always leaves them null; its own real media metadata keeps flowing through
// mediaExtract exactly as before.
function extractInboundMessage(payload: Record<string, unknown>): {
  from:                 string
  whatsappMessageId:    string
  messageText:          string
  messageType:          string
  mediaExtract:         MediaExtract | null
  mediaDurationSeconds: number | null
  mediaFilename:        string | null
  mediaPages:           number | null
  provider:             'meta' | 'autoresponder'
} {
  if (isAutoResponderPayload(payload)) {
    const internalEventId = typeof payload._internal_event_id === 'string' ? payload._internal_event_id : ''
    const extracted = extractAutoResponderMessage(payload, internalEventId)
    return { ...extracted, provider: 'autoresponder' }
  }
  return {
    ...extractMessage(payload),
    mediaDurationSeconds: null,
    mediaFilename:        null,
    mediaPages:            null,
    provider:              'meta',
  }
}

// ── Lead detection ─────────────────────────────────────────────────────────────

// Extracts OF-XXXXXX code from a free-text message (case-insensitive).
// Same regex as search-properties-for-reservation.ts to guarantee consistency.
function extractPublicCode(text: string): string | null {
  const m = text.match(/\bOF-([A-Z0-9]{6})\b/i)
  return m ? `OF-${m[1]!.toUpperCase()}` : null
}

// Converts DD/MM/YYYY to YYYY-MM-DD.
function ddmmyyyyToIso(s: string): string | null {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (!m) return null
  return `${m[3]}-${m[2]}-${m[1]}`
}

// Returns today and tomorrow as YYYY-MM-DD in Argentina timezone (UTC-3, no DST).
function todayTomorrowArgentina(): { start: string; end: string } {
  const pad    = (n: number) => String(n).padStart(2, '0')
  const toIso  = (d: Date)   => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const nowMs  = Date.now() - 3 * 60 * 60 * 1000
  const nowD   = new Date(nowMs)
  const today  = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate()))
  const tomorrow = new Date(today.getTime() + 86400000)
  return { start: toIso(today), end: toIso(tomorrow) }
}

// Parses colloquial date/guest expressions from conversational messages.
// "esta noche", "hoy a la noche", "para hoy", "solo por hoy" → today → tomorrow
// "soy yo solo", "voy solo" → guests=1; "somos N" → guests=N
function extractConversationalDates(text: string): Pick<LeadContext, 'requested_start_date' | 'requested_end_date' | 'requested_guests' | 'requested_nights'> {
  const result: Pick<LeadContext, 'requested_start_date' | 'requested_end_date' | 'requested_guests' | 'requested_nights'> = {}
  const t = text.toLowerCase()

  if (/esta\s+noche|hoy\s+a\s+la\s+noche|para\s+hoy|solo\s+por\s+hoy|hoy\s+hasta\s+ma[nñ]ana/.test(t)) {
    const { start, end } = todayTomorrowArgentina()
    result.requested_start_date = start
    result.requested_end_date   = end
    result.requested_nights     = 1
  }

  if (/\b(soy\s+yo\s+sol[ao]|voy\s+sol[ao]|soy\s+sol[ao]|solo\s+yo)\b/.test(t)) {
    result.requested_guests = 1
  } else {
    const m = t.match(/\bsomos\s+(\d+)|\bpara\s+(\d+)\s+personas?|\b(\d+)\s+personas?\b/)
    if (m) {
      const n = parseInt(m[1] ?? m[2] ?? m[3] ?? '0', 10)
      if (n > 0 && n <= 100) result.requested_guests = n
    }
  }

  return result
}

// Parses dates, guests, nights from the public site WA message format:
//   Fechas: 26/07/2026 al 28/07/2026
//   Personas: 2
//   Noches: 2
function extractLeadDates(text: string): Pick<LeadContext, 'requested_start_date' | 'requested_end_date' | 'requested_guests' | 'requested_nights'> {
  const result: Pick<LeadContext, 'requested_start_date' | 'requested_end_date' | 'requested_guests' | 'requested_nights'> = {}

  const fechasMatch = text.match(/Fechas?:\s*(\d{2}\/\d{2}\/\d{4})\s+al\s+(\d{2}\/\d{2}\/\d{4})/i)
  if (fechasMatch) {
    const start = ddmmyyyyToIso(fechasMatch[1]!)
    const end   = ddmmyyyyToIso(fechasMatch[2]!)
    if (start) result.requested_start_date = start
    if (end)   result.requested_end_date   = end
  }

  const personasMatch = text.match(/Personas?:\s*(\d+)/i)
  if (personasMatch) {
    const g = parseInt(personasMatch[1]!, 10)
    if (!isNaN(g) && g > 0) result.requested_guests = g
  }

  const nochesMatch = text.match(/Noches?:\s*(\d+)/i)
  if (nochesMatch) {
    const n = parseInt(nochesMatch[1]!, 10)
    if (!isNaN(n) && n > 0) result.requested_nights = n
  }

  return result
}

// ── Conversation matching (Fase 4.1 correction) ─────────────────────────────
//
// A WhatsApp conversation belongs to a specific account/channel, not just to
// a contact. contact_id identifies the PERSON (shared across channels);
// conversation_id identifies one interaction THROUGH ONE ACCOUNT. Matching a
// conversation by (tenant_id, contact_id, channel) alone — the original
// Fase 4.1 §2 behavior — let a contact who wrote via Meta and later via
// AutoResponder land in the SAME conversation object just because the phone
// matched, silently pinning the wrong account/provider to the second
// message's reply. This is fixed by adding whatsapp_account_id to the match:
// an inbound from account X may only reuse/reopen a conversation that
// already belongs to X (or a legacy NULL one — see below); it must never
// reuse a conversation belonging to a different account Y, even for the same
// contact/tenant. If none exists, a new conversation linked to X is created.
type ConversationCandidate = {
  id:                   string
  ai_mode:              string
  lead_source:          string | null
  lead_context:         unknown
  property_id:          string | null
  lead_operation_type:  string | null
  whatsapp_account_id:  string | null
}

const CONVERSATION_MATCH_SELECT =
  'id, ai_mode, lead_source, lead_context, property_id, lead_operation_type, whatsapp_account_id'

// Legacy conversations (whatsapp_account_id = NULL) predate this column.
// Backfilling one to account X is safe/unambiguous here specifically because
// prior to this fix, matching was contact+channel only — so a contact could
// have AT MOST ONE open (and at most one closed-then-reopenable) whatsapp
// conversation, full stop. There is therefore never more than one NULL
// candidate to choose between; claiming "the" legacy conversation for
// whichever account's message reaches it first after this fix ships is a
// deterministic, documented one-time migration — not a guess among several
// candidates. Once claimed, it behaves like any other account-linked
// conversation (never reassigned again). A different account's LATER
// message for the same contact will simply get its own new conversation.
async function findConversationForAccount(
  supabase:  ReturnType<typeof createClient>,
  tenantId:  string,
  contactId: string,
  accountId: string | null,
  status:    'open' | 'closed',
): Promise<{ conv: ConversationCandidate; needsAccountBackfill: boolean } | null> {
  const orderColumn = status === 'open' ? 'created_at' : 'updated_at'

  if (accountId) {
    const { data: exact } = await supabase
      .from('conversations')
      .select(CONVERSATION_MATCH_SELECT)
      .eq('tenant_id', tenantId)
      .eq('contact_id', contactId)
      .eq('channel', 'whatsapp')
      .eq('status', status)
      .eq('whatsapp_account_id', accountId)
      .order(orderColumn, { ascending: false })
      .limit(1)
      .maybeSingle()

    if (exact) return { conv: exact, needsAccountBackfill: false }

    const { data: legacy } = await supabase
      .from('conversations')
      .select(CONVERSATION_MATCH_SELECT)
      .eq('tenant_id', tenantId)
      .eq('contact_id', contactId)
      .eq('channel', 'whatsapp')
      .eq('status', status)
      .is('whatsapp_account_id', null)
      .order(orderColumn, { ascending: false })
      .limit(1)
      .maybeSingle()

    return legacy ? { conv: legacy, needsAccountBackfill: true } : null
  }

  // Degenerate fallback: this inbound message itself has no known account
  // (queueItem.whatsapp_account_id is null — should not happen in practice,
  // both the Meta and AutoResponder webhook routes always resolve and set
  // it). Without knowing X, account-scoped matching is impossible, so this
  // falls back to the pre-correction behavior (any conversation for this
  // contact+channel, regardless of account) rather than always creating a
  // fresh conversation.
  const { data: any } = await supabase
    .from('conversations')
    .select(CONVERSATION_MATCH_SELECT)
    .eq('tenant_id', tenantId)
    .eq('contact_id', contactId)
    .eq('channel', 'whatsapp')
    .eq('status', status)
    .order(orderColumn, { ascending: false })
    .limit(1)
    .maybeSingle()

  return any ? { conv: any, needsAccountBackfill: false } : null
}

function detectOperationIntent(text: string): 'sale' | 'long_term_rental' | 'temporary_rental' | null {
  const t = text.toLowerCase()
  if (/\b(comprar|compro|compra|venta|vender|vendo|vende|en\s+venta)\b/.test(t)) return 'sale'
  if (/\b(mensual|alquiler\s+mensual|para\s+vivir|larga\s+duraci[oó]n|mes\s+a\s+mes)\b/.test(t)) return 'long_term_rental'
  if (/\b(noche|noches|finde|fin\s+de\s+semana|estad[ií]a|vacaciones|temporario|temporada|por\s+d[ií]as?)\b/.test(t)) return 'temporary_rental'
  return null
}

export async function buildContext(queueItem: QueueRow): Promise<MessageContext> {
  const supabase = createClient()
  const payload  = queueItem.raw_payload as Record<string, unknown>

  const {
    from, whatsappMessageId, messageText, messageType, mediaExtract,
    mediaDurationSeconds, mediaFilename: autoresponderMediaFilename, mediaPages, provider,
  } = extractInboundMessage(payload)
  const tenantId = queueItem.tenant_id

  // Normalize wa_id to canonical AR mobile format (549 + 10 digits).
  const phone = normalizePhoneForWhatsApp(from)

  // ── Find or create contact by phone number ──────────────────────────────
  const { data: existingContact } = await supabase
    .from('contacts')
    .select('id, name')
    .eq('tenant_id', tenantId)
    .eq('phone', phone)
    .is('deleted_at', null)
    .maybeSingle()

  let contactId:   string
  let contactName: string | null = null

  if (existingContact) {
    contactId   = existingContact.id
    contactName = existingContact.name ?? null
  } else {
    const { data: newContact, error } = await supabase
      .from('contacts')
      .insert({ tenant_id: tenantId, phone, source: 'whatsapp' })
      .select('id')
      .single()

    if (error || !newContact) {
      throw new Error(`Failed to create contact: ${error?.message ?? 'no data'}`)
    }
    contactId = newContact.id
  }

  // ── Resolve conversation: open → reopen closed → create new ────────────
  let conversationId:  string
  let resolvedAiMode:  string
  let existingLeadContext: LeadContext = {}
  let existingLeadSource: string | null = null
  let existingPropertyId: string | null = null
  let existingLeadOpType: string = 'unknown'

  // The account/channel this conversation is routed through for OUTBOUND
  // replies. An inbound from account X may only match a conversation that
  // already belongs to X (or a legacy NULL one, backfilled once — see
  // findConversationForAccount above) — never one belonging to a different
  // account, even for the same contact/tenant. Once linked, never
  // reassigned again: "la misma cuenta/canal por la que la conversación fue
  // creada".
  let resolvedAccountId: string | null = null
  let accountIdWasBackfilled = false

  const openMatch = await findConversationForAccount(
    supabase, tenantId, contactId, queueItem.whatsapp_account_id, 'open',
  )

  if (openMatch) {
    const c = openMatch.conv
    conversationId      = c.id
    resolvedAiMode      = c.ai_mode
    existingLeadSource  = c.lead_source
    existingPropertyId  = c.property_id
    existingLeadContext = (c.lead_context as LeadContext | null) ?? {}
    existingLeadOpType  = c.lead_operation_type ?? 'unknown'

    if (openMatch.needsAccountBackfill) {
      resolvedAccountId      = queueItem.whatsapp_account_id
      accountIdWasBackfilled = true
    } else {
      resolvedAccountId = c.whatsapp_account_id
    }
  } else {
    const closedMatch = await findConversationForAccount(
      supabase, tenantId, contactId, queueItem.whatsapp_account_id, 'closed',
    )

    if (closedMatch) {
      const c = closedMatch.conv

      const { error: reopenError } = await supabase
        .from('conversations')
        .update({ status: 'open', updated_at: new Date().toISOString() })
        .eq('id', c.id)
        .eq('tenant_id', tenantId)

      if (reopenError) {
        throw new Error(`Failed to reopen conversation: ${reopenError.message}`)
      }

      console.log(`[builder] reopened closed conversation ${c.id} for contact ${contactId}`)
      conversationId      = c.id
      resolvedAiMode      = c.ai_mode
      existingLeadSource  = c.lead_source
      existingPropertyId  = c.property_id
      existingLeadContext = (c.lead_context as LeadContext | null) ?? {}
      existingLeadOpType  = c.lead_operation_type ?? 'unknown'

      if (closedMatch.needsAccountBackfill) {
        resolvedAccountId      = queueItem.whatsapp_account_id
        accountIdWasBackfilled = true
      } else {
        resolvedAccountId = c.whatsapp_account_id
      }
    } else {
      resolvedAccountId = queueItem.whatsapp_account_id

      const { data: newConv, error } = await supabase
        .from('conversations')
        .insert({
          tenant_id:           tenantId,
          contact_id:          contactId,
          channel:             'whatsapp',
          source:              'whatsapp_direct',
          ai_mode:             'autonomous',
          status:              'open',
          whatsapp_account_id: resolvedAccountId,
        })
        .select('id')
        .single()

      if (error || !newConv) {
        throw new Error(`Failed to create conversation: ${error?.message ?? 'no data'}`)
      }
      conversationId = newConv.id
      resolvedAiMode = 'autonomous'
    }
  }

  // ── Insert the incoming message (idempotent: skip if already exists) ────
  const { data: existingMsg } = await supabase
    .from('messages')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('whatsapp_message_id', whatsappMessageId)
    .maybeSingle()

  // Determine content_type and initial metadata for media messages
  const contentType: 'text' | 'image' | 'document' | 'audio' =
    messageType === 'image'    ? 'image'    :
    messageType === 'document' ? 'document' :
    messageType === 'audio'    ? 'audio'    :
    'text'

  // AutoResponder documents: the placeholder already reveals the real
  // filename (Fase 6B) — surface it immediately so the CRM's "processing"
  // state shows the actual name instead of a generic placeholder, even
  // before the upload arrives. Audio/image have no such early metadata
  // (AutoResponder gives nothing else usable).
  const mediaMetadata = mediaExtract ? {
    whatsapp_media_id: mediaExtract.mediaId,
    mime_type:         mediaExtract.mimeType,
    filename:          mediaExtract.filename,
    sha256:            mediaExtract.sha256,
    caption:           mediaExtract.caption,
    original_type:     mediaExtract.type,
    storage_bucket:    'whatsapp-media',
  } : (messageType === 'document' && autoresponderMediaFilename) ? {
    filename:      autoresponderMediaFilename,
    original_type: 'document',
  } : null

  let messageId: string

  if (existingMsg) {
    messageId = existingMsg.id
  } else {
    const { data: insertedMsg, error: msgError } = await supabase
      .from('messages')
      .insert({
        tenant_id:           tenantId,
        conversation_id:     conversationId,
        content:             messageText,
        content_type:        contentType,
        sender_type:         'customer',
        whatsapp_message_id: whatsappMessageId,
        ...(mediaMetadata ? { metadata: mediaMetadata as never } : {}),
      })
      .select('id')
      .single()

    if (msgError || !insertedMsg) {
      throw new Error(`Failed to insert message: ${msgError?.message ?? 'no data'}`)
    }
    messageId = insertedMsg.id
  }

  // ── Detect contact name from customer message (if not yet known) ─────────
  if (!contactName) {
    const detected = detectContactName(messageText)
    if (detected) {
      const { error: nameError } = await supabase
        .from('contacts')
        .update({ name: detected })
        .eq('id', contactId)
        .eq('tenant_id', tenantId)
      if (!nameError) {
        contactName = detected
        console.log(`[builder] contact name saved: "${detected}" for contact ${contactId}`)
      }
    }
  }

  // ── Detect lead context from public site message ──────────────────────────
  // Runs on EVERY inbound message so a follow-up message with new dates/ref
  // updates the stored context.
  let propertyId:    string | null = existingPropertyId
  let propertyTitle: string | null = null
  let propertySlug:  string | null = null
  let newLeadContext: LeadContext  = {}
  let newLeadSource:  string | null = existingLeadSource

  const detectedCode = extractPublicCode(messageText)
  if (detectedCode) {
    // Lookup property by public_code (deleted_at IS NULL only — allow archived props for continuity)
    const { data: prop } = await supabase
      .from('properties')
      .select('id, title, slug, public_code, operation_type')
      .eq('tenant_id', tenantId)
      .eq('public_code', detectedCode)
      .is('deleted_at', null)
      .maybeSingle()

    if (prop) {
      const isNewRef = existingPropertyId !== null && existingPropertyId !== prop.id

      if (isNewRef) {
        console.log('[builder] lead-context: Ref changed', {
          conversationId,
          previousPropertyId: existingPropertyId,
          newPropertyId:      prop.id,
          newPublicCode:      detectedCode,
        })
      }

      propertyId    = prop.id
      propertyTitle = prop.title
      propertySlug  = prop.slug ?? null
      newLeadSource = 'public_site'

      newLeadContext = {
        ...existingLeadContext,
        public_code:             detectedCode,
        property_slug:           prop.slug ?? undefined,
        property_operation_type: (prop as unknown as { operation_type: string }).operation_type,
      }
    } else {
      console.log('[builder] lead-context: public_code not found in DB', { conversationId, detectedCode })
    }
  }

  // When the conversation already has a linked property (from previous search or manual CRM
  // association) but no Ref code in this message, fetch its title/slug/type for AI context.
  if (!detectedCode && existingPropertyId && !propertyTitle) {
    const { data: existingProp } = await supabase
      .from('properties')
      .select('title, slug, operation_type')
      .eq('id', existingPropertyId)
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .maybeSingle()

    if (existingProp) {
      const ep = existingProp as unknown as { title: string; slug: string | null; operation_type: string }
      propertyTitle = ep.title
      propertySlug  = ep.slug ?? null
      if (!newLeadContext.property_operation_type) {
        newLeadContext = { ...existingLeadContext, ...newLeadContext, property_operation_type: ep.operation_type }
      }
    }
  }

  // Extract dates/guests regardless of whether there's a Ref
  // (a follow-up message might add dates without repeating the Ref)
  // Structured format ("Fechas: DD/MM/YYYY...") wins over conversational ("esta noche").
  const convInfo      = extractConversationalDates(messageText)
  const dateInfo      = extractLeadDates(messageText)
  const combinedInfo  = { ...convInfo, ...dateInfo }  // structured overwrites conversational

  if (Object.keys(combinedInfo).length > 0) {
    newLeadContext = {
      ...existingLeadContext,
      ...newLeadContext,
      ...combinedInfo,
    }
    if (!newLeadSource) newLeadSource = detectedCode ? 'public_site' : 'whatsapp_direct'

    console.log('[worker:date-guest-parser]', {
      text:      messageText.slice(0, 120),
      startDate: combinedInfo.requested_start_date ?? null,
      endDate:   combinedInfo.requested_end_date   ?? null,
      guests:    combinedInfo.requested_guests     ?? null,
      nights:    combinedInfo.requested_nights     ?? null,
      reason:    Object.keys(dateInfo).length > 0 ? 'structured_format' : 'conversational',
    })
  }

  // Determine lead_operation_type: property type > message intent > existing
  const propOpTypeFromContext = newLeadContext.property_operation_type ?? existingLeadContext.property_operation_type
  const detectedOpType        = detectOperationIntent(messageText)
  const newLeadOpType         = propOpTypeFromContext ?? detectedOpType ?? existingLeadOpType

  // Persist lead context update (only if something changed)
  const hasLeadUpdate =
    propertyId !== existingPropertyId ||
    newLeadSource !== existingLeadSource ||
    Object.keys(newLeadContext).length > 0 ||
    newLeadOpType !== existingLeadOpType

  if (hasLeadUpdate) {
    const mergedContext: LeadContext = {
      ...existingLeadContext,
      ...newLeadContext,
    }

    const { error: leadErr } = await supabase
      .from('conversations')
      .update({
        lead_source:  newLeadSource,
        lead_context: mergedContext as unknown as import('@orderflow/types').Json,
        ...(propertyId !== existingPropertyId ? { property_id: propertyId } : {}),
        ...(newLeadOpType !== existingLeadOpType ? { lead_operation_type: newLeadOpType } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversationId)
      .eq('tenant_id', tenantId)

    if (leadErr) {
      // Non-fatal — log and continue. AI still processes the message.
      console.error('[builder] failed to update lead context', { conversationId, error: leadErr.message })
    } else {
      console.log('[worker:lead-context]', {
        conversationId,
        detectedPublicCode:   detectedCode ?? null,
        matchedPropertyId:    propertyId,
        matchedPropertyTitle: propertyTitle,
        requestedStartDate:   mergedContext.requested_start_date ?? null,
        requestedEndDate:     mergedContext.requested_end_date   ?? null,
        requestedGuests:      mergedContext.requested_guests     ?? null,
        leadSource:           newLeadSource,
      })
      console.log('[worker:lead-pipeline]', {
        conversationId,
        leadOpType: newLeadOpType,
        source:     propOpTypeFromContext ? 'property_context' : detectedOpType ? 'message_intent' : 'unchanged',
      })
    }

    // Use merged context for this request
    existingLeadContext = { ...existingLeadContext, ...newLeadContext }
  }

  // ── Bump conversation updated_at; mark needs_human_attention for manual convs;
  //    persist the one-time legacy account_id backfill, if any ──────────────
  const accountBackfillPatch = accountIdWasBackfilled ? { whatsapp_account_id: resolvedAccountId } : {}

  if (resolvedAiMode !== 'autonomous') {
    await supabase
      .from('conversations')
      .update({ updated_at: new Date().toISOString(), needs_human_attention: true, ...accountBackfillPatch })
      .eq('id', conversationId)
  } else {
    await supabase
      .from('conversations')
      .update({ updated_at: new Date().toISOString(), ...accountBackfillPatch })
      .eq('id', conversationId)
  }

  return {
    tenantId,
    conversationId,
    contactId,
    contactPhone:       phone,
    contactName,
    messageText,
    whatsappMessageId,
    whatsappAccountId:  resolvedAccountId,
    provider,
    messageId,
    mediaType:            mediaExtract?.type ?? (messageType !== 'text' ? (messageType as 'image' | 'document' | 'audio') : null),
    mediaId:              mediaExtract?.mediaId ?? null,
    mediaMimeType:        mediaExtract?.mimeType ?? null,
    mediaFilename:        mediaExtract?.filename ?? autoresponderMediaFilename,
    mediaCaption:         mediaExtract?.caption ?? null,
    mediaSha256:          mediaExtract?.sha256 ?? null,
    mediaDurationSeconds,
    mediaPages,
    propertyId,
    propertyTitle,
    propertySlug,
    leadContext: { ...existingLeadContext, ...newLeadContext },
  }
}
