// Core request-handling logic for POST /api/webhooks/autoresponder, decoupled
// from Next.js and from a real Supabase client so it can be unit-tested with
// plain stub functions (no HTTP, no DB, no Android). apps/web's route.ts is a
// thin adapter that supplies the real implementations of AutoResponderWebhookDeps
// and translates WebhookResult to a NextResponse.

import { randomUUID } from 'node:crypto'
import { hashDeviceToken } from '../../lib/device-token'
import {
  isAutoResponderPayload,
  isValidAutoResponderPackages,
  isGroupMessage,
  resolveAutoResponderSender,
} from './inbound'

export interface AutoResponderAccountLookup {
  id:       string
  tenantId: string
  active:   boolean
}

export interface AutoResponderWebhookDeps {
  // Resolves the account by the SHA-256 hash of the device token. Must
  // return null when no row matches — never throw for "not found".
  findAccountByTokenHash(tokenHash: string): Promise<AutoResponderAccountLookup | null>
  // Persists the queue row. Returns the new row's id, or null on failure
  // (the caller does not retry — see Fase 4 report §5/§7).
  enqueueMessage(params: {
    tenantId:   string
    accountId:  string
    rawPayload: Record<string, unknown>
  }): Promise<{ id: string } | null>
  // Durably records a rejected inbound event (Fase 4.1 §1) — e.g. a sender
  // that could not be resolved to a phone (a saved contact name). Must
  // NEVER receive or persist the raw sender string, only its length as a
  // privacy-safe diagnostic hint. Best-effort: implementations must not
  // throw — a logging failure must never fail the webhook response.
  recordRejection(params: {
    tenantId:        string
    accountId:       string
    reason:          'sender_not_a_phone' | 'empty_sender'
    internalEventId: string
    senderLength:    number
  }): Promise<void>
}

export type WebhookOutcome =
  | 'ok_enqueued'
  | 'ok_group_ignored'
  | 'ok_unresolved_sender'
  | 'ok_package_mismatch'
  | 'rejected_no_token'
  | 'rejected_invalid_token'
  | 'rejected_bad_payload'
  | 'rejected_enqueue_failed'

export interface WebhookResult {
  httpStatus: number
  body:       { replies: [] } | { error: string }
  outcome:    WebhookOutcome
  // Only populated for logging by the caller — never contains secrets.
  logContext: Record<string, unknown>
}

const EMPTY_REPLIES: { replies: [] } = { replies: [] }

export async function handleAutoResponderWebhook(params: {
  deviceTokenHeader: string | null
  rawBody:           string
  deps:              AutoResponderWebhookDeps
}): Promise<WebhookResult> {
  const { deviceTokenHeader, rawBody, deps } = params

  // 1-2. Auth header presence
  if (!deviceTokenHeader || !deviceTokenHeader.trim()) {
    return {
      httpStatus: 401,
      body:       { error: 'Missing device token' },
      outcome:    'rejected_no_token',
      logContext: {},
    }
  }

  // Content-Type / JSON validation
  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return {
      httpStatus: 400,
      body:       { error: 'Invalid JSON body' },
      outcome:    'rejected_bad_payload',
      logContext: {},
    }
  }

  // 3-4. Resolve account by token hash — reject absent/invalid/inactive.
  const tokenHash = hashDeviceToken(deviceTokenHeader)
  const account   = await deps.findAccountByTokenHash(tokenHash)

  if (!account || !account.active) {
    return {
      httpStatus: 401,
      body:       { error: 'Invalid device token' },
      outcome:    'rejected_invalid_token',
      logContext: {},
    }
  }

  const logContext = { accountId: account.id, tenantId: account.tenantId }

  if (!isAutoResponderPayload(payload)) {
    return { httpStatus: 400, body: { error: 'Unexpected payload shape' }, outcome: 'rejected_bad_payload', logContext }
  }

  // 5. Validate appPackageName / messengerPackageName.
  if (!isValidAutoResponderPackages(payload)) {
    return { httpStatus: 200, body: EMPTY_REPLIES, outcome: 'ok_package_mismatch', logContext }
  }

  // 7. Groups are ignored for now.
  if (isGroupMessage(payload)) {
    return { httpStatus: 200, body: EMPTY_REPLIES, outcome: 'ok_group_ignored', logContext }
  }

  // internalEventId is generated ONCE here — before the sender check — so a
  // rejection (Fase 4.1 §1) and a successful enqueue both get one. When
  // enqueued it is persisted in raw_payload so retries of this SAME queue
  // row (our own crash-recovery) reuse the same id — see inbound.ts's doc
  // comment on ExtractedInboundMessage.whatsappMessageId for what this id
  // does and does not protect against.
  const internalEventId = randomUUID()

  // 8. Sender must resolve to a real phone — never resolve/create by name.
  const senderResolution = resolveAutoResponderSender(payload.query.sender)
  if (!senderResolution.resolved) {
    await deps.recordRejection({
      tenantId:        account.tenantId,
      accountId:       account.id,
      reason:          senderResolution.reason,
      internalEventId,
      senderLength:    payload.query.sender.length,
    })
    return {
      httpStatus: 200,
      body:       EMPTY_REPLIES,
      outcome:    'ok_unresolved_sender',
      logContext: { ...logContext, senderReason: senderResolution.reason, internalEventId },
    }
  }

  // 9. Enqueue for the existing worker pipeline.
  const envelope = {
    ...payload,
    provider:            'autoresponder' as const,
    _internal_event_id:  internalEventId,
  }

  const queued = await deps.enqueueMessage({
    tenantId:   account.tenantId,
    accountId:  account.id,
    rawPayload: envelope,
  })

  if (!queued) {
    return { httpStatus: 500, body: { error: 'Failed to enqueue message' }, outcome: 'rejected_enqueue_failed', logContext }
  }

  return {
    httpStatus: 200,
    body:       EMPTY_REPLIES,
    outcome:    'ok_enqueued',
    logContext: { ...logContext, queueItemId: queued.id, internalEventId },
  }
}
