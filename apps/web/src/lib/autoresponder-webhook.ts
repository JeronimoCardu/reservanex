// Core request-handling logic for POST /api/webhooks/autoresponder.
//
// NOTE on duplication: this mirrors apps/worker/src/providers/autoresponder/
// inbound.ts + webhook-handler.ts. It is a deliberate, small, self-contained
// duplicate (not a shared import) because apps/web cannot import apps/worker
// code — they are independently built/deployed Next.js/Node processes that
// only share state through the database, exactly like the existing Meta
// webhook (apps/web/src/app/api/webhooks/whatsapp/route.ts) has zero
// dependency on apps/worker. This is the same "small pure logic duplicated
// across the web/worker boundary" pattern already established by
// normalizePhoneForWhatsApp (packages/validators vs apps/worker/src/lib/phone.ts)
// — except here apps/web CAN import @orderflow/validators directly (unlike
// the worker), so this copy reuses it instead of re-implementing phone logic.
//
// This module has no dependency on Next.js or a real Supabase client — see
// AutoResponderWebhookDeps — so it stays testable by construction even though
// apps/web has no test runner configured yet (Vitest covers the equivalent
// logic on the worker side; see apps/worker/src/providers/autoresponder/*.test.ts).

import { createHash, randomUUID } from 'node:crypto'
import { normalizePhoneForWhatsApp, isValidARWhatsAppPhone } from '@orderflow/validators'

export const AUTORESPONDER_APP_PACKAGE = 'tkstudio.autoresponderforwa'
export const WHATSAPP_BUSINESS_PACKAGE = 'com.whatsapp.w4b'

export interface AutoResponderQuery {
  sender:           string
  message:          string
  isGroup:          boolean
  groupParticipant: string
  ruleId:           number
  isTestMessage:    boolean
}

export interface AutoResponderPayload {
  appPackageName:       string
  messengerPackageName: string
  query:                AutoResponderQuery
}

export function isAutoResponderPayload(payload: unknown): payload is AutoResponderPayload {
  if (typeof payload !== 'object' || payload === null) return false
  const query = (payload as Record<string, unknown>).query
  return typeof query === 'object' && query !== null
}

export function isValidAutoResponderPackages(payload: AutoResponderPayload): boolean {
  return (
    payload.appPackageName === AUTORESPONDER_APP_PACKAGE &&
    payload.messengerPackageName === WHATSAPP_BUSINESS_PACKAGE
  )
}

export function isGroupMessage(payload: AutoResponderPayload): boolean {
  return payload.query.isGroup === true
}

export type SenderResolution =
  | { resolved: true;  phone: string }
  | { resolved: false; reason: 'empty_sender' | 'sender_not_a_phone' }

// Never treats a name (or anything else that isn't a phone) as a contact
// identifier. normalizePhoneForWhatsApp returns any input containing letters
// (e.g. a saved contact's display name) UNCHANGED, so isValidARWhatsAppPhone()
// on the result reliably tells us whether `rawSender` was really a phone.
export function resolveAutoResponderSender(rawSender: string): SenderResolution {
  const trimmed = rawSender.trim()
  if (!trimmed) return { resolved: false, reason: 'empty_sender' }

  const normalized = normalizePhoneForWhatsApp(trimmed)
  if (!isValidARWhatsAppPhone(normalized)) {
    return { resolved: false, reason: 'sender_not_a_phone' }
  }
  return { resolved: true, phone: normalized }
}

// Same deterministic-hash rationale as apps/worker/src/lib/device-token.ts —
// keep both in sync, they must produce identical hashes for the same token.
export function hashDeviceToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

export interface AutoResponderAccountLookup {
  id:       string
  tenantId: string
  active:   boolean
}

export interface AutoResponderWebhookDeps {
  findAccountByTokenHash(tokenHash: string): Promise<AutoResponderAccountLookup | null>
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
  // Fase 7 Parte A — called once the device token has authenticated
  // successfully, for EVERY outcome that reaches this point (enqueued,
  // group ignored, unresolved sender, package mismatch) — all of these
  // prove the Android physically reached our server with valid
  // credentials, regardless of what the specific message contained.
  // Best-effort: implementations must not throw.
  markDeviceSeen(accountId: string): Promise<void>
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
  logContext: Record<string, unknown>
}

const EMPTY_REPLIES: { replies: [] } = { replies: [] }

export async function handleAutoResponderWebhook(params: {
  deviceTokenHeader: string | null
  rawBody:           string
  deps:              AutoResponderWebhookDeps
}): Promise<WebhookResult> {
  const { deviceTokenHeader, rawBody, deps } = params

  if (!deviceTokenHeader || !deviceTokenHeader.trim()) {
    return { httpStatus: 401, body: { error: 'Missing device token' }, outcome: 'rejected_no_token', logContext: {} }
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return { httpStatus: 400, body: { error: 'Invalid JSON body' }, outcome: 'rejected_bad_payload', logContext: {} }
  }

  const tokenHash = hashDeviceToken(deviceTokenHeader)
  const account   = await deps.findAccountByTokenHash(tokenHash)

  if (!account || !account.active) {
    return { httpStatus: 401, body: { error: 'Invalid device token' }, outcome: 'rejected_invalid_token', logContext: {} }
  }

  await deps.markDeviceSeen(account.id)

  const logContext = { accountId: account.id, tenantId: account.tenantId }

  if (!isAutoResponderPayload(payload)) {
    return { httpStatus: 400, body: { error: 'Unexpected payload shape' }, outcome: 'rejected_bad_payload', logContext }
  }

  if (!isValidAutoResponderPackages(payload)) {
    return { httpStatus: 200, body: EMPTY_REPLIES, outcome: 'ok_package_mismatch', logContext }
  }

  if (isGroupMessage(payload)) {
    return { httpStatus: 200, body: EMPTY_REPLIES, outcome: 'ok_group_ignored', logContext }
  }

  // internalEventId is generated ONCE here — before the sender check — so a
  // rejection (Fase 4.1 §1) and a successful enqueue both get one. When
  // enqueued it is persisted in raw_payload. NOT a provider message id —
  // AutoResponder gives none. Protects only against retries of the same
  // message_queue row within our own system (see
  // apps/worker/src/providers/autoresponder/inbound.ts's doc comment on
  // ExtractedInboundMessage.whatsappMessageId for exactly what this does and
  // does not guard against).
  const internalEventId = randomUUID()

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

  const envelope = {
    ...payload,
    provider:           'autoresponder' as const,
    _internal_event_id: internalEventId,
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
