// Fase 1B (AutoResponder sin MacroDroid, definitivo) §10/§G — this file had
// no test coverage before. Scoped narrowly to the one behavior this phase
// changed: a human reply from the CRM to a provider=autoresponder
// conversation must never enqueue messaging_outbox (MacroDroid is retired
// from every active flow) — it must fail predictably instead. Not a full
// test suite for messages.ts's many other behaviors (image/audio/document
// send, Meta media, retry) — those are unchanged by this phase.

import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/require-tenant-context', () => ({ requireTenantContext: vi.fn() }))
vi.mock('@/lib/repositories/conversations.repository', () => ({ getConversationById: vi.fn() }))
vi.mock('@/lib/repositories/messages.repository', () => ({ createMessage: vi.fn() }))
vi.mock('@orderflow/supabase/admin', () => ({ createAdminClient: vi.fn() }))

import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { getConversationById } from '@/lib/repositories/conversations.repository'
import { createMessage } from '@/lib/repositories/messages.repository'
import { createAdminClient } from '@orderflow/supabase/admin'
import { sendMessageAction } from './messages'

const TENANT_ID = 'tenant-1'
const USER_ID   = 'user-1'
const CONV_ID   = 'conv-1'
const CONTACT_ID = 'contact-1'
const MESSAGE_ID = 'msg-1'

function mockTenantContext() {
  vi.mocked(requireTenantContext).mockResolvedValue({
    userId: USER_ID, tenantId: TENANT_ID, role: 'owner', workspaceIds: null,
    accessMode: 'tenant_user',
    canAccessSettings: true, canAssignConversations: true, canCreateProperties: true, canConfirmReservations: true,
  } as never)
}

function mockConversation() {
  vi.mocked(getConversationById).mockResolvedValue({
    id: CONV_ID, tenant_id: TENANT_ID, contact_id: CONTACT_ID, status: 'open', channel: 'whatsapp', assigned_user_id: null,
  } as never)
}

function mockCreatedMessage() {
  vi.mocked(createMessage).mockResolvedValue({ id: MESSAGE_ID } as never)
}

// Chainable/thenable stub mirroring Supabase's PostgrestBuilder (itself a
// thenable) — a `resolveValue` reachable via `.maybeSingle()` (explicit
// terminal, used by every SELECT in sendViaWhatsApp) or by `await`ing the
// chain directly (used by the UPDATE calls, which are awaited without an
// explicit terminal method).
function makeChain(resolveValue: { data: unknown; error: unknown }, onCall?: (method: string, arg: unknown) => void) {
  const chain: Record<string, unknown> = {
    select:      (...a: unknown[]) => { onCall?.('select', a); return chain },
    eq:          (...a: unknown[]) => { onCall?.('eq', a); return chain },
    update:      (...a: unknown[]) => { onCall?.('update', a); return chain },
    insert:      (...a: unknown[]) => { onCall?.('insert', a); return chain },
    maybeSingle: () => Promise.resolve(resolveValue),
    then: (resolve: (v: { data: unknown; error: unknown }) => void) => resolve(resolveValue),
  }
  return chain
}

interface AdminMockOpts {
  contactPhone:          string | null
  conversationAccountId: string | null
  account:               { id: string; provider: string; phone_number: string; access_token_encrypted: string | null; active?: boolean } | null
}

function mockAdminClient(opts: AdminMockOpts) {
  const insertCalls: { table: string; payload: unknown }[] = []
  const updateCalls: { table: string; payload: unknown }[] = []

  const admin = {
    from: (table: string) => {
      if (table === 'contacts') {
        return makeChain({ data: opts.contactPhone ? { phone: opts.contactPhone } : null, error: null })
      }
      if (table === 'conversations') {
        return makeChain({ data: opts.conversationAccountId !== undefined ? { whatsapp_account_id: opts.conversationAccountId } : null, error: null })
      }
      if (table === 'whatsapp_accounts') {
        return makeChain({ data: opts.account, error: null })
      }
      if (table === 'messaging_outbox') {
        return makeChain({ data: null, error: null }, (method, arg) => {
          if (method === 'insert') insertCalls.push({ table, payload: arg })
        })
      }
      if (table === 'messages') {
        return makeChain({ data: null, error: null }, (method, arg) => {
          if (method === 'update') updateCalls.push({ table, payload: (arg as unknown[])[0] })
        })
      }
      throw new Error(`mockAdminClient: unexpected table "${table}"`)
    },
  }

  vi.mocked(createAdminClient).mockReturnValue(admin as never)
  return { insertCalls, updateCalls }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockTenantContext()
  mockConversation()
  mockCreatedMessage()
})

describe('sendMessageAction — Fase 1B §10/§G: provider=autoresponder never uses MacroDroid', () => {
  it('a human reply to an AutoResponder conversation never inserts into messaging_outbox', async () => {
    const { insertCalls } = mockAdminClient({
      contactPhone:          '5491112345678',
      conversationAccountId: 'acc-ar-1',
      account:               { id: 'acc-ar-1', provider: 'autoresponder', phone_number: '5491100000000', access_token_encrypted: null, active: true },
    })

    const result = await sendMessageAction(CONV_ID, { content: 'Hola desde el CRM', content_type: 'text' })

    expect(result.success).toBe(true) // the message row itself is still created — only delivery fails
    expect(insertCalls.filter((c) => c.table === 'messaging_outbox')).toHaveLength(0)
  })

  it('marks the message delivery as failed, with an honest reason, instead of silently dropping it', async () => {
    const { updateCalls } = mockAdminClient({
      contactPhone:          '5491112345678',
      conversationAccountId: 'acc-ar-1',
      account:               { id: 'acc-ar-1', provider: 'autoresponder', phone_number: '5491100000000', access_token_encrypted: null, active: true },
    })

    await sendMessageAction(CONV_ID, { content: 'Hola desde el CRM', content_type: 'text' })

    const failedUpdate = updateCalls.find((c) => c.table === 'messages')
    expect(failedUpdate).toBeDefined()
    const payload = failedUpdate!.payload as { metadata: { delivery_status: string; delivery_error: string } }
    expect(payload.metadata.delivery_status).toBe('failed')
    expect(payload.metadata.delivery_error).toMatch(/AutoResponder/i)
  })

  it('never calls fetch (no Graph API, no MacroDroid HTTP trigger) for provider=autoresponder', async () => {
    mockAdminClient({
      contactPhone:          '5491112345678',
      conversationAccountId: 'acc-ar-1',
      account:               { id: 'acc-ar-1', provider: 'autoresponder', phone_number: '5491100000000', access_token_encrypted: null, active: true },
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await sendMessageAction(CONV_ID, { content: 'Hola desde el CRM', content_type: 'text' })

    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('Meta conversations are unaffected — still attempt Graph API delivery, not blocked', async () => {
    mockAdminClient({
      contactPhone:          '5491112345678',
      conversationAccountId: 'acc-meta-1',
      account:               { id: 'acc-meta-1', provider: 'meta', phone_number: '5491100000000', access_token_encrypted: 'test-token', active: true },
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, json: () => Promise.resolve({ messages: [{ id: 'wamid.test' }] }),
    } as Response)

    const result = await sendMessageAction(CONV_ID, { content: 'Hola desde el CRM', content_type: 'text' })

    expect(result.success).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0]![0]).toMatch(/graph\.facebook\.com/)
    fetchSpy.mockRestore()
  })
})
