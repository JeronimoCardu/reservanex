import { describe, expect, it, vi } from 'vitest'
import { handleAutoResponderWebhook, type AutoResponderWebhookDeps } from './webhook-handler'
import { hashDeviceToken } from '../../lib/device-token'
import { AUTORESPONDER_APP_PACKAGE, WHATSAPP_BUSINESS_PACKAGE } from './inbound'

const RAW_TOKEN  = 'super-secret-device-token-abc123'
const TOKEN_HASH = hashDeviceToken(RAW_TOKEN)
const ACCOUNT    = { id: 'account-1', tenantId: 'tenant-1', active: true }

function makeDeps(overrides: Partial<AutoResponderWebhookDeps> = {}): AutoResponderWebhookDeps {
  return {
    findAccountByTokenHash: vi.fn(async (hash: string) => (hash === TOKEN_HASH ? ACCOUNT : null)),
    enqueueMessage:         vi.fn(async () => ({ id: 'queue-item-1' })),
    recordRejection:        vi.fn(async () => undefined),
    ...overrides,
  }
}

interface BodyOverrides {
  appPackageName?:       string
  messengerPackageName?: string
  query?:                Partial<Record<string, unknown>>
}

function validBody(overrides: BodyOverrides = {}): string {
  return JSON.stringify({
    appPackageName:       overrides.appPackageName ?? AUTORESPONDER_APP_PACKAGE,
    messengerPackageName: overrides.messengerPackageName ?? WHATSAPP_BUSINESS_PACKAGE,
    query: {
      sender:           '+54 9 2325 47-1890',
      message:          'TEST-NO-GUARDADO-123',
      isGroup:          false,
      groupParticipant: '',
      ruleId:           1,
      isTestMessage:    false,
      ...overrides.query,
    },
  })
}

describe('handleAutoResponderWebhook', () => {
  it('1. rejects a request with no device token header', async () => {
    const deps = makeDeps()
    const result = await handleAutoResponderWebhook({ deviceTokenHeader: null, rawBody: validBody(), deps })

    expect(result.httpStatus).toBe(401)
    expect(result.outcome).toBe('rejected_no_token')
    expect(deps.findAccountByTokenHash).not.toHaveBeenCalled()
  })

  it('2. rejects a request with an incorrect device token', async () => {
    const deps = makeDeps()
    const result = await handleAutoResponderWebhook({ deviceTokenHeader: 'wrong-token', rawBody: validBody(), deps })

    expect(result.httpStatus).toBe(401)
    expect(result.outcome).toBe('rejected_invalid_token')
  })

  it('3-4. accepts a valid payload from an authenticated device and returns {replies: []}', async () => {
    const deps = makeDeps()
    const result = await handleAutoResponderWebhook({ deviceTokenHeader: RAW_TOKEN, rawBody: validBody(), deps })

    expect(result.httpStatus).toBe(200)
    expect(result.body).toEqual({ replies: [] })
    expect(result.outcome).toBe('ok_enqueued')
  })

  it('5. a group message is ignored — never reaches enqueueMessage', async () => {
    const deps = makeDeps()
    const result = await handleAutoResponderWebhook({
      deviceTokenHeader: RAW_TOKEN,
      rawBody:            validBody({ query: { isGroup: true } }),
      deps,
    })

    expect(result.httpStatus).toBe(200)
    expect(result.body).toEqual({ replies: [] })
    expect(result.outcome).toBe('ok_group_ignored')
    expect(deps.enqueueMessage).not.toHaveBeenCalled()
  })

  it('6. normalizes a non-saved-contact sender phone before enqueueing', async () => {
    const deps = makeDeps()
    await handleAutoResponderWebhook({
      deviceTokenHeader: RAW_TOKEN,
      rawBody:            validBody({ query: { sender: '+54 9 2325 47-1890' } }),
      deps,
    })

    const call = (deps.enqueueMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // The raw AutoResponder sender string is preserved verbatim in the queued
    // envelope (builder.ts normalizes it downstream, same as it already does
    // for Meta's `from` field) — this test only confirms the request was
    // accepted and queued, i.e. resolveAutoResponderSender() accepted this format.
    expect(call.rawPayload.query.sender).toBe('+54 9 2325 47-1890')
  })

  it('7. a sender that is a saved-contact NAME is never resolved/queued as a phone', async () => {
    const deps = makeDeps()
    const result = await handleAutoResponderWebhook({
      deviceTokenHeader: RAW_TOKEN,
      rawBody:            validBody({ query: { sender: 'Jeronimo Cardu' } }),
      deps,
    })

    expect(result.httpStatus).toBe(200)
    expect(result.body).toEqual({ replies: [] })
    expect(result.outcome).toBe('ok_unresolved_sender')
    expect(deps.enqueueMessage).not.toHaveBeenCalled()
  })

  it('7b. an unresolved sender durably records a rejection — never the raw sender string', async () => {
    const deps = makeDeps()
    await handleAutoResponderWebhook({
      deviceTokenHeader: RAW_TOKEN,
      rawBody:            validBody({ query: { sender: 'Jeronimo Cardu' } }),
      deps,
    })

    expect(deps.recordRejection).toHaveBeenCalledTimes(1)
    const call = (deps.recordRejection as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.tenantId).toBe(ACCOUNT.tenantId)
    expect(call.accountId).toBe(ACCOUNT.id)
    expect(call.reason).toBe('sender_not_a_phone')
    expect(call.senderLength).toBe('Jeronimo Cardu'.length)
    expect(typeof call.internalEventId).toBe('string')
    expect(Object.values(call).some((v) => v === 'Jeronimo Cardu')).toBe(false)
  })

  it('7c. an empty sender records a rejection with reason empty_sender and length 0', async () => {
    const deps = makeDeps()
    await handleAutoResponderWebhook({
      deviceTokenHeader: RAW_TOKEN,
      rawBody:            validBody({ query: { sender: '' } }),
      deps,
    })

    const call = (deps.recordRejection as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.reason).toBe('empty_sender')
    expect(call.senderLength).toBe(0)
    expect(deps.enqueueMessage).not.toHaveBeenCalled()
  })

  it('8. the queued envelope is tagged with the authenticated account/tenant — never derived from sender', async () => {
    const deps = makeDeps()
    await handleAutoResponderWebhook({ deviceTokenHeader: RAW_TOKEN, rawBody: validBody(), deps })

    const call = (deps.enqueueMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.tenantId).toBe(ACCOUNT.tenantId)
    expect(call.accountId).toBe(ACCOUNT.id)
    expect(call.rawPayload.provider).toBe('autoresponder')
  })

  it('9. never invents a provider message id — only an internal UUID is attached', async () => {
    const deps = makeDeps()
    await handleAutoResponderWebhook({ deviceTokenHeader: RAW_TOKEN, rawBody: validBody(), deps })

    const call = (deps.enqueueMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const internalId = call.rawPayload._internal_event_id as string
    expect(typeof internalId).toBe('string')
    // UUID v4 shape — proves it's a generated id, not something copied from
    // the AutoResponder payload (which has no message-id field at all).
    expect(internalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('rejects a malformed (non-JSON) body', async () => {
    const deps = makeDeps()
    const result = await handleAutoResponderWebhook({ deviceTokenHeader: RAW_TOKEN, rawBody: '{not json', deps })

    expect(result.httpStatus).toBe(400)
    expect(result.outcome).toBe('rejected_bad_payload')
  })

  it('ignores (200, no enqueue) a payload with the wrong appPackageName/messengerPackageName', async () => {
    const deps = makeDeps()
    const result = await handleAutoResponderWebhook({
      deviceTokenHeader: RAW_TOKEN,
      rawBody:            validBody({ appPackageName: 'com.some.other.app' }),
      deps,
    })

    expect(result.httpStatus).toBe(200)
    expect(result.body).toEqual({ replies: [] })
    expect(result.outcome).toBe('ok_package_mismatch')
    expect(deps.enqueueMessage).not.toHaveBeenCalled()
  })

  it('rejects a token belonging to an inactive account', async () => {
    const deps = makeDeps({
      findAccountByTokenHash: vi.fn(async () => ({ ...ACCOUNT, active: false })),
    })
    const result = await handleAutoResponderWebhook({ deviceTokenHeader: RAW_TOKEN, rawBody: validBody(), deps })

    expect(result.httpStatus).toBe(401)
    expect(result.outcome).toBe('rejected_invalid_token')
  })
})
