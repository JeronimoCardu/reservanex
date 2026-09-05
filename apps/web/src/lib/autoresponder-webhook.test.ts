// Fase 1 (AutoResponder sin MacroDroid) — this pure handler previously had
// no dedicated test file at all (only the worker's parallel copy,
// apps/worker/src/providers/autoresponder/webhook-handler.test.ts, was
// tested — see that file's "NOTE on duplication"). Now that this exact
// function owns the new synchronous-reply contract (deps.processSync →
// {replies:[...]}) that the real webhook route depends on, it gets its own
// suite, mirroring the worker copy's style (deps injection, no HTTP, no DB).
import { describe, expect, it, vi } from 'vitest'
import {
  handleAutoResponderWebhook,
  hashDeviceToken,
  AUTORESPONDER_APP_PACKAGE,
  WHATSAPP_BUSINESS_PACKAGE,
  type AutoResponderWebhookDeps,
} from './autoresponder-webhook'

const RAW_TOKEN  = 'super-secret-device-token-abc123'
const TOKEN_HASH = hashDeviceToken(RAW_TOKEN)
const ACCOUNT    = { id: 'account-1', tenantId: 'tenant-1', active: true }

function makeDeps(overrides: Partial<AutoResponderWebhookDeps> = {}): AutoResponderWebhookDeps {
  return {
    findAccountByTokenHash: vi.fn(async (hash: string) => (hash === TOKEN_HASH ? ACCOUNT : null)),
    enqueueMessage:         vi.fn(async () => ({ id: 'queue-item-1' })),
    recordRejection:        vi.fn(async () => undefined),
    markDeviceSeen:         vi.fn(async () => undefined),
    processSync:            vi.fn(async () => ({ replyText: 'Hola! ¿En qué te puedo ayudar?' })),
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
      message:          'Hola, quiero info',
      isGroup:          false,
      groupParticipant: '',
      ruleId:           1,
      isTestMessage:    false,
      ...overrides.query,
    },
  })
}

describe('handleAutoResponderWebhook — auth/payload validation', () => {
  it('rejects a request with no device token header', async () => {
    const deps = makeDeps()
    const result = await handleAutoResponderWebhook({ deviceTokenHeader: null, rawBody: validBody(), deps })

    expect(result.httpStatus).toBe(401)
    expect(result.outcome).toBe('rejected_no_token')
    expect(deps.findAccountByTokenHash).not.toHaveBeenCalled()
    expect(deps.processSync).not.toHaveBeenCalled()
  })

  it('rejects an empty/whitespace device token header', async () => {
    const deps = makeDeps()
    const result = await handleAutoResponderWebhook({ deviceTokenHeader: '   ', rawBody: validBody(), deps })
    expect(result.httpStatus).toBe(401)
    expect(result.outcome).toBe('rejected_no_token')
  })

  it('rejects an incorrect device token', async () => {
    const deps = makeDeps()
    const result = await handleAutoResponderWebhook({ deviceTokenHeader: 'wrong-token', rawBody: validBody(), deps })

    expect(result.httpStatus).toBe(401)
    expect(result.outcome).toBe('rejected_invalid_token')
    expect(deps.processSync).not.toHaveBeenCalled()
  })

  it('rejects a token belonging to an inactive account', async () => {
    const deps = makeDeps({ findAccountByTokenHash: vi.fn(async () => ({ ...ACCOUNT, active: false })) })
    const result = await handleAutoResponderWebhook({ deviceTokenHeader: RAW_TOKEN, rawBody: validBody(), deps })

    expect(result.httpStatus).toBe(401)
    expect(result.outcome).toBe('rejected_invalid_token')
  })

  it('rejects a malformed (non-JSON) body', async () => {
    const deps = makeDeps()
    const result = await handleAutoResponderWebhook({ deviceTokenHeader: RAW_TOKEN, rawBody: '{not json', deps })

    expect(result.httpStatus).toBe(400)
    expect(result.outcome).toBe('rejected_bad_payload')
    expect(deps.processSync).not.toHaveBeenCalled()
  })

  it('ignores (200, empty replies, no enqueue/processSync) a payload with the wrong app/messenger package', async () => {
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
    expect(deps.processSync).not.toHaveBeenCalled()
  })

  it('ignores a group message — never reaches enqueueMessage or processSync', async () => {
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
    expect(deps.processSync).not.toHaveBeenCalled()
  })

  it('a sender that is a saved-contact NAME is never resolved/queued/processed as a phone', async () => {
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
    expect(deps.processSync).not.toHaveBeenCalled()
  })

  it('every authenticated outcome calls markDeviceSeen exactly once', async () => {
    const deps = makeDeps()
    await handleAutoResponderWebhook({ deviceTokenHeader: RAW_TOKEN, rawBody: validBody(), deps })
    expect(deps.markDeviceSeen).toHaveBeenCalledTimes(1)
    expect(deps.markDeviceSeen).toHaveBeenCalledWith(ACCOUNT.id)
  })
})

describe('handleAutoResponderWebhook — Fase 1 synchronous reply (Caso A/B/D/H)', () => {
  it('Caso A: a normal message enqueues then returns the AI reply from processSync', async () => {
    const deps = makeDeps({ processSync: vi.fn(async () => ({ replyText: 'Encontré 2 propiedades para vos.' })) })
    const result = await handleAutoResponderWebhook({ deviceTokenHeader: RAW_TOKEN, rawBody: validBody(), deps })

    expect(deps.enqueueMessage).toHaveBeenCalledTimes(1)
    expect(deps.processSync).toHaveBeenCalledTimes(1)
    const call = (deps.processSync as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(call).toEqual({ queueItemId: 'queue-item-1', tenantId: ACCOUNT.tenantId, accountId: ACCOUNT.id })

    expect(result.httpStatus).toBe(200)
    expect(result.body).toEqual({ replies: [{ message: 'Encontré 2 propiedades para vos.' }] })
    expect(result.outcome).toBe('ok_replied')
  })

  it('Caso B: processSync resolving null replyText (e.g. manual mode) → {replies: []}, not an error', async () => {
    const deps = makeDeps({ processSync: vi.fn(async () => ({ replyText: null })) })
    const result = await handleAutoResponderWebhook({ deviceTokenHeader: RAW_TOKEN, rawBody: validBody(), deps })

    expect(result.httpStatus).toBe(200)
    expect(result.body).toEqual({ replies: [] })
    expect(result.outcome).toBe('ok_silent')
  })

  it('Caso D/timeout/error: processSync resolving null (worker unreachable, timed out, or errored) → safe {replies: []}, never a 500', async () => {
    const deps = makeDeps({ processSync: vi.fn(async () => null) })
    const result = await handleAutoResponderWebhook({ deviceTokenHeader: RAW_TOKEN, rawBody: validBody(), deps })

    expect(result.httpStatus).toBe(200)
    expect(result.body).toEqual({ replies: [] })
    expect(result.outcome).toBe('ok_silent')
  })

  it('processSync throwing unexpectedly is caught — never propagates, still {replies: []}', async () => {
    const deps = makeDeps({ processSync: vi.fn(async () => { throw new Error('boom') }) })
    const result = await handleAutoResponderWebhook({ deviceTokenHeader: RAW_TOKEN, rawBody: validBody(), deps })

    expect(result.httpStatus).toBe(200)
    expect(result.body).toEqual({ replies: [] })
    expect(result.outcome).toBe('ok_silent')
  })

  it('Caso H: an empty/whitespace-only replyText from processSync never becomes a reply with empty text', async () => {
    const deps = makeDeps({ processSync: vi.fn(async () => ({ replyText: '   ' })) })
    const result = await handleAutoResponderWebhook({ deviceTokenHeader: RAW_TOKEN, rawBody: validBody(), deps })

    expect(result.body).toEqual({ replies: [] })
    expect(result.outcome).toBe('ok_silent')
  })

  it('Caso J: the reply shape is a `replies` array (multi-reply-ready) even with exactly one message', async () => {
    const deps = makeDeps({ processSync: vi.fn(async () => ({ replyText: 'Una respuesta' })) })
    const result = await handleAutoResponderWebhook({ deviceTokenHeader: RAW_TOKEN, rawBody: validBody(), deps })

    expect(result.body).toHaveProperty('replies')
    expect(Array.isArray((result.body as { replies: unknown[] }).replies)).toBe(true)
    expect((result.body as { replies: { message: string }[] }).replies).toHaveLength(1)
    expect((result.body as { replies: { message: string }[] }).replies[0]).toEqual({ message: 'Una respuesta' })
  })

  it('the queued envelope is tagged with the authenticated account/tenant — never derived from sender', async () => {
    const deps = makeDeps()
    await handleAutoResponderWebhook({ deviceTokenHeader: RAW_TOKEN, rawBody: validBody(), deps })

    const call = (deps.enqueueMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(call.tenantId).toBe(ACCOUNT.tenantId)
    expect(call.accountId).toBe(ACCOUNT.id)
    expect(call.rawPayload.provider).toBe('autoresponder')
  })

  it('never invents a provider message id — only an internal UUID is attached', async () => {
    const deps = makeDeps()
    await handleAutoResponderWebhook({ deviceTokenHeader: RAW_TOKEN, rawBody: validBody(), deps })

    const call = (deps.enqueueMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    const internalId = call.rawPayload._internal_event_id as string
    expect(internalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('an enqueue failure never reaches processSync and returns 500', async () => {
    const deps = makeDeps({ enqueueMessage: vi.fn(async () => null) })
    const result = await handleAutoResponderWebhook({ deviceTokenHeader: RAW_TOKEN, rawBody: validBody(), deps })

    expect(result.httpStatus).toBe(500)
    expect(result.outcome).toBe('rejected_enqueue_failed')
    expect(deps.processSync).not.toHaveBeenCalled()
  })
})
